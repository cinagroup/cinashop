import type { Context, MiddlewareHandler } from 'hono';
import type { AppVariables, Env } from '@/env';
import { SupplierProductRecycleService, supplierRecycleId, supplierRecycleOptions } from '@/services/supplier/SupplierProductRecycleService';
import { categoryActor } from './SupplierProductCategoryController';
import { jsonOk } from '@/utils/json';
import { readBoundedUtf8Text } from '@/utils/request-body';
import { ValidateException } from '@/utils/errors';
type App = { Bindings: Env; Variables: AppVariables };
type C = Context<App>;
export const privateResponse: MiddlewareHandler<App> = async (c, next) => {
  c.header('Cache-Control', 'private, no-store, max-age=0'); c.header('Pragma', 'no-cache'); await next();
};
async function actor(c: C) {
  const supplierId = c.get('supplierId'); if (!supplierId) throw Error('Supplier authentication context missing');
  return { ...await categoryActor(c), supplierId };
}
function service(c: C) { return new SupplierProductRecycleService(c.get('container')); }
export async function list(c: C) { return jsonOk(c, await service(c).list(new URL(c.req.url).searchParams, await actor(c))); }
export async function header(c: C) { return jsonOk(c, await service(c).header(new URL(c.req.url).searchParams, await actor(c))); }
async function options(c: C, thorough: boolean) {
  if (new URL(c.req.url).search) throw new ValidateException('商品回收写入不接受查询参数');
  const text = await readBoundedUtf8Text(c.req.raw, 1024);
  // Only one optional scalar is accepted; duplicate JSON keys cannot silently
  // choose a different toggle state through JSON.parse's last-key behavior.
  if (text.trim() && !/^\s*\{\s*(?:"expected_is_del"\s*:\s*[01]\s*)?\}\s*$/.test(text)) throw new ValidateException('商品回收参数未知、重复或格式错误');
  return supplierRecycleOptions(text.trim() ? JSON.parse(text) : {}, thorough);
}
export async function change(c: C) {
  const result = await service(c).change(supplierRecycleId(c.req.param('id')), await actor(c), await options(c, false));
  return jsonOk(c, result, result.operation === 'restore' ? '成功恢复商品' : '成功移到回收站');
}
export async function thorough(c: C) {
  return jsonOk(c, await service(c).thorough(supplierRecycleId(c.req.param('id')), await actor(c), await options(c, true)), '删除成功');
}
