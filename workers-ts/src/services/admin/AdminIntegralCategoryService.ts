import { and, desc, eq, getTableColumns, gte, ilike, lte, ne, or, sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { legacyCategory, systemLog } from '@/models/schema';
import { NotFoundException, ValidateException } from '@/utils/errors';

const GROUP = 5;
const LOCK_NAMESPACE = 731_641;
const MAX_VISIBLE_CATEGORIES = 1000; // The existing public integral category consumer's limit.
const maximum = 2_147_483_647;
const columns = { ...getTableColumns(legacyCategory), version: sql<string>`xmin::text` };
type CategoryRow = typeof legacyCategory.$inferSelect & { version: string };
type CategoryInput = { name: string; integralMin: number; integralMax: number; sort: number; isShow: number };
export type IntegralCategoryOperation = 'create' | 'update' | 'status' | 'delete';
export interface IntegralCategoryAdminActor { id: number; }

export function integralCategoryId(value: unknown): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^[1-9]\d{0,9}$/.test(String(value))) {
    throw new ValidateException('分类ID错误');
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id > maximum) throw new ValidateException('分类ID错误');
  return id;
}

function integer(value: unknown, label: string, max = maximum): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new ValidateException(`${label}必须是范围内的非负整数`);
  }
  return value;
}

function text(value: unknown, max: number, required = false): string {
  if (typeof value !== 'string' || value.length > max * 2 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ValidateException('分类名称格式错误');
  }
  const result = value.trim();
  if ((required && !result) || [...result].length > max) throw new ValidateException(`分类名称须为${required ? '1' : '0'}至${max}个字符`);
  return result;
}

function parseInput(input: Record<string, unknown>): CategoryInput {
  const minimum = integer(input.integral_min, '最低积分'), maximum = integer(input.integral_max, '最高积分');
  if (minimum >= maximum) throw new ValidateException('最低积分必须小于最高积分');
  return { name: text(input.name, 30, true), integralMin: minimum, integralMax: maximum,
    sort: integer(input.sort, '排序'), isShow: integer(input.is_show, '显示状态', 1) };
}

async function hash(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function project(row: CategoryRow) {
  return { id: row.id, name: row.name, integral_min: row.integralMin, integral_max: row.integralMax,
    is_show: row.isShow, sort: row.sort,
    add_time: row.addTime ? new Date(row.addTime * 1000).toISOString().replace('T', ' ').slice(0, 19) : '',
    revision: await hash(row) };
}

async function deadlines(db: DbClient) {
  await db.execute(sql`SELECT set_config('statement_timeout',
    LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
    set_config('lock_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000)::text || 'ms',true)`);
}

function parseQuery(query: URLSearchParams) {
  const allowed = new Set(['page', 'limit', 'name', 'is_show']);
  for (const key of query.keys()) {
    if (!allowed.has(key) || query.getAll(key).length !== 1) throw new ValidateException('不支持或重复的分类查询参数');
  }
  const page = query.has('page') ? integralCategoryId(query.get('page')) : 1;
  const limit = query.has('limit') ? integralCategoryId(query.get('limit')) : 15;
  const offset = (page - 1) * limit;
  if (limit > 100 || offset > 10_000) throw new ValidateException('分类分页超出范围');
  const isShow = query.get('is_show') || 'all';
  if (!['all', '0', '1'].includes(isShow)) throw new ValidateException('分类显示状态错误');
  return { page, limit, offset, isShow, name: text(query.get('name') ?? '', 100) };
}

/** Flat group-5 integral ranges. This never touches store_product_category,
 * other category groups, product assignments, balances or integral orders. */
export class AdminIntegralCategoryService {
  constructor(private readonly container: Container) {}

  async list(parameters: URLSearchParams) {
    const query = parseQuery(parameters);
    const conditions = [eq(legacyCategory.group, GROUP)];
    if (query.isShow !== 'all') conditions.push(eq(legacyCategory.isShow, Number(query.isShow)));
    if (query.name) {
      const pattern = `%${query.name.replace(/[\\%_]/g, '\\$&')}%`;
      conditions.push(or(ilike(legacyCategory.name, pattern), sql`${legacyCategory.id}::text ILIKE ${pattern}`)!);
    }
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await deadlines(tx);
      const predicate = and(...conditions);
      const rows = await tx.select(columns).from(legacyCategory).where(predicate)
        .orderBy(desc(legacyCategory.sort), desc(legacyCategory.id)).limit(query.limit).offset(query.offset);
      const [total] = await tx.select({ count: sql<number>`count(*)::integer` }).from(legacyCategory).where(predicate);
      return { list: await Promise.all(rows.map(project)), count: total.count, page: query.page, limit: query.limit };
    });
  }

  async detail(idValue: unknown) {
    const id = integralCategoryId(idValue);
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      await deadlines(tx);
      const [row] = await tx.select(columns).from(legacyCategory)
        .where(and(eq(legacyCategory.group, GROUP), eq(legacyCategory.id, id))).limit(1);
      if (!row) throw new NotFoundException('积分分类不存在');
      return project(row);
    });
  }

  async mutate(operation: IntegralCategoryOperation, idValue: unknown, raw: Record<string, unknown>, actor: IntegralCategoryAdminActor) {
    integralCategoryId(actor?.id);
    const id = operation === 'create' ? 0 : integralCategoryId(idValue);
    const allowed = new Set(['request_id', ...(operation === 'create' ? [] : ['revision']),
      ...(operation === 'delete' ? [] : operation === 'status' ? ['is_show'] : ['name', 'integral_min', 'integral_max', 'sort', 'is_show'])]);
    if (Object.keys(raw).some(key => !allowed.has(key))) throw new ValidateException('不支持的分类写入字段');
    if (typeof raw.request_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(raw.request_id)) {
      throw new ValidateException('请求标识必须是UUID');
    }
    if (operation !== 'create' && (typeof raw.revision !== 'string' || !/^[a-f0-9]{64}$/.test(raw.revision))) {
      throw new ValidateException('分类版本无效，请刷新后重新确认');
    }
    const input = operation === 'create' || operation === 'update' ? parseInput(raw) : null;
    const show = operation === 'status' ? integer(raw.is_show, '显示状态', 1) : input?.isShow;
    // Bind operation, target, expected version and normalized content. The
    // journal contains only IDs/operation/hash, never the category name/body.
    const fingerprint = await hash({ operation, id, revision: raw.revision ?? null, input, show: show ?? null });
    const replayPath = `/marketing/integral-categories/request/${raw.request_id}`;
    return withTx(this.container, async tx => {
      await deadlines(tx);
      // One bounded group fence closes duplicate-name/range/capacity races for
      // every writer in this management surface, including hidden ranges.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE}, ${GROUP})`);
      const journal = await tx.select({ action: systemLog.action }).from(systemLog)
        .where(and(eq(systemLog.adminId, actor.id), eq(systemLog.type, 'integral_category'), eq(systemLog.path, replayPath)))
        .orderBy(desc(systemLog.id)).limit(2);
      if (journal.length) {
        const match = /^([a-z]+);id=([1-9]\d{0,9});payload=([a-f0-9]{64})$/.exec(journal[0].action);
        if (journal.length !== 1 || !match || match[1] !== operation || match[3] !== fingerprint) {
          throw new ValidateException('请求标识已用于其他分类操作');
        }
        return { id: integralCategoryId(match[2]) };
      }
      const row = id ? (await tx.select(columns).from(legacyCategory)
        .where(and(eq(legacyCategory.id, id), eq(legacyCategory.group, GROUP))).for('update').limit(1))[0] : undefined;
      if (id && !row) throw new NotFoundException('积分分类不存在');
      if (row && await hash(row) !== raw.revision) throw new ValidateException('分类已更新，请刷新后重新确认');

      // Legacy malformed hidden rows may be repaired or deleted, but must not
      // become publicly visible through a status-only bypass of range checks.
      const candidate = input ?? (operation === 'status' && show === 1 && row
        ? parseInput({ name: row.name, integral_min: row.integralMin, integral_max: row.integralMax, sort: row.sort, is_show: 1 }) : null);
      if (candidate) {
        const [duplicate] = await tx.select({ id: legacyCategory.id }).from(legacyCategory)
          .where(and(eq(legacyCategory.group, GROUP), ne(legacyCategory.id, id),
            sql`lower(${legacyCategory.name}) = lower(${candidate.name})`)).limit(1);
        if (duplicate) throw new ValidateException('积分分类名称已存在');
        const [overlap] = await tx.select({ id: legacyCategory.id }).from(legacyCategory)
          .where(and(eq(legacyCategory.group, GROUP), ne(legacyCategory.id, id),
            lte(legacyCategory.integralMin, candidate.integralMax), gte(legacyCategory.integralMax, candidate.integralMin))).limit(1);
        if (overlap) throw new ValidateException('积分分类范围不可重叠');
      }
      if (show === 1 && (!row || row.isShow !== 1)) {
        const [visible] = await tx.select({ count: sql<number>`count(*)::integer` }).from(legacyCategory)
          .where(and(eq(legacyCategory.group, GROUP), eq(legacyCategory.isShow, 1)));
        if (visible.count >= MAX_VISIBLE_CATEGORIES) throw new ValidateException('最多显示1000个积分分类，请先隐藏或删除其他分类');
      }
      let resultId = id;
      if (operation === 'create' && input) {
        const [created] = await tx.insert(legacyCategory).values({ ...input, group: GROUP, type: 0, relationId: 0, ownerId: 0, pid: 0,
          addTime: Math.floor(Date.now() / 1000) }).returning({ id: legacyCategory.id });
        resultId = created.id;
      } else if (operation === 'update' && input) {
        await tx.update(legacyCategory).set(input).where(and(eq(legacyCategory.id, id), eq(legacyCategory.group, GROUP)));
      } else if (operation === 'status') {
        await tx.update(legacyCategory).set({ isShow: show! }).where(and(eq(legacyCategory.id, id), eq(legacyCategory.group, GROUP)));
      } else if (operation === 'delete') {
        await tx.delete(legacyCategory).where(and(eq(legacyCategory.id, id), eq(legacyCategory.group, GROUP)));
      }
      await tx.insert(systemLog).values({ adminId: actor.id, type: 'integral_category', path: replayPath,
        method: operation === 'create' ? 'POST' : operation === 'delete' ? 'DELETE' : 'PUT',
        action: `${operation};id=${resultId};payload=${fingerprint}`, addTime: Math.floor(Date.now() / 1000) });
      return { id: resultId };
    });
  }
}
