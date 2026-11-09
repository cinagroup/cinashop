/** Sole first-POST SUCCESS to local capture, in one owning SQL transaction.
 * No HTTP, provider I/O, Queue send, query/callback or new permission is added.
 * External truth has already committed independently; any local refusal leaves
 * it intact. Historical replay verifies physical immutable links, not current
 * wallet/refund/store/actor/credentials or readiness of a new financial write. */
import { randomUUID } from 'node:crypto';
import { and,eq,or,sql } from 'drizzle-orm';
import type { Env } from '@/env';
import type { Container,DbClient } from '@/lib/di';
import { capitalFlow,storeOrderOutbox,user,userBill,userRecharge } from '@/models/schema';
import { assertRechargeRefundRuntimeTx,type RechargeRefundRuntimeRole } from '@/migrations/rechargeRefund';
import { prepareRechargeRefundNoticeTx } from '@/migrations/rechargeRefundNotice';
import { ServiceUnavailableException } from '@/utils/errors';
import { readRechargePaidSettlementForRefundTx } from '@/services/order/RechargePaidNoticeSource';
import { assertRechargeRefundCaptureWritePrerequisitesTx } from './RechargeRefundCaptureWritePrerequisites';
import { assertRechargeRefundHoldBillTx,readRechargeRefundStateTx,type RechargeRefundStateRow } from './RechargeRefundAccounting';
import { readRechargeRefundFirstProviderResultTx,type RechargeRefundFirstProviderResult } from './RechargeRefundFirstProviderResult';
import { readRechargeRefundOperationHistoryTx } from './RechargeRefundOperationSource';
import { authenticateRechargeRefundRecord,insertRechargeRefundEvidenceTx,lockRechargeRefundKeyTx,
 readRechargeRefundOperationByIdTx,type RechargeRefundRecord } from './RechargeRefundLedger';
import { captureRechargeRefundCaptureFacts,parseRechargeRefundLocalCaptureResult,signRechargeRefundLocalCaptureResult,
 signRechargeRefundSuccessNoticeIntent,type RechargeRefundCaptureFacts,type RechargeRefundCaptureNoticeRow } from './RechargeRefundLocalCaptureCodec';
import { rechargeRefundCents,rechargeRefundDecimal } from './RechargeRefundMoney';
import { lockStoreOrderPaymentBoundary } from './StoreOrderPaymentBoundary';
import { routineEvidenceCanonical } from './RoutineProviderObservation';
import { readRechargeRefundMixedProviderHistoryTx } from './RechargeRefundMixedProviderHistory';

type Signing=Pick<Env,'APP_KEY'>;
const fail=():never=>{throw new ServiceUnavailableException('充值退款成功本地结算需要人工核对，请保留原操作');};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
const same=(a:unknown,b:unknown)=>routineEvidenceCanonical(a)===routineEvidenceCanonical(b);
const historyInput=(h:RechargeRefundFirstProviderResult)=>({operation:h.operation,attempt:h.attempt,providerResult:h.record,approval:h.approval});
const flowKey=(id:string)=>'recharge.refund:'+id;
const noticeKey=(id:string)=>'recharge.refund.success.notice:'+id;
const flowId=(id:string)=>id.replaceAll('-','');

async function boundedContext(tx:DbClient){
 await tx.execute(sql`SET LOCAL search_path TO public,pg_temp`);
 await tx.execute(sql`SELECT pg_catalog.set_config('statement_timeout',
  LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
  pg_catalog.set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
  pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
 const [r]=await tx.execute<{ready:boolean}>(sql`SELECT pg_catalog.current_setting('role')='none' AND current_user=session_user
  AND pg_catalog.current_setting('session_replication_role')='origin' AS ready`);
 if(r?.ready!==true)return fail();
}
async function finish<T>(tx:DbClient,value:T):Promise<T>{
 const [r]=await tx.execute<{ready:boolean}>(sql`SELECT pg_catalog.clock_timestamp()<=pg_catalog.transaction_timestamp()+interval '5 seconds' AS ready`);
 if(r?.ready!==true)return fail();return value;
}

/** Preserve the original sole-request cause and dedicated receipt while
 * checking every later callback for consistent identities and terminal truth. */
async function universe(tx:DbClient,env:Signing,role:RechargeRefundRuntimeRole,h:RechargeRefundFirstProviderResult,local?:RechargeRefundRecord){
 const physical=await readRechargeRefundMixedProviderHistoryTx(tx,env,role,h.operation.operation_id,local?.result_id);
 const u=physical.universe,q=u.requestQueryHistory;
 if(u.disposition!=='terminal_evidence'||q.totalAttempts!==1||!same(q.scope,h.scope)||!same(q.operation,h.operation)
  ||!same(q.first.attempt,h.attempt)||!same(q.firstApproval,h.approval)||!q.results.some(row=>same(row.record,h.record))
  ||!same(physical.local,local??null))return fail();
 const release=await tx.select({id:userBill.id}).from(userBill)
  .where(eq(userBill.eventKey,'recharge_refund_release:'+String(h.operation.operation_id))).limit(2);
 if(release.length)return fail();
}
async function noOrphans(tx:DbClient,operationId:string){
 const [r]=await tx.execute<{found:boolean}>(sql`SELECT
  EXISTS(SELECT 1 FROM public.capital_flow WHERE event_key=${flowKey(operationId)} OR flow_id=${flowId(operationId)})
  OR EXISTS(SELECT 1 FROM public.store_order_outbox WHERE event_key=${noticeKey(operationId)}) AS found`);
 if(r?.found!==false)return fail();
}

/** Fresh: compare all13 columns. Replay: the existing Admin setMark API may
 * edit only mark; all12 identity/financial/snapshot fields remain exact. The
 * immutable receipt always retains the originally captured mark. */
async function physicalFlow(tx:DbClient,f:RechargeRefundCaptureFacts['flow'],fresh:boolean){
 const rows=await tx.select().from(capitalFlow).where(or(eq(capitalFlow.id,f.id),eq(capitalFlow.eventKey,f.eventKey),eq(capitalFlow.flowId,f.flowId))).limit(4);
 const r=rows[0];
 if(rows.length!==1||r.id!==f.id||r.eventKey!==f.eventKey||r.flowId!==f.flowId||r.orderId!==f.orderId||r.storeId!==f.storeId
  ||r.uid!==f.uid||rechargeRefundCents(r.price,true)!==f.priceCents||r.tradingType!==f.tradingType||r.payType!==f.payType
  ||r.addTime!==f.addTime||r.nickname!==f.nickname||r.phone!==f.phone||fresh&&r.mark!==f.mark)return fail();
}
async function physicalNotice(tx:DbClient,id:number,key:string):Promise<RechargeRefundCaptureNoticeRow>{
 const rows=await tx.select({id:storeOrderOutbox.id,eventKey:storeOrderOutbox.eventKey,aggregateType:storeOrderOutbox.aggregateType,
  aggregateId:storeOrderOutbox.aggregateId,eventType:storeOrderOutbox.eventType,payload:storeOrderOutbox.payload,addTime:storeOrderOutbox.addTime})
  .from(storeOrderOutbox).where(or(eq(storeOrderOutbox.id,id),eq(storeOrderOutbox.eventKey,key))).limit(3);
 const r=rows[0];
 if(rows.length!==1||r.id!==id||r.eventKey!==key||r.aggregateType!=='recharge'||r.eventType!=='recharge.refund.success.notice')return fail();
 return {...r,aggregateType:'recharge',eventType:'recharge.refund.success.notice'};
}

async function replay(tx:DbClient,env:Signing,role:RechargeRefundRuntimeRole,h:RechargeRefundFirstProviderResult,state:RechargeRefundStateRow){
 if(state.status!=='SUCCEEDED'||state.wallet_state!=='captured'||!uuid(state.last_result_id))return fail();
 const rows=await tx.execute(sql`SELECT * FROM public.recharge_refund_result WHERE operation_id=${h.operation.operation_id}::uuid
  AND result_id=${state.last_result_id}::uuid LIMIT 2`);
 if(rows.length!==1)return fail();
 // Authenticate before extracting the bounded physical notice address. The
 // complete closed capture codec subsequently rejects any wrong evidence shape.
 const local=authenticateRechargeRefundRecord(env,h.scope,'recharge_refund_result',rows[0]);
 if(local.source!=='local_settlement'||local.caused_by_result_id!==h.record.result_id)return fail();
 const evidence=local.evidence;
 if(!evidence||typeof evidence!=='object'||Array.isArray(evidence))return fail();
 const linkValue=(evidence as Readonly<Record<string,unknown>>).noticeIntent;
 if(!linkValue||typeof linkValue!=='object'||Array.isArray(linkValue))return fail();
 const link=linkValue as Readonly<Record<string,unknown>>;
 if(typeof link.id!=='number'||!Number.isInteger(link.id)||link.id<1||link.id>2147483647
  ||link.eventKey!==noticeKey(String(h.operation.operation_id)))return fail();
 const notice=await physicalNotice(tx,link.id,String(link.eventKey));
 const parsed=parseRechargeRefundLocalCaptureResult(env,h.scope,historyInput(h),local,notice);
 await universe(tx,env,role,h,parsed.record);
 // Immutable physical history allows valid later appends and never asks for
 // mutable first-settlement/order/wallet/readiness or present merchant secrets.
 const history=await readRechargeRefundOperationHistoryTx(tx,env,role,h.operation.operation_id,'write');
 if(!same(history.pinned.operation,h.operation)||history.pinned.holdBillId!==parsed.facts.holdBillId)return fail();
 const hold=await assertRechargeRefundHoldBillTx(tx,h.operation);
 if(hold.billId!==parsed.facts.holdBillId||state.version!==parsed.facts.projection.afterVersion||state.attempt_count!==1
  ||state.provider_refund_id!==h.observation.providerRefundId||state.lease_id!==null||state.lease_until!==null||state.next_query_at!==null
  ||state.updated_at!==parsed.facts.capturedAt)return fail();
 await physicalFlow(tx,parsed.facts.flow,false);
 return Object.freeze({operationId:String(h.operation.operation_id),providerResultId:String(h.record.result_id),localResultId:String(local.result_id),
  flowId:parsed.facts.flow.id,noticeId:notice.id,captured:true as const,replayed:true});
}

/** Internal actual role only: caller supplies no actor, status, amount, source,
 * row, ready object or provider capability. Inputs are physically reread. */
export async function captureRechargeRefundSuccessFirstResult(container:Container,inputEnv:Signing,
 role:RechargeRefundRuntimeRole,operationId:unknown,providerResultId:unknown){
 if(!Object.hasOwn(container.db,'$client')||!['app','admin','financial'].includes(role)||!uuid(operationId)||!uuid(providerResultId))return fail();
 const env:Signing={APP_KEY:inputEnv.APP_KEY};
 return container.db.transaction(async raw=>{
  const tx=raw as unknown as DbClient;await boundedContext(tx);await assertRechargeRefundRuntimeTx(tx,role,'write');
  const initial=await readRechargeRefundOperationByIdTx(tx,env,role,operationId,'write');if(initial.admission!=='reserved')return fail();
  const prior=await tx.execute(sql`SELECT result_id FROM public.recharge_refund_result WHERE operation_id=${operationId}::uuid AND source='local_settlement' LIMIT 1`);
  // Early notification fences only. Full guard before key would retain recharge
  // ROWEX in a key waiter, blocking the winner's source SHARE NOWAIT. This
  // boolean is never retained or accepted as later write-readiness proof.
  if(!prior.length&&!await prepareRechargeRefundNoticeTx(tx))return fail();
  await lockRechargeRefundKeyTx(tx,Number(initial.admin_id),initial.request_key);
  const op=await readRechargeRefundOperationByIdTx(tx,env,role,operationId,'write');if(!same(initial,op))return fail();
  const h=await readRechargeRefundFirstProviderResultTx(tx,env,role,operationId,providerResultId,'write');
  if(!same(op,h.operation)||h.observation.status!=='SUCCESS')return fail();
  const recorded=await tx.execute(sql`SELECT result_id FROM public.recharge_refund_result WHERE operation_id=${operationId}::uuid AND source='local_settlement' LIMIT 1`);
  if(recorded.length)return finish(tx,await replay(tx,env,role,h,await readRechargeRefundStateTx(tx,op,false)));
  if(prior.length)return fail();
  const [locked]=await tx.execute<{id:number}>(sql`SELECT public.recharge_refund_lock_source_v1(${op.recharge_id}::integer) AS id`);
  if(locked?.id!==op.recharge_id)return fail();
  const names=await tx.execute<{domain:string;id:number}>(sql`SELECT 'recharge' AS domain,id FROM public.user_recharge WHERE order_id=${op.order_no}
   UNION ALL SELECT 'store_order',id FROM public.store_order WHERE order_id=${op.order_no}
   UNION ALL SELECT 'membership',id FROM public.other_order WHERE order_id=${op.order_no} LIMIT 2`);
  if(names.length!==1||names[0].domain!=='recharge'||names[0].id!==op.recharge_id)return fail();
  // First complete write proof follows the installed source SHARE+row lock,
  // before payment/wallet/state locks and before any money/intent mutation.
  await assertRechargeRefundCaptureWritePrerequisitesTx(tx,role);
  await lockStoreOrderPaymentBoundary(tx,String(op.order_no));
  const source=await readRechargeRefundOperationHistoryTx(tx,env,role,operationId,'write');
  if(!same(source.pinned.operation,op))return fail();
  const settled=await readRechargePaidSettlementForRefundTx(tx,env,source.pinned.business,role);
  if(!same(settled.event.payload,source.pinned.firstSettlement)||rechargeRefundCents(settled.order.refundPrice)!==0)return fail();
  const wallets=await tx.select({uid:user.uid,nowMoney:user.nowMoney,nickname:user.nickname,phone:user.phone,isDel:user.isDel,deleteTime:user.deleteTime})
   .from(user).where(eq(user.uid,Number(op.buyer_uid))).limit(2).for('update',{noWait:true});
  const wallet=wallets[0];if(wallets.length!==1||wallet.uid!==op.buyer_uid||wallet.isDel!==0||wallet.deleteTime!==null)return fail();
  const state=await readRechargeRefundStateTx(tx,op),hold=await assertRechargeRefundHoldBillTx(tx,op);
  await universe(tx,env,role,h);await noOrphans(tx,operationId);
  if(hold.billId!==h.request.holdBillId||hold.billId!==source.pinned.holdBillId||state.status!=='SUBMITTING'||state.wallet_state!=='held'||state.version!==1
   ||state.attempt_count!==1||state.lease_id!==h.request.leaseId||state.lease_until!==h.request.leaseUntil
   ||state.next_query_at!==h.request.issuedAt+60||state.provider_refund_id!==null||state.last_result_id!==null||state.updated_at!==h.request.issuedAt)return fail();
  const before=rechargeRefundCents(wallet.nowMoney,true);
  const [clock]=await tx.execute<{now:string}>(sql`SELECT floor(extract(epoch FROM pg_catalog.clock_timestamp()))::bigint AS now`);
  const now=Number(clock?.now);
  if(!Number.isSafeInteger(now)||now<Number(op.created_at)||now<state.updated_at||now<h.observation.observedAt-1||now>2147483647)return fail();
  // Author allocations, not prerequisite probes. Actual sequence ROWEX locks
  // last through commit; rollback may leave normal gaps but no economic row.
  const [ids]=await tx.execute<{flow:number;outbox:number}>(sql`SELECT pg_catalog.nextval('public.capital_flow_id_seq'::regclass)::integer AS flow,
   pg_catalog.nextval('public.store_order_outbox_id_seq'::regclass)::integer AS outbox`);
  if(!ids||![ids.flow,ids.outbox].every(id=>Number.isInteger(id)&&id>0&&id<=2147483647))return fail();
  await assertRechargeRefundCaptureWritePrerequisitesTx(tx,role,'allocated');
  const facts:RechargeRefundCaptureFacts={format:1,purpose:'recharge-refund-capture-facts-v1',scope:h.scope,localResultId:randomUUID(),
   operation:{id:operationId,signature:String(op.signature),paymentSignature:String(op.payment_signature)},
   request:{attemptId:String(h.attempt.attempt_id),signature:String(h.attempt.signature),requestHash:String(h.attempt.request_hash)},
   provider:{resultId:providerResultId,signature:String(h.record.signature),refundId:h.observation.providerRefundId,successTime:h.observation.successTime,observedAt:h.observation.observedAt},
   recharge:{id:Number(op.recharge_id),buyerUid:Number(op.buyer_uid),orderNo:String(op.order_no),transactionId:String(op.transaction_id),appId:h.request.approval.appId,
    merchantId:h.request.approval.merchantId,principalCents:Number(op.principal_cents),giftCents:Number(op.gift_cents),reclaimGift:Boolean(op.reclaim_gift),
    debitCents:Number(op.debit_cents),refundBeforeCents:0,refundAfterCents:Number(op.principal_cents),postReservationBalanceCents:Number(op.wallet_after)},
   holdBillId:hold.billId,wallet:{beforeCents:before,afterCents:before},
   flow:{id:ids.flow,eventKey:flowKey(operationId),flowId:flowId(operationId),orderId:String(op.order_no),storeId:settled.order.storeId,uid:wallet.uid,
    priceCents:-Number(op.principal_cents),tradingType:4,payType:'weixin',addTime:now,nickname:wallet.nickname,phone:wallet.phone,mark:'充值原路退款'},
   projection:{beforeVersion:state.version,afterVersion:state.version+1},capturedAt:now};
  captureRechargeRefundCaptureFacts(env,h.scope,historyInput(h),facts);
  const intent=signRechargeRefundSuccessNoticeIntent(env,h.scope,historyInput(h),facts);
  const updated=await tx.update(userRecharge).set({refundPrice:rechargeRefundDecimal(Number(op.principal_cents))})
   .where(and(eq(userRecharge.id,Number(op.recharge_id)),eq(userRecharge.refundPrice,'0.00'))).returning({id:userRecharge.id,refund:userRecharge.refundPrice});
  if(updated.length!==1||updated[0].id!==op.recharge_id||rechargeRefundCents(updated[0].refund)!==op.principal_cents)return fail();
  await tx.insert(capitalFlow).values({id:facts.flow.id,eventKey:facts.flow.eventKey,flowId:facts.flow.flowId,orderId:facts.flow.orderId,
   storeId:facts.flow.storeId,uid:facts.flow.uid,price:rechargeRefundDecimal(facts.flow.priceCents),tradingType:4,payType:'weixin',addTime:now,
   nickname:facts.flow.nickname,phone:facts.flow.phone,mark:facts.flow.mark});
  await physicalFlow(tx,facts.flow,true);
  await tx.insert(storeOrderOutbox).values({id:ids.outbox,eventKey:noticeKey(operationId),aggregateType:'recharge',aggregateId:Number(op.recharge_id),
   eventType:'recharge.refund.success.notice',payload:sql`${JSON.stringify(intent)}::jsonb`,status:'PENDING',dispatchCount:0,attemptCount:0,replayCount:0,availableTime:now,
   leaseUntil:0,leaseToken:'',lastError:'',enqueuedTime:0,processedTime:0,addTime:now,updateTime:now});
  const notice=await physicalNotice(tx,ids.outbox,noticeKey(operationId));
  const signed=signRechargeRefundLocalCaptureResult(env,h.scope,historyInput(h),facts,notice),{signature:_signature,...unsigned}=signed;
  const local=await insertRechargeRefundEvidenceTx(tx,env,role,'recharge_refund_result',unsigned);
  if(local.signature!==signed.signature)return fail();
  const changed=await tx.execute(sql`UPDATE public.recharge_refund_state SET status='SUCCEEDED',wallet_state='captured',version=2,
   lease_id=NULL,lease_until=NULL,next_query_at=NULL,provider_refund_id=${h.observation.providerRefundId},last_result_id=${local.result_id}::uuid,updated_at=${now}
   WHERE operation_id=${operationId}::uuid AND status='SUBMITTING' AND wallet_state='held' AND version=1 AND attempt_count=1
    AND lease_id=${h.request.leaseId}::uuid AND lease_until=${h.request.leaseUntil} AND next_query_at=${h.request.issuedAt+60}
    AND provider_refund_id IS NULL AND last_result_id IS NULL AND updated_at=${state.updated_at} RETURNING operation_id`);
  if(changed.length!==1||changed[0].operation_id!==operationId)return fail();
  const verified=await replay(tx,env,role,h,await readRechargeRefundStateTx(tx,op,false));
  return finish(tx,Object.freeze({...verified,replayed:false}));
 },{isolationLevel:'read committed',accessMode:'read write'});
}
