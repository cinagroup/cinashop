/** Pure authenticated query history only. No SQL, clock, credentials, RSA,
 * transport capability, provider I/O, local projection or financial permit. */
import { createHash } from 'node:crypto';
import type { Env } from '@/env';
import { ServiceUnavailableException } from '@/utils/errors';
import { authenticateRechargeRefundRecord,type RechargeRefundRecord } from './RechargeRefundLedger';
import { captureRechargeRefundJson,captureRechargeRefundScope,type RechargeRefundScope } from './RechargeRefundJournalCodec';
import { parseRechargeRefundFirstRequest,rechargeRefundTransportApproval,type RechargeRefundTransportApproval,type RechargeRefundFirstRequestPayload } from './RechargeRefundFirstRequest';
import { parseRechargeRoutineRefundAccountJournal,requireRechargeRoutineRefundPurpose,type RechargeRoutineRefundAccountJournal } from './RechargeRoutineRefundAccountCodec';
import { routineEvidenceCanonical } from './RoutineProviderObservation';

type Signing=Pick<Env,'APP_KEY'>;
export interface RechargeRefundQueryRequest {
 readonly method:'GET';readonly path:string;
 /** Absence marker in the journal; a future GET adapter must send no body. */
 readonly body:null;
}
export interface RechargeRefundQueryOriginal {
 readonly outTradeNo:string;readonly transactionId:string;readonly outRefundNo:string;
 readonly refundAmount:number;readonly totalAmount:number;readonly currency:'CNY';
}
export interface RechargeRefundQueryAttemptPayload {
 readonly format:1;readonly purpose:'recharge-refund-query-attempt-v1';readonly scope:RechargeRefundScope;
 readonly operationId:string;readonly operationSignature:string;
 readonly firstAttemptId:string;readonly firstAttemptSignature:string;readonly firstRequestHash:string;readonly firstIssuedAt:number;
 readonly ordinal:number;readonly approval:RechargeRefundTransportApproval;
 readonly leaseId:string;readonly issuedAt:number;readonly leaseUntil:number;
 readonly original:RechargeRefundQueryOriginal;readonly request:RechargeRefundQueryRequest;
}
export type RechargeRefundQueryProviderStatus='SUCCESS'|'PROCESSING'|'CLOSED'|'ABNORMAL'|'NOT_FOUND'|'UNKNOWN';
export interface RechargeRefundQueryObservation {
 readonly status:RechargeRefundQueryProviderStatus;readonly providerRefundId:string;
 readonly successTime:number;readonly errorCode:string;readonly responseDigest:string;
 readonly verifierKey:string;readonly httpStatus:number;readonly observedAt:number;
}
const fail=():never=>{throw new ServiceUnavailableException('充值退款查询历史证据暂不可核对，请保留原操作');};
const time=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0&&Number(v)<=2147483647;
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
const hex=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
const token=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9._:-]{1,128}$/u.test(v);
const same=(a:unknown,b:unknown)=>routineEvidenceCanonical(a)===routineEvidenceCanonical(b);
function object(value:unknown,keys:readonly string[]):Record<string,unknown>{
 const r=captureRechargeRefundJson(value);
 if(!r||typeof r!=='object'||Array.isArray(r)||Reflect.ownKeys(r).length!==keys.length||keys.some(k=>!Object.hasOwn(r,k)))return fail();
 return r as Record<string,unknown>;
}
function freeze<T>(value:T):T{
 if(value&&typeof value==='object'){
  for(const d of Object.values(Object.getOwnPropertyDescriptors(value)))if('value'in d)freeze(d.value);
  Object.freeze(value);
 }
 return value;
}
function requestHash(p:RechargeRefundQueryAttemptPayload):string{
 return createHash('sha256').update(routineEvidenceCanonical({method:p.request.method,path:p.request.path,body:p.request.body,
  appId:p.approval.appId,merchantId:p.approval.merchantId})).digest('hex');
}

/** Explicit module boundary: immutable historical data, never a capability. */
export interface RechargeRefundQueryAttempt {
 readonly scope:RechargeRefundScope;readonly operation:RechargeRefundRecord;
 readonly firstAttempt:RechargeRefundRecord;readonly firstRequest:RechargeRefundFirstRequestPayload;
 readonly firstApproval:RechargeRoutineRefundAccountJournal;readonly attempt:RechargeRefundRecord;
 readonly payload:RechargeRefundQueryAttemptPayload;readonly approval:RechargeRoutineRefundAccountJournal;
}
export interface RechargeRefundQueryResult extends RechargeRefundQueryAttempt {
 readonly record:RechargeRefundRecord;readonly observation:RechargeRefundQueryObservation;
}

/** Row authentication is not physical existence, contiguous ordinal history,
 * a latest live policy, maintained credentials or a query claim/GET permit.
 * Both approvals are validated at their own historical issuance time only. */
export function parseRechargeRefundQueryAttempt(env:Signing,expectedScope:RechargeRefundScope,
 rawOperation:unknown,rawFirstAttempt:unknown,rawFirstApproval:unknown,rawAttempt:unknown,rawApproval:unknown):RechargeRefundQueryAttempt{
 const scope=captureRechargeRefundScope(expectedScope),operation=authenticateRechargeRefundRecord(env,scope,'recharge_refund_operation',rawOperation);
 const first=parseRechargeRefundFirstRequest(env,scope,operation,rawFirstAttempt),fp=first.payload;
 const firstApproval=parseRechargeRoutineRefundAccountJournal(env,scope,rawFirstApproval);
 requireRechargeRoutineRefundPurpose(firstApproval,'refund_request',fp.issuedAt);
 if(firstApproval.created_at>fp.issuedAt||!same(rechargeRefundTransportApproval(firstApproval),fp.approval))return fail();
 const attempt=authenticateRechargeRefundRecord(env,scope,'recharge_refund_attempt',rawAttempt);
 const p=object(attempt.payload,['format','purpose','scope','operationId','operationSignature','firstAttemptId','firstAttemptSignature',
  'firstRequestHash','firstIssuedAt','ordinal','approval','leaseId','issuedAt','leaseUntil','original','request']);
 const approved=object(p.approval,['recordId','signature','accountId','appId','merchantId','credentialRef','credentialVersion','credentialStamp']);
 const original=object(p.original,['outTradeNo','transactionId','outRefundNo','refundAmount','totalAmount','currency']);
 const request=object(p.request,['method','path','body']);
 const approval=parseRechargeRoutineRefundAccountJournal(env,scope,rawApproval);
 if(!time(p.issuedAt))return fail();
 requireRechargeRoutineRefundPurpose(approval,'refund_query',p.issuedAt);
 const selected=rechargeRefundTransportApproval(approval);
 if(attempt.operation_id!==operation.operation_id||attempt.kind!=='query'||!time(attempt.ordinal)||attempt.ordinal<=1
  ||attempt.attempt_id===first.attempt.attempt_id||p.ordinal!==attempt.ordinal
  ||p.format!==1||p.purpose!=='recharge-refund-query-attempt-v1'||!same(captureRechargeRefundScope(p.scope),scope)
  ||p.operationId!==operation.operation_id||p.operationSignature!==operation.signature
  ||p.firstAttemptId!==first.attempt.attempt_id||p.firstAttemptSignature!==first.attempt.signature
  ||p.firstRequestHash!==first.attempt.request_hash||p.firstIssuedAt!==fp.issuedAt
  ||!uuid(p.leaseId)||p.leaseId!==attempt.lease_id||p.leaseId===fp.leaseId
  ||p.issuedAt!==attempt.created_at||p.issuedAt<fp.issuedAt+60||!time(p.leaseUntil)||p.leaseUntil!==p.issuedAt+30
  ||approval.created_at>p.issuedAt||!same(approved,selected)
  ||selected.appId!==fp.approval.appId||selected.merchantId!==fp.approval.merchantId||selected.accountId!==fp.approval.accountId
  ||original.outTradeNo!==fp.request.outTradeNo||original.transactionId!==fp.request.transactionId||original.outRefundNo!==fp.request.outRefundNo
  ||original.refundAmount!==fp.request.refundAmount||original.totalAmount!==fp.request.totalAmount||original.currency!=='CNY'
  ||request.method!=='GET'||request.path!=='/v3/refund/domestic/refunds/'+encodeURIComponent(fp.request.outRefundNo)
  ||request.body!==null)return fail();
 const payload=p as unknown as RechargeRefundQueryAttemptPayload;
 if(attempt.request_hash!==requestHash(payload))return fail();
 return freeze({scope,operation,firstAttempt:first.attempt,firstRequest:fp,firstApproval,attempt,payload,approval});
}

/** A MAC attests a future private verifier's closed result; it never proves
 * RSA/HTTP verification by itself and never mints a sending capability.
 * No current clock, wallet, actor, source, registry or latest approval is read. */
export function parseRechargeRefundQueryResult(env:Signing,expectedScope:RechargeRefundScope,
 rawOperation:unknown,rawFirstAttempt:unknown,rawFirstApproval:unknown,rawAttempt:unknown,rawApproval:unknown,rawResult:unknown):RechargeRefundQueryResult{
 const history=parseRechargeRefundQueryAttempt(env,expectedScope,rawOperation,rawFirstAttempt,rawFirstApproval,rawAttempt,rawApproval);
 const {scope,operation,attempt,payload:p}=history;
 const record=authenticateRechargeRefundRecord(env,scope,'recharge_refund_result',rawResult);
 const evidence=object(record.evidence,['format','purpose','scope','operationSignature','firstAttemptId','firstAttemptSignature','firstRequestHash',
  'queryAttemptSignature','requestHash','approval','original','request','result','verification']);
 const approved=object(evidence.approval,['recordId','signature','accountId','appId','merchantId','credentialRef','credentialVersion','credentialStamp']);
 const original=object(evidence.original,['outTradeNo','transactionId','outRefundNo','refundAmount','totalAmount','currency']);
 const request=object(evidence.request,['method','path','body']);
 const result=object(evidence.result,['status','providerRefundId','successTime','errorCode']);
 const verified=object(evidence.verification,['responseDigest','verifierKey','httpStatus','observedAt']);
 if(record.operation_id!==operation.operation_id||record.attempt_id!==attempt.attempt_id||record.source!=='query'
  ||record.source_id!==attempt.attempt_id||record.caused_by_result_id!==null
  ||!time(record.created_at)||record.created_at!==verified.observedAt
  ||evidence.format!==1||evidence.purpose!=='recharge-refund-query-provider-result-v1'
  ||!same(captureRechargeRefundScope(evidence.scope),scope)||evidence.operationSignature!==operation.signature
  ||evidence.firstAttemptId!==p.firstAttemptId||evidence.firstAttemptSignature!==p.firstAttemptSignature||evidence.firstRequestHash!==p.firstRequestHash
  ||evidence.queryAttemptSignature!==attempt.signature||evidence.requestHash!==attempt.request_hash
  ||!same(approved,p.approval)||!same(original,p.original)||!same(request,p.request)||record.status!==result.status
  ||typeof result.status!=='string'||!['SUCCESS','PROCESSING','CLOSED','ABNORMAL','NOT_FOUND','UNKNOWN'].includes(result.status)
  ||!hex(verified.responseDigest)||!token(verified.verifierKey)||!time(verified.observedAt)||verified.observedAt<p.issuedAt-1
  ||!Number.isSafeInteger(verified.httpStatus))return fail();
 const status=result.status as RechargeRefundQueryProviderStatus,httpStatus=Number(verified.httpStatus);
 if(status==='NOT_FOUND'){
  if(httpStatus!==404||result.errorCode!=='RESOURCE_NOT_EXISTS'||result.providerRefundId!==''||result.successTime!==0)return fail();
 }else if(status==='UNKNOWN'){
  if(httpStatus<400||httpStatus>599||result.providerRefundId!==''||result.successTime!==0
   ||result.errorCode!==''&&!token(result.errorCode)||httpStatus===404&&result.errorCode==='RESOURCE_NOT_EXISTS')return fail();
 }else{
  if(httpStatus<200||httpStatus>299||typeof result.providerRefundId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/u.test(result.providerRefundId)
   ||result.errorCode!=='')return fail();
  if(status==='SUCCESS'){
   // Querying much later must still accept the original POST's older success.
   if(!time(result.successTime)||result.successTime<p.firstIssuedAt-300||result.successTime>verified.observedAt+300)return fail();
  }else if(result.successTime!==0)return fail();
 }
 const observation:RechargeRefundQueryObservation={status,providerRefundId:result.providerRefundId as string,
  successTime:result.successTime as number,errorCode:result.errorCode as string,responseDigest:verified.responseDigest,
  verifierKey:verified.verifierKey,httpStatus,observedAt:verified.observedAt};
 return freeze({...history,record,observation});
}
