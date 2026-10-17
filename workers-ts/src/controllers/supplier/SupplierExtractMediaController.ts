import type {Context,MiddlewareHandler} from 'hono';
import type {AppVariables,Env} from '@/env';
import {ValidateException} from '@/utils/errors';
import {jsonOk} from '@/utils/json';
import {parseSupplierExtractMediaQuery,SupplierExtractMediaService} from '@/services/supplier/SupplierExtractMediaService';
import {categoryActor} from './SupplierProductCategoryController';
type C=Context<{Bindings:Env;Variables:AppVariables}>;
export const privateResponse:MiddlewareHandler<{Bindings:Env;Variables:AppVariables}>=async(c,next)=>{c.header('Cache-Control','private, no-store, max-age=0');c.header('Pragma','no-cache');await next();};
export async function read(c:C){
 const raw=c.req.param('id')??'',id=Number(raw);if(!/^[1-9]\d{0,9}$/.test(raw)||!Number.isSafeInteger(id)||id>2147483647)throw new ValidateException('提现记录ID无效');
 const revision=parseSupplierExtractMediaQuery(c.req.queries()),supplierId=c.get('supplierId');if(!supplierId)throw new ValidateException('供应商身份无效');
 return jsonOk(c,await new SupplierExtractMediaService(c.get('container'),c.env.APP_KEY).read({...await categoryActor(c),supplierId},id,revision));
}
