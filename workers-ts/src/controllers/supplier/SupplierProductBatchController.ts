import type { Context, MiddlewareHandler } from 'hono';
import type { AppVariables, Env } from '@/env';
import { extractToken } from '@/middleware/auth';
import { ApiErrorCode, AuthException, ValidateException } from '@/utils/errors';
import { verifyToken } from '@/utils/jwt';
import { jsonOk } from '@/utils/json';
import { readBoundedJsonObject } from '@/utils/request-body';
import { SupplierProductBatchService } from '@/services/supplier/SupplierProductBatchService';
import { supplierSingleQuery } from '@/services/supplier/SupplierReadSupport';

type App = { Bindings: Env; Variables: AppVariables }; type C = Context<App>;
export const privateResponse: MiddlewareHandler<App> = async (c, next) => {
  c.header('Cache-Control', 'private, no-store, max-age=0'); c.header('Pragma', 'no-cache'); await next();
};
function service(c: C) { return new SupplierProductBatchService(c.get('container')); }
function supplier(c: C) { const id = c.get('supplierId'); if (!id) throw new AuthException(); return id; }
async function actor(c: C) {
  const token = extractToken(c); if (!token) throw new AuthException();
  const value = c.get('supplierAdminInfo'); if (!value) throw new AuthException();
  let claims: Awaited<ReturnType<typeof verifyToken>>;
  try { claims = await verifyToken(token, c.env.APP_KEY); } catch { throw new AuthException('登录已过期', ApiErrorCode.ERR_EXPIRED); }
  if (claims.type !== 'supplier' || claims.id !== value.id || !claims.auth) throw new AuthException('供应商会话无效', ApiErrorCode.ERR_AUTH);
  return { id: claims.id, authVersion: claims.auth, expiresAt: claims.exp, ip: (c.req.header('CF-Connecting-IP') ?? '').slice(0, 45) };
}
export async function selection(c: C) {
  const query = supplierSingleQuery(c.req.queries());
  if (Object.keys(query).some(key => !['ids', 'all', 'where'].includes(key))) throw new ValidateException('批处理查询字段错误');
  if ((query.ids?.length ?? 0) > 1200 || (query.where?.length ?? 0) > 8192) throw new ValidateException('批处理查询过大');
  let where: unknown;
  try { where = query.where ? JSON.parse(query.where) : {}; } catch { throw new ValidateException('筛选条件须为有效JSON'); }
  return jsonOk(c, await service(c).selection(supplier(c), { ids: query.ids, all: query.all, where }, await actor(c)));
}
export async function apply(c: C) {
  return jsonOk(c, await service(c).apply(supplier(c), await readBoundedJsonObject(c.req.raw, 16 * 1024), await actor(c)), '批处理已完成并核对');
}
