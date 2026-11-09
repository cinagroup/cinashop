/** Sole original-account POST admission. SQL commits before a private,
 * one-consumption transport capability exists. No network operation here. */
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Env } from '@/env';
import type { Container, DbClient } from '@/lib/di';
import { ServiceUnavailableException } from '@/utils/errors';
import { captureAdminRechargeRefundActor, type AdminRechargeRefundActor } from '@/services/admin/AdminRechargeRefundActor';
import { readAdminRechargeRefundFirstRequestBasisTx } from './RechargeRefundOperationSource';
import { authenticateRechargeRefundRecord, insertRechargeRefundEvidenceTx, type RechargeRefundRecord } from './RechargeRefundLedger';
import { captureRechargeRefundJson, captureRechargeRefundScope, type RechargeRefundScope } from './RechargeRefundJournalCodec';
import { readRechargeRefundStateTx } from './RechargeRefundAccounting';
import { routineCommittedMerchantMaterials } from './RoutineApprovedPaymentAccount';
import { requireRechargeRoutineRefundPurpose, type RechargeRoutineRefundAccountJournal } from './RechargeRoutineRefundAccountCodec';
import { routineEvidenceCanonical } from './RoutineProviderObservation';
import { parseRoutineOriginalEvidence } from './RoutineOriginalPaymentEvidenceCodec';
import { rechargeRoutineRefundAccountId } from './RechargeRoutineRefundAccountCodec';

type Signing=Pick<Env,'APP_KEY'>;
type Runtime=Pick<Env,'APP_KEY'|'ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS'|'ROUTINE_REFUND_NOTIFY_ORIGIN'>;
const fail=():never=>{throw new ServiceUnavailableException('充值退款首派发暂不可核对，请查询原操作');};
const hex=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0&&Number(v)<=2147483647;
const same=(a:unknown,b:unknown)=>routineEvidenceCanonical(a)===routineEvidenceCanonical(b);
function object(value:unknown,keys:readonly string[]):Record<string,unknown>{
 const r=captureRechargeRefundJson(value);
 if(!r||typeof r!=='object'||Array.isArray(r)||Reflect.ownKeys(r).length!==keys.length||keys.some(k=>!Object.hasOwn(r,k)))return fail();
 return r as Record<string,unknown>;
}
function freeze<T>(value:T):T{
 if(value&&typeof value==='object'){for(const d of Object.values(Object.getOwnPropertyDescriptors(value)))if('value'in d)freeze(d.value);Object.freeze(value);}return value;
}
export interface RechargeRefundTransportApproval {
 readonly recordId:string;readonly signature:string;readonly accountId:string;readonly appId:string;readonly merchantId:string;
 readonly credentialRef:string;readonly credentialVersion:number;readonly credentialStamp:string;
}
export function rechargeRefundTransportApproval(row:RechargeRoutineRefundAccountJournal):Readonly<RechargeRefundTransportApproval>{
 const d=row.payload.data;return Object.freeze({recordId:row.record_id,signature:row.signature,accountId:d.accountId,appId:d.appId,
 merchantId:d.merchantId,credentialRef:d.credentialRef,credentialVersion:d.credentialVersion,credentialStamp:d.credentialStamp});
}
export interface RechargeRefundFirstRequestPayload {
 readonly format:1;readonly purpose:'recharge-refund-first-request-v1';readonly scope:RechargeRefundScope;
 readonly operationId:string;readonly operationSignature:string;readonly paymentSignature:string;readonly holdBillId:number;
 readonly adminId:number;readonly approval:RechargeRefundTransportApproval;readonly leaseId:string;readonly issuedAt:number;readonly leaseUntil:number;
 readonly request:{readonly outTradeNo:string;readonly transactionId:string;readonly outRefundNo:string;readonly refundAmount:number;readonly totalAmount:number;readonly reason:string};
 readonly notifyUrl:string;
}
function callbackUrl(origin:unknown,id:string){
 if(typeof origin!=='string'||origin.length>200||!uuid(id))return fail();
 let u:URL;try{u=new URL(origin);}catch{return fail();}
 if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/'||u.origin!==origin
  ||u.hostname==='localhost'||u.hostname.endsWith('.localhost')||!u.hostname.includes('.'))return fail();
 return origin+'/api/pay/notify/recharge-refund/'+id;
}
function requestDigest(p:RechargeRefundFirstRequestPayload){
 return createHash('sha256').update(routineEvidenceCanonical({method:'POST',path:'/v3/refund/domestic/refunds',
  appId:p.approval.appId,merchantId:p.approval.merchantId,request:p.request,notifyUrl:p.notifyUrl})).digest('hex');
}
/** Historical decoding only; no current registry, wallet or paid lookup. */
export function parseRechargeRefundFirstRequest(env:Signing,scope:RechargeRefundScope,operation:RechargeRefundRecord,input:unknown){
 scope=captureRechargeRefundScope(scope);const op=authenticateRechargeRefundRecord(env,scope,'recharge_refund_operation',operation);
 const row=authenticateRechargeRefundRecord(env,scope,'recharge_refund_attempt',input);
 const p=object(row.payload,['format','purpose','scope','operationId','operationSignature','paymentSignature','holdBillId','adminId','approval',
  'leaseId','issuedAt','leaseUntil','request','notifyUrl']);
 const a=object(p.approval,['recordId','signature','accountId','appId','merchantId','credentialRef','credentialVersion','credentialStamp']);
 const q=object(p.request,['outTradeNo','transactionId','outRefundNo','refundAmount','totalAmount','reason']);
 const source=object(op.payment_source,['original','holdBillId','refundApproval']);
 // Only the pinned immutable first provider envelope is needed for this receipt
 // binding. Do not revalidate nested first-settlement/use/current-source facts
 // here: their later local failure must not erase a verified external result.
 const originalSource=object(source.original,['format','domain','firstSettlement','originals','approvedUseRefs','approvedUseDigest']);
 if(originalSource.format!==2||originalSource.domain!=='recharge'||!Array.isArray(originalSource.originals)
  ||originalSource.originals.length<1||originalSource.originals.length>64)return fail();
 const original=parseRoutineOriginalEvidence(env,originalSource.originals[0]),facts=original.payload.observation.facts,local=original.payload.binding;
 if(local.state!=='bound'||local.local.domain!=='recharge'||local.local.orderId!==op.recharge_id||local.local.buyerUid!==op.buyer_uid
  ||local.local.orderNo!==op.order_no||local.local.amountCents!==op.principal_cents||local.local.tradeNo!==''&&local.local.tradeNo!==op.transaction_id
  ||facts.orderNo!==op.order_no||facts.transactionId!==op.transaction_id||facts.amountCents!==op.principal_cents||facts.currency!=='CNY'
  ||facts.tradeState!=='SUCCESS'||facts.tradeType!=='JSAPI'||!facts.payerId||a.appId!==facts.appId||a.merchantId!==facts.merchantId
  ||a.accountId!==rechargeRoutineRefundAccountId(env,facts.appId,facts.merchantId))return fail();
 const token=(v:unknown,n:number)=>typeof v==='string'&&new RegExp('^[A-Za-z0-9_-]{1,'+n+'}$','u').test(v);
 if(op.admission!=='reserved'||op.provider!=='wechat'||op.payment_profile!=='routine'||!hex(op.signature)||!hex(op.payment_signature)
  ||!positive(op.admin_id)||!positive(op.recharge_id)||!positive(op.buyer_uid)||!Number.isSafeInteger(op.principal_cents)
  ||Number(op.principal_cents)<1||Number(op.principal_cents)>999999999999||op.out_refund_no!=='CNSCR'+String(op.operation_id).replaceAll('-','')
  ||row.operation_id!==op.operation_id||row.kind!=='request'||row.ordinal!==1||p.format!==1||p.purpose!=='recharge-refund-first-request-v1'
  ||!same(captureRechargeRefundScope(p.scope),scope)||p.operationId!==op.operation_id||p.operationSignature!==op.signature
  ||p.paymentSignature!==op.payment_signature||!positive(p.holdBillId)||p.holdBillId!==source.holdBillId||p.adminId!==op.admin_id
  ||!uuid(p.leaseId)||p.leaseId!==row.lease_id||!positive(p.issuedAt)||p.issuedAt!==row.created_at||p.issuedAt<Number(op.created_at)||!positive(p.leaseUntil)||p.leaseUntil!==p.issuedAt+30
  ||!uuid(a.recordId)||!hex(a.signature)||!hex(a.accountId)||!token(a.appId,32)||typeof a.merchantId!=='string'||!/^\d{1,32}$/u.test(a.merchantId)
  ||!token(a.credentialRef,64)||!positive(a.credentialVersion)||!hex(a.credentialStamp)
  ||q.outTradeNo!==op.order_no||q.transactionId!==op.transaction_id||q.outRefundNo!==op.out_refund_no
  ||q.refundAmount!==op.principal_cents||q.totalAmount!==op.principal_cents||q.reason!=='充值原路退款'
  ||typeof p.notifyUrl!=='string'||!p.notifyUrl.endsWith('/api/pay/notify/recharge-refund/'+String(op.operation_id)))return fail();
 const origin=p.notifyUrl.slice(0,-('/api/pay/notify/recharge-refund/'+String(op.operation_id)).length);
 if(callbackUrl(origin,String(op.operation_id))!==p.notifyUrl)return fail();
 const payload=p as unknown as RechargeRefundFirstRequestPayload;
 if(row.request_hash!==requestDigest(payload))return fail();
 return freeze({operation:op,attempt:row,payload});
}
export type RechargeRefundFirstRequest=ReturnType<typeof parseRechargeRefundFirstRequest>;

const capabilityBrand:unique symbol=Symbol('recharge-refund-committed-first-request');
export interface PreparedRechargeRefundFirstRequest {readonly operationId:string;readonly attemptId:string;readonly expiresAt:number;readonly [capabilityBrand]:true}
const pending=new WeakMap<object,{binding:RechargeRefundFirstRequest;appKey:string;rootDb:DbClient}>();
async function clock(tx:DbClient){
 const [r]=await tx.execute<{now:string}>(sql`SELECT floor(extract(epoch FROM pg_catalog.clock_timestamp()))::bigint AS now`);
 const now=Number(r?.now);if(!positive(now))return fail();return now;
}
/** Replays deliberately refuse: even an unsent committed request is query-only.
 * This function can never recreate a POST token from an existing attempt. */
export async function claimAdminRechargeRefundFirstRequest(container:Container,inputEnv:Runtime,input:AdminRechargeRefundActor,operationId:unknown):Promise<PreparedRechargeRefundFirstRequest>{
 if(!Object.hasOwn(container.db,'$client')||!uuid(operationId))return fail();
 const env:Runtime={APP_KEY:inputEnv.APP_KEY,ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS:inputEnv.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS,
  ROUTINE_REFUND_NOTIFY_ORIGIN:inputEnv.ROUTINE_REFUND_NOTIFY_ORIGIN};
 const actor=captureAdminRechargeRefundActor(input),notifyUrl=callbackUrl(env.ROUTINE_REFUND_NOTIFY_ORIGIN,operationId);
 const admitted=await container.db.transaction(async rawTx=>{
  const tx=rawTx as unknown as DbClient;await tx.execute(sql`SET LOCAL search_path TO public,pg_temp`);
  const basis=await readAdminRechargeRefundFirstRequestBasisTx(tx,env,actor,operationId),p=basis.history.pinned,op=p.operation;
  const issuedAt=await clock(tx);requireRechargeRoutineRefundPurpose(basis.latestApproval,'refund_request',issuedAt);
  const approval=rechargeRefundTransportApproval(basis.latestApproval),leaseId=randomUUID(),attemptId=randomUUID();
  const payload:RechargeRefundFirstRequestPayload={format:1,purpose:'recharge-refund-first-request-v1',scope:p.scope,
   operationId,operationSignature:String(op.signature),paymentSignature:String(op.payment_signature),holdBillId:p.holdBillId,adminId:actor.id,
   approval,leaseId,issuedAt,leaseUntil:issuedAt+30,request:{outTradeNo:String(op.order_no),transactionId:String(op.transaction_id),
    outRefundNo:String(op.out_refund_no),refundAmount:Number(op.principal_cents),totalAmount:Number(op.principal_cents),reason:'充值原路退款'},notifyUrl};
  const attempt=await insertRechargeRefundEvidenceTx(tx,env,'admin','recharge_refund_attempt',{attempt_id:attemptId,operation_id:operationId,
   ordinal:1,kind:'request',lease_id:leaseId,request_hash:requestDigest(payload),payload,created_at:issuedAt});
  const updated=await tx.execute(sql`UPDATE public.recharge_refund_state SET status='SUBMITTING',version=version+1,lease_id=${leaseId}::uuid,
   lease_until=${payload.leaseUntil},attempt_count=1,next_query_at=${issuedAt+60},updated_at=${issuedAt}
   WHERE operation_id=${operationId}::uuid AND status='RESERVED' AND wallet_state='held' AND version=0 AND attempt_count=0
    AND lease_id IS NULL AND last_result_id IS NULL RETURNING operation_id`);
  if(updated.length!==1||updated[0].operation_id!==operationId)return fail();
  const parsed=parseRechargeRefundFirstRequest(env,p.scope,op,attempt),state=await readRechargeRefundStateTx(tx,op),now=await clock(tx);
  const [deadline]=await tx.execute<{ready:boolean}>(sql`SELECT pg_catalog.clock_timestamp()<=pg_catalog.transaction_timestamp()+interval '5 seconds' AS ready`);
  requireRechargeRoutineRefundPurpose(basis.latestApproval,'refund_request',now);
  if(state.status!=='SUBMITTING'||state.version!==1||state.attempt_count!==1||state.lease_id!==leaseId||state.lease_until!==payload.leaseUntil
   ||state.next_query_at!==issuedAt+60||now>=payload.leaseUntil||actor.expiresAt<=now||deadline?.ready!==true)return fail();
  routineCommittedMerchantMaterials(env,{appId:approval.appId,merchantId:approval.merchantId,credentialRef:approval.credentialRef,
   credentialVersion:approval.credentialVersion,credentialStamp:approval.credentialStamp});
  return{binding:parsed,expiresAt:Math.min(payload.leaseUntil,actor.expiresAt,basis.latestApproval.payload.data.validUntil)};
 },{isolationLevel:'read committed',accessMode:'read write'});
 // .transaction resolved only after COMMIT. A rollback or failed COMMIT never
 // reaches this minting point, so it cannot authorize any merchant request.
 const token=Object.freeze({operationId,attemptId:String(admitted.binding.attempt.attempt_id),expiresAt:admitted.expiresAt,
  [capabilityBrand]:true as const});
 pending.set(token,{binding:admitted.binding,appKey:env.APP_KEY,rootDb:container.db});return token;
}
/** Internal Wechat adapter entry: consume before RSA/fetch. Returned materials
 * stay request-local and must never be serialized into HTTP DTOs or logs. */
export function consumeRechargeRefundFirstRequest(env:Runtime,token:PreparedRechargeRefundFirstRequest){
 const value=token&&typeof token==='object'?pending.get(token):undefined;
 if(!value)return fail();pending.delete(token);
 const now=Math.floor(Date.now()/1000);
 if(value.appKey!==env.APP_KEY||now<value.binding.payload.issuedAt-1||now>=token.expiresAt)return fail();
 const a=value.binding.payload.approval;
 const materials=routineCommittedMerchantMaterials(env,{appId:a.appId,merchantId:a.merchantId,credentialRef:a.credentialRef,
  credentialVersion:a.credentialVersion,credentialStamp:a.credentialStamp});
 return{binding:value.binding,materials,rootDb:value.rootDb};
}
