import type {Context,MiddlewareHandler} from 'hono';
import type {AppVariables,Env} from '@/env';
import {categoryActor} from './SupplierProductCategoryController';
import {SupplierExtractApplicationService} from '@/services/supplier/SupplierExtractApplicationService';
import {extractRecord} from '@/services/supplier/SupplierExtractApplicationInput';
import {ValidateException} from '@/utils/errors';
import {readBoundedJsonObject} from '@/utils/request-body';
import {jsonOk} from '@/utils/json';
type C=Context<{Bindings:Env;Variables:AppVariables}>;
export const privateResponse:MiddlewareHandler<{Bindings:Env;Variables:AppVariables}>=async(c,next)=>{c.header('Cache-Control','private, no-store, max-age=0');c.header('Pragma','no-cache');await next();};
function service(c:C){if(new URL(c.req.url).search)throw new ValidateException('提现申请及原操作不接受查询参数');return new SupplierExtractApplicationService(c.get('container'),c.env.APP_KEY);}
async function actor(c:C){const supplierId=c.get('supplierId');if(!supplierId)throw new ValidateException('供应商身份无效');return{...await categoryActor(c),supplierId};}
export async function seed(c:C){return jsonOk(c,await service(c).seed(await actor(c)));}
export async function execute(c:C){const instance=service(c);return jsonOk(c,await instance.execute(await readBoundedJsonObject(c.req.raw,4096),await actor(c)),'原提现申请已核对');}
export async function receipt(c:C){return jsonOk(c,await service(c).receipt(c.req.param('operationId')??'',await actor(c)));}
export async function resolve(c:C){const instance=service(c);extractRecord(await readBoundedJsonObject(c.req.raw,2048),[]);return jsonOk(c,await instance.resolve(c.req.param('operationId')??'',await actor(c)));}
