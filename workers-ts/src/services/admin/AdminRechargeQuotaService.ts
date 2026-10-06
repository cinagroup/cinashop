import { and, desc, eq, getTableColumns, sql } from 'drizzle-orm';
import { withTx, type Container } from '@/lib/di';
import { systemGroupData, systemLog } from '@/models/schema';
import { NotFoundException, ValidateException } from '@/utils/errors';
import { decodeRechargeQuota, MAX_RECHARGE_QUOTAS, rechargeQuotaDeadlines, rechargeQuotaGroup, rechargeQuotaMoney,
  RECHARGE_QUOTA_LOCK_KEY, RECHARGE_QUOTA_LOCK_NAMESPACE } from '@/services/payment/RechargeQuotaPolicy';

const maximum = 2_147_483_647;
const columns = { ...getTableColumns(systemGroupData), version: sql<string>`xmin::text` };
type QuotaRow = typeof systemGroupData.$inferSelect & { version: string };
export type RechargeQuotaOperation = 'create' | 'update' | 'status' | 'delete';

function idValue(value: unknown): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^[1-9]\d{0,9}$/.test(String(value))) throw new ValidateException('充值档位ID错误');
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id > maximum) throw new ValidateException('充值档位ID错误');
  return id;
}
function integer(value: unknown, max = maximum): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) throw new ValidateException('排序或显示状态必须是范围内的整数');
  return value;
}
async function hash(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
async function project(row: QuotaRow) {
  const values = decodeRechargeQuota(row.value);
  return { id: row.id, price: values?.price ?? '', give_money: values?.give_money ?? '', valid: values !== null,
    status: row.status, sort: row.sort,
    add_time: row.addTime ? new Date(row.addTime * 1000).toISOString().replace('T', ' ').slice(0, 19) : '', revision: await hash(row) };
}
function parseQuery(query: URLSearchParams) {
  const allowed = new Set(['page', 'limit', 'status']);
  for (const key of query.keys()) if (!allowed.has(key) || query.getAll(key).length !== 1) throw new ValidateException('不支持或重复的充值档位查询参数');
  const page = query.has('page') ? idValue(query.get('page')) : 1;
  const limit = query.has('limit') ? idValue(query.get('limit')) : 15;
  const offset = (page - 1) * limit;
  if (limit > 100 || offset > 10_000) throw new ValidateException('充值档位分页超出范围');
  const status = query.get('status') || 'all';
  if (!['all', '0', '1'].includes(status)) throw new ValidateException('充值档位显示状态错误');
  return { page, limit, offset, status };
}

/** Dedicated user_recharge_quota writes. No generic group, schema, user balance
 * or existing recharge order mutation is exposed by this service. */
export class AdminRechargeQuotaService {
  constructor(private readonly container: Container) {}

  async list(parameters: URLSearchParams) {
    const query = parseQuery(parameters);
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await rechargeQuotaDeadlines(tx);
      const gid = await rechargeQuotaGroup(tx);
      const predicate = and(eq(systemGroupData.gid, gid), query.status === 'all' ? undefined : eq(systemGroupData.status, Number(query.status)));
      const rows = await tx.select(columns).from(systemGroupData).where(predicate)
        .orderBy(desc(systemGroupData.sort), desc(systemGroupData.id)).limit(query.limit).offset(query.offset);
      const [total] = await tx.select({ count: sql<number>`count(*)::integer` }).from(systemGroupData).where(predicate);
      return { list: await Promise.all(rows.map(project)), count: total.count, page: query.page, limit: query.limit };
    });
  }

  async detail(value: unknown) {
    const id = idValue(value);
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await rechargeQuotaDeadlines(tx);
      const gid = await rechargeQuotaGroup(tx);
      const [row] = await tx.select(columns).from(systemGroupData).where(and(eq(systemGroupData.gid, gid), eq(systemGroupData.id, id))).limit(1);
      if (!row) throw new NotFoundException('充值档位不存在');
      return project(row);
    });
  }

  async mutate(operation: RechargeQuotaOperation, value: unknown, raw: Record<string, unknown>, actor: { id: number }) {
    idValue(actor?.id);
    const id = operation === 'create' ? 0 : idValue(value);
    const allowed = new Set(['request_id', ...(operation === 'create' ? [] : ['revision']),
      ...(operation === 'delete' ? [] : operation === 'status' ? ['status'] : ['price', 'give_money', 'sort', 'status'])]);
    if (Object.keys(raw).some(key => !allowed.has(key))) throw new ValidateException('不支持的充值档位写入字段');
    if (typeof raw.request_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(raw.request_id)) throw new ValidateException('请求标识必须是UUID');
    if (operation !== 'create' && (typeof raw.revision !== 'string' || !/^[a-f0-9]{64}$/.test(raw.revision))) throw new ValidateException('充值档位版本无效，请刷新后重新确认');
    const input = operation === 'create' || operation === 'update' ? { price: rechargeQuotaMoney(raw.price),
      give_money: rechargeQuotaMoney(raw.give_money, true), sort: integer(raw.sort), status: integer(raw.status, 1) } : null;
    const status = operation === 'status' ? integer(raw.status, 1) : input?.status;
    const fingerprint = await hash({ operation, id, revision: raw.revision ?? null, input, status: status ?? null });
    const replayPath = `/marketing/recharge-quotas/request/${raw.request_id}`;
    return withTx(this.container, async tx => {
      await rechargeQuotaDeadlines(tx);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${RECHARGE_QUOTA_LOCK_NAMESPACE},${RECHARGE_QUOTA_LOCK_KEY})`);
      const journal = await tx.select({ action: systemLog.action }).from(systemLog)
        .where(and(eq(systemLog.adminId, actor.id), eq(systemLog.type, 'recharge_quota'), eq(systemLog.path, replayPath)))
        .orderBy(desc(systemLog.id)).limit(2);
      if (journal.length) {
        const match = /^([a-z]+);id=([1-9]\d{0,9});payload=([a-f0-9]{64})$/.exec(journal[0].action);
        if (journal.length !== 1 || !match || match[1] !== operation || match[3] !== fingerprint) throw new ValidateException('请求标识已用于其他充值档位操作');
        return { id: idValue(match[2]) };
      }
      const gid = await rechargeQuotaGroup(tx);
      const row = id ? (await tx.select(columns).from(systemGroupData)
        .where(and(eq(systemGroupData.id, id), eq(systemGroupData.gid, gid))).for('update').limit(1))[0] : undefined;
      if (id && !row) throw new NotFoundException('充值档位不存在');
      if (row && await hash(row) !== raw.revision) throw new ValidateException('充值档位已更新，请刷新后重新确认');
      if (operation === 'status' && status === 1 && !decodeRechargeQuota(row!.value)) throw new ValidateException('档位金额无效，请编辑修复后显示');
      if (operation === 'create') {
        const [total] = await tx.select({ count: sql<number>`count(*)::integer` }).from(systemGroupData).where(eq(systemGroupData.gid, gid));
        if (total.count >= MAX_RECHARGE_QUOTAS) throw new ValidateException('充值档位最多20条（含隐藏），请先删除其他档位');
      }
      if (status === 1 && row && row.status !== 1) {
        const [visible] = await tx.select({ count: sql<number>`count(*)::integer` }).from(systemGroupData)
          .where(and(eq(systemGroupData.gid, gid), eq(systemGroupData.status, 1)));
        if (visible.count >= MAX_RECHARGE_QUOTAS) throw new ValidateException('最多显示20个充值档位，请先隐藏其他档位');
      }
      let resultId = id;
      if (input) {
        const values = { value: JSON.stringify({ price: { type: 'input', value: input.price }, give_money: { type: 'input', value: input.give_money } }),
          sort: input.sort, status: input.status };
        if (operation === 'create') {
          const [created] = await tx.insert(systemGroupData).values({ ...values, gid, addTime: Math.floor(Date.now() / 1000) }).returning({ id: systemGroupData.id });
          resultId = created.id;
        } else await tx.update(systemGroupData).set(values).where(and(eq(systemGroupData.id, id), eq(systemGroupData.gid, gid)));
      } else if (operation === 'status') await tx.update(systemGroupData).set({ status: status! }).where(and(eq(systemGroupData.id, id), eq(systemGroupData.gid, gid)));
      else await tx.delete(systemGroupData).where(and(eq(systemGroupData.id, id), eq(systemGroupData.gid, gid)));
      await tx.insert(systemLog).values({ adminId: actor.id, type: 'recharge_quota', path: replayPath,
        method: operation === 'create' ? 'POST' : operation === 'delete' ? 'DELETE' : 'PUT',
        action: `${operation};id=${resultId};payload=${fingerprint}`, addTime: Math.floor(Date.now() / 1000) });
      return { id: resultId };
    });
  }
}
