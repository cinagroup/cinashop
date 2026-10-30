import type {Context} from 'hono';
import type {AppVariables,Env} from '@/env';
import {jsonOk} from '@/utils/json';
import {readBoundedJsonObject} from '@/utils/request-body';
import {AdminRuleAuthorService} from '@/services/admin/AdminRuleAuthorService';
import {ruleQuery} from '@/services/admin/AdminRuleAuthorInput';
type C=Context<{Bindings:Env;Variables:AppVariables}>;
function context(c:C){
  c.header('Cache-Control','private, no-store');c.header('Pragma','no-cache');
  return {service:new AdminRuleAuthorService(c.get('container')),actor:{id:c.get('adminId')??0,authVersion:c.get('socketAuthVersion')??'',expiresAt:c.get('socketTokenExp')??0},query:new URL(c.req.url).searchParams};
}
export const catalog=async(c:C)=>{const x=context(c);return jsonOk(c,await x.service.catalog(x.query,x.actor));};
export const receipt=async(c:C)=>{const x=context(c);return jsonOk(c,await x.service.receipt(c.req.param('operationId'),x.query,x.actor));};
export const commit=async(c:C)=>{const x=context(c);ruleQuery(x.query);return jsonOk(c,await x.service.mutate(await readBoundedJsonObject(c.req.raw,64*1024),x.actor));};
export const resolve=async(c:C)=>{const x=context(c);ruleQuery(x.query);return jsonOk(c,await x.service.resolve(await readBoundedJsonObject(c.req.raw,64*1024),x.actor));};
