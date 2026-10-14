import { eq, sql } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { systemAdmin, systemLog } from '@/models/schema';
import { ApiErrorCode, AuthException, HttpApiException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { md5 } from '@/utils/jwt';
import { ProductMetadataService } from '@/services/product/ProductMetadataService';
import { acquireAdminAuthorityWriteBarrier, assertAdminAuthoritySession, type AdminAuthorityActor } from './AdminAuthorityWriteService';
import { AdminPermissionService, hasAdminPermission } from './AdminPermissionService';

export type AdminProductUnitActor = AdminAuthorityActor;
const owner = { type: 0, relationId: 0 } as const;

export function unitId(value: unknown, zero = false): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < (zero ? 0 : 1) || parsed > 2_147_483_647) throw new ValidateException('商品单位ID错误');
  return parsed;
}
function noQuery(query: URLSearchParams) { if (query.size) throw new ValidateException('此单位操作不接受查询参数'); }
function unitQuery(query: URLSearchParams): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of query) {
    if (!['name', 'page', 'limit'].includes(key) || key in result) throw new ValidateException('单位查询参数错误');
    result[key] = value;
  }
  if (result.name && ([...result.name].length > 50 || /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(result.name))) throw new ValidateException('单位查询名称错误');
  for (const key of ['page', 'limit']) if (result[key] !== undefined) unitId(result[key]);
  return result;
}

export class AdminProductUnitService {
  constructor(private readonly container: Container) {}
  private async transaction<T>(actor: AdminProductUnitActor, write: boolean, work: (tx: DbClient, metadata: ProductMetadataService) => Promise<T>): Promise<T> {
    assertAdminAuthoritySession(actor);
    try {
      return await withTx(this.container, async tx => {
        if (write) await acquireAdminAuthorityWriteBarrier(tx);
        else await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
        await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
        await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
        await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5s'`);
        const [live] = await tx.select().from(systemAdmin).where(eq(systemAdmin.id, actor.id)).limit(1);
        if (!live || live.adminType !== 1 || live.relationId !== 0 || live.status !== 1 || live.isDel !== 0
          || !Number.isInteger(live.level) || live.level < 0 || live.level > 9) throw new AuthException('管理员身份已变化', ApiErrorCode.ERR_BANNED);
        const encoder = new TextEncoder();
        if (!timingSafeEqual(encoder.encode(md5(live.pwd)), encoder.encode(actor.authVersion))) throw new AuthException('登录凭据已变化', ApiErrorCode.ERR_EXPIRED);
        const permissions = new AdminPermissionService(createContainerFromDb(tx));
        if (live.level !== 0) {
          const { keys } = await permissions.resolveRoleAssignment(live.roles, write);
          if (!hasAdminPermission(keys, write ? 'product.manage' : 'product.view')) throw new AuthException('商品单位权限已变化', ApiErrorCode.ERR_AUTH);
        }
        assertAdminAuthoritySession(actor);
        const result = await work(tx, new ProductMetadataService(createContainerFromDb(tx)));
        // Recheck after business lock waits, including the database wall clock.
        const [clock] = await tx.execute(sql`SELECT extract(epoch from clock_timestamp()) >= ${actor.expiresAt} AS expired`) as unknown as Array<{ expired: boolean }>;
        if (clock?.expired !== false) throw new AuthException('登录已过期', ApiErrorCode.ERR_EXPIRED);
        assertAdminAuthoritySession(actor);
        if (write) {
          const [fresh] = await tx.select().from(systemAdmin).where(eq(systemAdmin.id, actor.id)).limit(1);
          if (JSON.stringify(fresh) !== JSON.stringify(live)) throw new AuthException('管理员身份已变化', ApiErrorCode.ERR_AUTH);
          if (fresh.level !== 0) {
            const { keys } = await permissions.resolveRoleAssignment(fresh.roles, true);
            if (!hasAdminPermission(keys, 'product.manage')) throw new AuthException('商品单位权限已变化', ApiErrorCode.ERR_AUTH);
          }
        }
        return result;
      });
    } catch (error) {
      let cause: unknown = error;
      for (let depth = 0; depth < 6 && cause && typeof cause === 'object'; depth++) {
        const code = 'code' in cause ? String(cause.code) : '';
        if (['55P03', '40P01', '40001'].includes(code)) throw Object.assign(new HttpApiException('单位、商品或管理员权限正在更新，请刷新后重试', 409, 409), { cause: error });
        if (['42501', '57014'].includes(code)) throw Object.assign(new ServiceUnavailableException('单位运行权限配置未就绪或操作超时'), { cause: error });
        cause = 'cause' in cause ? cause.cause : undefined;
      }
      throw error;
    }
  }
  async all(query: URLSearchParams, actor: AdminProductUnitActor) {
    noQuery(query);
    return this.transaction(actor, false, (_tx, metadata) => metadata.allUnits(owner));
  }
  async list(query: URLSearchParams, actor: AdminProductUnitActor) {
    const input = unitQuery(query);
    return this.transaction(actor, false, (_tx, metadata) => metadata.unitList(owner, input));
  }
  async detail(id: number, query: URLSearchParams, actor: AdminProductUnitActor) {
    noQuery(query); id = unitId(id);
    return this.transaction(actor, false, (_tx, metadata) => metadata.unitDetail(owner, id));
  }
  async form(id: number, query: URLSearchParams, actor: AdminProductUnitActor) {
    noQuery(query); id = unitId(id, true);
    return this.transaction(actor, false, async (_tx, metadata) => {
      const row = id ? await metadata.unitDetail(owner, id) : undefined;
      return {
        title: id ? '编辑商品单位' : '添加商品单位', action: `product/unit${id ? `/${id}` : ''}`, method: id ? 'PUT' : 'POST',
        rules: [
          { type: 'input', field: 'name', title: '单位名称', value: row?.name ?? '', props: { maxlength: 15 }, validate: [{ required: true, message: '请填写单位名称', trigger: 'blur' }] },
          { type: 'inputNumber', field: 'sort', title: '排序', value: row?.sort ?? 0, props: { min: 0, max: 32767 } },
        ],
      };
    });
  }
  private async audit(tx: DbClient, actor: AdminProductUnitActor, id: number, method: 'POST' | 'PUT' | 'DELETE') {
    const action = JSON.stringify({ operation: method === 'DELETE' ? 'delete' : method === 'POST' ? 'create' : 'save', id });
    const rows = await tx.insert(systemLog).values({ adminId: actor.id, path: `product/unit/${id}`, page: '商品单位管理', method,
      type: 'product_unit_catalog', action, addTime: Math.floor(Date.now() / 1000) }).returning();
    const row = rows[0];
    if (rows.length !== 1 || !row || row.id <= 0 || row.adminId !== actor.id || row.method !== method || row.type !== 'product_unit_catalog' || row.action !== action) throw Error('商品单位审计回执不完整');
  }
  async save(id: number, input: unknown, actor: AdminProductUnitActor) {
    id = unitId(id, true);
    return this.transaction(actor, true, async (tx, metadata) => {
      const result = await metadata.saveUnit(owner, id, input);
      await this.audit(tx, actor, result.id, id ? 'PUT' : 'POST');
      return result;
    });
  }
  async remove(id: number, query: URLSearchParams, actor: AdminProductUnitActor) {
    noQuery(query); id = unitId(id);
    return this.transaction(actor, true, async (tx, metadata) => {
      await metadata.deleteUnit(owner, id);
      await this.audit(tx, actor, id, 'DELETE');
      return { id };
    });
  }
}
