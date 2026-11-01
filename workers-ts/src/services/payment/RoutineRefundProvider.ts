import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { eq, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { storeOrder,storeOrderRefund,storeOrderRefundPayment } from '@/models/schema';
import { assertRoutineRefundInstalledTx,assertRoutineRefundReadInTx,assertRoutineRefundStatusReadTx } from '@/migrations/routineRefund';
import { lockRefundExecution } from '@/services/order/StoreOrderRefundService';
import { readRoutineRefundOriginalTx } from './RoutineRefundOriginal';
import { assertNativeAppExcludedForRoutineRefundTx } from './NativeAppRefundProviderAuthority';
import { readRoutineRefundAccountPolicyTx,readRoutineRefundAccountJournalTx, type RoutineRefundPurpose } from './RoutineRefundAccountPolicy';
import { routineCommittedMerchantMaterials,type RoutineMerchantMaterials } from './RoutineApprovedPaymentAccount';
import { routineEvidenceHmac } from './RoutineProviderObservation';
import { type RefundProviderResult } from './RefundGateway';
import { readRoutineRefundDispatchTx,readRoutineRefundDispatchIdTx,routineRefundRootTx,validateRoutineRefundDispatchTx,
 routineRefundApproval,routineRefundMaterialsReference,routineRefundRoleTx,routineRefundRecord,routineRefundEqualMac,routineRefundClock,
 freezeRoutineRefund,sameRoutineRefund,routineRefundUnavailable,type RoutineRefundApproval,type RoutineRefundDispatch } from './RoutineRefundDispatch';

type Mode='request'|'query'|'callback';
type Lease={attemptCount:number;requestTime:number;queryTime:number};
type Signing=Pick<Env,'APP_KEY'>;
const slot=Symbol('routine.refund.prepared-merchant.v1');
const resultSlot=Symbol('routine.refund.verified-result.v1');
export function hasRoutineRefundResult(value:object):boolean{return Object.hasOwn(value,resultSlot);}
export interface PreparedRoutineRefund {
 readonly dispatch:RoutineRefundDispatch;readonly approval:RoutineRefundApproval;readonly mode:Mode;readonly lease:Lease;
 readonly issuedAt:number;readonly signature:string;readonly [slot]:Readonly<RoutineMerchantMaterials>;
}
interface Observation {
 format:1;purpose:'routine_refund_provider_result';dispatchId:string;dispatchSignature:string;
 approval:RoutineRefundApproval;source:Mode;sourceId:string;lease:Lease;result:{status:string;providerRefundId:string;successTime:number};
 responseDigest:string;verifierKey:string;httpStatus:number;issuedAt:number;verifiedAt:number;signature:string;
}
type Evidence={evidence_id:string;dispatch_id:string;source:Mode;source_id:string;payload:Observation;created_at:number;signature:string};
const fail=routineRefundUnavailable;
const hex=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
const int=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0&&Number(v)<=2147483647;
const leaseOf=(p:typeof storeOrderRefundPayment.$inferSelect):Lease=>({attemptCount:p.attemptCount,requestTime:p.requestTime,queryTime:p.queryTime});
const purpose=(mode:Mode):RoutineRefundPurpose=>mode==='callback'?'refund_notify':mode==='request'?'refund_request':'refund_query';
function commitmentEqual(a:RoutineRefundApproval,b:RoutineRefundApproval):boolean {
 return a.accountId===b.accountId&&sameRoutineRefund(routineRefundMaterialsReference({payload:{approval:a}} as RoutineRefundDispatch),
  routineRefundMaterialsReference({payload:{approval:b}} as RoutineRefundDispatch));
}
async function snapshot(tx:DbClient,refundId:number,lock:boolean){
 if(lock)await lockRefundExecution(tx,refundId);
 const refunds=lock?await tx.select().from(storeOrderRefund).where(eq(storeOrderRefund.id,refundId)).limit(2).for('update')
  :await tx.select().from(storeOrderRefund).where(eq(storeOrderRefund.id,refundId)).limit(2);
 if(refunds.length!==1)return fail();const refund=refunds[0];
 const orders=lock?await tx.select().from(storeOrder).where(eq(storeOrder.id,refund.storeOrderId)).limit(2).for('update',{noWait:true})
  :await tx.select().from(storeOrder).where(eq(storeOrder.id,refund.storeOrderId)).limit(2);
 if(orders.length!==1)return fail();const order=orders[0];
 const root=lock?await routineRefundRootTx(tx,order):order.pid>0?(await tx.select().from(storeOrder).where(eq(storeOrder.id,order.pid)).limit(2))[0]:order;
 const payments=lock?await tx.select().from(storeOrderRefundPayment).where(eq(storeOrderRefundPayment.refundId,refundId)).limit(2).for('update')
  :await tx.select().from(storeOrderRefundPayment).where(eq(storeOrderRefundPayment.refundId,refundId)).limit(2);
 if(!root||payments.length!==1)return fail();return{refund,order,root,payment:payments[0]};
}
/** Fresh authorization on the same real business role; no provider I/O inside
 * this transaction. Neither a plain dispatch nor archived secrets is a lease. */
export async function prepareRoutineRefundProvider(container:Container,env:Env,dispatchId:string,mode:Mode):Promise<PreparedRoutineRefund> {
 if(!Object.hasOwn(container.db,'$client')||!['request','query','callback'].includes(mode))return fail();
 return withTx(container,async tx=>{
  if(!await assertRoutineRefundInstalledTx(tx))return fail();
  const d=await readRoutineRefundDispatchIdTx(tx,env,dispatchId),s=await snapshot(tx,d.refund_id,true);
  await validateRoutineRefundDispatchTx(tx,env,d,s.refund,s.order,s.root,s.payment);
  const now=await routineRefundClock(tx),p=s.payment;
  if(p.attemptCount<1||p.requestTime<1||mode==='request'&&(p.providerStatus!=='REQUESTING'||now-p.requestTime>=120)
   ||mode==='query'&&['SUCCESS','CLOSED','ABNORMAL'].includes(p.providerStatus))return fail();
  const original=await readRoutineRefundOriginalTx(tx,env,{rootOrderId:s.root.id,buyerUid:s.root.uid,orderNo:d.payload.request.outTradeNo,
   transactionId:d.payload.request.transactionId,totalAmount:d.payload.request.totalAmount,evidenceId:d.payload.original.evidenceId});
  if(!original||original.evidence.signature!==d.payload.original.signature)return fail();
  await assertNativeAppExcludedForRoutineRefundTx(tx,env,d.payload.request,original);
  const policy=await readRoutineRefundAccountPolicyTx(tx,env,d.payload.approval.accountId,purpose(mode),await routineRefundRoleTx(tx));
  const approval=routineRefundApproval(policy);
  if(!commitmentEqual(approval,d.payload.approval))return fail();
  const materials=routineCommittedMerchantMaterials(env,routineRefundMaterialsReference(d));
  const issuedAt=await routineRefundClock(tx),[deadline]=await tx.execute<{ready:boolean}>(sql`SELECT
    pg_catalog.clock_timestamp()<=pg_catalog.transaction_timestamp()+interval '8 seconds' AS ready`);
  if(issuedAt<policy.payload.data.validFrom||issuedAt>=policy.payload.data.validUntil||deadline?.ready!==true)return fail();
  const body={dispatch:d,approval,mode,lease:leaseOf(p),issuedAt};
  const prepared={...body,signature:routineEvidenceHmac(env,'refund-provider-prepared',body)};
  Object.defineProperty(prepared,slot,{value:materials,enumerable:false,writable:false,configurable:false});
  freezeRoutineRefund(body);return Object.freeze(prepared) as PreparedRoutineRefund;
 });
}
export function routineRefundPreparedMaterials(env:Signing,p:PreparedRoutineRefund):Readonly<RoutineMerchantMaterials> {
 const descriptor=p&&typeof p==='object'?Object.getOwnPropertyDescriptor(p,slot):undefined;
 if(!descriptor||!('value'in descriptor)||!Object.isFrozen(p))return fail();
 const body={dispatch:p.dispatch,approval:p.approval,mode:p.mode,lease:p.lease,issuedAt:p.issuedAt};
 if(!routineRefundEqualMac(p.signature,routineEvidenceHmac(env,'refund-provider-prepared',body)))return fail();return descriptor.value;
}
/** Production adapter calls this only after actual RSA (plus callback AES),
 * exact pinned business fields and response currency/status checks. */
export function captureRoutineRefundResult(env:Signing,p:PreparedRoutineRefund,input:{result:RefundProviderResult;
 verifiedBody:string;verifierKey:string;httpStatus:number;eventId?:string}):RefundProviderResult {
 const materials=routineRefundPreparedMaterials(env,p),r=input.result;
 if(typeof input.verifiedBody!=='string'||!input.verifiedBody||Buffer.byteLength(input.verifiedBody,'utf8')>1048576
  ||input.verifierKey!==materials.platformPublicKeyId||!Number.isSafeInteger(input.httpStatus)
  ||p.mode==='callback'&&input.httpStatus!==200||p.mode!=='callback'&&input.httpStatus!==200&&input.httpStatus!==202&&input.httpStatus!==404
  ||!['SUCCESS','PROCESSING','CLOSED','ABNORMAL','NOT_FOUND'].includes(r.status)
  ||r.status==='NOT_FOUND'&&(p.mode!=='query'||input.httpStatus!==404)
  ||r.status!=='NOT_FOUND'&&input.httpStatus===404
  ||r.status!=='NOT_FOUND'&&(typeof r.providerRefundId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/u.test(r.providerRefundId))
  ||r.status==='SUCCESS'&&(!int(r.successTime)||!r.successTime))return fail();
 const result={status:r.status,providerRefundId:r.status==='NOT_FOUND'?'':r.providerRefundId!,
  successTime:r.status==='SUCCESS'?r.successTime!:0};
 const digest=createHash('sha256').update(input.verifiedBody).digest('hex');
 // Preserve the first attestation of an identical provider fact. A changing
 // query lease, JSON key order or repeated PROCESSING must not consume a row.
 const sourceId=p.mode==='callback'?input.eventId:routineEvidenceHmac(env,'refund-response-source',
  [p.dispatch.dispatch_id,p.dispatch.signature,p.mode,result,input.httpStatus]);
 if(typeof sourceId!=='string'||!/^[A-Za-z0-9._:-]{1,128}$/u.test(sourceId))return fail();
 const body={format:1 as const,purpose:'routine_refund_provider_result' as const,dispatchId:p.dispatch.dispatch_id,
  dispatchSignature:p.dispatch.signature,approval:p.approval,source:p.mode,sourceId,lease:{...p.lease},result,
  responseDigest:digest,verifierKey:input.verifierKey,httpStatus:input.httpStatus,issuedAt:p.issuedAt,verifiedAt:Math.floor(Date.now()/1000)};
 const observation=freezeRoutineRefund({...body,signature:routineEvidenceHmac(env,'refund-provider-result',body)});
 const output:RefundProviderResult={status:r.status,...(result.providerRefundId?{providerRefundId:result.providerRefundId}:{}),
  ...(result.successTime?{successTime:result.successTime}:{}),...(r.message?{message:r.message}:{})};
 Object.defineProperty(output,resultSlot,{value:observation,enumerable:false,writable:false,configurable:false});return output;
}
function parseObservation(env:Signing,v:unknown,d:RoutineRefundDispatch):Observation {
 const r=routineRefundRecord(v,['format','purpose','dispatchId','dispatchSignature','approval','source','sourceId','lease','result',
  'responseDigest','verifierKey','httpStatus','issuedAt','verifiedAt','signature']);
 const lease=routineRefundRecord(r.lease,['attemptCount','requestTime','queryTime']);
 const result=routineRefundRecord(r.result,['status','providerRefundId','successTime']);
 const a=routineRefundRecord(r.approval,['recordId','signature','accountId','appId','merchantId','credentialRef','credentialVersion','credentialStamp']);
 if(r.format!==1||r.purpose!=='routine_refund_provider_result'||r.dispatchId!==d.dispatch_id||r.dispatchSignature!==d.signature
  ||!['request','query','callback'].includes(r.source as string)||typeof r.sourceId!=='string'||!/^[A-Za-z0-9._:-]{1,128}$/u.test(r.sourceId)
  ||!int(lease.attemptCount)||lease.attemptCount<1||!int(lease.requestTime)||lease.requestTime<1||!int(lease.queryTime)
  ||!['SUCCESS','PROCESSING','CLOSED','ABNORMAL','NOT_FOUND'].includes(result.status as string)||!int(result.successTime)
  ||typeof result.providerRefundId!=='string'||result.status!=='NOT_FOUND'&&!/^[A-Za-z0-9_-]{1,128}$/u.test(result.providerRefundId)
  ||result.status==='SUCCESS'&&!result.successTime||!hex(r.responseDigest)||typeof r.verifierKey!=='string'
  ||result.status!=='SUCCESS'&&result.successTime!==0||result.status==='NOT_FOUND'&&result.providerRefundId!==''
  ||!int(r.issuedAt)||!r.issuedAt||!int(r.verifiedAt)||!r.verifiedAt||r.verifiedAt<r.issuedAt-60||r.verifiedAt-r.issuedAt>90
  ||!int(r.httpStatus)||!commitmentEqual(a as unknown as RoutineRefundApproval,d.payload.approval)
  ||result.status==='NOT_FOUND'&&(r.source!=='query'||r.httpStatus!==404)
  ||result.status!=='NOT_FOUND'&&![200,202].includes(r.httpStatus as number)
  ||r.source==='callback'&&r.httpStatus!==200)return fail();
 if(r.source!=='callback'&&r.sourceId!==routineEvidenceHmac(env,'refund-response-source',
  [d.dispatch_id,d.signature,r.source,result,r.httpStatus]))return fail();
 const{signature,...body}=r;if(!routineRefundEqualMac(signature,routineEvidenceHmac(env,'refund-provider-result',body)))return fail();
 return freezeRoutineRefund({...body,signature}) as unknown as Observation;
}
function evidence(env:Signing,raw:unknown,d:RoutineRefundDispatch):Evidence {
 const r=routineRefundRecord(raw,['evidence_id','dispatch_id','source','source_id','payload','created_at','signature']);
 const o=parseObservation(env,r.payload,d),created=typeof r.created_at==='string'?Number(r.created_at):r.created_at;
 const id=routineEvidenceHmac(env,'refund-result-id',[o.source,o.sourceId]);
 if(r.evidence_id!==id||r.dispatch_id!==d.dispatch_id||r.source!==o.source||r.source_id!==o.sourceId||!int(created)||!created)return fail();
 const body={evidence_id:id,dispatch_id:d.dispatch_id,source:o.source,source_id:o.sourceId,payload:o,created_at:created};
 if(!routineRefundEqualMac(r.signature,routineEvidenceHmac(env,'refund-result-record',body)))return fail();return{...body,signature:r.signature as string};
}
export async function routineRefundEvidenceTx(tx:DbClient,env:Signing,d:RoutineRefundDispatch):Promise<Evidence[]> {
 const rows=await tx.execute(sql`SELECT * FROM public.routine_refund_provider_evidence WHERE dispatch_id=${d.dispatch_id}
  ORDER BY created_at,evidence_id LIMIT 129`);
 if(rows.length>128||Buffer.byteLength(JSON.stringify(rows),'utf8')>2097152)return fail();return Array.from(rows,r=>evidence(env,r,d));
}
function stableObservation(o:Observation){return{dispatchId:o.dispatchId,dispatchSignature:o.dispatchSignature,source:o.source,
 sourceId:o.sourceId,result:o.result,verifierKey:o.verifierKey,httpStatus:o.httpStatus,
 ...(o.source==='callback'?{responseDigest:o.responseDigest}:{})};}
async function pastApproval(tx:DbClient,env:Signing,o:Observation,statusRead=false):Promise<void>{
 const row=await readRoutineRefundAccountJournalTx(tx,env,o.approval.recordId,statusRead),d=row.payload.data;
 if(!sameRoutineRefund(routineRefundApproval(row),o.approval)||d.state!=='active'||!d.purposes.includes(purpose(o.source))
  ||o.issuedAt<d.validFrom||o.issuedAt>=d.validUntil)return fail();
}
/** Store and mutable projection must share the caller's refund/order TX. */
export async function acceptRoutineRefundResultTx(tx:DbClient,env:Env,d:RoutineRefundDispatch,result:RefundProviderResult):Promise<{replayed:boolean}> {
 if(!await assertRoutineRefundReadInTx(tx))return fail();
 const stored=await readRoutineRefundDispatchTx(tx,env,d.refund_id);
 if(!stored||!sameRoutineRefund(stored,d))return fail();
 const descriptor=result&&typeof result==='object'?Object.getOwnPropertyDescriptor(result,resultSlot):undefined;
 if(!descriptor||!('value'in descriptor))return fail();
 const o=parseObservation(env,descriptor.value,d),s=await snapshot(tx,d.refund_id,true),now=await routineRefundClock(tx);
 await validateRoutineRefundDispatchTx(tx,env,d,s.refund,s.order,s.root,s.payment);
 if(o.result.status!==result.status||o.result.providerRefundId!==(result.providerRefundId??'')||o.result.successTime!==(result.successTime??0)
  ||now<o.verifiedAt-60||now-o.verifiedAt>300||o.result.status==='NOT_FOUND'&&!sameRoutineRefund(o.lease,leaseOf(s.payment)))return fail();
 await pastApproval(tx,env,o);
 const prior=await routineRefundEvidenceTx(tx,env,d),success=prior.find(e=>e.payload.result.status==='SUCCESS');
 if(success&&(o.result.status!=='SUCCESS'||o.result.providerRefundId!==success.payload.result.providerRefundId
  ||o.result.successTime!==success.payload.result.successTime))return fail();
 const known=prior.find(e=>e.payload.result.providerRefundId);
 if(known&&(o.result.status==='NOT_FOUND'||o.result.providerRefundId!==known.payload.result.providerRefundId))return fail();
 const rows=await tx.execute(sql`SELECT * FROM public.routine_refund_provider_evidence WHERE source=${o.source} AND source_id=${o.sourceId} LIMIT 2`);
 if(rows.length){if(rows.length!==1||!sameRoutineRefund(stableObservation(evidence(env,rows[0],d).payload),stableObservation(o)))return fail();return{replayed:true};}
 // Keep a slot for the first genuine SUCCESS; non-final repeated facts must
 // never make a successful provider refund permanently unreadable locally.
 if(prior.length>=(o.result.status==='SUCCESS'?128:127)){
  if(success&&o.result.status==='SUCCESS')return{replayed:true};return fail();
 }
 const id=routineEvidenceHmac(env,'refund-result-id',[o.source,o.sourceId]);
 const body={evidence_id:id,dispatch_id:d.dispatch_id,source:o.source,source_id:o.sourceId,payload:o,created_at:now};
 const signature=routineEvidenceHmac(env,'refund-result-record',body);
 await tx.execute(sql`INSERT INTO public.routine_refund_provider_evidence(evidence_id,dispatch_id,source,source_id,payload,created_at,signature)
  VALUES(${id},${d.dispatch_id},${o.source},${o.sourceId},${JSON.stringify(o)}::jsonb,${now},${signature})`);
 const saved=await tx.execute(sql`SELECT * FROM public.routine_refund_provider_evidence WHERE evidence_id=${id}`);
 if(saved.length!==1||!sameRoutineRefund(evidence(env,saved[0],d),{...body,signature}))return fail();
 return{replayed:false};
}
/** Durable completion/status needs no active approval, registry or new gate. */
export async function assertRoutineRefundProjectionTx(tx:DbClient,env:Signing,refundId:number,statusRead=false):Promise<boolean> {
 if(!await(statusRead?assertRoutineRefundStatusReadTx(tx):assertRoutineRefundReadInTx(tx)))return false;
 const d=await readRoutineRefundDispatchTx(tx,env,refundId,statusRead),s=await snapshot(tx,refundId,false);
 if(!d){
  if(s.payment.provider!=='wechat')return false;
  const rows=await tx.execute(sql`SELECT evidence_id FROM public.routine_original_payment_evidence
   WHERE order_no=${s.root.orderId} OR transaction_id=${s.root.tradeNo} LIMIT 1`);
  if(rows.length)return fail();return false;
 }
 await validateRoutineRefundDispatchTx(tx,env,d,s.refund,s.order,s.root,s.payment,statusRead);
 const rows=await routineRefundEvidenceTx(tx,env,d),p=s.payment;
 for(const row of rows)await pastApproval(tx,env,row.payload,statusRead);
 if(p.providerStatus==='SUCCESS'){
  const success=rows.filter(e=>e.payload.result.status==='SUCCESS');
  if(!success.length||success.some(e=>e.payload.result.providerRefundId!==p.providerRefundId||e.payload.result.successTime!==p.successTime))return fail();
 }else if(['PROCESSING','CLOSED','ABNORMAL'].includes(p.providerStatus)){
  if(!rows.some(e=>e.payload.result.status===p.providerStatus&&e.payload.result.providerRefundId===p.providerRefundId))return fail();
 }else if(!['CREATED','REQUESTING','UNKNOWN','FAILED'].includes(p.providerStatus))return fail();
 return true;
}
export async function assertRoutineRefundRetryTx(tx:DbClient,env:Signing,d:RoutineRefundDispatch,result:RefundProviderResult):Promise<void> {
 const descriptor=result&&typeof result==='object'?Object.getOwnPropertyDescriptor(result,resultSlot):undefined;
 if(!descriptor||!('value'in descriptor))return fail();const o=parseObservation(env,descriptor.value,d);
 const s=await snapshot(tx,d.refund_id,false),rows=await routineRefundEvidenceTx(tx,env,d);
 if(o.source!=='query'||o.result.status!=='NOT_FOUND'||o.httpStatus!==404||!sameRoutineRefund(o.lease,leaseOf(s.payment))
  ||rows.some(row=>row.payload.result.providerRefundId)
  ||!rows.some(row=>sameRoutineRefund(stableObservation(row.payload),stableObservation(o))))return fail();
 const latest=routineRefundApproval(await readRoutineRefundAccountPolicyTx(tx,env,d.payload.approval.accountId,'refund_request',await routineRefundRoleTx(tx)));
 if(!commitmentEqual(latest,d.payload.approval))return fail();
}
