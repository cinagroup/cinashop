/** Public provider callback, fixed ordinary-App container. The path is an
 * operation address only. Actual RSA/AES plus current original-account policy
 * authorize an immutable observation; async recovery owns all money changes. */
import type { Context } from 'hono';
import type { AppVariables,Env } from '@/env';
import { RechargeRefundCallbackService } from '@/services/payment/RechargeRefundCallbackService';
import { createRechargeRefundCallbackBudget,rechargeRefundCallbackHttpHeaders,readRechargeRefundCallbackHttpBody } from '@/services/payment/RechargeRefundCallbackHttpInput';
import { captureRechargeRefundRecoveryMessage } from '@/services/payment/RechargeRefundRecoveryQueue';
import { emitOperationalEvent } from '@/utils/observability';
type C=Context<{Bindings:Env;Variables:AppVariables}>;
const rejected=()=>Response.json({code:'FAIL',message:'充值退款通知尚未完成持久核对'},{status:503,headers:{'Cache-Control':'no-store'}});
export async function rechargeRefundCallback(c:C):Promise<Response>{
 const budget=createRechargeRefundCallbackBudget();
 if(c.req.method!=='POST')return Response.json({code:'FAIL',message:'仅接受 POST'},{status:405,headers:{Allow:'POST','Cache-Control':'no-store'}});
 const operationId=c.req.param('operationId')??'';
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(operationId))return rejected();
 try{
  const headers=rechargeRefundCallbackHttpHeaders(c.req.raw.headers),body=await readRechargeRefundCallbackHttpBody(c.req.raw,budget);
  const service=new RechargeRefundCallbackService(c.get('container'),c.env,budget),verified=await service.verify(operationId,headers,body);
  const receipt=await service.persist(verified);budget.check();
  // No queue send precedes the durable COMMIT. waitUntil never determines ACK;
  // the actual due scheduler recovers absent/failed/ambiguous enqueue.
  if(receipt.status==='SUCCESS'||receipt.status==='CLOSED'){
   const message=captureRechargeRefundRecoveryMessage({action:'recoverRechargeRefund',operationId:receipt.operationId});
   const enqueue=Promise.resolve().then(()=>c.env.ORDER_QUEUE.send(message)).catch(()=>{
    emitOperationalEvent('warn',{event:'recharge_refund_callback_enqueue_deferred',component:'refund',operation:'recharge_refund_callback',outcome:'retry'});
   });
   try{c.executionCtx.waitUntil(enqueue);}catch{void enqueue;}
  }
  budget.check();return new Response(null,{status:204,headers:{'Cache-Control':'no-store'}});
 }catch{
  // Never echo request/cleartext/cryptography/SQL errors or operation details.
  emitOperationalEvent('warn',{event:'recharge_refund_callback_rejected',component:'refund',operation:'recharge_refund_callback',outcome:'rejected'});
  return rejected();
 }
}
