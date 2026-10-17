import type {Context,MiddlewareHandler} from 'hono';
import type {AppVariables,Env} from '@/env';
import {ValidateException} from '@/utils/errors';
import {jsonOk} from '@/utils/json';
import {readBoundedJsonObject} from '@/utils/request-body';
import {SupplierFinanceAccountsService} from '@/services/supplier/SupplierFinanceAccountsService';
import {categoryActor} from './SupplierProductCategoryController';
type C=Context<{Bindings:Env;Variables:AppVariables}>;
export const privateResponse:MiddlewareHandler<{Bindings:Env;Variables:AppVariables}>=async(c,next)=>{c.header('Cache-Control','private, no-store, max-age=0');c.header('Pragma','no-cache');await next();};
function modern(c:C){const query=c.req.queries(),keys=Object.keys(query);if(!keys.length)return false;if(keys.length!==1||keys[0]!=='selection'||query.selection?.length!==1||query.selection[0]!=='accounts')throw new ValidateException('收款设置查询参数无效');return true;}
function service(c:C){return new SupplierFinanceAccountsService(c.get('container'),c.env.APP_KEY);}
async function actor(c:C){const supplierId=c.get('supplierId');if(!supplierId)throw new ValidateException('供应商身份无效');return{...await categoryActor(c),supplierId};}
export async function info(c:C){const selected=modern(c),principal=await actor(c),instance=service(c);return jsonOk(c,selected?await instance.context(principal):await instance.legacy(principal));}
export async function update(c:C){const selected=modern(c),principal=await actor(c);return jsonOk(c,await service(c).save(await readBoundedJsonObject(c.req.raw,16*1024),principal,selected),'当前收款设置已核对');}
