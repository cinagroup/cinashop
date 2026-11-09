/** Narrow owning SQL author for the persisted query CLOSED.
 * No HTTP, provider IO, callback recovery, success capture or notices.
 * Historical replay verifies its immutable bill/result chain independently of
 * later wallet/order/source projections, actor expiry and credential rotation. */
import { randomUUID } from 'node:crypto';
import { and, eq, or, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import type { Container, DbClient } from '@/lib/di';
import { user, userBill } from '@/models/schema';
import { assertRechargeRefundRuntimeTx, type RechargeRefundRuntimeRole } from '@/migrations/rechargeRefund';
import { ServiceUnavailableException } from '@/utils/errors';
import { readRechargePaidSettlementForRefundTx } from '@/services/order/RechargePaidNoticeSource';
import { assertRechargeRefundReleaseWritePrerequisitesTx as freshCatalog } from './RechargeRefundClosedRelease';
import { assertRechargeRefundHoldBillTx, readRechargeRefundStateTx, type RechargeRefundStateRow } from './RechargeRefundAccounting';
import { readRechargeRefundOperationHistoryTx } from './RechargeRefundOperationSource';
import { insertRechargeRefundEvidenceTx, lockRechargeRefundKeyTx,
 readRechargeRefundOperationByIdTx, type RechargeRefundRecord } from './RechargeRefundLedger';
import { parseRechargeRefundQueryLocalReleaseResult, signRechargeRefundQueryLocalReleaseResult,
 type RechargeRefundQueryReleaseFacts } from './RechargeRefundQueryLocalReleaseCodec';
import { rechargeRefundCents, rechargeRefundDecimal } from './RechargeRefundMoney';
import { lockStoreOrderPaymentBoundary } from './StoreOrderPaymentBoundary';
import { routineEvidenceCanonical } from './RoutineProviderObservation';

import { readRechargeRefundQueryEconomicHistoryTx,rechargeRefundQueryEconomicHistoryInput,type RechargeRefundQueryEconomicBasis } from './RechargeRefundQueryEconomicHistory';

type Signing = Pick<Env, 'APP_KEY'>;
const fail = (): never => { throw new ServiceUnavailableException('充值退款渠道关闭解冻需要人工核对，请保留原操作'); };
const uuid = (v: unknown): v is string => typeof v === 'string'
 && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
const same = (a: unknown, b: unknown) => routineEvidenceCanonical(a) === routineEvidenceCanonical(b);
const historyInput=rechargeRefundQueryEconomicHistoryInput;

/** Only local transaction budgets are tightened. A zero old timeout means
 * unbounded, never permission to leave a fresh or replay transaction unbounded. */
async function boundedContext(tx: DbClient) {
 await tx.execute(sql`SET LOCAL search_path TO public,pg_temp`);
 await tx.execute(sql`SELECT pg_catalog.set_config('statement_timeout',
  LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
  pg_catalog.set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
  pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
 const [r] = await tx.execute<{ ready: boolean }>(sql`SELECT pg_catalog.current_setting('role')='none'
  AND current_user=session_user AND pg_catalog.current_setting('session_replication_role')='origin' AS ready`);
 if (r?.ready !== true) return fail();
}

async function finish<T>(tx: DbClient, value: T): Promise<T> {
 const [deadline] = await tx.execute<{ ready: boolean }>(sql`SELECT pg_catalog.clock_timestamp()<=pg_catalog.transaction_timestamp()+interval '5 seconds' AS ready`);
 if (deadline?.ready !== true) return fail();
 return value;
}

/** Exact canonical write footprint from user.ts/order.ts, 0144 CHECK state,
 * 0106/0173 partial indexes and the separately reviewed optional0176 gift index.
 * No regex/cast/parenthesis normalization or target-learned catalog is used. */
async function universe(tx:DbClient,env:Signing,role:RechargeRefundRuntimeRole,h:RechargeRefundQueryEconomicBasis,local?:RechargeRefundRecord){
 const physical=await readRechargeRefundQueryEconomicHistoryTx(tx,env,role,h.operation.operation_id,h.record.result_id,local?.result_id);
 if(!same(physical.basis,h)||!same(physical.local,local??null))return fail();
 const [conflict] = await tx.execute<{ found: boolean }>(sql`SELECT
  EXISTS(SELECT 1 FROM public.capital_flow WHERE event_key=${'recharge.refund:' + String(h.operation.operation_id)}
   OR flow_id=${String(h.operation.operation_id).replaceAll('-', '')})
  OR EXISTS(SELECT 1 FROM public.store_order_outbox WHERE event_key=${'recharge.refund.success.notice:' + String(h.operation.operation_id)}) AS found`);
 if (!conflict || conflict.found !== false) return fail();
}

async function physicalReleaseBill(tx: DbClient, facts: RechargeRefundQueryReleaseFacts) {
 const bills = await tx.select().from(userBill).where(or(eq(userBill.id, facts.bill.id), eq(userBill.eventKey, facts.bill.eventKey))).limit(3);
 const b = bills[0], f = facts.bill;
 if (bills.length !== 1 || b.id !== f.id || b.uid !== f.uid || b.linkId !== f.linkId || b.eventKey !== f.eventKey
  || b.pm !== f.pm || b.category !== f.category || b.type !== f.type || b.title !== f.title
  || rechargeRefundCents(b.number) !== f.numberCents || rechargeRefundCents(b.balance, true) !== f.balanceCents
  || b.status !== f.status || b.take !== f.take || b.frozenTime !== f.frozenTime || b.addTime !== f.addTime || b.mark !== f.mark) return fail();
}

async function replay(tx: DbClient, env: Signing, role:RechargeRefundRuntimeRole, h: RechargeRefundQueryEconomicBasis, state: RechargeRefundStateRow) {
 if (state.status !== 'FAILED' || state.wallet_state !== 'released' || !uuid(state.last_result_id)) return fail();
 const rows = await tx.execute(sql`SELECT * FROM public.recharge_refund_result
  WHERE operation_id=${h.operation.operation_id}::uuid AND result_id=${state.last_result_id}::uuid LIMIT 2`);
 if (rows.length !== 1) return fail();
 const parsed = parseRechargeRefundQueryLocalReleaseResult(env, h.scope, historyInput(h), rows[0]);
 await universe(tx, env, role, h, parsed.record);
 const history=await readRechargeRefundOperationHistoryTx(tx,env,role,h.operation.operation_id,'write');
 if(!same(history.pinned.operation,h.operation)||history.pinned.holdBillId!==parsed.facts.holdBillId)return fail();
 const hold = await assertRechargeRefundHoldBillTx(tx, h.operation);
 if (hold.billId !== parsed.facts.holdBillId || state.version !== parsed.facts.projection.afterVersion
  || state.attempt_count !== h.history.totalAttempts || state.provider_refund_id !== h.observation.providerRefundId || state.lease_id !== null
  || state.lease_until !== null || state.next_query_at !== null || state.updated_at !== parsed.facts.releasedAt) return fail();
 await physicalReleaseBill(tx, parsed.facts);
 return Object.freeze({ operationId: String(h.operation.operation_id), providerResultId: String(h.record.result_id),
  localResultId: String(parsed.record.result_id), releaseBillId: parsed.facts.bill.id, released: true as const, replayed: true });
}

/** Internal actual role only. The caller supplies no actor, amount, balance,
 * cause row or prevalidated proof. All inputs are physically reread. */
export async function releaseRechargeRefundClosedQueryResult(container: Container, inputEnv: Signing,
 role: RechargeRefundRuntimeRole, operationId: unknown, providerResultId: unknown) {
 if (!Object.hasOwn(container.db, '$client') || !['app', 'admin', 'financial'].includes(role)
  || !uuid(operationId) || !uuid(providerResultId)) return fail();
 const env: Signing = { APP_KEY: inputEnv.APP_KEY };
 return container.db.transaction(async raw => {
  const tx = raw as unknown as DbClient;
  await boundedContext(tx);
  await assertRechargeRefundRuntimeTx(tx, role, 'write');
  const initial = await readRechargeRefundOperationByIdTx(tx, env, role, operationId, 'write');
  if (initial.admission !== 'reserved') return fail();
  // This SELECT does not mint a terminal proof or acquire a business row lock.
  // It merely routes already recorded history away from fresh economic gates.
  const prior = await tx.execute(sql`SELECT result_id FROM public.recharge_refund_result
   WHERE operation_id=${operationId}::uuid AND source='local_release' LIMIT 1`);
  if (!prior.length) await freshCatalog(tx, role);
  await lockRechargeRefundKeyTx(tx, Number(initial.admin_id), initial.request_key);
  const op = await readRechargeRefundOperationByIdTx(tx, env, role, operationId, 'write');
  if (!same(initial, op)) return fail();
  const recorded=await tx.execute(sql`SELECT result_id FROM public.recharge_refund_result WHERE operation_id=${operationId}::uuid AND source='local_release' LIMIT 2`);
  if(recorded.length>1)return fail();
  const physical=await readRechargeRefundQueryEconomicHistoryTx(tx,env,role,operationId,providerResultId,recorded[0]?.result_id);
  const h=physical.basis;
  if(!same(op,h.operation)||h.observation.status!=='CLOSED')return fail();
  if(recorded.length)return finish(tx,await replay(tx,env,role,h,physical.state));
  if(prior.length)return fail();
  const [locked] = await tx.execute<{ id: number }>(sql`SELECT public.recharge_refund_lock_source_v1(${op.recharge_id}::integer) AS id`);
  if (locked?.id !== op.recharge_id) return fail();
  const names = await tx.execute<{ domain: string; id: number }>(sql`SELECT 'recharge' AS domain,id FROM public.user_recharge WHERE order_id=${op.order_no}
   UNION ALL SELECT 'store_order',id FROM public.store_order WHERE order_id=${op.order_no}
   UNION ALL SELECT 'membership',id FROM public.other_order WHERE order_id=${op.order_no} LIMIT 2`);
  if (names.length !== 1 || names[0].domain !== 'recharge' || names[0].id !== op.recharge_id) return fail();
  await lockStoreOrderPaymentBoundary(tx, String(op.order_no));
  const source = await readRechargeRefundOperationHistoryTx(tx, env, role, operationId, 'write');
  if (!same(source.pinned.operation, op)) return fail();
  const settled = await readRechargePaidSettlementForRefundTx(tx, env, source.pinned.business, role);
  if (!same(settled.event.payload, source.pinned.firstSettlement) || rechargeRefundCents(settled.order.refundPrice) !== 0) return fail();
  const wallets = await tx.select({ uid: user.uid, nowMoney: user.nowMoney, isDel: user.isDel, deleteTime: user.deleteTime }).from(user)
   .where(eq(user.uid, Number(op.buyer_uid))).limit(2).for('update', { noWait: true });
  const wallet = wallets[0];
  if (wallets.length !== 1 || wallet.uid !== op.buyer_uid || wallet.isDel !== 0 || wallet.deleteTime !== null) return fail();
  const state = await readRechargeRefundStateTx(tx, op), hold = await assertRechargeRefundHoldBillTx(tx, op);
  await universe(tx, env, role, h);
  const tail=h.history.queries.at(-1)!.payload,n=h.history.totalAttempts;
  if(hold.billId!==h.request.holdBillId||state.status!=='UNKNOWN'||state.wallet_state!=='held'||state.version!==n
   ||state.attempt_count!==n||state.lease_id!==tail.leaseId||state.lease_until!==tail.leaseUntil
   ||state.next_query_at!==tail.issuedAt+60||state.provider_refund_id!==null||state.last_result_id!==null
   ||state.updated_at!==tail.issuedAt)return fail();
  const existing = await tx.select({ id: userBill.id }).from(userBill)
   .where(eq(userBill.eventKey, 'recharge_refund_release:' + operationId)).limit(2);
  if (existing.length) return fail();
  const before = rechargeRefundCents(wallet.nowMoney, true), after = before + Number(op.debit_cents), balance = rechargeRefundDecimal(after);
  const [clock] = await tx.execute<{ now: string }>(sql`SELECT floor(extract(epoch FROM pg_catalog.clock_timestamp()))::bigint AS now`);
  const now = Number(clock?.now);
  if (!Number.isSafeInteger(now) || now < Number(op.created_at) || now < state.updated_at || now < h.observation.observedAt - 1 || now > 2147483647) return fail();
  // This is the actual author's one bill-ID allocation, not a prerequisite
  // probe. nextval retains the sequence ROW EXCLUSIVE lock to TX end; ALTER
  // SEQUENCE/OWNED BY/CACHE must not race the final physical recheck. Rollback
  // may leave a normal sequence gap, never a credited wallet or bill.
  const [allocated] = await tx.execute<{ id: number }>(sql`SELECT pg_catalog.nextval('public.user_bill_id_seq'::regclass)::integer AS id`);
  if (!allocated || !Number.isInteger(allocated.id) || allocated.id < 1 || allocated.id > 2147483647) return fail();
  // Re-execute all actual catalog/ACL/write-footprint facts with wallet/state,
  // table DML locks and the actual allocated sequence lock already held.
  await freshCatalog(tx, role);
  const updated = await tx.update(user).set({ nowMoney: balance })
   .where(and(eq(user.uid, wallet.uid), eq(user.nowMoney, wallet.nowMoney))).returning({ uid: user.uid });
  if (updated.length !== 1) return fail();
  const bills = await tx.insert(userBill).values({ id: allocated.id, uid: wallet.uid, linkId: String(op.order_no),
   eventKey: 'recharge_refund_release:' + operationId, pm: 1, category: 'now_money', type: 'recharge_refund_release',
   title: '渠道关闭充值退款退回预留', number: rechargeRefundDecimal(Number(op.debit_cents)), balance, status: 1, take: 0,
   frozenTime: 0, addTime: now, mark: '渠道已确认关闭，退回原充值退款预留' }).returning();
  if (bills.length !== 1) return fail();
  const facts: RechargeRefundQueryReleaseFacts = { format: 1, purpose: 'recharge-refund-query-closed-release-facts-v1', scope: h.scope,
   localResultId: randomUUID(), operation: { id: operationId, signature: String(op.signature), paymentSignature: String(op.payment_signature) },
   request: { attemptId: String(h.attempt.attempt_id), signature: String(h.attempt.signature), requestHash: String(h.attempt.request_hash) },
   query:{attemptId:String(h.query.attempt.attempt_id),signature:String(h.query.attempt.signature),requestHash:String(h.query.attempt.request_hash),
    ordinal:h.query.payload.ordinal,approvalId:h.query.approval.record_id,approvalSignature:h.query.approval.signature},
   provider: { resultId: providerResultId, signature: String(h.record.signature), refundId: h.observation.providerRefundId, observedAt: h.observation.observedAt },
   recharge: { id: Number(op.recharge_id), buyerUid: Number(op.buyer_uid), orderNo: String(op.order_no), transactionId: String(op.transaction_id),
    appId: h.request.approval.appId, merchantId: h.request.approval.merchantId, principalCents: Number(op.principal_cents), giftCents: Number(op.gift_cents),
    reclaimGift: Boolean(op.reclaim_gift), debitCents: Number(op.debit_cents), refundBeforeCents: 0, refundAfterCents: 0 },
   holdBillId: hold.billId, wallet: { beforeCents: before, afterCents: after },
   bill: { id: bills[0].id, uid: wallet.uid, linkId: String(op.order_no), eventKey: 'recharge_refund_release:' + operationId,
    pm: 1, category: 'now_money', type: 'recharge_refund_release', title: '渠道关闭充值退款退回预留', numberCents: Number(op.debit_cents),
    balanceCents: after, status: 1, take: 0, frozenTime: 0, addTime: now, mark: '渠道已确认关闭，退回原充值退款预留' },
   projection: { beforeVersion: state.version, afterVersion: state.version + 1,totalAttempts:n }, releasedAt: now };
  await physicalReleaseBill(tx, facts);
  const signed = signRechargeRefundQueryLocalReleaseResult(env, h.scope, historyInput(h), facts), { signature: _signature, ...unsigned } = signed;
  const local = await insertRechargeRefundEvidenceTx(tx, env, role, 'recharge_refund_result', unsigned);
  if (local.signature !== signed.signature) return fail();
  const changed=await tx.execute(sql`UPDATE public.recharge_refund_state SET status='FAILED',wallet_state='released',version=version+1,
   lease_id=NULL,lease_until=NULL,next_query_at=NULL,provider_refund_id=${h.observation.providerRefundId},last_result_id=${local.result_id}::uuid,updated_at=${now}
   WHERE operation_id=${operationId}::uuid AND status='UNKNOWN' AND wallet_state='held' AND version=${state.version} AND attempt_count=${n}
    AND lease_id=${tail.leaseId}::uuid AND lease_until=${tail.leaseUntil} AND next_query_at=${tail.issuedAt+60}
    AND provider_refund_id IS NULL AND last_result_id IS NULL AND updated_at=${state.updated_at} RETURNING operation_id`);
  if (changed.length !== 1 || changed[0].operation_id !== operationId) return fail();
  const verified = await replay(tx, env, role, h, await readRechargeRefundStateTx(tx, op, false));
  return finish(tx, Object.freeze({ ...verified, replayed: false }));
 }, { isolationLevel: 'read committed', accessMode: 'read write' });
}
