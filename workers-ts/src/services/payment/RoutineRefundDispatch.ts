import { createHash, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { eq, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import type { DbClient } from '@/lib/di';
import { storeOrder, storeOrderRefund, storeOrderRefundPayment } from '@/models/schema';
import { assertRoutineRefundReadInTx, assertRoutineRefundStatusReadTx, inspectRoutineRefundCatalog } from '@/migrations/routineRefund';
import { ServiceUnavailableException } from '@/utils/errors';
import { amountToCents, type RefundProviderRequest } from './RefundGateway';
import { routineEvidenceCanonical, routineEvidenceHmac } from './RoutineProviderObservation';
import { parseRoutineOriginalEvidence } from './RoutineOriginalPaymentEvidence';
import { readRoutineApprovedUsesForRefundTx } from './RoutineApprovedPaymentAccount';
import { readRoutineRefundOriginalTx } from './RoutineRefundOriginal';
import { assertNativeAppExcludedForRoutineRefundTx } from './NativeAppRefundProviderAuthority';
import { readRoutineRefundAccountJournalTx, selectRoutineRefundAccountPolicyTx } from './RoutineRefundAccountPolicy';

type Signing=Pick<Env,'APP_KEY'>;
type Refund=typeof storeOrderRefund.$inferSelect;
type Order=typeof storeOrder.$inferSelect;
type Payment=typeof storeOrderRefundPayment.$inferSelect;
type Scope={database:string;databaseOid:string;maintenance:string;maintenanceOid:string};
export type RoutineRefundApproval={recordId:string;signature:string;accountId:string;appId:string;merchantId:string;
 credentialRef:string;credentialVersion:number;credentialStamp:string};
type Actor={kind:'app'}|{kind:'financial';actorUid:number;requestKey:string;requestHash:string;serviceId:number;receiptDigest:string};
export interface RoutineRefundDispatch {
 dispatch_id:string;refund_id:number;out_refund_no:string;created_at:number;signature:string;
 payload:{format:1;purpose:'routine_refund_dispatch';scope:Scope;
  identity:{refundId:number;refundNo:string;childId:number;rootId:number;buyerUid:number;storeId:number;supplierId:number};
  request:Required<RefundProviderRequest>;approval:RoutineRefundApproval;original:{evidenceId:string;signature:string};
  actor:Actor;notifyUrl:string};
}
export const routineRefundUnavailable=():never=>{throw new ServiceUnavailableException('原账号退款凭据或首次受理记录尚未完整就绪，请维护后核对原退款单');};
const fail=routineRefundUnavailable;
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0&&Number(v)<=2147483647;
const nonnegative=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0&&Number(v)<=2147483647;
const token=(v:unknown,n=64):v is string=>typeof v==='string'&&new RegExp(`^[A-Za-z0-9_-]{1,${n}}$`,'u').test(v);
const hex=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
export const sameRoutineRefund=(a:unknown,b:unknown)=>routineEvidenceCanonical(a)===routineEvidenceCanonical(b);
export function routineRefundEqualMac(a:unknown,b:string):boolean {
 return hex(a)&&timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
}
export function freezeRoutineRefund<T>(v:T):T {
 if(v&&typeof v==='object'){for(const d of Object.values(Object.getOwnPropertyDescriptors(v)))if('value'in d)freezeRoutineRefund(d.value);Object.freeze(v);}return v;
}
export function routineRefundRecord(v:unknown,keys:readonly string[]):Record<string,unknown> {
 if(!v||typeof v!=='object'||Array.isArray(v)||![Object.prototype,null].includes(Object.getPrototypeOf(v)))return fail();
 const ds=Object.getOwnPropertyDescriptors(v);
 if(Reflect.ownKeys(v).length!==keys.length||keys.some(k=>!ds[k]?.enumerable||!('value'in ds[k])))return fail();
 return v as Record<string,unknown>;
}
export const routineRefundDigest=(v:unknown)=>createHash('sha256').update(routineEvidenceCanonical(v)).digest('hex');
export async function routineRefundClock(tx:DbClient):Promise<number> {
 const[r]=await tx.execute<{now:string}>(sql`SELECT floor(extract(epoch FROM pg_catalog.clock_timestamp()))::bigint AS now`);
 const now=Number(r?.now);if(!positive(now))return fail();return now;
}
async function scope(tx:DbClient):Promise<Scope> {
 const[c]=await tx.execute<Scope>(sql`SELECT pg_catalog.current_database() AS database,
 (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS "databaseOid",
 pg_catalog.pg_get_userbyid(relowner) AS maintenance,relowner::text AS "maintenanceOid"
 FROM pg_catalog.pg_class WHERE oid=pg_catalog.to_regclass('public.routine_refund_dispatch')`);
 if(!c||!token(c.database,128)||!token(c.maintenance,128)||!/^\d+$/u.test(c.databaseOid)||!/^\d+$/u.test(c.maintenanceOid))return fail();return{...c};
}
export function routineRefundApproval(row:Awaited<ReturnType<typeof readRoutineRefundAccountJournalTx>>):RoutineRefundApproval {
 const d=row.payload.data;return{recordId:row.record_id,signature:row.signature,accountId:d.accountId,appId:d.appId,
 merchantId:d.merchantId,credentialRef:d.credentialRef,credentialVersion:d.credentialVersion,credentialStamp:d.credentialStamp};
}
export function routineRefundMaterialsReference(d:RoutineRefundDispatch){const a=d.payload.approval;return{appId:a.appId,
 merchantId:a.merchantId,credentialRef:a.credentialRef,credentialVersion:a.credentialVersion,credentialStamp:a.credentialStamp};}
export async function routineRefundRoleTx(tx:DbClient):Promise<'app'|'financial'> {
 const c=await inspectRoutineRefundCatalog(tx),[r]=await tx.execute<{name:string}>(sql`SELECT current_user AS name`);
 if(c.ready&&r?.name===c.binding?.app)return'app';
 if(c.ready&&c.binding?.financial&&r?.name===c.binding.financial)return'financial';return fail();
}
function callbackUrl(origin:unknown,id:string):string {
 if(typeof origin!=='string'||origin.length>200)return fail();
 let u:URL;try{u=new URL(origin);}catch{return fail();}
 if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/'||u.origin!==origin
  ||u.hostname==='localhost'||u.hostname.endsWith('.localhost')||!u.hostname.includes('.'))return fail();
 return`${origin}/api/pay/notify/routine-refund/${id}`;
}
function decode(env:Signing,raw:unknown,s:Scope):RoutineRefundDispatch {
 const r=routineRefundRecord(raw,['dispatch_id','refund_id','out_refund_no','payload','created_at','signature']);
 const p=routineRefundRecord(r.payload,['format','purpose','scope','identity','request','approval','original','actor','notifyUrl']);
 const i=routineRefundRecord(p.identity,['refundId','refundNo','childId','rootId','buyerUid','storeId','supplierId']);
 const q=routineRefundRecord(p.request,['outTradeNo','transactionId','outRefundNo','refundAmount','totalAmount','reason']);
 const a=routineRefundRecord(p.approval,['recordId','signature','accountId','appId','merchantId','credentialRef','credentialVersion','credentialStamp']);
 const o=routineRefundRecord(p.original,['evidenceId','signature']);
 const actorKind=p.actor&&typeof p.actor==='object'?Object.getOwnPropertyDescriptor(p.actor,'kind')?.value:undefined;
 const actor=routineRefundRecord(p.actor,actorKind==='app'?['kind']:['kind','actorUid','requestKey','requestHash','serviceId','receiptDigest']);
 const created=typeof r.created_at==='string'&&/^[1-9][0-9]*$/u.test(r.created_at)?Number(r.created_at):r.created_at;
 if(!hex(r.dispatch_id)||!positive(r.refund_id)||!positive(created)||r.out_refund_no!=='CNSR'+r.refund_id
  ||p.format!==1||p.purpose!=='routine_refund_dispatch'||!sameRoutineRefund(p.scope,s)
  ||i.refundId!==r.refund_id||!token(i.refundNo)||!positive(i.childId)||!positive(i.rootId)||!positive(i.buyerUid)
  ||!nonnegative(i.storeId)||!nonnegative(i.supplierId)||!token(q.outTradeNo)||!token(q.transactionId,100)
  ||q.outRefundNo!==r.out_refund_no||!positive(q.refundAmount)||!positive(q.totalAmount)||q.refundAmount>q.totalAmount
  ||typeof q.reason!=='string'||q.reason.length>512||!uuid(a.recordId)||!hex(a.signature)||!token(a.accountId)||!token(a.appId,32)
  ||typeof a.merchantId!=='string'||!/^\d{1,32}$/u.test(a.merchantId)||!token(a.credentialRef)||!positive(a.credentialVersion)
  ||!hex(a.credentialStamp)||!hex(o.evidenceId)||!hex(o.signature)
  ||actor.kind!=='app'&&(actor.kind!=='financial'||!positive(actor.actorUid)||!uuid(actor.requestKey)||!hex(actor.requestHash)
   ||!positive(actor.serviceId)||!hex(actor.receiptDigest))||typeof p.notifyUrl!=='string')return fail();
 const id=routineEvidenceHmac(env,'refund-dispatch-id',{scope:s,refundId:r.refund_id});
 if(r.dispatch_id!==id||!p.notifyUrl.endsWith('/api/pay/notify/routine-refund/'+id))return fail();
 const origin=p.notifyUrl.slice(0,-('/api/pay/notify/routine-refund/'+id).length);
 if(callbackUrl(origin,id)!==p.notifyUrl)return fail();
 const body={dispatch_id:r.dispatch_id,refund_id:r.refund_id,out_refund_no:r.out_refund_no,payload:p,created_at:created};
 if(!routineRefundEqualMac(r.signature,routineEvidenceHmac(env,'refund-dispatch-record',body)))return fail();
 return freezeRoutineRefund({...body,signature:r.signature}) as RoutineRefundDispatch;
}
/** Historical row authentication only; no secret lookup or active policy. */
export async function readRoutineRefundDispatchTx(tx:DbClient,env:Signing,refundId:number,statusRead=false):Promise<RoutineRefundDispatch|null> {
 if(!positive(refundId))return fail();
 if(!await(statusRead?assertRoutineRefundStatusReadTx(tx):assertRoutineRefundReadInTx(tx)))return null;
 const rows=await tx.execute(sql`SELECT * FROM public.routine_refund_dispatch WHERE refund_id=${refundId} LIMIT 2`);
 if(rows.length>1)return fail();return rows[0]?decode(env,rows[0],await scope(tx)):null;
}
export async function readRoutineRefundDispatchIdTx(tx:DbClient,env:Signing,id:string):Promise<RoutineRefundDispatch> {
 if(!hex(id)||!await assertRoutineRefundReadInTx(tx))return fail();
 const rows=await tx.execute(sql`SELECT * FROM public.routine_refund_dispatch WHERE dispatch_id=${id} LIMIT 2`);
 if(rows.length!==1)return fail();return decode(env,rows[0],await scope(tx));
}
/** Preserve the immutable Financial provider-admitted v1 receipt as it is.
 * A new actor's lawful resume does not overwrite the first actor's provenance. */
async function financialActor(tx:DbClient,env:Signing,refund:Refund,order:Order):Promise<Actor> {
 const catalog=await inspectRoutineRefundCatalog(tx);
 const[identity]=await tx.execute<{name:string}>(sql`SELECT current_user AS name`);
 if(identity?.name===catalog.binding?.app)return{kind:'app'};
 if(!catalog.binding?.financial||identity?.name!==catalog.binding.financial)return fail();
 const rows=await tx.execute<{actor_uid:number;request_key:string;request_hash:string;service_id:number;row:unknown}>(sql`
  SELECT actor_uid,request_key::text,request_hash,service_id,
   (to_jsonb(t)-'created_at')||jsonb_build_object('created_at',floor(extract(epoch FROM created_at))::bigint) AS row
  FROM public.customer_financial_operation_request t WHERE order_id=${order.id} AND kind='refund_execute'
   AND outcome='provider-admitted' AND evidence->>'refund_id'=${String(refund.id)}
  ORDER BY created_at,actor_uid,request_key LIMIT 65`);
 if(!rows.length||rows.length>64||Buffer.byteLength(JSON.stringify(rows),'utf8')>1048576)return fail();
 const r=rows[0];if(!positive(r.actor_uid)||!positive(r.service_id)||!uuid(r.request_key)||!hex(r.request_hash))return fail();
 return{kind:'financial',actorUid:r.actor_uid,requestKey:r.request_key,requestHash:r.request_hash,serviceId:r.service_id,
  receiptDigest:routineEvidenceHmac(env,'refund-financial-receipt',r.row)};
}
function matchesPhysical(d:RoutineRefundDispatch,refund:Refund,order:Order,root:Order,payment:Payment):void {
 const i=d.payload.identity,q=d.payload.request;
 if(refund.id!==i.refundId||refund.orderId!==i.refundNo||refund.storeOrderId!==i.childId||order.id!==i.childId||root.id!==i.rootId
  ||refund.uid!==i.buyerUid||order.uid!==i.buyerUid||root.uid!==i.buyerUid||refund.storeId!==i.storeId||order.storeId!==i.storeId
  ||refund.supplierId!==i.supplierId||order.supplierId!==i.supplierId||order.paid!==1||root.paid!==1||order.payType!=='weixin'
  ||root.payType!=='weixin'||(order.pid>0?order.pid:order.id)!==root.id||root.orderId!==q.outTradeNo||root.tradeNo!==q.transactionId
  ||amountToCents(refund.refundPrice)!==q.refundAmount||amountToCents(root.payPrice)!==q.totalAmount
  ||payment.refundId!==refund.id||payment.storeOrderId!==order.id||payment.provider!=='wechat'||payment.outRefundNo!==q.outRefundNo
  ||payment.requestAmount!==q.refundAmount||payment.totalAmount!==q.totalAmount)return fail();
}
/** Validate the durable original/first approval even after approval retirement
 * or secret withdrawal. Never acquires a fresh gate under order locks. */
export async function validateRoutineRefundDispatchTx(tx:DbClient,env:Signing,d:RoutineRefundDispatch,
 refund:Refund,order:Order,root:Order,payment:Payment,statusRead=false):Promise<void> {
 matchesPhysical(d,refund,order,root,payment);
 const a=await readRoutineRefundAccountJournalTx(tx,env,d.payload.approval.recordId,statusRead);
 if(!sameRoutineRefund(routineRefundApproval(a),d.payload.approval)||a.payload.data.state!=='active'
  ||!a.payload.data.purposes.includes('refund_request')||d.created_at<a.payload.data.validFrom||d.created_at>=a.payload.data.validUntil)return fail();
 const q=d.payload.request,rows=await tx.execute(sql`SELECT * FROM public.routine_original_payment_evidence
 WHERE order_no=${q.outTradeNo} OR transaction_id=${q.transactionId} ORDER BY evidence_id LIMIT 65`);
 if(!rows.length||rows.length>64||Buffer.byteLength(JSON.stringify(rows),'utf8')>1048576)return fail();
 const originals=Array.from(rows,r=>parseRoutineOriginalEvidence(env,r)),anchor=originals.find(r=>r.evidence_id===d.payload.original.evidenceId);
 if(!anchor||anchor.signature!==d.payload.original.signature)return fail();
 const canonical=anchor.payload.observation.facts,i=d.payload.identity;
 for(const r of originals){const f=r.payload.observation.facts,b=r.payload.binding;
  if(!sameRoutineRefund(f,canonical)||f.appId!==a.payload.data.appId||f.merchantId!==a.payload.data.merchantId
   ||f.orderNo!==q.outTradeNo||f.transactionId!==q.transactionId||f.amountCents!==q.totalAmount
   ||b.state!=='bound'||b.local.domain!=='store_order'||b.local.orderId!==i.rootId||b.local.buyerUid!==i.buyerUid
   ||b.local.orderNo!==q.outTradeNo||b.local.amountCents!==q.totalAmount
   ||b.local.tradeNo!==''&&b.local.tradeNo!==q.transactionId||b.local.paid===1&&b.local.payType!=='weixin')return fail();}
 await readRoutineApprovedUsesForRefundTx(tx,env,originals,statusRead);
 const actor=d.payload.actor;
 const[reader]=await tx.execute<{name:string}>(sql`SELECT current_user AS name`);
 if(actor.kind==='financial'&&reader?.name===(await inspectRoutineRefundCatalog(tx)).binding?.financial){
  const rows=await tx.execute<{row:unknown}>(sql`SELECT
   (to_jsonb(t)-'created_at')||jsonb_build_object('created_at',floor(extract(epoch FROM created_at))::bigint) AS row
   FROM public.customer_financial_operation_request t
   WHERE actor_uid=${actor.actorUid} AND request_key=${actor.requestKey}::uuid AND request_hash=${actor.requestHash}
    AND service_id=${actor.serviceId} AND order_id=${i.childId} AND kind='refund_execute' AND outcome='provider-admitted'
    AND evidence->>'refund_id'=${String(i.refundId)} LIMIT 2`);
  // App has deliberately no Financial ledger SELECT. Only the actual Financial
  // consumer verifies this separate owner receipt; dispatch HMAC preserves it.
  if(rows.length!==1||routineEvidenceHmac(env,'refund-financial-receipt',rows[0].row)!==actor.receiptDigest)return fail();
 }
}
/** Called after the existing actor callback persisted provider-admitted and
 * before REQUESTING commits, with physical root/child/refund locks held. */
export async function admitRoutineRefundDispatchTx(tx:DbClient,env:Env,refund:Refund,order:Order,root:Order,
 payment:Payment,request:RefundProviderRequest):Promise<RoutineRefundDispatch|null> {
 if(!await assertRoutineRefundReadInTx(tx))return null;
 const prior=await readRoutineRefundDispatchTx(tx,env,refund.id);
 if(prior){await validateRoutineRefundDispatchTx(tx,env,prior,refund,order,root,payment);
  if(!sameRoutineRefund(prior.payload.request,request))return fail();return prior;}
 // An already touched CNSR has no recorded historical first merchant. Payment
 // evidence alone cannot retroactively establish that refund's first request.
 const original=await readRoutineRefundOriginalTx(tx,env,{rootOrderId:root.id,buyerUid:root.uid,orderNo:root.orderId,
  transactionId:request.transactionId??'',totalAmount:request.totalAmount});
 if(!original)return null;
 if(payment.providerStatus!=='CREATED'||payment.attemptCount!==0||payment.requestTime!==0||payment.queryTime!==0
  ||payment.notifyTime!==0||payment.providerRefundId||!request.transactionId||request.reason===undefined)return fail();
 const facts=original.evidence.payload.observation.facts;
 const approval=await selectRoutineRefundAccountPolicyTx(tx,env,{appId:facts.appId,merchantId:facts.merchantId},'refund_request');
 await assertNativeAppExcludedForRoutineRefundTx(tx,env,request,original);
 const s=await scope(tx),id=routineEvidenceHmac(env,'refund-dispatch-id',{scope:s,refundId:refund.id}),now=await routineRefundClock(tx);
 const[deadline]=await tx.execute<{ready:boolean}>(sql`SELECT pg_catalog.clock_timestamp()<=pg_catalog.transaction_timestamp()+interval '8 seconds' AS ready`);
 if(now<approval.payload.data.validFrom||now>=approval.payload.data.validUntil||deadline?.ready!==true)return fail();
 const payload:RoutineRefundDispatch['payload']={format:1,purpose:'routine_refund_dispatch',scope:s,
  identity:{refundId:refund.id,refundNo:refund.orderId,childId:order.id,rootId:root.id,buyerUid:refund.uid,storeId:refund.storeId,supplierId:refund.supplierId},
  request:{...request,transactionId:request.transactionId,reason:request.reason},approval:routineRefundApproval(approval),
  original:{evidenceId:original.evidence.evidence_id,signature:original.evidence.signature},actor:await financialActor(tx,env,refund,order),
  notifyUrl:callbackUrl(env.ROUTINE_REFUND_NOTIFY_ORIGIN,id)};
 const body={dispatch_id:id,refund_id:refund.id,out_refund_no:request.outRefundNo,payload,created_at:now};
 const signed={...body,signature:routineEvidenceHmac(env,'refund-dispatch-record',body)};
 matchesPhysical(signed,refund,order,root,payment);
 await tx.execute(sql`INSERT INTO public.routine_refund_dispatch(dispatch_id,refund_id,out_refund_no,payload,created_at,signature)
 VALUES(${id},${refund.id},${request.outRefundNo},${JSON.stringify(payload)}::jsonb,${now},${signed.signature})`);
 const saved=await readRoutineRefundDispatchTx(tx,env,refund.id);if(!saved||!sameRoutineRefund(saved,signed))return fail();return saved;
}
/** Stabilize the root without waiting after a caller's child/refund locks. */
export async function routineRefundRootTx(tx:DbClient,order:Order):Promise<Order> {
 if(order.pid<=0)return order;
 const rows=await tx.select().from(storeOrder).where(eq(storeOrder.id,order.pid)).limit(2).for('update',{noWait:true});
 if(rows.length!==1)return fail();return rows[0];
}

/** Availability metadata only. A snapshot can show the historical account's
 * readiness without borrowing current merchant readiness or minting a lease.
 * The fresh, gated physical admission remains mandatory before any I/O. */
export async function routineRefundOrderReadinessTx(tx:DbClient,env:Env,root:Order,refund?:Refund):Promise<boolean|null>{
 const[mode]=await tx.execute<{ro:boolean}>(sql`SELECT pg_catalog.current_setting('transaction_read_only')='on' AS ro`);
 const ro=mode?.ro===true;
 if(!await(ro?assertRoutineRefundStatusReadTx(tx):assertRoutineRefundReadInTx(tx)))return null;
 const rows=await tx.execute(sql`SELECT * FROM public.routine_original_payment_evidence
  WHERE order_no=${root.orderId} OR transaction_id=${root.tradeNo} ORDER BY evidence_id LIMIT 65`);
 if(!rows.length)return null;
 if(rows.length>64||Buffer.byteLength(JSON.stringify(rows),'utf8')>1048576||root.paid!==1||root.payType!=='weixin')return fail();
 const originals=Array.from(rows,r=>parseRoutineOriginalEvidence(env,r)),f=originals[0].payload.observation.facts;
 for(const row of originals){const b=row.payload.binding;
  if(!sameRoutineRefund(f,row.payload.observation.facts)||f.orderNo!==root.orderId||f.transactionId!==root.tradeNo
   ||f.amountCents!==amountToCents(root.payPrice)||b.state!=='bound'||b.local.domain!=='store_order'
   ||b.local.orderId!==root.id||b.local.buyerUid!==root.uid||b.local.amountCents!==f.amountCents
   ||b.local.orderNo!==root.orderId||b.local.tradeNo!==''&&b.local.tradeNo!==root.tradeNo
   ||b.local.paid===1&&b.local.payType!=='weixin')return fail();}
 await readRoutineApprovedUsesForRefundTx(tx,env,originals,ro);
 const existing=refund?await readRoutineRefundDispatchTx(tx,env,refund.id,ro):null;
 if(!existing)callbackUrl(env.ROUTINE_REFUND_NOTIFY_ORIGIN,'0'.repeat(64));
 const selected=await selectRoutineRefundAccountPolicyTx(tx,env,{appId:f.appId,merchantId:f.merchantId},
  existing?'refund_query':'refund_request',ro?'read-snapshot':'write-snapshot');
 if(existing&&!sameRoutineRefund(routineRefundMaterialsReference(existing),{
  appId:selected.payload.data.appId,merchantId:selected.payload.data.merchantId,credentialRef:selected.payload.data.credentialRef,
  credentialVersion:selected.payload.data.credentialVersion,credentialStamp:selected.payload.data.credentialStamp}))return fail();
 return true;
}
