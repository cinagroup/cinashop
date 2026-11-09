/** Synthetic MAC codec examples only, no physical SQL/provider/funds proof. */
import { signRechargeRefundRecord,type RechargeRefundRecord } from '@/services/payment/RechargeRefundLedger';
import { parseRechargeRefundCountedFirstEconomicBasis } from '@/services/payment/RechargeRefundCountedFirstEconomicHistory';
import { signRechargeRefundCountedFirstLocalCaptureResult,signRechargeRefundCountedFirstSuccessNoticeIntent,captureRechargeRefundCountedFirstCaptureFacts } from '@/services/payment/RechargeRefundCountedFirstLocalCaptureCodec';
import { signRechargeRefundCountedFirstLocalReleaseResult,captureRechargeRefundCountedFirstReleaseFacts } from '@/services/payment/RechargeRefundCountedFirstLocalReleaseCodec';
import { rechargeQueryHistoryPureFixture,historySigning as env,historyScope as scope } from './rechargeRefundQueryHistoryPure';
import { operationSourceUuid } from './rechargeRefundOperationSourcePure';
export { historySigning as countedFirstSigning,historyScope as countedFirstScope } from './rechargeRefundQueryHistoryPure';
export function rechargeCountedFirstEconomicPureFixture(status:'SUCCESS'|'CLOSED'='SUCCESS',gift=true,count=2){
 const f=rechargeQueryHistoryPureFixture(count,Array.from({length:Math.max(0,count-1)},()=> 'PROCESSING' as const),status);
 const firstProvider=(f.results[0].evidence as Record<string,unknown>).result as Record<string,unknown>;
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
   ...(row.source==='request'?{attemptSignature:attempts[0].signature}:{firstAttemptSignature:attempts[0].signature,queryAttemptSignature:attempts[i].signature,result:{...(e.result as Record<string,unknown>),providerRefundId:firstProvider.providerRefundId}})}});
 });
 const history={operation,attempts,policies:f.policies,results,providerResultId:results[0].result_id};
 const cause=()=>parseRechargeRefundCountedFirstEconomicBasis(env,scope,history);
 const h=()=>cause(),at=Math.max(2100,Number(attempts.at(-1)!.created_at)+1);
 function common(){const b=h();return{format:1,scope,localResultId:operationSourceUuid(900),
  operation:{id:operation.operation_id,signature:operation.signature,paymentSignature:operation.payment_signature},
  request:{attemptId:attempts[0].attempt_id,signature:attempts[0].signature,requestHash:attempts[0].request_hash},
  claimTail:{attemptId:b.claimTail.attempt.attempt_id,signature:b.claimTail.attempt.signature,requestHash:b.claimTail.attempt.request_hash,ordinal:b.claimTail.payload.ordinal,
   approvalId:b.claimTail.approval.record_id,approvalSignature:b.claimTail.approval.signature},
  provider:{resultId:b.record.result_id,signature:b.record.signature,refundId:b.observation.providerRefundId,observedAt:b.observation.observedAt},
  recharge:{id:Number(operation.recharge_id),buyerUid:Number(operation.buyer_uid),orderNo:String(operation.order_no),transactionId:String(operation.transaction_id),
   appId:b.request.approval.appId,merchantId:b.request.approval.merchantId,principalCents:1000,giftCents:150,reclaimGift:gift,debitCents:gift?1150:1000,refundBeforeCents:0},
  holdBillId:b.request.holdBillId,projection:{beforeVersion:count,afterVersion:count+1,totalAttempts:count}};}
 function captureFacts(patch:Record<string,unknown>={}):Record<string,unknown>{const c=common();return{...c,purpose:'recharge-refund-counted-first-capture-facts-v1',
  provider:{...c.provider,successTime:h().observation.successTime},recharge:{...c.recharge,refundAfterCents:1000,postReservationBalanceCents:gift?0:150},
  wallet:{beforeCents:-25,afterCents:-25},flow:{id:91,eventKey:'recharge.refund:'+String(operation.operation_id),flowId:String(operation.operation_id).replaceAll('-',''),
   orderId:operation.order_no,storeId:1,uid:operation.buyer_uid,priceCents:-1000,tradingType:4,payType:'weixin',addTime:at,nickname:'退款快照',phone:'13800138000',mark:'充值原路退款'},capturedAt:at,...patch};}
 const capture=(v:unknown=captureFacts())=>captureRechargeRefundCountedFirstCaptureFacts(env,scope,history,v);
 const notice=(v:unknown=captureFacts())=>signRechargeRefundCountedFirstSuccessNoticeIntent(env,scope,history,v);
 const noticeRow=(v:unknown=captureFacts())=>({id:92,eventKey:'recharge.refund.success.notice:'+String(operation.operation_id),aggregateType:'recharge',
  aggregateId:operation.recharge_id,eventType:'recharge.refund.success.notice',payload:notice(v),addTime:at});
 const localCapture=(v:unknown=captureFacts())=>signRechargeRefundCountedFirstLocalCaptureResult(env,scope,history,v,noticeRow(v));
 function releaseFacts(before=1700,patch:Record<string,unknown>={}):Record<string,unknown>{const c=common(),after=before+c.recharge.debitCents;return{...c,
  purpose:'recharge-refund-counted-first-closed-release-facts-v1',recharge:{...c.recharge,refundAfterCents:0},wallet:{beforeCents:before,afterCents:after},
  bill:{id:93,uid:operation.buyer_uid,linkId:operation.order_no,eventKey:'recharge_refund_release:'+String(operation.operation_id),pm:1,category:'now_money',
   type:'recharge_refund_release',title:'渠道关闭充值退款退回预留',numberCents:c.recharge.debitCents,balanceCents:after,status:1,take:0,frozenTime:0,addTime:at,mark:'渠道已确认关闭，退回原充值退款预留'},
  releasedAt:at,...patch};}
 const release=(v:unknown=releaseFacts())=>captureRechargeRefundCountedFirstReleaseFacts(env,scope,history,v);
 const localRelease=(v:unknown=releaseFacts())=>signRechargeRefundCountedFirstLocalReleaseResult(env,scope,history,v);
 return{history,cause,captureFacts,capture,notice,noticeRow,localCapture,releaseFacts,release,localRelease};
}
