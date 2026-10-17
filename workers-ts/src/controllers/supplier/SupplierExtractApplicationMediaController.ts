import type {Context,MiddlewareHandler} from 'hono';
import type {AppVariables,Env} from '@/env';
import {ValidateException} from '@/utils/errors';
import {jsonOk} from '@/utils/json';
import {parseSupplierExtractApplicationMediaQuery,SupplierExtractApplicationMediaService} from '@/services/supplier/SupplierExtractApplicationMediaService';
import {categoryActor} from './SupplierProductCategoryController';
type C=Context<{Bindings:Env;Variables:AppVariables}>;
export const privateResponse:MiddlewareHandler<{Bindings:Env;Variables:AppVariables}>=async(c,next)=>{
 c.header('Cache-Control','private, no-store, max-age=0');c.header('Pragma','no-cache');await next();
};
export async function read(c:C){
 const requestHash=parseSupplierExtractApplicationMediaQuery(c.req.queries()),supplierId=c.get('supplierId');
 if(!supplierId)throw new ValidateException('供应商身份无效');
 return jsonOk(c,await new SupplierExtractApplicationMediaService(c.get('container'),c.env.APP_KEY)
  .read({...await categoryActor(c),supplierId},c.req.param('operationId')??'',requestHash));
}
