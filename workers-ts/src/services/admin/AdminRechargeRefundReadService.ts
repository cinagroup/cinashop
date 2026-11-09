/** Dedicated-current-Admin RR/RO receipt and execution views. No provider I/O,
 * economic writer, mutable current wallet, or caller-supplied ready proof. */
import { eq,or,sql } from 'drizzle-orm';
import type { Env } from '@/env';
import type { Container,DbClient } from '@/lib/di';
import { capitalFlow,storeOrderOutbox,userBill } from '@/models/schema';
import { assertRechargeRoutineRefundAccountRuntimeTx } from '@/migrations/rechargeRoutineRefundAccount';
import { ServiceUnavailableException } from '@/utils/errors';
import { normalizeOutRequestKey } from '@/services/out/OutIdempotency';
import { captureAdminRechargeRefundActor,authorizeAdminRechargeRefundTx,type AdminRechargeRefundActor } from './AdminRechargeRefundActor';
import { readRechargeRefundOperationTx,authenticateRechargeRefundRecord,type RechargeRefundRecord } from '@/services/payment/RechargeRefundLedger';
import { RECHARGE_REFUND_VERSION } from '@/services/payment/RechargeRefundRequest';
import { captureRechargeRefundState,assertRechargeRefundHoldBillTx,type RechargeRefundStateRow } from '@/services/payment/RechargeRefundAccounting';
import { rechargeRefundCents,rechargeRefundDecimal,rechargeRefundId } from '@/services/payment/RechargeRefundMoney';
import { readRechargeRefundOperationHistoryTx } from '@/services/payment/RechargeRefundOperationSource';
import { parseRechargeRefundFirstRequest } from '@/services/payment/RechargeRefundFirstRequest';
import { readRechargeRefundFirstProviderResultTx } from '@/services/payment/RechargeRefundFirstProviderResult';
import { readRechargeRefundQueryEconomicHistoryTx,rechargeRefundQueryEconomicHistoryInput } from '@/services/payment/RechargeRefundQueryEconomicHistory';
import { RECHARGE_QUERY_HISTORY_LIMITS } from '@/services/payment/RechargeRefundQueryHistoryCodec';
import { parseRechargeRefundCallbackProviderUniverse } from '@/services/payment/RechargeRefundCallbackHistoryCodec';
import { readRechargeRefundCallbackEconomicHistoryTx,rechargeRefundCallbackEconomicHistoryInput } from '@/services/payment/RechargeRefundCallbackEconomicHistory';
import { parseRechargeRefundCallbackLocalCaptureResult,type RechargeRefundCallbackCaptureFacts } from '@/services/payment/RechargeRefundCallbackLocalCaptureCodec';
import { parseRechargeRefundCallbackLocalReleaseResult,type RechargeRefundCallbackReleaseFacts } from '@/services/payment/RechargeRefundCallbackLocalReleaseCodec';
import { parseRechargeRefundLocalCaptureResult,type RechargeRefundCaptureFacts,type RechargeRefundCaptureNoticeRow } from '@/services/payment/RechargeRefundLocalCaptureCodec';
import { parseRechargeRefundQueryLocalCaptureResult,type RechargeRefundQueryCaptureFacts } from '@/services/payment/RechargeRefundQueryLocalCaptureCodec';
import { parseRechargeRefundLocalReleaseResult,type RechargeRefundReleaseFacts } from '@/services/payment/RechargeRefundLocalReleaseCodec';
import { parseRechargeRefundQueryLocalReleaseResult,type RechargeRefundQueryReleaseFacts } from '@/services/payment/RechargeRefundQueryLocalReleaseCodec';
import { readRechargeRefundCountedFirstEconomicHistoryTx,rechargeRefundCountedFirstEconomicHistoryInput } from '@/services/payment/RechargeRefundCountedFirstEconomicHistory';
import { parseRechargeRefundCountedFirstLocalCaptureResult,type RechargeRefundCountedFirstCaptureFacts } from '@/services/payment/RechargeRefundCountedFirstLocalCaptureCodec';
import { parseRechargeRefundCountedFirstLocalReleaseResult,type RechargeRefundCountedFirstReleaseFacts } from '@/services/payment/RechargeRefundCountedFirstLocalReleaseCodec';
import { routineEvidenceCanonical } from '@/services/payment/RoutineProviderObservation';

type Signing=Pick<Env,'APP_KEY'>;
export interface AdminRechargeRefundReceipt {
 readonly version:typeof RECHARGE_REFUND_VERSION;readonly operationId:string;readonly rechargeId:number;
 readonly requestHash:string;readonly recoverGift:boolean|null;readonly admission:'reserved'|'rejected_insufficient'|'abandoned';
 readonly principal:string|null;readonly gift:string|null;readonly walletDebitCents:number|null;
 readonly balanceBefore:string|null;readonly postBalance:string|null;readonly createdAt:number;
}
export interface AdminRechargeRefundExecution {
 readonly operationId:string;readonly phase:'not_requested'|'awaiting_provider'|'awaiting_local'|'succeeded'|'released'|'cancelled'|'manual_review'|'rejected_insufficient'|'abandoned';
 readonly wallet:'held'|'captured'|'released'|'none';readonly attemptCount:number;readonly nextQueryAt:number|null;
}
export interface AdminRechargeRefundView {readonly receipt:AdminRechargeRefundReceipt;readonly execution:AdminRechargeRefundExecution}
const fail=():never=>{throw new ServiceUnavailableException('充值退款执行证据暂不可核对，请保留原请求人工处理');};
const same=(a:unknown,b:unknown)=>routineEvidenceCanonical(a)===routineEvidenceCanonical(b);
const money=(v:unknown,signed=false):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&!Object.is(v,-0)
 &&v>=(signed?-999999999999:0)&&v<=999999999999;
function object(v:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!v||typeof v!=='object'||Array.isArray(v)||![Object.prototype,null].includes(Object.getPrototypeOf(v)))return fail();
 const d=Object.getOwnPropertyDescriptors(v);if(Reflect.ownKeys(d).length!==keys.length||keys.some(k=>!d[k]?.enumerable||!('value'in d[k])))return fail();
 return Object.fromEntries(keys.map(k=>[k,d[k].value]));
}
async function bounded(tx:DbClient){
 await tx.execute(sql`SET LOCAL search_path TO public,pg_temp`);
 await tx.execute(sql`SELECT pg_catalog.set_config('statement_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000),5000)::text||'ms',true),
  pg_catalog.set_config('lock_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000),1000)::text||'ms',true),
  pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000),5000)::text||'ms',true)`);
}
export async function projectAdminRechargeRefundReceipt(op:RechargeRefundRecord,actorId:number,key:string):Promise<AdminRechargeRefundReceipt>{
 // The installed immutable journal retains the request HASH, not its quote
 // fingerprint/body. Never fabricate either from a later quote. Recovery by
 // key is independent of that body; a future first POST still needs the
 // caller's exact original body (or the caller can cancel its unused hold).
 if(op.admin_id!==rechargeRefundId(actorId)||op.request_key!==normalizeOutRequestKey(key)
  ||typeof op.request_hash!=='string'||!/^[a-f0-9]{64}$/u.test(op.request_hash)
  ||typeof op.created_at!=='number'||!Number.isSafeInteger(op.created_at)||op.created_at<1||op.created_at>2147483647)return fail();
 const common={version:RECHARGE_REFUND_VERSION,operationId:String(op.operation_id),rechargeId:rechargeRefundId(op.recharge_id),requestHash:op.request_hash,createdAt:op.created_at};
 if(op.admission==='abandoned'){
  if(['buyer_uid','order_no','provider','payment_profile','transaction_id','payment_source','payment_signature','principal_cents','gift_cents','reclaim_gift',
   'debit_cents','wallet_before','wallet_after','out_refund_no'].some(k=>op[k]!==null))return fail();
  return Object.freeze({...common,recoverGift:null,admission:'abandoned',principal:null,gift:null,walletDebitCents:null,balanceBefore:null,postBalance:null});
 }
 if(!['reserved','rejected_insufficient'].includes(String(op.admission))||!money(op.principal_cents)||op.principal_cents<=0||!money(op.gift_cents)
  ||typeof op.reclaim_gift!=='boolean'||op.debit_cents!==op.principal_cents+(op.reclaim_gift?op.gift_cents:0)
  ||!money(op.wallet_before,true)||!money(op.wallet_after,true)
  ||op.admission==='reserved'&&(op.wallet_before<Number(op.debit_cents)||op.wallet_after!==op.wallet_before-Number(op.debit_cents))
  ||op.admission==='rejected_insufficient'&&(op.wallet_before>=Number(op.debit_cents)||op.wallet_after!==op.wallet_before))return fail();
 return Object.freeze({...common,recoverGift:op.reclaim_gift,admission:op.admission as 'reserved'|'rejected_insufficient',principal:rechargeRefundDecimal(op.principal_cents),
  gift:rechargeRefundDecimal(op.gift_cents),walletDebitCents:Number(op.debit_cents),balanceBefore:rechargeRefundDecimal(op.wallet_before),postBalance:rechargeRefundDecimal(op.wallet_after)});
}
async function noSuccessArtifacts(tx:DbClient,id:string){
 const [r]=await tx.execute<{found:boolean}>(sql`SELECT
  EXISTS(SELECT 1 FROM public.capital_flow WHERE event_key=${'recharge.refund:'+id} OR flow_id=${id.replaceAll('-','')})
  OR EXISTS(SELECT 1 FROM public.store_order_outbox WHERE event_key=${'recharge.refund.success.notice:'+id}) AS found`);
 if(r?.found!==false)return fail();
}
async function releaseBill(tx:DbClient,f:Pick<RechargeRefundReleaseFacts,'bill'>){
 const rows=await tx.select().from(userBill).where(or(eq(userBill.id,f.bill.id),eq(userBill.eventKey,f.bill.eventKey))).limit(3),r=rows[0],b=f.bill;
 if(rows.length!==1||r.id!==b.id||r.uid!==b.uid||r.linkId!==b.linkId||r.eventKey!==b.eventKey||r.pm!==b.pm||r.category!==b.category
  ||r.type!==b.type||r.title!==b.title||rechargeRefundCents(r.number)!==b.numberCents||rechargeRefundCents(r.balance,true)!==b.balanceCents
  ||r.status!==b.status||r.take!==b.take||r.frozenTime!==b.frozenTime||r.addTime!==b.addTime||r.mark!==b.mark)return fail();
}
async function physicalNotice(tx:DbClient,local:RechargeRefundRecord,id:string):Promise<RechargeRefundCaptureNoticeRow>{
 const e=object(local.evidence,['format','purpose','scope','settlement','settlementCommitment','noticeIntent']),link=object(e.noticeIntent,['id','eventKey','payloadSignature']);
 if(!Number.isSafeInteger(link.id)||Number(link.id)<1||Number(link.id)>2147483647||link.eventKey!=='recharge.refund.success.notice:'+id)return fail();
 const rows=await tx.select({id:storeOrderOutbox.id,eventKey:storeOrderOutbox.eventKey,aggregateType:storeOrderOutbox.aggregateType,aggregateId:storeOrderOutbox.aggregateId,
  eventType:storeOrderOutbox.eventType,payload:storeOrderOutbox.payload,addTime:storeOrderOutbox.addTime}).from(storeOrderOutbox)
  .where(or(eq(storeOrderOutbox.id,Number(link.id)),eq(storeOrderOutbox.eventKey,String(link.eventKey)))).limit(3),r=rows[0];
 if(rows.length!==1||r.id!==link.id||r.eventKey!==link.eventKey||r.aggregateType!=='recharge'||r.eventType!=='recharge.refund.success.notice')return fail();
 return{...r,aggregateType:'recharge',eventType:'recharge.refund.success.notice'};
}
async function physicalFlow(tx:DbClient,f:Pick<RechargeRefundCaptureFacts,'flow'|'operation'>){
 const b=f.flow,rows=await tx.select().from(capitalFlow).where(or(eq(capitalFlow.id,b.id),eq(capitalFlow.eventKey,b.eventKey),eq(capitalFlow.flowId,b.flowId))).limit(4),r=rows[0];
 if(rows.length!==1||r.id!==b.id||r.eventKey!==b.eventKey||r.flowId!==b.flowId||r.orderId!==b.orderId||r.storeId!==b.storeId||r.uid!==b.uid
  ||rechargeRefundCents(r.price,true)!==b.priceCents||r.tradingType!==b.tradingType||r.payType!==b.payType||r.addTime!==b.addTime||r.nickname!==b.nickname||r.phone!==b.phone)return fail();
 // Legacy Admin mark editing is presentation-only; the receipt retains its original mark.
 const release=await tx.select({id:userBill.id}).from(userBill).where(eq(userBill.eventKey,'recharge_refund_release:'+f.operation.id)).limit(1);
 if(release.length)return fail();
}
async function cancelled(tx:DbClient,env:Signing,op:RechargeRefundRecord,s:RechargeRefundStateRow,results:readonly RechargeRefundRecord[]):Promise<AdminRechargeRefundExecution>{
 if(results.length!==2)return fail();const c=results.find(r=>r.source==='local_cancel'),r=results.find(v=>v.source==='local_release');if(!c||!r)return fail();
 const a=object(c.evidence,['format','adminId','requestKey','reason','previousVersion']),b=object(r.evidence,['format','reason','holdBillId','releaseBillId','walletBeforeCents','walletAfterCents','debitCents','previousVersion','nextVersion']);
 const id=String(op.operation_id),hold=await assertRechargeRefundHoldBillTx(tx,op);
 if(c.operation_id!==id||r.operation_id!==id||c.source_id!=='cancel:'+id||r.source_id!=='release:'+id||c.status!=='CLOSED'||r.status!=='SUCCESS'
  ||c.attempt_id!==null||r.attempt_id!==null||c.caused_by_result_id!==null||r.caused_by_result_id!==c.result_id||c.created_at!==r.created_at
  ||a.format!==1||a.adminId!==op.admin_id||a.requestKey!==op.request_key||a.reason!=='admin_cancel_before_post'||a.previousVersion!==0
  ||b.format!==1||b.reason!==a.reason||b.holdBillId!==hold.billId||!Number.isSafeInteger(b.releaseBillId)||Number(b.releaseBillId)<1||Number(b.releaseBillId)>2147483647
  ||!money(b.walletBeforeCents,true)||!money(b.walletAfterCents,true)||b.debitCents!==op.debit_cents||b.walletAfterCents!==b.walletBeforeCents+Number(op.debit_cents)
  ||b.previousVersion!==0||b.nextVersion!==1||s.status!=='FAILED'||s.wallet_state!=='released'||s.version!==1||s.attempt_count!==0
  ||s.last_result_id!==r.result_id||s.updated_at!==r.created_at||s.provider_refund_id!==null||s.lease_id!==null||s.lease_until!==null||s.next_query_at!==null)return fail();
 const bills=await tx.select().from(userBill).where(or(eq(userBill.id,Number(b.releaseBillId)),eq(userBill.eventKey,'recharge_refund_release:'+id))).limit(3),bill=bills[0];
 if(bills.length!==1||bill.id!==b.releaseBillId||bill.id===hold.billId||bill.uid!==op.buyer_uid||bill.linkId!==op.order_no||bill.eventKey!=='recharge_refund_release:'+id
  ||bill.pm!==1||bill.category!=='now_money'||bill.type!=='recharge_refund_release'||bill.title!=='取消充值退款退回预留'
  ||rechargeRefundCents(bill.number)!==b.debitCents||rechargeRefundCents(bill.balance,true)!==b.walletAfterCents||bill.status!==1||bill.take!==0||bill.frozenTime!==0
  ||bill.addTime!==r.created_at||bill.mark!=='渠道请求尚未发出，退回原充值退款预留')return fail();
 const source=await readRechargeRefundOperationHistoryTx(tx,env,'admin',id,'read');if(!same(source.pinned.operation,op)||source.pinned.holdBillId!==hold.billId)return fail();
 await noSuccessArtifacts(tx,id);return{operationId:id,phase:'cancelled',wallet:'released',attemptCount:0,nextQueryAt:null};
}
async function executionTx(tx:DbClient,env:Signing,op:RechargeRefundRecord):Promise<AdminRechargeRefundExecution>{
 const id=String(op.operation_id);
 if(op.admission!=='reserved')return{operationId:id,phase:op.admission==='abandoned'?'abandoned':'rejected_insufficient',wallet:'none',attemptCount:0,nextQueryAt:null};
 const stateRows=await tx.execute(sql`SELECT * FROM public.recharge_refund_state WHERE operation_id=${id}::uuid LIMIT 2`);
 if(stateRows.length!==1)return fail();const s=captureRechargeRefundState(stateRows[0],op);
 const attempts=await tx.execute(sql`SELECT * FROM public.recharge_refund_attempt WHERE operation_id=${id}::uuid ORDER BY ordinal LIMIT ${RECHARGE_QUERY_HISTORY_LIMITS.attempts+1}`);
 const raw=await tx.execute(sql`SELECT * FROM public.recharge_refund_result WHERE operation_id=${id}::uuid ORDER BY created_at,result_id LIMIT ${RECHARGE_QUERY_HISTORY_LIMITS.results+2}`);
 if(raw.length>RECHARGE_QUERY_HISTORY_LIMITS.results+1)return fail();
 const scope=await assertRechargeRoutineRefundAccountRuntimeTx(tx,'admin','read'),rows=Array.from(raw,r=>authenticateRechargeRefundRecord(env,scope,'recharge_refund_result',r));
 if(!attempts.length){
  if(rows.length)return cancelled(tx,env,op,s,rows);
  if(s.status!=='RESERVED'||s.wallet_state!=='held'||s.version!==0||s.attempt_count!==0||s.last_result_id!==null||s.provider_refund_id!==null
   ||s.lease_id!==null||s.lease_until!==null||s.next_query_at!==null||s.updated_at!==s.created_at)return fail();
  await assertRechargeRefundHoldBillTx(tx,op);return{operationId:id,phase:'not_requested',wallet:'held',attemptCount:0,nextQueryAt:null};
 }
 const first=parseRechargeRefundFirstRequest(env,scope,op,attempts[0]),policies=await tx.execute(sql`SELECT * FROM public.recharge_routine_refund_account_policy
  WHERE account_id=${first.payload.approval.accountId} ORDER BY revision LIMIT ${RECHARGE_QUERY_HISTORY_LIMITS.policies+1}`);
 const locals=rows.filter(r=>['local_settlement','local_release','local_cancel'].includes(String(r.source)));if(locals.length>1||locals[0]?.source==='local_cancel')return fail();
 const local=locals[0]??null;
 if(local&&(s.last_result_id!==local.result_id||!['SUCCEEDED','FAILED'].includes(s.status)||!['captured','released'].includes(s.wallet_state)))return fail();
 const providers=local?rows.filter(r=>r.result_id!==local.result_id):rows;
 const universe=parseRechargeRefundCallbackProviderUniverse(env,scope,op,Array.from(attempts),Array.from(policies),providers),history=universe.requestQueryHistory,n=history.totalAttempts;
 const hold=await assertRechargeRefundHoldBillTx(tx,op),source=await readRechargeRefundOperationHistoryTx(tx,env,'admin',id,'read');
 if(!same(source.pinned.operation,op)||source.pinned.holdBillId!==hold.billId)return fail();
 if(!local){
  const tail=history.attempts.at(-1)!;
  if(s.wallet_state!=='held'||s.status!==(n===1?'SUBMITTING':'UNKNOWN')||s.version!==n||s.attempt_count!==n||s.lease_id!==tail.lease_id
   ||s.lease_until!==Number(tail.created_at)+30||s.next_query_at!==Number(tail.created_at)+60||s.updated_at!==tail.created_at
   ||s.last_result_id!==null||s.provider_refund_id!==null)return fail();
  const phase=universe.disposition==='manual_review'||n===64&&universe.disposition==='unresolved'?'manual_review'
   :universe.disposition==='terminal_evidence'?'awaiting_local':'awaiting_provider';
  return{operationId:id,phase,wallet:'held',attemptCount:n,nextQueryAt:phase==='awaiting_provider'?history.earliestNextQueryAt:null};
 }
 if(universe.disposition!=='terminal_evidence'||s.last_result_id!==local.result_id)return fail();
 const cause=[...history.results,...universe.callbacks].find(r=>r.record.result_id===local.caused_by_result_id);if(!cause)return fail();
 const capture=local.source==='local_settlement';let facts:RechargeRefundCaptureFacts|RechargeRefundReleaseFacts|RechargeRefundQueryCaptureFacts|RechargeRefundQueryReleaseFacts|RechargeRefundCallbackCaptureFacts|RechargeRefundCallbackReleaseFacts|RechargeRefundCountedFirstCaptureFacts|RechargeRefundCountedFirstReleaseFacts;
 if(cause.record.source==='callback'){
  const h=await readRechargeRefundCallbackEconomicHistoryTx(tx,env,'admin',id,cause.record.result_id,local.result_id,'read');
  if(!same(h.basis.operation,op)||!same(h.local,local)||!same(h.state,s))return fail();
  const input=rechargeRefundCallbackEconomicHistoryInput(h.basis);
  if(capture)facts=parseRechargeRefundCallbackLocalCaptureResult(env,scope,input,local,await physicalNotice(tx,local,id)).facts;
  else facts=parseRechargeRefundCallbackLocalReleaseResult(env,scope,input,local).facts;
 }else if(cause.record.source==='query'){
  const h=await readRechargeRefundQueryEconomicHistoryTx(tx,env,'admin',id,cause.record.result_id,local.result_id,'read');
  if(!same(h.basis.operation,op)||!same(h.local,local)||!same(h.state,s))return fail();
  const input=rechargeRefundQueryEconomicHistoryInput(h.basis);
  if(capture)facts=parseRechargeRefundQueryLocalCaptureResult(env,scope,input,local,await physicalNotice(tx,local,id)).facts;
  else facts=parseRechargeRefundQueryLocalReleaseResult(env,scope,input,local).facts;
 }else if(cause.record.source==='request'&&n>=2){
  const h=await readRechargeRefundCountedFirstEconomicHistoryTx(tx,env,'admin',id,cause.record.result_id,local.result_id,'read');
  if(!same(h.basis.operation,op)||!same(h.local,local)||!same(h.state,s))return fail();
  const input=rechargeRefundCountedFirstEconomicHistoryInput(h.basis);
  if(capture)facts=parseRechargeRefundCountedFirstLocalCaptureResult(env,scope,input,local,await physicalNotice(tx,local,id)).facts;
  else facts=parseRechargeRefundCountedFirstLocalReleaseResult(env,scope,input,local).facts;
 }else{
  if(cause.record.source!=='request'||n!==1||history.results.length!==1)return fail();
  const h=await readRechargeRefundFirstProviderResultTx(tx,env,'admin',id,cause.record.result_id,'read');
  const input={operation:h.operation,attempt:h.attempt,providerResult:h.record,approval:h.approval};
  if(!same(h.operation,op))return fail();
  if(capture)facts=parseRechargeRefundLocalCaptureResult(env,scope,input,local,await physicalNotice(tx,local,id)).facts;
  else facts=parseRechargeRefundLocalReleaseResult(env,scope,input,local).facts;
 }
 if(facts.holdBillId!==hold.billId||s.status!==(capture?'SUCCEEDED':'FAILED')||s.wallet_state!==(capture?'captured':'released')
  ||s.version!==facts.projection.afterVersion||s.attempt_count!==n||s.provider_refund_id!==cause.observation.providerRefundId
  ||s.lease_id!==null||s.lease_until!==null||s.next_query_at!==null||s.updated_at!==local.created_at)return fail();
 if('flow'in facts)await physicalFlow(tx,facts);else{await releaseBill(tx,facts);await noSuccessArtifacts(tx,id);}
 return{operationId:id,phase:capture?'succeeded':'released',wallet:capture?'captured':'released',attemptCount:n,nextQueryAt:null};
}
async function view(container:Container,env:Signing,input:AdminRechargeRefundActor,requestKey:unknown,execution:boolean):Promise<AdminRechargeRefundView|null>{
 if(!Object.hasOwn(container.db,'$client'))return fail();const actor=captureAdminRechargeRefundActor(input),key=normalizeOutRequestKey(requestKey);
 return container.db.transaction(async raw=>{
  const tx=raw as unknown as DbClient;await bounded(tx);await assertRechargeRoutineRefundAccountRuntimeTx(tx,'admin','read');
  await authorizeAdminRechargeRefundTx(tx,actor,'read');
  const op=await readRechargeRefundOperationTx(tx,env,actor.id,key,'read');if(!op)return null;
  const receipt=await projectAdminRechargeRefundReceipt(op,actor.id,key);
  const state=execution?await executionTx(tx,env,op):undefined;
  const [deadline]=await tx.execute<{ready:boolean}>(sql`SELECT pg_catalog.clock_timestamp()<=pg_catalog.transaction_timestamp()+interval '5 seconds' AS ready`);if(deadline?.ready!==true)return fail();
  return{receipt,execution:state??{operationId:receipt.operationId,phase:'not_requested',wallet:'none',attemptCount:0,nextQueryAt:null}};
 },{isolationLevel:'repeatable read',accessMode:'read only'});
}
export async function lookupAdminRechargeRefundReceipt(container:Container,env:Signing,actor:AdminRechargeRefundActor,key:unknown):Promise<AdminRechargeRefundReceipt|null>{
 return(await view(container,env,actor,key,false))?.receipt??null;
}
export function lookupAdminRechargeRefundExecution(container:Container,env:Signing,actor:AdminRechargeRefundActor,key:unknown):Promise<AdminRechargeRefundView|null>{
 return view(container,env,actor,key,true);
}
