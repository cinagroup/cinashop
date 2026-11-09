/** Admin HTTP orchestration. SQL authors own admission/claims and funds;
 * the first POST is sent only after its independently committed first claim.
 * An existing attempt is recovered by GET/stored truth, never a second POST. */
import type { Env } from '@/env';
import type { Container } from '@/lib/di';
import { NotFoundException,ServiceUnavailableException,ValidateException } from '@/utils/errors';
import { normalizeOutRequestKey } from '@/services/out/OutIdempotency';
import { captureRechargeRefundRequest } from '@/services/payment/RechargeRefundRequest';
import { rechargeRefundId } from '@/services/payment/RechargeRefundMoney';
import { claimAdminRechargeRefundFirstRequest } from '@/services/payment/RechargeRefundFirstRequest';
import { recoverAdminRechargeRefund } from '@/services/payment/RechargeRefundRecoveryService';
import { captureRechargeRefundSuccessFirstResult } from '@/services/payment/RechargeRefundSuccessCapture';
import { releaseRechargeRefundClosedFirstResult } from '@/services/payment/RechargeRefundClosedRelease';
import { WechatPayService } from '@/services/wechat/WechatPayService';
import { captureAdminRechargeRefundActor,type AdminRechargeRefundActor } from './AdminRechargeRefundActor';
import { admitAdminRechargeRefund,abandonAdminRechargeRefund } from './AdminRechargeRefundAdmission';
import { cancelAdminRechargeRefundBeforePost } from './AdminRechargeRefundCancellation';
import { lookupAdminRechargeRefundExecution,projectAdminRechargeRefundReceipt,type AdminRechargeRefundView } from './AdminRechargeRefundReadService';

function request(id:unknown,body:unknown){
 const rechargeId=rechargeRefundId(id),captured=captureRechargeRefundRequest(body);
 if(captured.rechargeId!==rechargeId)throw new ValidateException('退款请求与充值订单不一致');
 return captured;
}
async function required(container:Container,env:Env,actor:AdminRechargeRefundActor,key:string):Promise<AdminRechargeRefundView>{
 const value=await lookupAdminRechargeRefundExecution(container,env,actor,key);
 if(!value)throw new ServiceUnavailableException('原充值退款回执暂不可核对，请保留原键');
 return value;
}
export async function executeAdminRechargeRefund(container:Container,env:Env,input:AdminRechargeRefundActor,id:unknown,keyInput:unknown,body:unknown){
 const actor=captureAdminRechargeRefundActor(input),key=normalizeOutRequestKey(keyInput),captured=request(id,body);
 const admission=await admitAdminRechargeRefund(container,env,actor,key,captured),operationId=String(admission.operation.operation_id);
 if(admission.operation.admission!=='reserved')return{receipt:await projectAdminRechargeRefundReceipt(admission.operation,actor.id,key),
  execution:{operationId,phase:admission.operation.admission==='abandoned'?'abandoned':'rejected_insufficient',wallet:'none',attemptCount:0,nextQueryAt:null},replayed:admission.replayed};
 if(admission.replayed){
  const prior=await required(container,env,actor,key);
  if(['cancelled','succeeded','released','manual_review'].includes(prior.execution.phase))return{...prior,replayed:true};
  if(prior.execution.phase!=='not_requested'){
   const recovery=await recoverAdminRechargeRefund(container,env,actor,operationId);
   return{...await required(container,env,actor,key),replayed:true,recovery};
  }
 }
 let prepared;
 try{prepared=await claimAdminRechargeRefundFirstRequest(container,env,actor,operationId);}
 catch(error){
  // A concurrent first claim or a lost claim acknowledgement leaves an
  // immutable attempt. Report it without consuming/reconstructing a token.
  const actual=await required(container,env,actor,key);
  if(actual.execution.attemptCount>0)return{...actual,replayed:true};
  throw error;
 }
 const provider=new WechatPayService(container,env),verified=await provider.requestRechargeRefundFirst(prepared);
 const recorded=await provider.persistRechargeRefundFirstResult(verified);
 if(recorded.status==='SUCCESS')await captureRechargeRefundSuccessFirstResult(container,env,'admin',operationId,recorded.resultId);
 else if(recorded.status==='CLOSED')await releaseRechargeRefundClosedFirstResult(container,env,'admin',operationId,recorded.resultId);
 return{...await required(container,env,actor,key),replayed:admission.replayed};
}
export async function queryAdminRechargeRefund(container:Container,env:Env,input:AdminRechargeRefundActor,keyInput:unknown){
 const actor=captureAdminRechargeRefundActor(input),key=normalizeOutRequestKey(keyInput),prior=await required(container,env,actor,key);
 if(['not_requested','cancelled','rejected_insufficient','abandoned','manual_review'].includes(prior.execution.phase))return prior;
 const recovery=await recoverAdminRechargeRefund(container,env,actor,prior.receipt.operationId);
 return{...await required(container,env,actor,key),recovery};
}
export async function abandonAdminRechargeRefundRequest(container:Container,env:Env,input:AdminRechargeRefundActor,id:unknown,keyInput:unknown,body:unknown){
 const actor=captureAdminRechargeRefundActor(input),key=normalizeOutRequestKey(keyInput),captured=request(id,body);
 const op=await abandonAdminRechargeRefund(container,env,actor,key,captured);
 return projectAdminRechargeRefundReceipt(op,actor.id,key);
}
export async function cancelAdminRechargeRefundRequest(container:Container,env:Env,input:AdminRechargeRefundActor,id:unknown,keyInput:unknown){
 const actor=captureAdminRechargeRefundActor(input),key=normalizeOutRequestKey(keyInput),rechargeId=rechargeRefundId(id);
 const prior=await lookupAdminRechargeRefundExecution(container,env,actor,key);
 if(!prior)throw new NotFoundException('原充值退款操作尚未存在');
 if(prior.receipt.rechargeId!==rechargeId)throw new ValidateException('原操作不属于当前充值订单');
 if(prior.execution.phase==='cancelled')return{...prior,replayed:true};
 const result=await cancelAdminRechargeRefundBeforePost(container,env,actor,rechargeId,key);
 return{...await required(container,env,actor,key),replayed:!result.released};
}
