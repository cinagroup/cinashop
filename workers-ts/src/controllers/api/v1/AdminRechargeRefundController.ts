import type { Context,MiddlewareHandler } from 'hono';
import type { AppVariables,Env } from '@/env';
import { AuthException,HttpApiException,ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
import { readBoundedUtf8Text } from '@/utils/request-body';
import { normalizeOutRequestKey } from '@/services/out/OutIdempotency';
import { captureAdminRechargeRefundActor } from '@/services/admin/AdminRechargeRefundActor';
import { quoteAdminRechargeRefund } from '@/services/admin/AdminRechargeRefundAdmission';
import { lookupAdminRechargeRefundReceipt,lookupAdminRechargeRefundExecution } from '@/services/admin/AdminRechargeRefundReadService';
import { executeAdminRechargeRefund,queryAdminRechargeRefund,abandonAdminRechargeRefundRequest,cancelAdminRechargeRefundRequest } from '@/services/admin/AdminRechargeRefundExecutionService';
import { RECHARGE_REFUND_VERSION,captureRechargeRefundRequest } from '@/services/payment/RechargeRefundRequest';
import { rechargeRefundId } from '@/services/payment/RechargeRefundMoney';

type HttpEnv={Bindings:Env;Variables:AppVariables};type C=Context<HttpEnv>;
export const privateRechargeRefundResponse:MiddlewareHandler<HttpEnv>=async(c,next)=>{
 c.header('Cache-Control','private, no-store, max-age=0');c.header('Pragma','no-cache');await next();
};
function identity(c:C){
 const id=c.get('adminId');
 if(!id||id!==c.get('adminInfo')?.id||id!==c.get('socketAuthId'))throw new AuthException('请重新登录');
 const actor=captureAdminRechargeRefundActor({id,authVersion:c.get('socketAuthVersion')??'',expiresAt:c.get('socketTokenExp')??0});
 if(c.req.header('X-Recharge-Refund-Scope')!==`v1:admin:${id}`)throw new HttpApiException('充值退款操作身份已变化或缺失，请保留原请求',412,412);
 if(new URL(c.req.url).search)throw new ValidateException('充值退款不接受查询参数');
 return{actor,key:normalizeOutRequestKey(c.req.header('Idempotency-Key'))};
}
function id(c:C){
 const raw=c.req.param('id');if(!raw||!/^[1-9]\d{0,9}$/u.test(raw)||String(Number(raw))!==raw)throw new ValidateException('充值退款标识无效');
 return rechargeRefundId(Number(raw));
}
async function body(c:C):Promise<unknown>{
 if(!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/iu.test(c.req.header('Content-Type')??'')
  ||!['','identity'].includes((c.req.header('Content-Encoding')??'').toLowerCase()))throw new ValidateException('充值退款仅接受 UTF-8 JSON');
 const text=await readBoundedUtf8Text(c.req.raw,4096);
 try{return JSON.parse(text);}catch{throw new ValidateException('充值退款 JSON 无效');}
}
async function version(c:C){
 const value=await body(c);
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1||!Object.hasOwn(value,'version')||!('version'in value)
  ||value.version!==RECHARGE_REFUND_VERSION)throw new ValidateException('充值退款协议版本或字段无效');
}
export async function quote(c:C){
 const {actor}=identity(c),rechargeId=id(c);await version(c);
 return jsonOk(c,await quoteAdminRechargeRefund(c.get('container'),c.env,actor,rechargeId));
}
export async function execute(c:C){
 const {actor,key}=identity(c),rechargeId=id(c),request=captureRechargeRefundRequest(await body(c));
 return jsonOk(c,await executeAdminRechargeRefund(c.get('container'),c.env,actor,rechargeId,key,request));
}
export async function receipt(c:C){
 const {actor,key}=identity(c);await version(c);
 return jsonOk(c,{version:RECHARGE_REFUND_VERSION,receipt:await lookupAdminRechargeRefundReceipt(c.get('container'),c.env,actor,key)});
}
export async function execution(c:C){
 const {actor,key}=identity(c);await version(c);
 return jsonOk(c,await lookupAdminRechargeRefundExecution(c.get('container'),c.env,actor,key));
}
export async function query(c:C){
 const {actor,key}=identity(c);await version(c);
 return jsonOk(c,await queryAdminRechargeRefund(c.get('container'),c.env,actor,key));
}
export async function abandon(c:C){
 const {actor,key}=identity(c),rechargeId=id(c),request=captureRechargeRefundRequest(await body(c));
 return jsonOk(c,{version:RECHARGE_REFUND_VERSION,receipt:await abandonAdminRechargeRefundRequest(c.get('container'),c.env,actor,rechargeId,key,request)});
}
export async function cancel(c:C){
 const {actor,key}=identity(c),rechargeId=id(c);await version(c);
 return jsonOk(c,await cancelAdminRechargeRefundRequest(c.get('container'),c.env,actor,rechargeId,key));
}
