import type { Context, MiddlewareHandler } from 'hono';
import type { AppVariables, Env } from '@/env';
import { categoryActor } from './SupplierProductCategoryController';
import { SupplierOrderTrackingService, assertSupplierTrackingQuery, supplierTrackingId } from '@/services/supplier/SupplierOrderTrackingService';
import { ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
type App = { Bindings: Env; Variables: AppVariables };
export const privateResponse: MiddlewareHandler<App> = async (c, next) => {
  c.header('Cache-Control', 'private, no-store, max-age=0'); c.header('Pragma', 'no-cache'); await next();
};
export async function read(c: Context<App>) {
  assertSupplierTrackingQuery(c.req.queries()); const id = supplierTrackingId(c.req.param('id')), supplierId = c.get('supplierId');
  if (!supplierId) throw new ValidateException('供应商身份无效');
  return jsonOk(c, await new SupplierOrderTrackingService(c.get('container'), c.env).read({ ...await categoryActor(c), supplierId }, id));
}
