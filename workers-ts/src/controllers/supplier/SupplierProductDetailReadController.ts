import type {Context} from 'hono';
import type {AppVariables,Env} from '@/env';
import {jsonOk} from '@/utils/json';
import {ValidateException} from '@/utils/errors';
import {categoryActor} from './SupplierProductCategoryController';
import {assertSupplierProductDetailQuery,supplierProductDetailId,SupplierProductDetailReadService} from '@/services/supplier/SupplierProductDetailReadService';
type C=Context<{Bindings:Env;Variables:AppVariables}>;
export async function read(c:C){
 assertSupplierProductDetailQuery(c.req.queries());const supplierId=c.get('supplierId');
 if(!supplierId)throw new ValidateException('供应商身份无效');
 return jsonOk(c,await new SupplierProductDetailReadService(c.get('container'),c.env.APP_KEY)
  .read({...await categoryActor(c),supplierId},supplierProductDetailId(c.req.param('id'))));
}
