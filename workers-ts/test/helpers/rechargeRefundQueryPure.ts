/** Synthetic closed MAC contracts only; no physical history, RSA, maintained
 * credential, SQL claim/COMMIT, dispatch capability or financial authority. */
import { createHash } from 'node:crypto';
import { signRechargeRefundRecord,type RechargeRefundRecord } from '@/services/payment/RechargeRefundLedger';
import type { RechargeRefundJson } from '@/services/payment/RechargeRefundJournalCodec';
import { rechargeRefundTransportApproval,type RechargeRefundTransportApproval } from '@/services/payment/RechargeRefundFirstRequest';
import { rechargeRoutineRefundAccountId,signRechargeRoutineRefundAccountJournal,type RechargeRoutineRefundAccountJournal } from '@/services/payment/RechargeRoutineRefundAccountCodec';
import type { RechargeRefundQueryProviderStatus } from '@/services/payment/RechargeRefundQueryCodec';
import { routineEvidenceCanonical } from '@/services/payment/RoutineProviderObservation';
import { rechargeFirstResultPureFixture,firstResultScope as scope,firstResultSigning as env,type RechargeFirstResultPureFixture } from './rechargeFirstProviderResultPure';
import { operationSourceUuid } from './rechargeRefundOperationSourcePure';
export { firstResultScope as queryScope,firstResultSigning as querySigning } from './rechargeFirstProviderResultPure';
export interface RechargeQueryPureOptions {
 readonly ordinal?:number;readonly issuedAt?:number;readonly queryPolicy?:Record<string,unknown>;readonly queryApprovalCreatedAt?:number;
 readonly firstPolicy?:Record<string,unknown>;readonly firstApprovalCreatedAt?:number;readonly reuseFirstApproval?:boolean;
}
/** Synthetic raw ledger scalars remain JSON unions; no valid-row assertion is
 * introduced merely to annotate this helper's exported data boundary. */
interface QueryPureOriginal {
 readonly outTradeNo:RechargeRefundJson;readonly transactionId:RechargeRefundJson;readonly outRefundNo:RechargeRefundJson;
 readonly refundAmount:RechargeRefundJson;readonly totalAmount:RechargeRefundJson;readonly currency:string;
}
interface QueryPureRequest {readonly method:string;readonly path:string;readonly body:null}
interface QueryPurePayload {
 readonly format:number;readonly purpose:string;readonly scope:typeof scope;readonly operationId:RechargeRefundJson;
 readonly operationSignature:RechargeRefundJson;readonly firstAttemptId:RechargeRefundJson;readonly firstAttemptSignature:RechargeRefundJson;
 readonly firstRequestHash:RechargeRefundJson;readonly firstIssuedAt:RechargeRefundJson;readonly ordinal:number;
 readonly approval:RechargeRefundTransportApproval;readonly leaseId:string;readonly issuedAt:number;readonly leaseUntil:number;
 readonly original:QueryPureOriginal;readonly request:QueryPureRequest;
}
interface QueryPureEvidence {
 readonly format:number;readonly purpose:string;readonly scope:typeof scope;readonly operationSignature:RechargeRefundJson;
 readonly firstAttemptId:RechargeRefundJson;readonly firstAttemptSignature:RechargeRefundJson;readonly firstRequestHash:RechargeRefundJson;
 readonly queryAttemptSignature:RechargeRefundJson;readonly requestHash:RechargeRefundJson;readonly approval:RechargeRefundTransportApproval;
 readonly original:QueryPureOriginal;readonly request:QueryPureRequest;
 readonly result:{readonly status:RechargeRefundQueryProviderStatus;readonly providerRefundId:string;readonly successTime:number;readonly errorCode:string};
 readonly verification:{readonly responseDigest:string;readonly verifierKey:string;readonly httpStatus:number;readonly observedAt:number};
}
export interface RechargeQueryPureFixture {
 readonly first:RechargeFirstResultPureFixture;readonly approval:RechargeRoutineRefundAccountJournal;
 readonly ordinal:number;readonly issuedAt:number;readonly payload:QueryPurePayload;
 readonly queryAttempt:(patch?:Record<string,unknown>,rowPatch?:Record<string,unknown>)=>RechargeRefundRecord;
 readonly attempt:RechargeRefundRecord;readonly evidence:QueryPureEvidence;
 readonly result:(patch?:Record<string,unknown>,rowPatch?:Record<string,unknown>)=>RechargeRefundRecord;
}
export function rechargeQueryPureFixture(status:RechargeRefundQueryProviderStatus='SUCCESS',options:RechargeQueryPureOptions={}):RechargeQueryPureFixture{
 const first=rechargeFirstResultPureFixture('UNKNOWN',options.firstPolicy,options.firstApprovalCreatedAt);
 const pair=first.approval.payload.data,accountId=rechargeRoutineRefundAccountId(env,pair.appId,pair.merchantId);
 const queryPolicy={accountId,provider:'wechat',profile:'routine',state:'active',appId:pair.appId,merchantId:pair.merchantId,
  credentialRef:'synthetic_query_rotated',credentialVersion:2,credentialStamp:'c'.repeat(64),purposes:['refund_query'],
  validFrom:1800,validUntil:4000,...options.queryPolicy};
 const approval=options.reuseFirstApproval?first.approval:signRechargeRoutineRefundAccountJournal(env,scope,{
  record_id:operationSourceUuid(20),account_id:queryPolicy.accountId,revision:2,
  payload:{format:1,purpose:'recharge_routine_refund_account',scope,previousRecordId:first.approval.record_id,data:queryPolicy},
  created_at:options.queryApprovalCreatedAt??1900});
 const ordinal=options.ordinal??2,issuedAt=options.issuedAt??2000;
 const original={outTradeNo:first.operation.order_no,transactionId:first.operation.transaction_id,outRefundNo:first.operation.out_refund_no,
  refundAmount:first.operation.principal_cents,totalAmount:first.operation.principal_cents,currency:'CNY'};
 const request={method:'GET',path:'/v3/refund/domestic/refunds/'+encodeURIComponent(String(first.operation.out_refund_no)),body:null};
 const payload={format:1,purpose:'recharge-refund-query-attempt-v1',scope,operationId:first.operation.operation_id,
  operationSignature:first.operation.signature,firstAttemptId:first.attempt.attempt_id,firstAttemptSignature:first.attempt.signature,
  firstRequestHash:first.attempt.request_hash,firstIssuedAt:first.attempt.created_at,ordinal,approval:rechargeRefundTransportApproval(approval),
  leaseId:operationSourceUuid(21),issuedAt,leaseUntil:issuedAt+30,original,request};
 const queryAttempt=(patch:Record<string,unknown>={},rowPatch:Record<string,unknown>={}):RechargeRefundRecord=>{
  const p={...payload,...patch},q=p.request as Record<string,unknown>,a=p.approval as Record<string,unknown>;
  const requestHash=createHash('sha256').update(routineEvidenceCanonical({method:q.method,path:q.path,body:q.body,appId:a.appId,merchantId:a.merchantId})).digest('hex');
  return signRechargeRefundRecord(env,scope,'recharge_refund_attempt',{attempt_id:operationSourceUuid(22),operation_id:first.operation.operation_id,
   ordinal,kind:'query',lease_id:payload.leaseId,request_hash:requestHash,payload:p,created_at:issuedAt,...rowPatch});
 };
 const attempt=queryAttempt(),negative=status==='UNKNOWN'||status==='NOT_FOUND';
 const evidence={format:1,purpose:'recharge-refund-query-provider-result-v1',scope,operationSignature:first.operation.signature,
  firstAttemptId:first.attempt.attempt_id,firstAttemptSignature:first.attempt.signature,firstRequestHash:first.attempt.request_hash,
  queryAttemptSignature:attempt.signature,requestHash:attempt.request_hash,approval:payload.approval,original,request,
  result:{status,providerRefundId:negative?'':'synthetic_query_refund',successTime:status==='SUCCESS'?1102:0,
   errorCode:status==='NOT_FOUND'?'RESOURCE_NOT_EXISTS':status==='UNKNOWN'?'SYSTEM_ERROR':''},
  verification:{responseDigest:'d'.repeat(64),verifierKey:'SYNTHETIC_QUERY_KEY',httpStatus:status==='NOT_FOUND'?404:status==='UNKNOWN'?500:200,observedAt:issuedAt+1}};
 const result=(patch:Record<string,unknown>={},rowPatch:Record<string,unknown>={}):RechargeRefundRecord=>signRechargeRefundRecord(env,scope,'recharge_refund_result',{
  result_id:operationSourceUuid(23),operation_id:first.operation.operation_id,attempt_id:attempt.attempt_id,source:'query',source_id:attempt.attempt_id,
  status,evidence:{...evidence,...patch},created_at:issuedAt+1,caused_by_result_id:null,...rowPatch});
 return{first,approval,ordinal,issuedAt,payload,queryAttempt,attempt,evidence,result};
}
