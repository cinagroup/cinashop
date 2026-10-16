import type {Context,MiddlewareHandler} from 'hono';
import type {AppVariables,Env} from '@/env';
import {categoryActor} from './SupplierProductCategoryController';
import {SupplierProactiveRefundService} from '@/services/supplier/SupplierProactiveRefundService';
import {supplierProactiveRefundId} from '@/services/supplier/SupplierProactiveRefundInput';
import {readSupplierOrderEditBody} from '@/services/supplier/SupplierUnpaidOrderEditInput';
import {ValidateException} from '@/utils/errors';
import {jsonOk} from '@/utils/json';
type C=Context<{Bindings:Env;Variables:AppVariables}>;
export const privateResponse:MiddlewareHandler<{Bindings:Env;Variables:AppVariables}>=async(c,next)=>{
 c.header('Cache-Control','private, no-store');c.header('Pragma','no-cache');await next();
};
function service(c:C) {
 if(new URL(c.req.url).search)throw new ValidateException('主动退款不接受查询参数');
 return new SupplierProactiveRefundService(c.get('container'),c.env.APP_KEY,c.env);
}
async function actor(c:C) {
 const supplierId=c.get('supplierId');if(!supplierId)throw new ValidateException('供应商身份无效');
 return{...await categoryActor(c),supplierId};
}
export async function seed(c:C){return jsonOk(c,await service(c).seed(supplierProactiveRefundId(c.req.param('id')),await actor(c)));}
export async function execute(c:C){return jsonOk(c,await service(c).execute(supplierProactiveRefundId(c.req.param('id')),await readSupplierOrderEditBody(c.req.raw),await actor(c)),'主动退款处理完成');}
export async function receipt(c:C){return jsonOk(c,await service(c).receipt(c.req.param('operationId')??'',await actor(c)));}
export async function resolve(c:C){
 const instance=service(c),body=await readSupplierOrderEditBody(c.req.raw);
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==1||!Object.hasOwn(body,'order_id'))throw new ValidateException('主动退款恢复仅接受原订单ID');
 return jsonOk(c,await instance.resolve(c.req.param('operationId')??'',supplierProactiveRefundId((body as Record<string,unknown>).order_id),await actor(c)));
}
