/** Historical admission provenance, not a provider capability. Pure decoding,
 * immutable physical history and fresh first-request checks are separate.
 * A verified provider result MUST be retained before mutable source checks. */
import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Env } from '@/env';
import type { DbClient } from '@/lib/di';
import { assertRechargeRefundRuntimeTx } from '@/migrations/rechargeRefund';
import type { RechargeRefundRuntimeRole } from '@/migrations/rechargeRefundContract';
import { captureAdminRechargeRefundActor,authorizeAdminRechargeRefundTx,type AdminRechargeRefundActor } from '@/services/admin/AdminRechargeRefundActor';
import { captureRechargePaidNoticeBusiness,rechargePaidNoticeObject } from '@/services/order/RechargePaidNoticeCodec';
import { readRechargePaidSettlementForRefundTx } from '@/services/order/RechargePaidNoticeSource';
import { ServiceUnavailableException } from '@/utils/errors';
import { authenticateRechargeRefundRecord,lockRechargeRefundKeyTx } from './RechargeRefundLedger';
import { captureRechargeRefundJson,captureRechargeRefundScope,type RechargeRefundScope } from './RechargeRefundJournalCodec';
import { assertRechargeRefundHoldBillTx,readRechargeRefundStateTx } from './RechargeRefundAccounting';
import { rechargeRefundCents,rechargeRefundId } from './RechargeRefundMoney';
import { parseRoutineOriginalEvidence,type RoutineOriginalEvidence } from './RoutineOriginalPaymentEvidenceCodec';
import { parseRoutineApprovedUse,type RoutineApprovedUse } from './RoutineApprovedPaymentEvidenceCodec';
import { readRoutineApprovedUsesForRechargeRefundTx } from './RoutineApprovedPaymentAccount';
import { readRechargeRoutineRefundAccountJournalTx,readRechargeRoutineRefundAccountPolicyTx,type RechargeRoutineRefundAccountRuntime } from './RechargeRoutineRefundAccount';
import { captureRechargeRefundApprovalReference } from './RechargeRefundAccounting';
import { routineEvidenceCanonical,routineEvidenceHmac,type RoutineProviderFacts } from './RoutineProviderObservation';
import { lockStoreOrderPaymentBoundary } from './StoreOrderPaymentBoundary';

type Signing=Pick<Env,'APP_KEY'>;
const fail=():never=>{throw new ServiceUnavailableException('充值退款原操作历史证据需要人工核对');};
const hex=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
const token=(v:unknown,max:number):v is string=>typeof v==='string'&&new RegExp(`^[A-Za-z0-9._:-]{1,${max}}$`,'u').test(v);
const same=(a:unknown,b:unknown)=>routineEvidenceCanonical(a)===routineEvidenceCanonical(b);
const equal=(a:unknown,b:string)=>hex(a)&&timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
function object(v:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!v||typeof v!=='object'||Array.isArray(v)||![Object.prototype,null].includes(Object.getPrototypeOf(v)))return fail();
 const ds=Object.getOwnPropertyDescriptors(v);
 if(Reflect.ownKeys(ds).length!==keys.length||keys.some(k=>!ds[k]?.enumerable||!('value'in ds[k])))return fail();
 return Object.fromEntries(keys.map(k=>[k,ds[k].value]));
}
function freeze<T>(value:T):T {
 if(value&&typeof value==='object'){
  for(const d of Object.values(Object.getOwnPropertyDescriptors(value)))if('value'in d)freeze(d.value);
  Object.freeze(value);
 }
 return value;
}
const baseScope=(scope:RechargeRefundScope)=>({database:scope.database,databaseOid:scope.databaseOid,
 maintenance:scope.maintenance,maintenanceOid:scope.maintenanceOid});

/** The pinned admission source retains the existing 16KiB finite JSON limit.
 * Appended physical histories have their existing separate 64-row/1MiB bounds;
 * they are not combined into a new source or re-signed as this admission. */
function historyRows(input:unknown):unknown[] {
 let nodes=0,bytes=0;const seen=new Set<object>();
 const visit=(value:unknown,depth:number):unknown=>{
  if(++nodes>32768||depth>24)return fail();
  if(value===null||typeof value==='boolean')return value;
  if(typeof value==='number'){if(!Number.isSafeInteger(value)||Object.is(value,-0))return fail();return value;}
  if(typeof value==='string'){bytes+=Buffer.byteLength(value,'utf8');if(bytes>1048576)return fail();return value;}
  if(!value||typeof value!=='object'||seen.has(value))return fail();seen.add(value);
  try{
   const ds=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(ds);
   if(Array.isArray(value)){
    if(Object.getPrototypeOf(value)!==Array.prototype||value.length>512||keys.length!==value.length+1)return fail();
    return Array.from({length:value.length},(_,i)=>{const d=ds[String(i)];if(!d?.enumerable||!('value'in d))return fail();return visit(d.value,depth+1);});
   }
   if(![Object.prototype,null].includes(Object.getPrototypeOf(value)))return fail();
   if(keys.length>128||keys.some(k=>typeof k!=='string'))return fail();
   const result:Record<string,unknown>=Object.create(null);
   for(const k of keys as string[]){const d=ds[k];if(!d.enumerable||!('value'in d))return fail();bytes+=Buffer.byteLength(k,'utf8');if(bytes>1048576)return fail();result[k]=visit(d.value,depth+1);}
   return result;
  }finally{seen.delete(value);}
 };
 const copied=visit(input,0);
 if(!Array.isArray(copied)||copied.length>64||Buffer.byteLength(routineEvidenceCanonical(copied),'utf8')>1048576)return fail();
 return copied;
}

function settlement(scope:RechargeRefundScope,input:unknown){
 const r=object(input,['scope','business','bill','provider','signature']),business=captureRechargePaidNoticeBusiness(r.business);
 if(!same(r.scope,baseScope(scope))||business.payType!=='weixin')return fail();
 const bill=object(r.bill,['id','uid','linkId','eventKey','pm','category','type','number','balance','status','addTime']);
 if(!same(bill,{id:business.billId,uid:business.userId,linkId:business.orderNo,eventKey:'recharge_external_payment',pm:1,
  category:'now_money',type:'recharge',number:business.creditedAmount,balance:business.postBalance,status:1,addTime:business.payTime}))return fail();
 const descriptor=r.provider&&typeof r.provider==='object'?Object.getOwnPropertyDescriptor(r.provider,'kind'):undefined;
 const callback=descriptor&&'value'in descriptor&&descriptor.value==='callback';
 const provider=rechargePaidNoticeObject(r.provider,callback
  ?['kind','id','replayKey','provider','profile','providerEventId','payloadHash','orderNo','transactionId','tradeState','amountCents','currency']
  :['kind','id','replayKey','provider','profile','orderNo','transactionId','amountCents','initiatedTime']);
 if((provider.kind!=='callback'&&provider.kind!=='signed-query')||!Number.isSafeInteger(provider.id)||Number(provider.id)<1
  ||!uuid(provider.replayKey)||provider.provider!=='wechat'||provider.profile!=='routine'||provider.orderNo!==business.orderNo
  ||provider.transactionId!==business.tradeNo||provider.amountCents!==rechargeRefundCents(business.payPrice)
  ||callback&&(!token(provider.providerEventId,128)||!hex(provider.payloadHash)||provider.tradeState!=='SUCCESS'||provider.currency!=='CNY')
  ||!callback&&(!Number.isSafeInteger(provider.initiatedTime)||Number(provider.initiatedTime)<=0))return fail();
 const unsigned={scope:baseScope(scope),business,bill,provider};
 // The caller checks this complete historical MAC, independently of mutable
 // outbox/provider rows and the current merchant credential registry.
 return{unsigned,signature:r.signature,business};
}

function checkOriginal(original:RoutineOriginalEvidence,operation:ReturnType<typeof authenticateRechargeRefundRecord>,facts:RoutineProviderFacts){
 const b=original.payload.binding,f=original.payload.observation.facts;
 if(!same(f,facts)||b.state!=='bound'||b.local.domain!=='recharge'||b.local.orderId!==operation.recharge_id
  ||b.local.buyerUid!==operation.buyer_uid||b.local.orderNo!==operation.order_no||b.local.amountCents!==operation.principal_cents
  ||b.local.tradeNo!==''&&b.local.tradeNo!==operation.transaction_id||b.local.paid===1&&b.local.payType!=='weixin'
  ||original.order_no!==operation.order_no||original.transaction_id!==operation.transaction_id
  ||f.orderNo!==operation.order_no||f.transactionId!==operation.transaction_id||f.amountCents!==operation.principal_cents
  ||f.currency!=='CNY'||f.tradeState!=='SUCCESS'||f.tradeType!=='JSAPI'||!f.payerId)return fail();
}

/** Pure historical decoding only. An operation/source MAC cannot grant SQL,
 * fresh Admin/account authority, a request lease or a provider POST. */
export function parseRechargeRefundOperationSource(env:Signing,expectedScope:RechargeRefundScope,raw:unknown){
 env={APP_KEY:env.APP_KEY};const scope=captureRechargeRefundScope(expectedScope);
 const operation=authenticateRechargeRefundRecord(env,scope,'recharge_refund_operation',raw);
 if(operation.admission!=='reserved'||!hex(operation.request_hash)||operation.provider!=='wechat'||operation.payment_profile!=='routine'
  ||!token(operation.transaction_id,100)||typeof operation.order_no!=='string'||!/^cz[A-Za-z0-9_-]{1,30}$/u.test(operation.order_no)
  ||typeof operation.principal_cents!=='number'||operation.principal_cents<1||operation.principal_cents>999999999999
  ||typeof operation.gift_cents!=='number'||operation.gift_cents<0||operation.gift_cents>999999999999
  ||typeof operation.reclaim_gift!=='boolean'||typeof operation.debit_cents!=='number'
  ||operation.debit_cents!==operation.principal_cents+(operation.reclaim_gift?operation.gift_cents:0)
  ||typeof operation.wallet_before!=='number'||typeof operation.wallet_after!=='number'
  ||operation.wallet_before<operation.debit_cents||operation.wallet_before>999999999999||operation.wallet_after<0
  ||operation.wallet_after!==operation.wallet_before-operation.debit_cents
  ||operation.out_refund_no!=='CNSCR'+String(operation.operation_id).replaceAll('-',''))return fail();
 rechargeRefundId(operation.admin_id);rechargeRefundId(operation.recharge_id);rechargeRefundId(operation.buyer_uid);
 const payment=object(captureRechargeRefundJson(operation.payment_source),['original','holdBillId','refundApproval']);
 const holdBillId=rechargeRefundId(payment.holdBillId),approval=captureRechargeRefundApprovalReference(payment.refundApproval);
 const original=captureRechargeRefundJson(payment.original),source=object(original,
  ['format','domain','firstSettlement','originals','approvedUseRefs','approvedUseDigest']);
 if(source.format!==2||source.domain!=='recharge'||!hex(source.approvedUseDigest)
  ||!equal(operation.payment_signature,routineEvidenceHmac(env,'recharge-refund-original-source-v1',{scope,source:original})))return fail();
 const first=settlement(scope,source.firstSettlement);
 if(!equal(first.signature,routineEvidenceHmac(env,'subscription-recharge-paid-settlement-v1',first.unsigned))
  ||first.business.orderId!==operation.recharge_id||first.business.userId!==operation.buyer_uid
  ||first.business.orderNo!==operation.order_no||first.business.tradeNo!==operation.transaction_id
  ||rechargeRefundCents(first.business.payPrice)!==operation.principal_cents
  ||rechargeRefundCents(first.business.giftPrice)!==operation.gift_cents)return fail();
 if(!Array.isArray(source.originals)||!source.originals.length||source.originals.length>64)return fail();
 const originals=source.originals.map(row=>parseRoutineOriginalEvidence(env,row)),facts=originals[0].payload.observation.facts;
 for(let i=0;i<originals.length;i++){
  if(i&&originals[i-1].evidence_id>=originals[i].evidence_id)return fail();checkOriginal(originals[i],operation,facts);
 }
 if(!Array.isArray(source.approvedUseRefs)||source.approvedUseRefs.length>64)return fail();
 const refs=source.approvedUseRefs.map(value=>{const r=object(value,['useId','signature']);if(!hex(r.useId)||!hex(r.signature))return fail();return{useId:r.useId,signature:r.signature};});
 if(new Set(refs.map(r=>r.useId)).size!==refs.length)return fail();
 return freeze({scope,operation,original,firstSettlement:source.firstSettlement,business:first.business,originals,
  approvedUseRefs:refs,approvedUseDigest:source.approvedUseDigest,holdBillId,refundApproval:approval,facts,
  appId:facts.appId,merchantId:facts.merchantId});
}
export type RechargeRefundOperationSource=ReturnType<typeof parseRechargeRefundOperationSource>;

/** Pure comparison of supplied physical-row candidates. Every envelope/MAC is
 * decoded again; the return still proves NO row actually exists in PostgreSQL.
 * The SQL reader below separately verifies physical account policies and scope. */
export function reconcileRechargeRefundOperationSourceHistory(env:Signing,scope:RechargeRefundScope,raw:unknown,
 originalRows:unknown,useRows:unknown){
 env={APP_KEY:env.APP_KEY};const pinned=parseRechargeRefundOperationSource(env,scope,raw);
 const originals=historyRows(originalRows).map(row=>parseRoutineOriginalEvidence(env,row));
 if(!originals.length||new Set(originals.map(row=>row.evidence_id)).size!==originals.length)return fail();
 for(let i=0;i<originals.length;i++){
  if(i&&originals[i-1].evidence_id>=originals[i].evidence_id)return fail();checkOriginal(originals[i],pinned.operation,pinned.facts);
 }
 for(const prior of pinned.originals){const found=originals.find(row=>row.evidence_id===prior.evidence_id);if(!found||!same(found,prior))return fail();}
 const uses:RoutineApprovedUse[]=historyRows(useRows).map(rawUse=>{
  const descriptor=rawUse&&typeof rawUse==='object'?Object.getOwnPropertyDescriptor(rawUse,'evidence_id'):undefined;
  const original=originals.find(row=>descriptor&&'value'in descriptor&&row.evidence_id===descriptor.value);if(!original)return fail();
  const decoded=parseRoutineApprovedUse(env,rawUse,baseScope(pinned.scope),original);if(!decoded.payload.scopeMatches)return fail();return decoded;
 });
 for(let i=0;i<uses.length;i++)if(i&&(uses[i-1].evidence_id>uses[i].evidence_id
  ||uses[i-1].evidence_id===uses[i].evidence_id&&uses[i-1].use_id>=uses[i].use_id))return fail();
 if(new Set(uses.map(row=>row.use_id)).size!==uses.length)return fail();
 const pinnedUses=uses.filter(row=>pinned.approvedUseRefs.some(ref=>ref.useId===row.use_id));
 if(pinnedUses.length!==pinned.approvedUseRefs.length||pinnedUses.some((row,i)=>!pinned.originals.some(o=>o.evidence_id===row.evidence_id)
  ||row.use_id!==pinned.approvedUseRefs[i].useId
  ||!equal(row.signature,pinned.approvedUseRefs[i].signature))
  ||!equal(pinned.approvedUseDigest,routineEvidenceHmac(env,'recharge-refund-approved-use-set',pinnedUses)))return fail();
 return freeze({pinned,originals,uses,pinnedUses});
}

async function operationTx(tx:DbClient,env:Signing,scope:RechargeRefundScope,id:unknown){
 if(!uuid(id))return fail();
 const rows=await tx.execute(sql`SELECT * FROM public.recharge_refund_operation WHERE operation_id=${id}::uuid LIMIT 2`);
 if(rows.length!==1)return fail();return parseRechargeRefundOperationSource(env,scope,rows[0]);
}
async function immutableHistoryTx(tx:DbClient,env:Signing,role:RechargeRefundRuntimeRole,mode:'read'|'write',pinned:RechargeRefundOperationSource){
 const op=pinned.operation,rows=await tx.execute(sql`SELECT * FROM public.routine_original_payment_evidence
  WHERE order_no=${op.order_no} OR transaction_id=${op.transaction_id} ORDER BY evidence_id LIMIT 65`);
 const originals=historyRows(Array.from(rows)).map(row=>parseRoutineOriginalEvidence(env,row));
 // This established reader authenticates every current use AND its actually
 // stored immutable account/query policy; no current approval/registry lookup.
 const all=await readRoutineApprovedUsesForRechargeRefundTx(tx,env,originals,role,mode==='read');
 const result=reconcileRechargeRefundOperationSourceHistory(env,pinned.scope,op,originals,all.uses);
 const approval=await readRechargeRoutineRefundAccountJournalTx(tx,env,pinned.refundApproval.recordId,role,mode);
 if(!equal(approval.signature,pinned.refundApproval.signature)||approval.payload.data.appId!==pinned.appId
  ||approval.payload.data.merchantId!==pinned.merchantId)return fail();
 return freeze({...result,approval});
}

/** Actual immutable history only. NO user wallet, paid/refund_price, mutable
 * outbox/callback, current mini AppID, expiry or merchant secrets are read.
 * Do not make successful provider evidence insertion depend on this reader. */
export async function readRechargeRefundOperationHistoryTx(tx:DbClient,env:Signing,role:RechargeRefundRuntimeRole,
 id:unknown,mode:'read'|'write'='read'){
 env={APP_KEY:env.APP_KEY};const scope=await assertRechargeRefundRuntimeTx(tx,role,mode);
 const pinned=await operationTx(tx,env,scope,id);return immutableHistoryTx(tx,env,role,mode,pinned);
}

/** Fresh Admin-only first-request basis, SQL-only. Current wallet balance is
 * deliberately absent: the debit is already reserved. This does NOT insert a
 * sole attempt, issue a lease, read merchant materials or authorize HTTP. */
export async function readAdminRechargeRefundFirstRequestBasisTx(tx:DbClient,env:RechargeRoutineRefundAccountRuntime,
 input:AdminRechargeRefundActor,id:unknown){
 env={APP_KEY:env.APP_KEY,ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS:env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS};
 const actor=captureAdminRechargeRefundActor(input);await authorizeAdminRechargeRefundTx(tx,actor);
 const scope=await assertRechargeRefundRuntimeTx(tx,'admin','write'),pinned=await operationTx(tx,env,scope,id),op=pinned.operation;
 if(actor.id!==op.admin_id)return fail();await lockRechargeRefundKeyTx(tx,actor.id,op.request_key);
 const [locked]=await tx.execute<{id:number}>(sql`SELECT public.recharge_refund_lock_source_v1(${op.recharge_id}::integer) AS id`);
 if(locked?.id!==op.recharge_id)return fail();
 const universe=await tx.execute<{domain:string;id:number}>(sql`SELECT 'recharge' AS domain,id FROM public.user_recharge WHERE order_id=${op.order_no}
  UNION ALL SELECT 'store_order',id FROM public.store_order WHERE order_id=${op.order_no}
  UNION ALL SELECT 'membership',id FROM public.other_order WHERE order_id=${op.order_no} LIMIT 2`);
 if(universe.length!==1||universe[0].domain!=='recharge'||universe[0].id!==op.recharge_id)return fail();
 await lockStoreOrderPaymentBoundary(tx,String(op.order_no));
 const settled=await readRechargePaidSettlementForRefundTx(tx,env,pinned.business,'admin');
 if(!same(settled.event.payload,pinned.firstSettlement)||rechargeRefundCents(settled.order.refundPrice)!==0)return fail();
 const history=await immutableHistoryTx(tx,env,'admin','write',pinned);
 const hold=await assertRechargeRefundHoldBillTx(tx,op),state=await readRechargeRefundStateTx(tx,op);
 const [counts]=await tx.execute<{attempts:string;results:string}>(sql`SELECT
  (SELECT count(*)::text FROM public.recharge_refund_attempt WHERE operation_id=${op.operation_id}::uuid) AS attempts,
  (SELECT count(*)::text FROM public.recharge_refund_result WHERE operation_id=${op.operation_id}::uuid) AS results`);
 if(hold.billId!==pinned.holdBillId||state.status!=='RESERVED'||state.wallet_state!=='held'||state.version!==0
  ||state.attempt_count!==0||state.lease_id!==null||state.lease_until!==null||state.next_query_at!==null
  ||state.provider_refund_id!==null||state.last_result_id!==null||state.updated_at!==state.created_at
  ||counts?.attempts!=='0'||counts.results!=='0')return fail();
 const latest=await readRechargeRoutineRefundAccountPolicyTx(tx,env,{appId:pinned.appId,merchantId:pinned.merchantId},'refund_request','admin');
 const prior=history.approval.payload.data,live=latest.payload.data;
 if(prior.state!=='active'||!prior.purposes.includes('refund_request')
  ||['accountId','appId','merchantId','credentialRef','credentialVersion','credentialStamp'].some(k=>
   prior[k as keyof typeof prior]!==live[k as keyof typeof live]))return fail();
 // The caller must claim its one immutable request+lease in THIS TX and then
 // perform transport after commit under a separately authenticated capability.
 return freeze({history,hold,state,latestApproval:latest});
}
