import { eq, sql } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { storeProduct, storeProductEnsure, systemAdmin, systemLog } from '@/models/schema';
import { ProductExperienceService, platformEnsureOwner } from '@/services/product/ProductExperienceService';
import { formatParameterSpecTime } from '@/services/product/ProductMetadataService';
import { ApiErrorCode, AuthException, HttpApiException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { md5 } from '@/utils/jwt';
import { acquireAdminAuthorityWriteBarrier, assertAdminAuthoritySession, loadAdminAuthorityLiveActor,
  parseAdminAuthorityRoleIds, type AdminAuthorityActor } from './AdminAuthorityWriteService';
import { loadAdminLegacyRoleReferenceHistory } from './AdminLegacyRoleDeletionProof';
import { AdminPermissionService, hasAdminPermission } from './AdminPermissionService';

export type AdminProductEnsureActor = AdminAuthorityActor;
type EnsureRow = typeof storeProductEnsure.$inferSelect;
const MAX_ID = 2_147_483_647;
const fields = ['id', 'type', 'relation_id', 'name', 'image', 'desc', 'sort', 'status', 'add_time', 'product_count'];

export function ensureId(value: unknown, allowZero = false): number {
  const id = typeof value === 'number' ? value : typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(id) || id < (allowZero ? 0 : 1) || id > MAX_ID) throw new ValidateException('商品保障服务ID错误');
  return id;
}

export function ensureStatus(value: unknown): 0 | 1 {
  if (value === 0 || value === '0') return 0;
  if (value === 1 || value === '1') return 1;
  throw new ValidateException('商品保障服务状态只能是0或1');
}

function noQuery(query: URLSearchParams): void {
  if (query.size) throw new ValidateException('此商品保障服务操作不接受查询参数');
}

function listQuery(query: URLSearchParams): Record<string, string> {
  const input: Record<string, string> = {};
  for (const [key, value] of query) {
    if (!['name', 'page', 'limit'].includes(key) || Object.hasOwn(input, key)) throw new ValidateException('商品保障服务查询参数错误或重复');
    input[key] = value;
  }
  if (input.name !== undefined && ([...input.name].length > 255 || /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(input.name))) {
    throw new ValidateException('商品保障服务查询名称错误');
  }
  const page = input.page === undefined ? 1 : ensureId(input.page);
  const limit = input.limit === undefined ? 20 : ensureId(input.limit);
  if (limit > 100 || (page - 1) * limit > MAX_ID) throw new ValidateException('商品保障服务分页超出范围');
  return input;
}

function saveInput(id: number, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidateException('商品保障服务正文必须是对象');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !fields.includes(key))) throw new ValidateException('商品保障服务正文包含未知字段');
  if (input.id !== undefined && ensureId(input.id, true) !== id) throw new ValidateException('商品保障服务正文ID必须与路径一致');
  // The core compares complete echo metadata, including the optional derived
  // product_count, while the same lifecycle fence and row lock are held.
  return input;
}

function sameStoredRow(actual: EnsureRow | undefined, expected: EnsureRow): boolean {
  if (!actual) return false;
  return Object.keys(actual).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, value]) => actual[key as keyof EnsureRow] === value);
}

function operationError(error: unknown): never {
  let cause: unknown = error;
  for (let depth = 0; depth < 6 && cause && typeof cause === 'object'; depth++) {
    const code = 'code' in cause ? String(cause.code) : '';
    if (['55P03', '40P01', '40001'].includes(code)) throw Object.assign(new HttpApiException('保障服务、商品或管理员权限正在更新，请刷新后重试', 409, 409), { cause: error });
    if (['42501', '57014'].includes(code)) throw Object.assign(new ServiceUnavailableException('保障服务运行权限配置未就绪或操作超时'), { cause: error });
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  throw error;
}

export class AdminProductEnsureService {
  constructor(private readonly container: Container) {}

  private async readActor(tx: DbClient, actor: AdminProductEnsureActor): Promise<void> {
    const [live] = await tx.select().from(systemAdmin).where(eq(systemAdmin.id, actor.id)).limit(1);
    if (!live || live.adminType !== 1 || live.relationId !== 0 || live.status !== 1 || live.isDel !== 0
      || !Number.isInteger(live.level) || live.level < 0 || live.level > 9) throw new AuthException('管理员身份已变化', ApiErrorCode.ERR_BANNED);
    const encoder = new TextEncoder();
    if (!timingSafeEqual(encoder.encode(md5(live.pwd)), encoder.encode(actor.authVersion))) throw new AuthException('登录凭据已变化', ApiErrorCode.ERR_EXPIRED);
    await loadAdminLegacyRoleReferenceHistory(tx, parseAdminAuthorityRoleIds(live.roles), live.level);
    const { keys } = await new AdminPermissionService(createContainerFromDb(tx)).resolveRoleAssignment(live.roles);
    if (live.level !== 0 && !hasAdminPermission(keys, 'product.view')) throw new AuthException('商品保障服务查看权限已变化', ApiErrorCode.ERR_AUTH);
    assertAdminAuthoritySession(actor);
  }

  private async transaction<T>(actor: AdminProductEnsureActor, write: boolean,
    work: (tx: DbClient, core: ProductExperienceService) => Promise<T>): Promise<T> {
    assertAdminAuthoritySession(actor);
    try {
      return await withTx(this.container, async tx => {
        let initial: typeof systemAdmin.$inferSelect | undefined;
        if (write) {
          await acquireAdminAuthorityWriteBarrier(tx);
          await loadAdminAuthorityLiveActor(tx, actor, 'product.manage');
          [initial] = await tx.select().from(systemAdmin).where(eq(systemAdmin.id, actor.id)).limit(1);
        } else {
          await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
          await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
          await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
          await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5s'`);
          await this.readActor(tx, actor);
        }
        const result = await work(tx, new ProductExperienceService(createContainerFromDb(tx)));
        if (write) {
          await loadAdminAuthorityLiveActor(tx, actor, 'product.manage');
          const [fresh] = await tx.select().from(systemAdmin).where(eq(systemAdmin.id, actor.id)).limit(1);
          if (!initial || JSON.stringify(fresh) !== JSON.stringify(initial)) throw new AuthException('管理员身份已变化', ApiErrorCode.ERR_AUTH);
        }
        const [clock] = await tx.execute(sql`SELECT extract(epoch from clock_timestamp()) >= ${actor.expiresAt} AS expired`) as unknown as Array<{ expired: boolean }>;
        if (clock?.expired !== false) throw new AuthException('登录已过期', ApiErrorCode.ERR_EXPIRED);
        assertAdminAuthoritySession(actor);
        return result;
      });
    } catch (error) { return operationError(error); }
  }

  async all(query: URLSearchParams, actor: AdminProductEnsureActor, legacy = true) {
    noQuery(query);
    return this.transaction(actor, false, async (_tx, core) => {
      const rows = await core.allEnsures(platformEnsureOwner);
      return legacy ? [...rows].sort((a, b) => b.sort - a.sort || b.id - a.id).map(row => ({ id: row.id, name: row.name })) : rows;
    });
  }

  private async productCounts(tx: DbClient, ids: number[]): Promise<Map<number, number>> {
    if (!ids.length) return new Map();
    // PHP StoreProductDao::getUseEnsureCount uses FIND_IN_SET alone: exact CSV
    // tokens, all product owners, deleted products included, no relation rows.
    const rows = await tx.execute(sql`WITH selected(id) AS (VALUES ${sql.join(ids.map(id => sql`(${id}::integer)`), sql`,`)})
      SELECT selected.id, count(${storeProduct.id})::integer AS product_count
      FROM selected LEFT JOIN ${storeProduct} ON selected.id::text=ANY(string_to_array(${storeProduct.ensureId}, ','))
      GROUP BY selected.id`) as unknown as Array<{ id: number; product_count: number }>;
    if (rows.length !== ids.length || new Set(rows.map(row => row.id)).size !== ids.length
      || rows.some(row => !ids.includes(row.id) || !Number.isSafeInteger(row.product_count) || row.product_count < 0)) {
      throw new Error('商品保障服务使用数量回读不完整');
    }
    return new Map(rows.map(row => [row.id, row.product_count]));
  }

  async list(query: URLSearchParams, actor: AdminProductEnsureActor, legacy = true) {
    const input = listQuery(query);
    return this.transaction(actor, false, async (tx, core) => {
      const result = await core.ensureList(platformEnsureOwner, input);
      if (!legacy) return result;
      const counts = await this.productCounts(tx, result.list.map(row => row.id));
      return { list: result.list.map(row => ({ ...row, add_time: formatParameterSpecTime(row.add_time), product_count: counts.get(row.id)! })), count: result.count };
    });
  }

  /** Existing TS detail extension stays numeric; PHP has no read action. */
  async detail(id: number, query: URLSearchParams, actor: AdminProductEnsureActor, _legacy = true) {
    noQuery(query); id = ensureId(id);
    return this.transaction(actor, false, (_tx, core) => core.ensureDetail(platformEnsureOwner, id));
  }

  private async form(id: number, query: URLSearchParams, actor: AdminProductEnsureActor) {
    noQuery(query);
    return this.transaction(actor, false, async (_tx, core) => {
      const row = id ? await core.ensureDetail(platformEnsureOwner, id) : undefined;
      const required = (message: string) => [{ type: 'string', trigger: 'change', message, required: true }];
      return { title: id ? '编辑保障服务' : '添加保障服务', action: `product/ensure${id ? `/${id}` : ''}`, method: id ? 'PUT' : 'POST',
        rules: [
          { type: 'input', field: 'name', title: '保障服务条款', value: row?.name ?? '',
            props: { type: 'text', maxlength: 100, placeholder: '请输入保障服务条款' }, validate: required('请输入保障服务条款') },
          { type: 'input', field: 'desc', title: '内容描述', value: row?.desc ?? '',
            props: { type: 'textarea', placeholder: '请输入内容描述' }, validate: required('请输入内容描述') },
          { type: 'frame', field: 'image', title: '图标（100 * 100)', value: row?.image ?? '',
            props: { type: 'image', maxLength: 1, src: '/admin/widget.images/index?fodder=image', icon: 'ios-add',
              title: '请选择图标（100 * 100)', width: '960px', height: '505px', modal: { 'footer-hide': true } },
            validate: required('请选择图标(建议尺寸：100px*100px)') },
          { type: 'inputNumber', field: 'sort', title: '排序', value: row?.sort ?? 0,
            props: { min: 0, max: 99999, placeholder: '请输入排序' } },
        ] };
    });
  }

  createForm(query: URLSearchParams, actor: AdminProductEnsureActor, _legacy = true) { return this.form(0, query, actor); }
  editForm(id: number, query: URLSearchParams, actor: AdminProductEnsureActor, _legacy = true) { return this.form(ensureId(id), query, actor); }

  private async receipt(tx: DbClient, id: number): Promise<EnsureRow> {
    const [row] = await tx.select().from(storeProductEnsure).where(eq(storeProductEnsure.id, id)).limit(1);
    if (!row || row.type !== 0 || row.relationId !== 0) throw new Error('商品保障服务业务回执不完整');
    return row;
  }

  private async audit(tx: DbClient, actor: AdminProductEnsureActor, id: number,
    operation: 'create' | 'update' | 'status' | 'delete', status?: 0 | 1): Promise<void> {
    const expected = { adminId: actor.id, path: `product/ensure/${id}`, page: '商品保障服务管理',
      method: operation === 'create' ? 'POST' : operation === 'delete' ? 'DELETE' : 'PUT', type: 'product_ensure_catalog',
      action: JSON.stringify({ operation, id, ...(status === undefined ? {} : { status }) }), addTime: Math.floor(Date.now() / 1000) };
    const rows = await tx.insert(systemLog).values(expected).returning();
    const row = rows[0];
    const matches = (value: typeof row | undefined) => value && Number.isSafeInteger(value.id) && value.id > 0
      && Object.entries(expected).every(([key, expectedValue]) => value[key as keyof typeof value] === expectedValue);
    if (rows.length !== 1 || !matches(row)) throw new Error('商品保障服务审计回执不完整');
    const [readBack] = await tx.select().from(systemLog).where(eq(systemLog.id, row.id)).limit(1);
    if (!matches(readBack)) throw new Error('商品保障服务审计回读不一致');
  }

  private async save(id: number, value: unknown, actor: AdminProductEnsureActor, legacy: boolean) {
    const input = saveInput(id, value);
    return this.transaction(actor, true, async (tx, core) => {
      const result = await core.saveEnsure(platformEnsureOwner, id, input, legacy);
      const savedId = ensureId(result.id);
      if (id && savedId !== id) throw new Error('商品保障服务保存回执ID不一致');
      const receipt = await this.receipt(tx, savedId);
      await this.audit(tx, actor, savedId, id ? 'update' : 'create');
      const [after] = await tx.select().from(storeProductEnsure).where(eq(storeProductEnsure.id, savedId)).limit(1);
      if (!sameStoredRow(after, receipt)) throw new Error('商品保障服务审计后保存核验失败');
      return result;
    });
  }

  create(input: unknown, actor: AdminProductEnsureActor, legacy = true) { return this.save(0, input, actor, legacy); }
  update(id: number, input: unknown, actor: AdminProductEnsureActor, legacy = true) { return this.save(ensureId(id), input, actor, legacy); }

  async setStatus(id: number, value: unknown, query: URLSearchParams, actor: AdminProductEnsureActor, _legacy = true) {
    noQuery(query); id = ensureId(id); const status = ensureStatus(value);
    return this.transaction(actor, true, async (tx, core) => {
      await core.setEnsureStatus(platformEnsureOwner, id, status);
      const receipt = await this.receipt(tx, id);
      if (receipt.status !== status) throw new Error('商品保障服务状态回执不一致');
      await this.audit(tx, actor, id, 'status', status);
      const [after] = await tx.select().from(storeProductEnsure).where(eq(storeProductEnsure.id, id)).limit(1);
      if (!sameStoredRow(after, receipt)) throw new Error('商品保障服务审计后状态核验失败');
      return null;
    });
  }

  async remove(id: number, query: URLSearchParams, actor: AdminProductEnsureActor, _legacy = true) {
    noQuery(query); id = ensureId(id);
    return this.transaction(actor, true, async (tx, core) => {
      await core.deleteEnsure(platformEnsureOwner, id);
      await this.audit(tx, actor, id, 'delete');
      const [after] = await tx.select({ id: storeProductEnsure.id }).from(storeProductEnsure).where(eq(storeProductEnsure.id, id)).limit(1);
      if (after) throw new Error('商品保障服务审计后删除核验失败');
      return null;
    });
  }
}
