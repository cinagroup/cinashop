import type { Context } from 'hono';
import type { AppVariables,Env } from '@/env';
import { categoryActor } from './SupplierProductCategoryController';
import { SupplierManualRefundService } from '@/services/supplier/SupplierManualRefundService';
import { supplierManualRefundId,supplierManualRefundRecord } from '@/services/supplier/SupplierManualRefundInput';
import { readSupplierOrderEditBody } from '@/services/supplier/SupplierUnpaidOrderEditInput';
import { ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
type C=Context<{Bindings:Env;Variables:AppVariables}>;
function service(c:C) {
  if(new URL(c.req.url).search)throw new ValidateException('现金退款不接受查询参数');
  c.header('Cache-Control','private, no-store');c.header('Pragma','no-cache');
  return new SupplierManualRefundService(c.get('container'),c.env.APP_KEY,c.env);
}
async function actor(c:C) {
  const supplierId=c.get('supplierId');if(!supplierId)throw new ValidateException('供应商身份无效');
  return{...await categoryActor(c),supplierId};
}
export async function seed(c:C){return jsonOk(c,await service(c).seed(supplierManualRefundId(c.req.param('id')),await actor(c)));}
export async function execute(c:C){return jsonOk(c,await service(c).execute(supplierManualRefundId(c.req.param('id')),await readSupplierOrderEditBody(c.req.raw),await actor(c)),'现金退款完成');}
export async function receipt(c:C){return jsonOk(c,await service(c).receipt(c.req.param('operationId')??'',await actor(c)));}
export async function resolve(c:C){
  const instance=service(c),body=supplierManualRefundRecord(await readSupplierOrderEditBody(c.req.raw));
  if(Object.keys(body).length!==1||!Object.hasOwn(body,'refund_id'))throw new ValidateException('现金退款恢复仅接受原售后ID');
  return jsonOk(c,await instance.resolve(c.req.param('operationId')??'',supplierManualRefundId(body.refund_id),await actor(c)));
}
