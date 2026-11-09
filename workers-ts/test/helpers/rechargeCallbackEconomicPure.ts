/** Synthetic MAC codec examples only, no physical SQL/provider/funds proof. */
import { signRechargeRefundRecord,type RechargeRefundRecord } from '@/services/payment/RechargeRefundLedger';
import { parseRechargeRefundCallbackEconomicBasis } from '@/services/payment/RechargeRefundCallbackEconomicHistory';
import { signRechargeRefundCallbackLocalCaptureResult,signRechargeRefundCallbackSuccessNoticeIntent,captureRechargeRefundCallbackCaptureFacts } from '@/services/payment/RechargeRefundCallbackLocalCaptureCodec';
import { signRechargeRefundCallbackLocalReleaseResult,captureRechargeRefundCallbackReleaseFacts } from '@/services/payment/RechargeRefundCallbackLocalReleaseCodec';
import type { RechargeRefundCallbackStatus } from '@/services/payment/RechargeRefundCallbackCodec';
import { rechargeRefundCallbackPureFixture,callbackSigning as env,callbackScope as scope } from './rechargeRefundCallbackPure';
import { operationSourceUuid } from './rechargeRefundOperationSourcePure';
export { callbackSigning as callbackEconomicSigning,callbackScope as callbackEconomicScope } from './rechargeRefundCallbackPure';
export function rechargeCallbackEconomicPureFixture(status:RechargeRefundCallbackStatus='SUCCESS',gift=true,count=1){
 const base=rechargeRefundCallbackPureFixture(status,count),f=base.history;
 const {signature:_op,...oldOp}=f.operation;
 const operation=signRechargeRefundRecord(env,scope,'recharge_refund_operation',{...oldOp,reclaim_gift:gift,debit_cents:gift?1150:1000,wallet_after:gift?0:150});
 const attempts:RechargeRefundRecord[]=[];
 for(const row of f.attempts){
  const {signature:_,...old}=row,p=row.payload as Record<string,unknown>;
  attempts.push(signRechargeRefundRecord(env,scope,'recharge_refund_attempt',{...old,payload:{...p,operationSignature:operation.signature,
   ...(row.kind==='query'?{firstAttemptSignature:attempts[0].signature}:{})}}));
 }
 const results=f.results.map((row,i)=>{
  const {signature:_,...old}=row,e=row.evidence as Record<string,unknown>;
  return signRechargeRefundRecord(env,scope,'recharge_refund_result',{...old,evidence:{...e,operationSignature:operation.signature,
   ...(row.source==='request'?{attemptSignature:attempts[0].signature}:{firstAttemptSignature:attempts[0].signature,queryAttemptSignature:attempts[i].signature})}});
 });
 const {signature:_callback,...oldCallback}=base.result();
 const cb=signRechargeRefundRecord(env,scope,'recharge_refund_result',{...oldCallback,evidence:{...base.evidence,operationSignature:operation.signature,firstAttemptSignature:attempts[0].signature}});
 const history={operation,attempts,policies:base.policies,results:[...results,cb],providerResultId:cb.result_id};
 const cause=()=>parseRechargeRefundCallbackEconomicBasis(env,scope,history);
 const h=()=>cause(),at=Math.max(2600,Number(attempts.at(-1)!.created_at)+1);
 function common(){const b=h();return{format:1,scope,localResultId:operationSourceUuid(900),
  operation:{id:operation.operation_id,signature:operation.signature,paymentSignature:operation.payment_signature},
  request:{attemptId:attempts[0].attempt_id,signature:attempts[0].signature,requestHash:attempts[0].request_hash},
  callback:{eventId:b.observation.eventId,eventType:b.observation.eventType,eventCreatedAt:b.observation.eventCreatedAt,
   approvalId:b.callback.approval.record_id,approvalSignature:b.callback.approval.signature,requestDigest:b.observation.requestDigest,
   plaintextDigest:b.observation.plaintextDigest,verifierKey:b.observation.verifierKey,signedAt:b.observation.signedAt,receivedAt:b.observation.receivedAt},
  provider:{resultId:b.record.result_id,signature:b.record.signature,refundId:b.observation.providerRefundId,receivedAt:b.observation.receivedAt},
  recharge:{id:Number(operation.recharge_id),buyerUid:Number(operation.buyer_uid),orderNo:String(operation.order_no),transactionId:String(operation.transaction_id),
   appId:b.request.approval.appId,merchantId:b.request.approval.merchantId,principalCents:1000,giftCents:150,reclaimGift:gift,debitCents:gift?1150:1000,refundBeforeCents:0},
  holdBillId:b.request.holdBillId,projection:{beforeVersion:count,afterVersion:count+1,totalAttempts:count}};}
 function captureFacts(patch:Record<string,unknown>={}):Record<string,unknown>{const c=common();return{...c,purpose:'recharge-refund-callback-capture-facts-v1',
  provider:{...c.provider,successTime:h().observation.successTime},recharge:{...c.recharge,refundAfterCents:1000,postReservationBalanceCents:gift?0:150},
  wallet:{beforeCents:-25,afterCents:-25},flow:{id:91,eventKey:'recharge.refund:'+String(operation.operation_id),flowId:String(operation.operation_id).replaceAll('-',''),
   orderId:operation.order_no,storeId:1,uid:operation.buyer_uid,priceCents:-1000,tradingType:4,payType:'weixin',addTime:at,nickname:'退款快照',phone:'13800138000',mark:'充值原路退款'},capturedAt:at,...patch};}
 const capture=(v:unknown=captureFacts())=>captureRechargeRefundCallbackCaptureFacts(env,scope,history,v);
 const notice=(v:unknown=captureFacts())=>signRechargeRefundCallbackSuccessNoticeIntent(env,scope,history,v);
 const noticeRow=(v:unknown=captureFacts())=>({id:92,eventKey:'recharge.refund.success.notice:'+String(operation.operation_id),aggregateType:'recharge',
  aggregateId:operation.recharge_id,eventType:'recharge.refund.success.notice',payload:notice(v),addTime:at});
 const localCapture=(v:unknown=captureFacts())=>signRechargeRefundCallbackLocalCaptureResult(env,scope,history,v,noticeRow(v));
 function releaseFacts(before=1700,patch:Record<string,unknown>={}):Record<string,unknown>{const c=common(),after=before+c.recharge.debitCents;return{...c,
  purpose:'recharge-refund-callback-closed-release-facts-v1',recharge:{...c.recharge,refundAfterCents:0},wallet:{beforeCents:before,afterCents:after},
  bill:{id:93,uid:operation.buyer_uid,linkId:operation.order_no,eventKey:'recharge_refund_release:'+String(operation.operation_id),pm:1,category:'now_money',
   type:'recharge_refund_release',title:'渠道关闭充值退款退回预留',numberCents:c.recharge.debitCents,balanceCents:after,status:1,take:0,frozenTime:0,addTime:at,mark:'渠道已确认关闭，退回原充值退款预留'},
  releasedAt:at,...patch};}
 const release=(v:unknown=releaseFacts())=>captureRechargeRefundCallbackReleaseFacts(env,scope,history,v);
 const localRelease=(v:unknown=releaseFacts())=>signRechargeRefundCallbackLocalReleaseResult(env,scope,history,v);
 return{history,cause,captureFacts,capture,notice,noticeRow,localCapture,releaseFacts,release,localRelease};
}
