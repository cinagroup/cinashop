/** Locked recharge source. Neither paid=1 nor a writable bill is authority. */
import { and, eq, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import type { DbClient } from '@/lib/di';
import { user, userRecharge, storeOrderOutbox } from '@/models/schema';
import { assertRechargeRefundRuntimeTx } from '@/migrations/rechargeRefund';
import type { RechargeRefundRuntimeRole } from '@/migrations/rechargeRefundContract';
import { inspectRoutineOriginalPaymentEvidenceCatalog } from '@/migrations/routineOriginalPaymentEvidence';
import { inspectRoutinePaymentAccountPolicyCatalog } from '@/migrations/routinePaymentAccountPolicy';
import { captureRechargePaidNoticeBusiness, rechargePaidSettlementKey } from '@/services/order/RechargePaidNoticeCodec';
import { readRechargePaidSettlementForRefundTx } from '@/services/order/RechargePaidNoticeSource';
import { ServiceUnavailableException, NotFoundException } from '@/utils/errors';
import { captureRechargeRefundBasis, rechargeRefundCents, rechargeRefundId } from './RechargeRefundMoney';
import { captureRechargeRefundJson, type RechargeRefundJson } from './RechargeRefundJournalCodec';
import { parseRoutineOriginalEvidence } from './RoutineOriginalPaymentEvidenceCodec';
import { readRoutineApprovedUsesForRechargeRefundTx } from './RoutineApprovedPaymentAccount';
import { routineEvidenceCanonical, routineEvidenceHmac } from './RoutineProviderObservation';
import { lockStoreOrderPaymentBoundary } from './StoreOrderPaymentBoundary';

type Signing = Pick<Env, 'APP_KEY'>;
const sourceSlot = Symbol('recharge.refund.locked-source.v1');
const unavailable = (): never => { throw new ServiceUnavailableException('充值原付款归属或真实结算证据尚未完整就绪，请人工核对'); };

/** Source table fences precede the common payment boundary, like payment
 * settlement itself. All locks are bounded NOWAIT/lock_timeout; no transport
 * or credential lookup occurs here. Historical rows lacking first settlement
 * evidence cannot be silently adopted from mutable paid/trade_no fields. */
export async function readRechargeRefundSourceTx(tx: DbClient, env: Signing,
  role: RechargeRefundRuntimeRole, rechargeId: number) {
  rechargeId = rechargeRefundId(rechargeId);
  const scope = await assertRechargeRefundRuntimeTx(tx, role, 'write');
  const [resolution] = await tx.execute<{ ready: boolean }>(sql`SELECT
    pg_catalog.to_regclass('user')=pg_catalog.to_regclass('public.user')
    AND pg_catalog.to_regclass('user_recharge')=pg_catalog.to_regclass('public.user_recharge')
    AND pg_catalog.to_regclass('store_order')=pg_catalog.to_regclass('public.store_order')
    AND pg_catalog.to_regclass('other_order')=pg_catalog.to_regclass('public.other_order')
    AND pg_catalog.to_regclass('user_bill')=pg_catalog.to_regclass('public.user_bill')
    AND pg_catalog.to_regclass('store_order_outbox')=pg_catalog.to_regclass('public.store_order_outbox') AS ready`);
  if (resolution?.ready !== true) return unavailable();
  const [locked] = await tx.execute<{ id: number }>(sql`SELECT public.recharge_refund_lock_source_v1(${rechargeId}::integer) AS id`);
  if (locked?.id !== rechargeId) return unavailable();
  const orders = await tx.select().from(userRecharge).where(eq(userRecharge.id, rechargeId)).limit(2);
  const order = orders[0];
  if (!orders.length) throw new NotFoundException('充值订单不存在');
  if (orders.length !== 1) return unavailable();
  const universe = await tx.execute<{ domain: string; id: number }>(sql`
    SELECT 'recharge' AS domain,id FROM public.user_recharge WHERE order_id=${order.orderId}
    UNION ALL SELECT 'store_order',id FROM public.store_order WHERE order_id=${order.orderId}
    UNION ALL SELECT 'membership',id FROM public.other_order WHERE order_id=${order.orderId} LIMIT 2`);
  if (universe.length !== 1 || universe[0].domain !== 'recharge' || universe[0].id !== rechargeId) return unavailable();
  await lockStoreOrderPaymentBoundary(tx, order.orderId);
  const wallets = await tx.select({ uid: user.uid, nowMoney: user.nowMoney, isDel: user.isDel, deleteTime: user.deleteTime })
    .from(user).where(eq(user.uid, order.uid)).limit(2).for('update', { noWait: true });
  const wallet = wallets[0];
  if (wallets.length !== 1 || wallet.isDel !== 0 || wallet.deleteTime !== null) return unavailable();
  const basis = captureRechargeRefundBasis({ id: order.id, uid: order.uid, orderId: order.orderId,
    price: order.price, givePrice: order.givePrice, refundPrice: order.refundPrice, paid: order.paid,
    nowMoney: wallet.nowMoney, rechargeType: order.rechargeType });
  const events = await tx.select().from(storeOrderOutbox)
    .where(and(eq(storeOrderOutbox.eventKey, rechargePaidSettlementKey(order.id)), eq(storeOrderOutbox.aggregateId, order.id)))
    .limit(2);
  if (events.length !== 1) return unavailable();
  const payload = events[0].payload;
  const descriptor = payload && typeof payload === 'object' ? Object.getOwnPropertyDescriptor(payload, 'business') : undefined;
  if (!descriptor || !('value' in descriptor)) return unavailable();
  const business = captureRechargePaidNoticeBusiness(descriptor.value);
  if (business.orderId !== order.id) return unavailable();
  const settled = await readRechargePaidSettlementForRefundTx(tx, env, business, role);
  const proof = captureRechargeRefundJson(settled.event.payload);
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) return unavailable();
  const proofFields = proof as Readonly<Record<string, RechargeRefundJson>>;
  if (routineEvidenceCanonical(proofFields.scope) !== routineEvidenceCanonical({ database: scope.database,
    databaseOid: scope.databaseOid, maintenance: scope.maintenance, maintenanceOid: scope.maintenanceOid })) return unavailable();
  const provider = proofFields.provider;
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) return unavailable();
  // A first settlement for another channel is retained evidence, but it does
  // not identify a JSAPI merchant/account or authorize using current secrets.
  const providerFields = provider as Readonly<Record<string, RechargeRefundJson>>;
  if (providerFields.provider !== 'wechat' || providerFields.profile !== 'routine' || basis.rechargeType !== 'weixin') {
    throw new ServiceUnavailableException('该充值渠道尚无已批准的原账号退款接入，请人工核对');
  }
  const originalCatalog = await inspectRoutineOriginalPaymentEvidenceCatalog(tx),
    accountCatalog = await inspectRoutinePaymentAccountPolicyCatalog(tx);
  if (!originalCatalog.ready || !accountCatalog.ready
    || [originalCatalog.binding, accountCatalog.binding].some(b => !b || b.maintenance !== scope.maintenance
      || b.maintenanceOid !== scope.maintenanceOid || b.app !== scope.app || b.appOid !== scope.appOid)) return unavailable();
  const [originalResolution] = await tx.execute<{ ready: boolean }>(sql`SELECT
    pg_catalog.to_regclass('routine_original_payment_evidence')=pg_catalog.to_regclass('public.routine_original_payment_evidence') AS ready`);
  if (originalResolution?.ready !== true) return unavailable();
  const rows = await tx.execute(sql`SELECT * FROM public.routine_original_payment_evidence
    WHERE order_no=${order.orderId} OR transaction_id=${order.tradeNo} ORDER BY evidence_id LIMIT 65`);
  if (!rows.length || rows.length > 64 || Buffer.byteLength(JSON.stringify(rows), 'utf8') > 1_048_576) return unavailable();
  const originals = Array.from(rows, row => parseRoutineOriginalEvidence(env, row));
  const facts = originals[0].payload.observation.facts, canonical = routineEvidenceCanonical(facts);
  const principalCents = rechargeRefundCents(order.price);
  for (const original of originals) {
    const binding = original.payload.binding, f = original.payload.observation.facts;
    if (routineEvidenceCanonical(f) !== canonical || binding.state !== 'bound'
      || binding.local.domain !== 'recharge' || binding.local.orderId !== order.id || binding.local.buyerUid !== order.uid
      || binding.local.orderNo !== order.orderId || binding.local.amountCents !== principalCents
      || binding.local.tradeNo !== '' && binding.local.tradeNo !== order.tradeNo
      || binding.local.paid === 1 && binding.local.payType !== 'weixin'
      || f.orderNo !== order.orderId || f.transactionId !== order.tradeNo || f.amountCents !== principalCents
      || f.currency !== 'CNY' || f.tradeState !== 'SUCCESS' || f.tradeType !== 'JSAPI' || !f.payerId) return unavailable();
  }
  const uses = await readRoutineApprovedUsesForRechargeRefundTx(tx, env, originals, role);
  const versions = await tx.execute<{ recharge: string; wallet: string }>(sql`SELECT r.xmin::text AS recharge,u.xmin::text AS wallet
    FROM public.user_recharge r JOIN public."user" u ON u.uid=r.uid WHERE r.id=${order.id}`);
  if (versions.length !== 1 || !/^[0-9]+$/.test(versions[0].recharge) || !/^[0-9]+$/.test(versions[0].wallet)) return unavailable();
  // Bind the actual historical subset, not just its digest. A later lawful
  // payment observation or approval revision may append another use for the
  // same original. Recovery must retain this admission's exact first subset.
  const source = captureRechargeRefundJson({ format: 2, domain: 'recharge', firstSettlement: proof,
    originals, approvedUseRefs: uses.uses.map(row => ({ useId: row.use_id, signature: row.signature })),
    approvedUseDigest: uses.digest });
  const result = { scope, basis, versions: Object.freeze({ ...versions[0] }), source,
    provider: 'wechat' as const, profile: 'routine' as const, transactionId: order.tradeNo,
    appId: facts.appId, merchantId: facts.merchantId,
    signature: routineEvidenceHmac(env, 'recharge-refund-original-source-v1', { scope, source }) };
  Object.defineProperty(result, sourceSlot, { value: tx });
  return Object.freeze(result);
}

export type RechargeRefundLockedSource = Awaited<ReturnType<typeof readRechargeRefundSourceTx>>;
export function assertRechargeRefundSourceTx(tx: DbClient, source: RechargeRefundLockedSource) {
  const descriptor = source && Object.getOwnPropertyDescriptor(source, sourceSlot);
  if (!descriptor || !('value' in descriptor) || descriptor.value !== tx || !Object.isFrozen(source)) return unavailable();
  return source;
}
