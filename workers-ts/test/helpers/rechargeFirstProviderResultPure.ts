/** Synthetic MAC contracts only. No physical SQL, RSA/provider fact, dispatch
 * capability or funds authority is established by any value in this fixture. */
import { createHash } from 'node:crypto';
import { signRechargeRefundRecord,type RechargeRefundRecord } from '@/services/payment/RechargeRefundLedger';
import { rechargeRefundTransportApproval } from '@/services/payment/RechargeRefundFirstRequest';
import { rechargeRoutineRefundAccountId,signRechargeRoutineRefundAccountJournal } from '@/services/payment/RechargeRoutineRefundAccountCodec';
import type { RechargeRefundFirstProviderStatus } from '@/services/payment/RechargeRefundFirstProviderResult';
import { routineEvidenceCanonical } from '@/services/payment/RoutineProviderObservation';
import { operationSourcePureFixture,operationSourceScope as scope,operationSourceSigning as env,
 operationSourceFacts,operationSourceUuid } from './rechargeRefundOperationSourcePure';
export { operationSourceScope as firstResultScope,operationSourceSigning as firstResultSigning } from './rechargeRefundOperationSourcePure';

export function rechargeFirstResultPureFixture(status:RechargeRefundFirstProviderStatus='SUCCESS',policyPatch:Record<string,unknown>={},createdAt=1050){
 const f=operationSourcePureFixture(),accountId=rechargeRoutineRefundAccountId(env,operationSourceFacts.appId,operationSourceFacts.merchantId);
 const approval=signRechargeRoutineRefundAccountJournal(env,scope,{record_id:operationSourceUuid(5),account_id:accountId,revision:1,
  payload:{format:1,purpose:'recharge_routine_refund_account',scope,previousRecordId:'',data:{accountId,provider:'wechat',profile:'routine',
   state:'active',appId:operationSourceFacts.appId,merchantId:operationSourceFacts.merchantId,credentialRef:'synthetic_source_contract',
   credentialVersion:1,credentialStamp:'a'.repeat(64),purposes:['refund_request'],validFrom:800,validUntil:1500,...policyPatch}},created_at:createdAt});
 const base=f.operation(),{signature:_,...unsigned}=base,payment=base.payment_source as Record<string,unknown>;
 const operation=signRechargeRefundRecord(env,scope,'recharge_refund_operation',{...unsigned,payment_source:{...payment,
  refundApproval:{recordId:approval.record_id,signature:approval.signature}}});
 const projected=rechargeRefundTransportApproval(approval),request={outTradeNo:operation.order_no,transactionId:operation.transaction_id,
  outRefundNo:operation.out_refund_no,refundAmount:operation.principal_cents,totalAmount:operation.principal_cents,reason:'充值原路退款'};
 const notifyUrl='https://refund-contract.example/api/pay/notify/recharge-refund/'+operation.operation_id;
 const requestHash=createHash('sha256').update(routineEvidenceCanonical({method:'POST',path:'/v3/refund/domestic/refunds',
  appId:projected.appId,merchantId:projected.merchantId,request,notifyUrl})).digest('hex');
 const attempt=signRechargeRefundRecord(env,scope,'recharge_refund_attempt',{attempt_id:operationSourceUuid(6),operation_id:operation.operation_id,
  ordinal:1,kind:'request',lease_id:operationSourceUuid(7),request_hash:requestHash,created_at:1101,
  payload:{format:1,purpose:'recharge-refund-first-request-v1',scope,operationId:operation.operation_id,operationSignature:operation.signature,
   paymentSignature:operation.payment_signature,holdBillId:payment.holdBillId,adminId:operation.admin_id,approval:projected,
   leaseId:operationSourceUuid(7),issuedAt:1101,leaseUntil:1131,request,notifyUrl}});
 const evidence={format:1,purpose:'recharge-refund-first-provider-result-v1',scope,operationSignature:operation.signature,
  attemptSignature:attempt.signature,requestHash,approval:projected,request,
  result:{status,providerRefundId:status==='UNKNOWN'?'':'refund_contract_1',successTime:status==='SUCCESS'?1102:0,errorCode:status==='UNKNOWN'?'SYSTEM_ERROR':''},
  verification:{responseDigest:'b'.repeat(64),verifierKey:'SYNTHETIC_CONTRACT_KEY',httpStatus:status==='UNKNOWN'?500:200,observedAt:1102}};
 const result=(patch:Record<string,unknown>={},recordPatch:Record<string,unknown>={}):RechargeRefundRecord=>signRechargeRefundRecord(env,scope,'recharge_refund_result',{
  result_id:operationSourceUuid(8),operation_id:operation.operation_id,attempt_id:attempt.attempt_id,source:'request',source_id:attempt.attempt_id,
  status,evidence:{...evidence,...patch},created_at:1102,caused_by_result_id:null,...recordPatch});
 return{operation,attempt,approval,evidence,result};
}
export type RechargeFirstResultPureFixture=ReturnType<typeof rechargeFirstResultPureFixture>;
