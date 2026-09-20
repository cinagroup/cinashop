import { eq, sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { otherOrder, otherOrderStatus, paymentCallbackEvent, storeOrderEconomize, user, userBill, userMoney } from '@/models/schema';
import { offlineOrderAdmission } from '@/models/candidates/offline_order_admission';
import { offlineOrderPaymentSelection } from '@/models/candidates/offline_order_payment_selection';
import { offlineOrderCallbackBinding, offlineOrderExternalPayment } from '@/models/candidates/offline_order_external_payment';
import { ValidateException } from '@/utils/errors';
import { prepareOfflinePaymentTransaction } from './OfflineOrderPaymentContext';
import { matchesOfflineCollection as matches, selectionForOfflineCollection as selectionForEvent,
  lockOfflineCollectionContext as paymentContext, lockOfflineCollectionRecovery, type OfflineCollectionFact } from './OfflineOrderCollectionContext';
import { offlineOrderQueryEvidence } from '@/models/candidates/offline_order_query_evidence';
import { lockOfflineQueryEvidence, validateOfflineQueryEvidence, type OfflineQueryReference } from './OfflineOrderQueryEvidenceService';
import { OFFLINE_MAX_INTEGRAL, readOfflinePaymentPolicy, writeOfflineRewardEffectsTx } from './OfflineOrderPaymentPolicy';

type Event = typeof paymentCallbackEvent.$inferSelect;
type Selection = typeof offlineOrderPaymentSelection.$inferSelect;
type Receipt = typeof offlineOrderExternalPayment.$inferSelect;
export interface OfflineCallbackReference { eventId: number; replayKey: string }
/** Only values decoded from the same signature-verified provider notification. */
export interface OfflineVerifiedCallbackIdentity { appId: string; merchantId: string; payerId?: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
async function digest(value: unknown) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
async function validateEvent(event: Event) {
  if (!/^xx[0-9a-f]{30}$/.test(event.orderNo) || !/^[A-Za-z0-9_-]{1,50}$/.test(event.transactionId)
    || event.currency !== 'CNY' || !Number.isSafeInteger(event.amountCents) || event.amountCents <= 0 || event.amountCents > 2_147_483_647
    || !Number.isSafeInteger(event.providerEventTime) || event.providerEventTime < 0 || !['', 'offline_order'].includes(event.orderDomain)
    || event.lastErrorCode === 'transaction_evidence_conflict'
    || !(event.provider === 'wechat' ? event.tradeState === 'SUCCESS' && ['wechat', 'routine'].includes(event.profile)
      : event.provider === 'alipay' && event.profile === 'alipay' && ['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(event.tradeState))) {
    throw new ValidateException('线下消费回调不是可核验的成功支付证据');
  }
  // Existing canonicalCallback v1 order, deliberately unchanged. Native tests
  // use the canonical persistence primitive and signed HTTP pipeline to detect drift.
  const hash = await digest({ provider: event.provider, profile: event.profile, providerEventId: event.providerEventId,
    orderNo: event.orderNo, transactionId: event.transactionId, tradeState: event.tradeState, amountCents: event.amountCents,
    currency: event.currency, providerEventTime: event.providerEventTime });
  if (hash !== event.payloadHash) throw new ValidateException('线下消费回调摘要不一致');
}
async function lockEvent(tx: DbClient, input: OfflineCallbackReference) {
  if (!Number.isSafeInteger(input.eventId) || input.eventId <= 0 || typeof input.replayKey !== 'string' || !UUID.test(input.replayKey)) {
    throw new ValidateException('线下消费回调引用无效');
  }
  await prepareOfflinePaymentTransaction(tx);
  const [hint] = await tx.select().from(paymentCallbackEvent).where(eq(paymentCallbackEvent.id, input.eventId));
  if (!hint || hint.replayKey !== input.replayKey) throw new ValidateException('线下消费回调引用不存在');
  // Same provider-transaction lock as canonical ingress. No provider I/O in tx.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${hint.provider}:${hint.transactionId}`},0))`);
  const [event] = await tx.select().from(paymentCallbackEvent).where(eq(paymentCallbackEvent.id, input.eventId)).for('update');
  if (!event || event.replayKey !== input.replayKey || event.provider !== hint.provider || event.transactionId !== hint.transactionId) {
    throw new ValidateException('线下消费回调引用已变化');
  }
  await validateEvent(event);
  await lockOfflineCollectionRecovery(tx, event);
  return event;
}
const identityHash = (selection: Selection, event: Event) => digest({ version: 'offline-callback-v1', selectionKey: selection.selectionKey,
  eventHash: event.payloadHash, provider: selection.rail, profile: selection.profile, transactionType: selection.transactionType,
  appId: selection.appId, merchantId: selection.merchantId, payerId: selection.payerId });
async function validateBinding(tx: DbClient, event: Event, selection: Selection) {
  const [binding] = await tx.select().from(offlineOrderCallbackBinding).where(eq(offlineOrderCallbackBinding.eventId, event.id));
  if (!binding || binding.selectionKey !== selection.selectionKey || binding.eventHash !== event.payloadHash
    || binding.identityHash !== await identityHash(selection, event) || binding.createdAt < selection.createdAt) {
    throw new ValidateException('线下消费缺少完整的可信回调绑定');
  }
  return binding;
}

/** TRUSTED INGRESS ONLY. Caller must have verified the provider signature and
 * decoded app/merchant/payer from that SAME callback before calling. Neither
 * this function nor its hash verifies signatures. Never accept a customer DTO.
 * Persist this binding before dispatch; on a crash before it, redelivery must
 * reverify identity. Existing opaque callback/outbox payload stays unchanged.
 */
export async function bindOfflineOrderCallback(container: Container, input: OfflineCallbackReference & OfflineVerifiedCallbackIdentity) {
  return withTx(container, tx => bindOfflineOrderCallbackTx(tx, input));
}

/** Shared ingress transaction: canonical event/outbox and identity binding become
 * visible together. Caller owns the transaction; never opens a nested one.
 */
export async function bindOfflineOrderCallbackTx(tx: DbClient, input: OfflineCallbackReference & OfflineVerifiedCallbackIdentity) {
  if (typeof input.appId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(input.appId)
    || typeof input.merchantId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(input.merchantId)
    || (input.payerId !== undefined && (typeof input.payerId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(input.payerId)))) {
    throw new ValidateException('线下消费可信支付身份无效');
  }
  const event = await lockEvent(tx, input), selection = await selectionForEvent(tx, event);
  if (input.appId !== selection.appId || input.merchantId !== selection.merchantId
    || (selection.payerId !== '' && input.payerId !== selection.payerId)) throw new ValidateException('线下消费支付商户或付款人不匹配');
  await paymentContext(tx, event, selection);
  const [prior] = await tx.select().from(offlineOrderCallbackBinding).where(eq(offlineOrderCallbackBinding.eventId, event.id));
  if (prior) { await validateBinding(tx, event, selection); return { eventId: event.id, replayed: true }; }
  const [clock] = await tx.execute<{ now: number }>(sql`SELECT floor(extract(epoch FROM statement_timestamp()))::integer AS now`);
  await tx.insert(offlineOrderCallbackBinding).values({ eventId: event.id, selectionKey: selection.selectionKey,
    eventHash: event.payloadHash, identityHash: await identityHash(selection, event), createdAt: clock.now });
  return { eventId: event.id, replayed: false };
}

export async function verifyOfflineExternalReceipt(tx: DbClient, receipt: Receipt, selection: Selection) {
  if ((receipt.eventId === null) === (receipt.queryId === null)) throw new ValidateException('线下消费原收款来源不唯一');
  if (receipt.eventId !== null) {
  const [event] = await tx.select().from(paymentCallbackEvent).where(eq(paymentCallbackEvent.id, receipt.eventId));
  if (!event) throw new ValidateException('线下消费原始回调凭据缺失');
  await validateEvent(event); matches(selection, event);
  const binding = await validateBinding(tx, event, selection);
  if (event.transactionId !== receipt.transactionId || event.providerEventTime !== receipt.providerPaidAt || receipt.paidAt < binding.createdAt) {
    throw new ValidateException('线下消费原始回调凭据不一致');
  }
  } else {
    if (!receipt.queryId) throw new ValidateException('线下消费原始查单凭据缺失');
    const [evidence] = await tx.select().from(offlineOrderQueryEvidence).where(eq(offlineOrderQueryEvidence.id, receipt.queryId));
    if (!evidence) throw new ValidateException('线下消费原始查单凭据缺失');
    await validateOfflineQueryEvidence(evidence, selection);
    if (evidence.transactionId !== receipt.transactionId || evidence.providerEventTime !== receipt.providerPaidAt || receipt.paidAt < evidence.createdAt) {
      throw new ValidateException('线下消费原始查单凭据不一致');
    }
  }
  const [proof] = await tx.execute<{ valid: boolean }>(sql`SELECT
    (r.version='offline-external-v1' AND r.pay_price>0 AND r.pay_price<=21474836.47
      AND r.integral_before>=0 AND r.integral_after>=0 AND r.integral_reward>=0
      AND r.integral_after::bigint=r.integral_before::bigint+r.integral_reward::bigint
      AND r.integral_rate>=0 AND r.integral_rate<>'NaN'::numeric AND r.member_bonus>=0 AND (r.member_active OR r.member_bonus=0)
      AND r.integral_reward=trunc(r.integral_rate*r.pay_price)+r.member_bonus
      AND ((r.integral_reward=0 AND r.integral_bill_id IS NULL) OR
        (r.integral_reward>0 AND b.id IS NOT NULL AND b.uid=r.uid AND b.link_id=r.order_no AND b.category='integral'
          AND b.type='gain' AND b.event_key='offline_order_give_integral' AND b.pm=1 AND b.status=1 AND b.take=0
          AND b.frozen_time=0 AND b.number=r.integral_reward AND b.balance=r.integral_after AND b.add_time=r.paid_at))
      AND ((a.discount_percent=0 AND r.savings_id IS NULL) OR
        (a.discount_percent>0 AND s.id IS NOT NULL AND s.uid=r.uid AND s.order_id=r.order_no AND s.order_type=2
          AND s.pay_price=r.pay_price AND s.offline_price=a.raw_price-a.pay_price AND s.postage_price=0
          AND s.member_price=0 AND s.coupon_price=0 AND s.status=0 AND s.add_time=r.paid_at))) AS valid
    FROM ${offlineOrderExternalPayment} r JOIN ${offlineOrderAdmission} a ON a.order_id=r.order_id
      LEFT JOIN ${userBill} b ON b.id=r.integral_bill_id LEFT JOIN ${storeOrderEconomize} s ON s.id=r.savings_id
    WHERE r.order_id=${receipt.orderId}`);
  if (proof?.valid !== true) throw new ValidateException('线下消费外部支付凭据不完整');
}

/** Internal settlement used by callback queue and durable-callback recovery. Consume only
 * persisted event + trusted binding. Never debit cash, extend membership, send
 * provider requests, or claim the existing callback/reconciliation completed.
 */
export async function settleOfflineOrderExternalPayment(container: Container, input: OfflineCallbackReference) {
  return withTx(container, async tx => {
    const event = await lockEvent(tx, input), selection = await selectionForEvent(tx, event);
    const binding = await validateBinding(tx, event, selection);
    return settleOfflineCollectionTx(tx, event, selection, binding.createdAt, { eventId: event.id, queryId: null });
  });
}

/** Same financial writer as callbacks, but an explicit durable QUERY reference. */
export async function settleOfflineOrderQueryPayment(container: Container, input: OfflineQueryReference) {
  return withTx(container, async tx => {
    const { evidence, selection } = await lockOfflineQueryEvidence(tx, input);
    return settleOfflineCollectionTx(tx, evidence, selection, evidence.createdAt, { eventId: null, queryId: evidence.id });
  });
}

async function settleOfflineCollectionTx(tx: DbClient, event: OfflineCollectionFact, selection: Selection, boundAt: number,
  source: { eventId: number | null; queryId: string | null }) {
    const context = await paymentContext(tx, event, selection), { order, account } = context;
    const payType = event.provider === 'wechat' ? 'weixin' as const : 'alipay' as const;
    const [prior] = await tx.select().from(offlineOrderExternalPayment).where(eq(offlineOrderExternalPayment.orderId, order.id));
    const result = (row: Receipt, replayed: boolean) => ({ order_id: order.orderId, paid: true as const,
      pay_type: payType, pay_price: row.payPrice, integral_reward: row.integralReward, replayed, cancelled: order.isDel !== 0 });
    if (prior) {
      if (prior.uid !== order.uid || prior.orderNo !== order.orderId || prior.payPrice !== order.payPrice || prior.provider !== event.provider
        || prior.profile !== event.profile || prior.transactionId !== event.transactionId || order.paid !== 1 || order.payType !== payType
        || order.tradeNo !== prior.transactionId || order.payTime !== prior.paidAt) throw new ValidateException('线下消费外部支付状态与凭据不一致');
      await verifyOfflineExternalReceipt(tx, prior, selection);
      return result(prior, true);
    }
    // A hidden order or later banned account does not undo money already collected.
    // Preserve those flags, never authorize a new payment through this boundary.
    if (order.paid !== 0 || order.payType !== '' || order.tradeNo !== '' || order.payTime !== 0) throw new ValidateException('线下消费存在未绑定的支付状态');
    const [existing] = await tx.execute<{ present: boolean }>(sql`SELECT
      (EXISTS(SELECT 1 FROM ${userMoney} WHERE uid=${order.uid} AND link_id=${order.orderId} AND type='offline_scan')
        OR EXISTS(SELECT 1 FROM ${userBill} WHERE uid=${order.uid} AND link_id=${order.orderId} AND event_key='offline_order_give_integral')
        OR EXISTS(SELECT 1 FROM ${storeOrderEconomize} WHERE uid=${order.uid} AND order_id=${order.orderId})) AS present`);
    if (existing.present) throw new ValidateException('线下消费存在未绑定的历史账单');
    if (!Number.isInteger(account.integral) || account.integral < 0 || ![0, 1].includes(account.isPromoter)) throw new ValidateException('账户积分或推广状态无效');
    const policy = await readOfflinePaymentPolicy(tx, order.uid, BigInt(event.amountCents), account.isPromoter, false);
    const after = BigInt(account.integral) + BigInt(policy.reward);
    if (after > OFFLINE_MAX_INTEGRAL || policy.now < boundAt) throw new ValidateException('线下消费积分或支付时间超出范围');
    await tx.update(user).set({ integral: Number(after), isPromoter: policy.promoted ? 1 : account.isPromoter }).where(eq(user.uid, order.uid));
    const effects = await writeOfflineRewardEffectsTx(tx, context, policy, Number(after));
    await tx.update(otherOrder).set({ paid: 1, payType, payTime: policy.now, tradeNo: event.transactionId }).where(eq(otherOrder.id, order.id));
    if (event.profile === 'app') throw new ValidateException('线下消费支付渠道不支持');
    const [receipt] = await tx.insert(offlineOrderExternalPayment).values({ orderId: order.id, uid: order.uid, orderNo: order.orderId,
      ...source, provider: event.provider, profile: event.profile, transactionId: event.transactionId,
      providerPaidAt: event.providerEventTime, payPrice: order.payPrice, integralBefore: account.integral, integralAfter: Number(after),
      integralReward: policy.reward, integralRate: policy.rate, memberBonus: policy.bonus, memberActive: policy.memberActive,
      ...effects, promoted: policy.promoted, policy: policy.evidence, paidAt: policy.now }).returning();
    await tx.insert(otherOrderStatus).values({ oid: order.id, changeType: 'pay_success', changeMessage: '线下消费外部支付成功',
      shopType: 3, changeTime: policy.now });
    return result(receipt, false);
}
