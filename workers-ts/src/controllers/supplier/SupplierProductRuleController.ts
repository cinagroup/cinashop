import type { Context, MiddlewareHandler } from 'hono';
import type { AppVariables, Env } from '@/env';
import { extractToken } from '@/middleware/auth';
import { ApiErrorCode, AuthException, ValidateException } from '@/utils/errors';
import { verifyToken } from '@/utils/jwt';
import { jsonOk } from '@/utils/json';
import { readBoundedJsonObject, readBoundedUtf8Text } from '@/utils/request-body';
import { SupplierProductRuleService } from '@/services/supplier/SupplierProductRuleService';
import { supplierRuleId, supplierRuleNoQuery } from '@/services/supplier/SupplierProductRuleInput';
type App = { Bindings: Env; Variables: AppVariables };
type C = Context<App>;
export const privateResponse: MiddlewareHandler<App> = async (c, next) => {
  c.header('Cache-Control', 'private, no-store, max-age=0'); c.header('Pragma', 'no-cache'); await next();
};
function service(c: C) { return new SupplierProductRuleService(c.get('container')); }
function supplier(c: C) { const id = c.get('supplierId'); if (!id) throw new AuthException(); return id; }
async function actor(c: C) {
  const token = extractToken(c); if (!token) throw new AuthException();
  const identity = c.get('supplierAdminInfo'); if (!identity) throw new AuthException();
  let claims: Awaited<ReturnType<typeof verifyToken>>;
  try { claims = await verifyToken(token, c.env.APP_KEY); } catch { throw new AuthException('登录已过期', ApiErrorCode.ERR_EXPIRED); }
  if (claims.type !== 'supplier' || claims.id !== identity.id || !claims.auth) throw new AuthException('供应商会话无效', ApiErrorCode.ERR_AUTH);
  return { id: claims.id, authVersion: claims.auth, expiresAt: claims.exp, ip: (c.req.header('CF-Connecting-IP') ?? '').slice(0, 45) };
}
export async function list(c: C) { return jsonOk(c, await service(c).list(supplier(c), new URL(c.req.url).searchParams, await actor(c))); }
export async function templates(c: C) { return jsonOk(c, await service(c).templates(supplier(c), new URL(c.req.url).searchParams, await actor(c))); }
export async function detail(c: C) { return jsonOk(c, await service(c).detail(supplier(c), supplierRuleId(c.req.param('id')), new URL(c.req.url).searchParams, await actor(c))); }
export async function save(c: C) {
  supplierRuleNoQuery(new URL(c.req.url).searchParams);
  return jsonOk(c, await service(c).save(supplier(c), supplierRuleId(c.req.param('id'), true), await readBoundedJsonObject(c.req.raw, 49_152), await actor(c)));
}
export async function remove(c: C) {
  supplierRuleNoQuery(new URL(c.req.url).searchParams); const text = await readBoundedUtf8Text(c.req.raw, 1_024);
  let body: unknown; if (text.trim()) { try { body = JSON.parse(text); } catch { throw new ValidateException('规格模板删除数据格式错误'); } }
  return jsonOk(c, await service(c).delete(supplier(c), supplierRuleId(c.req.param('id')), body, await actor(c)));
}
