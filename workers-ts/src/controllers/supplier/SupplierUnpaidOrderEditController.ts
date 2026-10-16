import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { categoryActor } from './SupplierProductCategoryController';
import { SupplierUnpaidOrderEditService } from '@/services/supplier/SupplierUnpaidOrderEditService';
import { readSupplierOrderEditBody, supplierOrderEditId } from '@/services/supplier/SupplierUnpaidOrderEditInput';
import { OrderOutboxService } from '@/services/order/OrderOutboxService';
import { ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
type C = Context<{ Bindings: Env; Variables: AppVariables }>;
function service(c: C) {
  if (new URL(c.req.url).search) throw new ValidateException('订单编辑不接受查询参数');
  c.header('Cache-Control', 'private, no-store'); c.header('Pragma', 'no-cache');
  const container = c.get('container');
  return new SupplierUnpaidOrderEditService(container, c.env.APP_KEY,
    { dispatch: async id => { await new OrderOutboxService(container, c.env).dispatchPending(1, id); } });
}
async function actor(c: C) {
  const supplierId = c.get('supplierId'); if (!supplierId) throw new ValidateException('供应商身份无效');
  return { ...await categoryActor(c), supplierId };
}
export async function seed(c: C) { return jsonOk(c, await service(c).seed(supplierOrderEditId(c.req.param('id')), await actor(c))); }
export async function save(c: C) { return jsonOk(c, await service(c).save(supplierOrderEditId(c.req.param('id')), await readSupplierOrderEditBody(c.req.raw), await actor(c)), '订单修改成功'); }
export async function receipt(c: C) { return jsonOk(c, await service(c).receipt(c.req.param('operationId') ?? '', await actor(c))); }
export async function resolve(c: C) {
  const instance = service(c), body = await readSupplierOrderEditBody(c.req.raw);
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'order_id'))
    throw new ValidateException('订单编辑恢复仅接受原订单ID');
  return jsonOk(c, await instance.resolve(c.req.param('operationId') ?? '', supplierOrderEditId((body as Record<string, unknown>).order_id), await actor(c)));
}
