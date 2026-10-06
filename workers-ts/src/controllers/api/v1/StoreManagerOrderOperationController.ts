import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { md5 } from '@/utils/jwt';
import { ValidateException, AuthException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
import { readBoundedUtf8Text } from '@/utils/request-body';
import { ManagerOrderOperationRequest, managerActor, type ManagerOperationContext, type ManagerOperationInput, type ManagerOperationKind } from '@/services/store/ManagerOrderOperationRequest';
import { StoreManagerOrderOperationService } from '@/services/store/StoreManagerOrderOperationService';

type C = Context<{Bindings:Env;Variables:AppVariables}>;
function privateResponse(c:C) { c.header('Cache-Control','private, no-store'); c.header('Pragma','no-cache'); }
export function managerOperationActor(c:C) {
  const user=c.get('user'),uid=c.get('uid');
  if(!c.get('isLogin') || !user || user.uid!==uid || c.get('socketAuthId')!==uid || typeof c.get('socketAuthVersion')!=='string') throw new AuthException('管理会话未通过用户鉴权');
  return managerActor({uid,authVersion:md5(user.pwd),expiresAt:c.get('socketTokenExp')??0});
}
export function managerOperationContext(c:C):ManagerOperationContext {return{actor:managerOperationActor(c),request_key:c.req.header('Idempotency-Key')??''};}
async function input(c:C):Promise<ManagerOperationInput> {
  if(new URL(c.req.url).search || !/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(c.req.header('Content-Type')??'') || !['','identity'].includes((c.req.header('Content-Encoding')??'').toLowerCase())) throw new ValidateException('管理操作仅接受无查询参数的UTF-8 JSON');
  const raw=await readBoundedUtf8Text(c.req.raw,262144);
  let value:unknown;try{value=JSON.parse(raw);}catch{throw new ValidateException('管理操作JSON无效');}
  if(!value || typeof value!=='object' || Array.isArray(value)) throw new ValidateException('管理操作内容格式错误');
  // The durable ledger validates the exact six-field contract and creates its
  // immutable copy before any SQL or callback can use this untrusted body.
  return value as ManagerOperationInput;
}
function service(c:C) {return new StoreManagerOrderOperationService(c.get('container'),c.env);}
export async function saveRemark(c:C) {privateResponse(c);return jsonOk(c,await service(c).saveRemark(managerOperationContext(c),await input(c)));}
export async function manualDelivery(c:C) {privateResponse(c);return jsonOk(c,await service(c).delivery('manual_delivery',managerOperationContext(c),await input(c)));}
export async function splitDelivery(c:C) {privateResponse(c);return jsonOk(c,await service(c).delivery('split_delivery',managerOperationContext(c),await input(c)));}
export async function operationOutcome(c:C) {privateResponse(c);return jsonOk(c,{receipt:await new ManagerOrderOperationRequest(c.get('container')).getOutcome(managerOperationActor(c),c.req.param('requestKey'))});}
export async function abandonOperation(c:C) {
  privateResponse(c);const kind=c.req.param('kind')??'';
  if(!['remark','manual_delivery','split_delivery','change_price','confirm_offline','refund_create','return_approve','refund_refuse','refund_execute'].includes(kind)) throw new ValidateException('管理操作种类无效');
  return jsonOk(c,{receipt:await new ManagerOrderOperationRequest(c.get('container')).abandon(kind as ManagerOperationKind,managerOperationContext(c),await input(c))});
}
