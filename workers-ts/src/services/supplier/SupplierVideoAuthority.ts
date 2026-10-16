import { and, eq, sql } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import type { DbClient } from '@/lib/di';
import { systemAdmin, systemSupplier } from '@/models/schema';
import { ApiErrorCode, AuthException, HttpApiException, ServiceUnavailableException } from '@/utils/errors';
import { md5 } from '@/utils/jwt';
import { SupplierPermissionService } from './SupplierPermissionService';

export interface SupplierVideoActor { id: number; supplierId: number; authVersion: string; expiresAt: number }
/** Caller holds the real authority table barrier. Repeated after every storage
 * stage, so a login, tenant or role change cannot publish a stale reservation. */
export async function assertSupplierVideoAuthority(db: DbClient, actor: SupplierVideoActor, capability: string | null) {
  const id = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
  if (!actor || !id(actor.id) || !id(actor.supplierId) || typeof actor.authVersion !== 'string'
    || !/^[a-f0-9]{32}$/.test(actor.authVersion) || !Number.isSafeInteger(actor.expiresAt)) throw new AuthException('请重新登录', ApiErrorCode.ERR_LOGIN);
  const [clock] = await db.execute(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::integer AS now`);
  if (Number(clock?.now) >= actor.expiresAt) throw new AuthException('登录已过期', ApiErrorCode.ERR_EXPIRED);
  const [admin] = await db.select().from(systemAdmin).where(and(eq(systemAdmin.id, actor.id), eq(systemAdmin.adminType, 4),
    eq(systemAdmin.relationId, actor.supplierId), eq(systemAdmin.status, 1), eq(systemAdmin.isDel, 0))).limit(1);
  const [supplier] = await db.select().from(systemSupplier).where(and(eq(systemSupplier.id, actor.supplierId),
    eq(systemSupplier.isShow, 1), eq(systemSupplier.isDel, 0))).limit(1);
  if (!admin || !supplier) throw new AuthException('供应商身份已变化', ApiErrorCode.ERR_BANNED);
  if (!timingSafeEqual(new TextEncoder().encode(md5(admin.pwd)), new TextEncoder().encode(actor.authVersion)))
    throw new AuthException('登录凭据已变化', ApiErrorCode.ERR_EXPIRED);
  if (capability) {
    const granted = await new SupplierPermissionService(db).permissionsFor({ id: admin.id, roles: admin.roles, isPrimary: supplier.adminId === admin.id }, supplier.id);
    if (!granted.has(capability)) throw new AuthException('暂时没有权限访问', ApiErrorCode.ERR_AUTH);
  }
}
export function supplierVideoWriteError(error: unknown): never {
  let cause = error;
  for (let depth = 0; depth < 6 && cause && typeof cause === 'object'; depth++) {
    const code = 'code' in cause ? String(cause.code) : '';
    if (['55P03', '40P01', '40001'].includes(code)) throw new HttpApiException('供应商视频或权限正在变化，请查询原结果', 409, 409);
    if (code === '57014') throw new ServiceUnavailableException('供应商视频操作超时，请查询原结果');
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  throw error;
}
