import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { SupplierProductCopyService } from '@/services/supplier/SupplierProductCopyService';
import { supplierCopyId } from '@/services/supplier/SupplierProductCopySource';
import { categoryActor } from './SupplierProductCategoryController';
import { readAdminLegacyProductBody } from '@/services/admin/AdminLegacyProductInput';
import { OrderOutboxService } from '@/services/order/OrderOutboxService';
import { jsonOk } from '@/utils/json';
import { ValidateException } from '@/utils/errors';
type C=Context<{Bindings:Env;Variables:AppVariables}>;
function context(c:C){
  if(new URL(c.req.url).search)throw new ValidateException('商品复制不接受查询参数');
  c.header('Cache-Control','private, no-store');c.header('Pragma','no-cache');
  const container=c.get('container');
  return new SupplierProductCopyService(container,c.env.APP_KEY,{dispatch:async id=>{await new OrderOutboxService(container,c.env).dispatchPending(1,id);}});
}
async function actor(c:C){const supplierId=c.get('supplierId');if(!supplierId)throw new ValidateException('供应商身份无效');return {...await categoryActor(c),supplierId};}
export async function seed(c:C){const service=context(c);return jsonOk(c,await service.seed(supplierCopyId(c.req.param('id')),await actor(c)));}
export async function save(c:C){const service=context(c);return jsonOk(c,await service.save(supplierCopyId(c.req.param('id')),await readAdminLegacyProductBody(c.req.raw),await actor(c)),'商品复制成功，等待平台审核');}
export async function receipt(c:C){const service=context(c);return jsonOk(c,await service.receipt(c.req.param('operationId')??'',await actor(c)));}
export async function resolve(c:C){
  const service=context(c),body=await readAdminLegacyProductBody(c.req.raw);
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==1||!Object.hasOwn(body,'source_id'))throw new ValidateException('复制恢复仅接受原来源ID');
  return jsonOk(c,await service.resolve(c.req.param('operationId')??'',supplierCopyId((body as Record<string,unknown>).source_id),await actor(c)));
}
