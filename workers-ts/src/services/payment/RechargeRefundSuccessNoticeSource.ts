/** Physical, actual-App success-notice source across all four monetary cause
 * families. No caller payload/receipt supplies send authority. Complete mixed
 * truth is rechecked; late consistent observations do not rewrite the cause. */
import {eq,or,sql}from 'drizzle-orm';
import type {Env}from '@/env';
import type {DbClient}from '@/lib/di';
import {capitalFlow,storeOrderOutbox,userBill}from '@/models/schema';
import {assertRechargeRoutineRefundAccountRuntimeTx}from '@/migrations/rechargeRoutineRefundAccount';
import {ServiceUnavailableException}from '@/utils/errors';
import {captureRechargeRefundScope,type RechargeRefundScope}from './RechargeRefundJournalCodec';
import {captureRechargeRefundState,assertRechargeRefundHoldBillTx}from './RechargeRefundAccounting';
import {readRechargeRefundOperationHistoryTx}from './RechargeRefundOperationSource';
import {parseRechargeRefundFirstProviderResult}from './RechargeRefundFirstProviderResult';
import {parseRechargeRefundCallbackProviderUniverse}from './RechargeRefundCallbackHistoryCodec';
import {readRechargeRefundMixedProviderHistoryTx,rechargeRefundMixedHistoryInput}from './RechargeRefundMixedProviderHistory';
import {parseRechargeRefundQueryEconomicBasis}from './RechargeRefundQueryEconomicHistory';
import {parseRechargeRefundCallbackEconomicBasis}from './RechargeRefundCallbackEconomicHistory';
import {parseRechargeRefundCountedFirstEconomicBasis}from './RechargeRefundCountedFirstEconomicHistory';
import {parseRechargeRefundLocalCaptureResult,type RechargeRefundCaptureFacts,type RechargeRefundCaptureNoticeRow}from './RechargeRefundLocalCaptureCodec';
import {parseRechargeRefundQueryLocalCaptureResult,type RechargeRefundQueryCaptureFacts}from './RechargeRefundQueryLocalCaptureCodec';
import {parseRechargeRefundCallbackLocalCaptureResult,type RechargeRefundCallbackCaptureFacts}from './RechargeRefundCallbackLocalCaptureCodec';
import {parseRechargeRefundCountedFirstLocalCaptureResult,type RechargeRefundCountedFirstCaptureFacts}from './RechargeRefundCountedFirstLocalCaptureCodec';
import {rechargeRefundCents}from './RechargeRefundMoney';
import {routineEvidenceCanonical,routineEvidenceHmac}from './RoutineProviderObservation';
import {authenticateRechargeRefundRecord,type RechargeRefundRecord}from './RechargeRefundLedger';
type Signing=Pick<Env,'APP_KEY'>;
export type RechargeRefundSuccessNoticeFamily='first'|'counted-first'|'query'|'callback';
export type RechargeRefundSuccessNoticeFacts=RechargeRefundCaptureFacts|RechargeRefundQueryCaptureFacts|RechargeRefundCallbackCaptureFacts|RechargeRefundCountedFirstCaptureFacts;
const fail=():never=>{throw new ServiceUnavailableException('充值退款成功通知的原结算与完整渠道证据暂不可核对');};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
const same=(a:unknown,b:unknown)=>routineEvidenceCanonical(a)===routineEvidenceCanonical(b);
const id=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0&&v<=2147483647;
import {rechargeRefundSuccessNoticeKey,RECHARGE_REFUND_SUCCESS_NOTICE_PREFIX as prefix}from './RechargeRefundSuccessNoticeKey';
export {rechargeRefundSuccessNoticeKey}from './RechargeRefundSuccessNoticeKey';
export interface RechargeRefundSuccessNoticeHistoryInput{
 readonly operation:unknown;readonly attempts:unknown;readonly policies:unknown;readonly results:unknown;
 readonly state:unknown;readonly local:unknown;readonly notice:unknown;
}
/** Pure MAC/data decoder only. Physical readers below independently establish
 * actual LOGIN, rows and footprints; this result is never a sending permit. */
export function parseRechargeRefundSuccessNoticeHistory(env:Signing,expectedScope:RechargeRefundScope,input:RechargeRefundSuccessNoticeHistoryInput){
 if(!input||typeof input!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(input)))return fail();
 const keys=['operation','attempts','policies','results','state','local','notice'],d=Object.getOwnPropertyDescriptors(input);
 if(Reflect.ownKeys(d).length!==keys.length||keys.some(k=>!d[k]?.enumerable||!('value'in d[k])))return fail();
 const row=Object.fromEntries(keys.map(k=>[k,d[k].value])),scope=captureRechargeRefundScope(expectedScope);
 const u=parseRechargeRefundCallbackProviderUniverse(env,scope,row.operation,row.attempts,row.policies,row.results),h=u.requestQueryHistory;
 const state=captureRechargeRefundState(row.state,h.operation);
 if(u.disposition!=='terminal_evidence'||!uuid(state.last_result_id)||state.wallet_state!=='captured'||state.status!=='SUCCEEDED')return fail();
 // Each selected family authenticates the actual local and distinct notice.
 // No request/query/callback cause is relabelled to fit another codec.
 const raw=authenticateRechargeRefundRecord(env,scope,'recharge_refund_result',row.local),cause=[...h.results,...u.callbacks].find(r=>r.record.result_id===raw?.caused_by_result_id);
 if(!cause||cause.observation.status!=='SUCCESS')return fail();
 const economic={...rechargeRefundMixedHistoryInput(u),providerResultId:cause.record.result_id};
 let family:RechargeRefundSuccessNoticeFamily,facts:RechargeRefundSuccessNoticeFacts,local:RechargeRefundRecord;
 if(cause.record.source==='callback'){
  parseRechargeRefundCallbackEconomicBasis(env,scope,economic);
  const p=parseRechargeRefundCallbackLocalCaptureResult(env,scope,economic,row.local,row.notice);family='callback';facts=p.facts;local=p.record;
 }else if(cause.record.source==='query'){
  parseRechargeRefundQueryEconomicBasis(env,scope,economic);
  const p=parseRechargeRefundQueryLocalCaptureResult(env,scope,economic,row.local,row.notice);family='query';facts=p.facts;local=p.record;
 }else if(cause.record.source==='request'&&h.totalAttempts>=2){
  parseRechargeRefundCountedFirstEconomicBasis(env,scope,economic);
  const p=parseRechargeRefundCountedFirstLocalCaptureResult(env,scope,economic,row.local,row.notice);family='counted-first';facts=p.facts;local=p.record;
 }else{
  if(cause.record.source!=='request'||h.totalAttempts!==1)return fail();
  const first=parseRechargeRefundFirstProviderResult(env,scope,h.operation,h.first.attempt,cause.record,h.firstApproval);
  const p=parseRechargeRefundLocalCaptureResult(env,scope,{operation:first.operation,attempt:first.attempt,providerResult:first.record,approval:first.approval},row.local,row.notice);
  family='first';facts=p.facts;local=p.record;
 }
 if(local.result_id!==state.last_result_id||state.version!==h.totalAttempts+1||state.version!==facts.projection.afterVersion||state.attempt_count!==h.totalAttempts
  ||state.provider_refund_id!==cause.observation.providerRefundId||state.lease_id!==null||state.lease_until!==null||state.next_query_at!==null
  ||state.updated_at!==local.created_at||state.updated_at!==facts.capturedAt)return fail();
 return Object.freeze({scope,operation:h.operation,state,local,cause:cause.record,family,facts,universe:u});
}
async function context(tx:DbClient){
 if(Object.hasOwn(tx,'$client'))return fail();await tx.execute(sql`SET LOCAL search_path TO public,pg_temp`);
 await tx.execute(sql`SELECT pg_catalog.set_config('statement_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000),5000)::text||'ms',true),
  pg_catalog.set_config('lock_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000),1000)::text||'ms',true),
  pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000),5000)::text||'ms',true)`);
 // Address-only, nonblocking lower-order maintenance gates. Current explicit
 // subscription readiness/approval is proved separately before any Mini send.
 for(const gate of [731663,731664,731669,731714,731716,731717,731718,731725,731726]){
  const [r]=await tx.execute<{locked:boolean}>(sql`SELECT pg_catalog.pg_try_advisory_xact_lock_shared(${gate},0)AS locked`);if(r?.locked!==true)return fail();
 }
}
export async function prepareRechargeRefundSuccessNoticeContextTx(tx:DbClient,mode:'read'|'write'='write'){await context(tx);await assertRechargeRoutineRefundAccountRuntimeTx(tx,'app',mode);}
export async function readRechargeRefundSuccessNoticeSourceTx(tx:DbClient,env:Signing,input:{outboxId:number;eventKey:string},mode:'read'|'write'='write'){
 if(!id(input.outboxId)||!rechargeRefundSuccessNoticeKey(input.eventKey))return fail();await context(tx);
 const scope=await assertRechargeRoutineRefundAccountRuntimeTx(tx,'app',mode),operationId=input.eventKey.slice(prefix.length);
 const events=await tx.select().from(storeOrderOutbox).where(or(eq(storeOrderOutbox.id,input.outboxId),eq(storeOrderOutbox.eventKey,input.eventKey))).limit(3),event=events[0];
 if(events.length!==1||event.id!==input.outboxId||event.eventKey!==input.eventKey||event.eventType!=='recharge.refund.success.notice'||event.aggregateType!=='recharge')return fail();
 const states=await tx.execute(sql`SELECT last_result_id FROM public.recharge_refund_state WHERE operation_id=${operationId}::uuid LIMIT 2`);
 if(states.length!==1||!uuid(states[0].last_result_id))return fail();
 const physical=await readRechargeRefundMixedProviderHistoryTx(tx,env,'app',operationId,states[0].last_result_id,mode);
 if(!physical.local)return fail();
 const notice:RechargeRefundCaptureNoticeRow={id:event.id,eventKey:event.eventKey,aggregateType:'recharge',aggregateId:event.aggregateId,eventType:'recharge.refund.success.notice',payload:event.payload as RechargeRefundCaptureNoticeRow['payload'],addTime:event.addTime};
 const source=parseRechargeRefundSuccessNoticeHistory(env,scope,{...rechargeRefundMixedHistoryInput(physical.universe),state:physical.state,local:physical.local,notice}),f=source.facts;
 const op=await readRechargeRefundOperationHistoryTx(tx,env,'app',operationId,mode),hold=await assertRechargeRefundHoldBillTx(tx,source.operation);
 if(!same(op.pinned.operation,source.operation)||hold.billId!==f.holdBillId||op.pinned.holdBillId!==f.holdBillId||event.aggregateId!==f.recharge.id||event.addTime!==f.capturedAt
  ||op.pinned.appId!==f.recharge.appId||op.pinned.merchantId!==f.recharge.merchantId)return fail();
 const b=f.flow,flows=await tx.select().from(capitalFlow).where(or(eq(capitalFlow.id,b.id),eq(capitalFlow.eventKey,b.eventKey),eq(capitalFlow.flowId,b.flowId))).limit(4),flow=flows[0];
 if(flows.length!==1||flow.id!==b.id||flow.eventKey!==b.eventKey||flow.flowId!==b.flowId||flow.orderId!==b.orderId||flow.storeId!==b.storeId||flow.uid!==b.uid
  ||rechargeRefundCents(flow.price,true)!==b.priceCents||flow.tradingType!==b.tradingType||flow.payType!==b.payType||flow.addTime!==b.addTime||flow.nickname!==b.nickname||flow.phone!==b.phone)return fail();
 const releases=await tx.select({id:userBill.id}).from(userBill).where(eq(userBill.eventKey,'recharge_refund_release:'+operationId)).limit(1);if(releases.length)return fail();
 const [deadline]=await tx.execute<{ready:boolean}>(sql`SELECT pg_catalog.clock_timestamp()<=pg_catalog.transaction_timestamp()+interval '5 seconds' AS ready`);if(deadline?.ready!==true)return fail();
 // Bind immutable selected cause/receipt/notice/source, not mutable dispatch
 // counters, current wallet or additional later consistent provider rows.
 const sourceDigest=routineEvidenceHmac(env,'recharge-refund-success-notice-physical-v1',[source.operation.signature,source.local.signature,source.cause.signature,event.id,event.eventKey,event.payload,event.addTime,op.pinned.original,f]);
 return Object.freeze({...source,event,pinned:op.pinned,sourceDigest});
}
