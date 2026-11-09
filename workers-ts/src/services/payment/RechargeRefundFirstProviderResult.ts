/** Historical first-request provider attestation only. No sending capability,
 * mutable-source readiness, local settlement, money/state write or HTTP route. */
import { sql } from 'drizzle-orm';
import type { Env } from '@/env';
import type { DbClient } from '@/lib/di';
import { assertRechargeRefundRuntimeTx,type RechargeRefundRuntimeRole } from '@/migrations/rechargeRefund';
import { ServiceUnavailableException } from '@/utils/errors';
import { authenticateRechargeRefundRecord,readRechargeRefundOperationByIdTx } from './RechargeRefundLedger';
import { captureRechargeRefundJson,captureRechargeRefundScope,type RechargeRefundScope } from './RechargeRefundJournalCodec';
import { parseRechargeRefundFirstRequest,rechargeRefundTransportApproval } from './RechargeRefundFirstRequest';
import { readRechargeRoutineRefundAccountJournalTx } from './RechargeRoutineRefundAccount';
import { parseRechargeRoutineRefundAccountJournal,requireRechargeRoutineRefundPurpose } from './RechargeRoutineRefundAccountCodec';
import { routineEvidenceCanonical } from './RoutineProviderObservation';

type Signing=Pick<Env,'APP_KEY'>;
export type RechargeRefundFirstProviderStatus='SUCCESS'|'PROCESSING'|'CLOSED'|'ABNORMAL'|'UNKNOWN';
export interface RechargeRefundFirstProviderObservation{
 readonly status:RechargeRefundFirstProviderStatus;readonly providerRefundId:string;
 readonly successTime:number;readonly errorCode:string;
 readonly responseDigest:string;readonly verifierKey:string;readonly httpStatus:number;readonly observedAt:number;
}
const fail=():never=>{throw new ServiceUnavailableException('充值退款渠道历史证据暂不可核对，请保留原操作');};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
const hex=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
const time=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0&&Number(v)<=2147483647;
const token=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9._:-]{1,128}$/u.test(v);
const same=(a:unknown,b:unknown)=>routineEvidenceCanonical(a)===routineEvidenceCanonical(b);
function object(value:unknown,keys:readonly string[]):Record<string,unknown>{
 const row=captureRechargeRefundJson(value);
 if(!row||typeof row!=='object'||Array.isArray(row)||Reflect.ownKeys(row).length!==keys.length||keys.some(k=>!Object.hasOwn(row,k)))return fail();
 return row as Record<string,unknown>;
}
function freeze<T>(value:T):T{
 if(value&&typeof value==='object'){for(const d of Object.values(Object.getOwnPropertyDescriptors(value)))if('value'in d)freeze(d.value);Object.freeze(value);}return value;
}

/** Pure authenticated-history decoder. The caller-supplied rows are not proof
 * of physical existence, RSA verification, fresh dispatch or settlement funds.
 * APP_KEY authenticates the closed actual writer's verifier/digest attestation;
 * this decoder does not recreate a private transport capability or query the
 * current credential registry to reinterpret an old response. */
export function parseRechargeRefundFirstProviderResult(env:Signing,expectedScope:RechargeRefundScope,
 rawOperation:unknown,rawAttempt:unknown,rawResult:unknown,rawApproval:unknown){
 const scope=captureRechargeRefundScope(expectedScope),operation=authenticateRechargeRefundRecord(env,scope,'recharge_refund_operation',rawOperation);
 const request=parseRechargeRefundFirstRequest(env,scope,operation,rawAttempt),p=request.payload;
 const record=authenticateRechargeRefundRecord(env,scope,'recharge_refund_result',rawResult);
 const approval=parseRechargeRoutineRefundAccountJournal(env,scope,rawApproval);
 requireRechargeRoutineRefundPurpose(approval,'refund_request',p.issuedAt);
 if(approval.created_at>p.issuedAt||!same(rechargeRefundTransportApproval(approval),p.approval))return fail();
 const evidence=object(record.evidence,['format','purpose','scope','operationSignature','attemptSignature','requestHash','approval','request','result','verification']);
 const approved=object(evidence.approval,['recordId','signature','accountId','appId','merchantId','credentialRef','credentialVersion','credentialStamp']);
 const sent=object(evidence.request,['outTradeNo','transactionId','outRefundNo','refundAmount','totalAmount','reason']);
 const result=object(evidence.result,['status','providerRefundId','successTime','errorCode']);
 const verified=object(evidence.verification,['responseDigest','verifierKey','httpStatus','observedAt']);
 if(record.operation_id!==operation.operation_id||record.attempt_id!==request.attempt.attempt_id||record.source!=='request'
  ||record.source_id!==request.attempt.attempt_id||record.caused_by_result_id!==null
  ||!time(record.created_at)||record.created_at!==verified.observedAt
  ||evidence.format!==1||evidence.purpose!=='recharge-refund-first-provider-result-v1'
  ||!same(captureRechargeRefundScope(evidence.scope),scope)||evidence.operationSignature!==operation.signature
  ||evidence.attemptSignature!==request.attempt.signature||evidence.requestHash!==request.attempt.request_hash
  ||!same(approved,p.approval)||!same(sent,p.request)||record.status!==result.status
  ||typeof result.status!=='string'||!['SUCCESS','PROCESSING','CLOSED','ABNORMAL','UNKNOWN'].includes(result.status)
  ||!hex(verified.responseDigest)||!token(verified.verifierKey)||!time(verified.observedAt)||verified.observedAt<p.issuedAt-1
  ||!Number.isSafeInteger(verified.httpStatus))return fail();
 const status=result.status as RechargeRefundFirstProviderStatus,httpStatus=Number(verified.httpStatus);
 if(status==='UNKNOWN'){
  if(httpStatus<400||httpStatus>599||result.providerRefundId!==''||result.successTime!==0
   ||result.errorCode!==''&&!token(result.errorCode))return fail();
 }else{
  if(httpStatus<200||httpStatus>299||typeof result.providerRefundId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/u.test(result.providerRefundId)
   ||result.errorCode!=='')return fail();
  if(status==='SUCCESS'){
   if(!time(result.successTime)||result.successTime<p.issuedAt-300||result.successTime>verified.observedAt+300)return fail();
  }else if(result.successTime!==0)return fail();
 }
 const observation:RechargeRefundFirstProviderObservation={status,providerRefundId:result.providerRefundId as string,
  successTime:result.successTime as number,errorCode:result.errorCode as string,responseDigest:verified.responseDigest,
  verifierKey:verified.verifierKey,httpStatus,observedAt:verified.observedAt};
 return freeze({scope,operation,attempt:request.attempt,request:p,approval,record,observation});
}
export type RechargeRefundFirstProviderResult=ReturnType<typeof parseRechargeRefundFirstProviderResult>;

/** Real physical immutable history on the actual App/Admin/Financial LOGIN.
 * `write` only selects this transaction's required RC/read-write role guard for
 * a later owning settlement author; this reader itself never writes or locks
 * wallet, payment source, projection or first-settlement business rows. */
export async function readRechargeRefundFirstProviderResultTx(tx:DbClient,env:Signing,role:RechargeRefundRuntimeRole,
 operationId:unknown,resultId:unknown,mode:'read'|'write'='read'):Promise<RechargeRefundFirstProviderResult>{
 if(Object.hasOwn(tx,'$client')||!uuid(operationId)||!uuid(resultId))return fail();
 const scope=await assertRechargeRefundRuntimeTx(tx,role,mode);
 const operation=await readRechargeRefundOperationByIdTx(tx,env,role,operationId,mode);
 const results=await tx.execute(sql`SELECT * FROM public.recharge_refund_result
  WHERE operation_id=${operationId}::uuid AND result_id=${resultId}::uuid LIMIT 2`);
 if(results.length!==1)return fail();
 const record=authenticateRechargeRefundRecord(env,scope,'recharge_refund_result',results[0]);
 if(record.source!=='request'||!uuid(record.attempt_id))return fail();
 const attempts=await tx.execute(sql`SELECT * FROM public.recharge_refund_attempt
  WHERE operation_id=${operationId}::uuid AND attempt_id=${record.attempt_id}::uuid LIMIT 2`);
 if(attempts.length!==1)return fail();
 const request=parseRechargeRefundFirstRequest(env,scope,operation,attempts[0]);
 const approval=await readRechargeRoutineRefundAccountJournalTx(tx,env,request.payload.approval.recordId,role,mode);
 return parseRechargeRefundFirstProviderResult(env,scope,operation,request.attempt,record,approval);
}
