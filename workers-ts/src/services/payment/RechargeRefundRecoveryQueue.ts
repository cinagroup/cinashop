/** Queue addresses only. No status, amount, role, credential or ready proof
 * carried by these messages can authorize a query or economic mutation. */
import { ValidateException } from '@/utils/errors';

export interface RechargeRefundRecoveryMessage {
 readonly action:'recoverRechargeRefund';readonly operationId:string;
}
export interface RechargeRefundRecoveryDispatchMessage {
 readonly action:'dispatchRechargeRefundRecovery';readonly scheduledAt:number;
 readonly phase:'submitting'|'unknown';readonly cutoff:number|null;
 readonly cursor:{readonly queryAt:number;readonly operationId:string}|null;
}
const max=2147483647;
const uuid=(v:unknown):v is string=>typeof v==='string'&&v.length===36&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
const second=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0&&v<=max;
const fail=():never=>{throw new ValidateException('充值退款恢复消息无效');};
function object(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return fail();
 const d=Object.getOwnPropertyDescriptors(value);
 if(Reflect.ownKeys(d).length!==keys.length||keys.some(k=>!d[k]?.enumerable||!('value'in d[k])))return fail();
 return Object.fromEntries(keys.map(k=>[k,d[k].value]));
}
export function captureRechargeRefundRecoveryMessage(value:unknown):Readonly<RechargeRefundRecoveryMessage>{
 const r=object(value,['action','operationId']);if(r.action!=='recoverRechargeRefund'||!uuid(r.operationId))return fail();
 return Object.freeze({action:'recoverRechargeRefund',operationId:r.operationId});
}
export function captureRechargeRefundRecoveryDispatch(value:unknown):Readonly<RechargeRefundRecoveryDispatchMessage>{
 const r=object(value,['action','scheduledAt','phase','cutoff','cursor']);
 if(r.action!=='dispatchRechargeRefundRecovery'||typeof r.scheduledAt!=='number'||!Number.isSafeInteger(r.scheduledAt)
  ||r.scheduledAt<1||r.scheduledAt>max*1000||r.phase!=='submitting'&&r.phase!=='unknown'
  ||r.cutoff!==null&&!second(r.cutoff))return fail();
 let cursor:RechargeRefundRecoveryDispatchMessage['cursor']=null;
 if(r.cursor!==null){
  const c=object(r.cursor,['queryAt','operationId']);if(!second(c.queryAt)||!uuid(c.operationId)||r.cutoff===null||c.queryAt>Number(r.cutoff))return fail();
  cursor=Object.freeze({queryAt:c.queryAt,operationId:c.operationId});
 }
 if(r.cutoff===null&&(r.phase!=='submitting'||cursor!==null))return fail();
 return Object.freeze({action:'dispatchRechargeRefundRecovery',scheduledAt:r.scheduledAt,phase:r.phase as 'submitting'|'unknown',cutoff:r.cutoff as number|null,cursor});
}
export function createRechargeRefundRecoveryRoot(scheduledAt:number):Readonly<RechargeRefundRecoveryDispatchMessage>{
 return captureRechargeRefundRecoveryDispatch({action:'dispatchRechargeRefundRecovery',scheduledAt,phase:'submitting',cutoff:null,cursor:null});
}
export function isRechargeRefundRecoveryMessage(value:unknown):value is RechargeRefundRecoveryMessage{
 try{captureRechargeRefundRecoveryMessage(value);return true;}catch{return false;}
}
export function isRechargeRefundRecoveryDispatch(value:unknown):value is RechargeRefundRecoveryDispatchMessage{
 try{captureRechargeRefundRecoveryDispatch(value);return true;}catch{return false;}
}
