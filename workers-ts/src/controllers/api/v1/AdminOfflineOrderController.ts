import type { Context, MiddlewareHandler } from 'hono';
import type { AppVariables, Env } from '@/env';
import { ApiException, AuthException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
import { adminOfflineId, listAdminOfflineOrders, readAdminOfflineOrder } from '@/services/admin/AdminOfflineOrderReadService';
import { readAdminOfflineScan } from '@/services/admin/AdminOfflineScanService';
import { offlineScanType } from '@/services/order/OfflineScanCode';
type E = { Bindings: Env; Variables: AppVariables };
type C = Context<E>;
export const privateResponse: MiddlewareHandler<E> = async (c, next) => {
  c.header('Cache-Control', 'private, no-store, max-age=0');
  c.header('Pragma', 'no-cache');
  await next();
};
function actor(c: C) {
  const id = c.get('adminId');
  if (!id || id !== c.get('adminInfo')?.id || id !== c.get('socketAuthId')) throw new AuthException('请重新登录');
  return { id, authVersion: c.get('socketAuthVersion') ?? '', expiresAt: c.get('socketTokenExp') ?? 0 };
}
async function available<T>(work: () => Promise<T>) {
  try { return await work(); } catch (error) {
    if (error instanceof ApiException) throw error;
    let cause: unknown = error;
    for (let i = 0; i < 8 && cause && typeof cause === 'object'; i++) {
      if ('code' in cause && ['57014', '55P03'].includes(String(cause.code))) {
        throw new ServiceUnavailableException('线下消费查询繁忙或超时，请缩小范围后重试');
      }
      if ('code' in cause && ['42P01', '42703', '42883', '42501'].includes(String(cause.code))) {
        throw new ServiceUnavailableException('线下消费查询尚未就绪，请联系管理员核验安装和权限');
      }
      if (!('cause' in cause) || cause.cause === cause) break;
      cause = cause.cause;
    }
    throw error;
  }
}
export async function list(c: C) {
  const principal = actor(c), url = new URL(c.req.url), keys = [...url.searchParams.keys()];
  if (url.search.length > 1200 || new Set(keys).size !== keys.length) throw new ValidateException('线下消费查询参数过长或重复');
  return jsonOk(c, await available(() => listAdminOfflineOrders(c.get('container'), principal, Object.fromEntries(url.searchParams))));
}
export async function detail(c: C) {
  const principal = actor(c);
  if (new URL(c.req.url).search) throw new ValidateException('消费详情不接受查询覆盖');
  return jsonOk(c, await available(() => readAdminOfflineOrder(c.get('container'), principal, adminOfflineId(c.req.param('id')))));
}
export async function scan(c: C) {
  const principal = actor(c), type = offlineScanType(new URL(c.req.url));
  return jsonOk(c, await available(() => readAdminOfflineScan(c.get('container'), c.env, principal, type)));
}
