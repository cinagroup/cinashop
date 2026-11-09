import {readRoutineSubscriptionRechargeRefundNoticeSourceTx}from './RoutineSubscriptionRechargeRefundSource';
import type {RoutineSubscriptionRechargeRefundFacts}from './RoutineSubscriptionRechargeRefundEvidenceCodec';
import {readRoutineSubscriptionRechargeNoticeSourceTx} from './RoutineSubscriptionRechargeSource';
import type {RoutineSubscriptionRechargeNoticeFacts} from './RoutineSubscriptionRechargeEvidenceCodec';
import { readRoutineSubscriptionMembershipNoticeSourceTx } from './RoutineSubscriptionMembershipSource';
import { membershipSubscriptionTransientSqlState, type RoutineSubscriptionMembershipNoticeFacts } from './RoutineSubscriptionMembershipEvidenceCodec';
import { readRoutineSubscriptionPaidNoticeSourceTx } from './RoutineSubscriptionPaidSource';
import type { RoutineSubscriptionPaidNoticeFacts } from './RoutineSubscriptionPaidEvidenceCodec';
import { Buffer } from 'node:buffer';
import { asc, eq, or, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { orderNotificationDelivery, storeOrder, storeOrderOutbox, storeOrderRefund, storeOrderRefundPayment,
  type OrderDeliveryNoticeOutboxPayload, type OrderRefundRefusedNoticeOutboxPayload, type OrderRefundSuccessNoticeOutboxPayload, type OrderPinkSuccessNoticeOutboxPayload } from '@/models/schema';
import { assertRoutineSubscriptionDeliveryReadyTx } from '@/migrations/routineSubscriptionDelivery';
import { assertRoutineSubscriptionReadyTx } from '@/migrations/routineSubscription';
import { amountToCents } from '@/services/payment/RefundGateway';
import { assertOrderNotificationPayload, customerCityNoticeIsActive, ORDER_DELIVERY_NOTICE_EVENT, ORDER_REFUND_REFUSED_NOTICE_EVENT, ORDER_REFUND_SUCCESS_NOTICE_EVENT,
  orderDeliveryNoticeEventKey, orderRefundRefusedNoticeEventKey, orderRefundSuccessNoticeEventKey, readRoutineDeliveryNotificationDataTx,
  readRoutineRefundRefusalNotificationDataTx, readRoutineRefundSuccessNotificationDataTx, ORDER_PINK_SUCCESS_NOTICE_EVENT, readRoutinePinkSuccessNotificationDataTx } from '@/services/order/OrderNotificationOutboxService';
import { readRoutineIdentityOwnerForUidTx } from './RoutineIdentityOwnership';
import { readRoutineSubscriptionOriginalTx } from './RoutineSubscriptionOriginal';
import { assertNativeAppExcludedForRoutineSubscriptionTx } from './NativeAppRoutineSubscriptionAuthority';
import { parseRoutineSubscriptionNoticeRequest } from './RoutineSubscriptionNoticeRequest';
import { parseRoutineSubscriptionRefusalRequest, assertRoutineSubscriptionRefusalDecision } from './RoutineSubscriptionRefusalRequest';
import { parseRoutineSubscriptionRefundSuccessRequest, assertRoutineSubscriptionRefundSuccessDecision } from './RoutineSubscriptionRefundSuccessRequest';
import { parseRoutineSubscriptionMaterializedRefundSuccessRequest, assertRoutineSubscriptionMaterializedRefundSuccessDecision } from './RoutineSubscriptionMaterializedRefundSuccessRequest';
import { readRoutineMaterializedRefundSuccessSourceTx, type MaterializedRefundSuccessPublicRefund } from './RoutineSubscriptionMaterializedRefundSource';
import { parseRoutineSubscriptionPinkRequest, readRoutineSubscriptionPinkTargetTx } from './RoutineSubscriptionPinkRequest';
import { routineSubscriptionNoticeKey, routineSubscriptionRechargeRefundKey, routineSubscriptionPaidKey, routineSubscriptionRechargeKey, routineSubscriptionMembershipKey } from './RoutineSubscriptionNoticeKinds';
import { parseRoutineSubscriptionNoticeIntent } from './RoutineSubscriptionNoticeIntent';
import { captureRoutineSubscriptionEnv, freezeSubscription, prepareRoutineSubscriptionAccountTx,
  routineSubscriptionUnavailable, routineSubscriptionScopeTx, routineSubscriptionClockTx, subscriptionInteger, subscriptionMac, subscriptionObject, subscriptionSame,
  type PreparedRoutineSubscriptionAccount } from './RoutineSubscriptionAccount';

export interface RoutineSubscriptionDeliveryNoticeInput { deliveryId: number; eventKey: string }
export interface RoutineSubscriptionNoticeRequest {
  touser: string; template_id: string; page: string; data: Record<string, { value: string }>;
}
/** Formats 2..6 always reference an authenticated original WeChat payment. */
export interface RoutineSubscriptionLegacyDeliveryNoticeFacts {
  readonly deliveryId: number; readonly outboxId: number; readonly eventKey: string;
  readonly orderId: number; readonly rootId: number; readonly buyerUid: number; readonly appId: string;
  readonly ownershipId: string; readonly bindingId: number; readonly observationId: string;
  readonly evidenceId: string; readonly evidenceSignature: string;
  readonly relatedDigest: string; readonly approvedUseDigest: string;
  readonly templateMark: '1458' | '1128' | '1451' | '3098'; readonly sourceDigest: string;
}
/** A 1927 paid source has its own closed payment variant; a balance payment
 * must never acquire synthetic legacy original-evidence fields. */
export type RoutineSubscriptionDeliveryNoticeFacts = RoutineSubscriptionLegacyDeliveryNoticeFacts | RoutineSubscriptionPaidNoticeFacts | RoutineSubscriptionMembershipNoticeFacts | RoutineSubscriptionRechargeNoticeFacts | RoutineSubscriptionRechargeRefundFacts;
const noticeSlot = Symbol('routine.subscription.delivery-notice-source.v1');
export interface PreparedRoutineSubscriptionDeliveryNotice {
  readonly [noticeSlot]: true;
  readonly facts: RoutineSubscriptionDeliveryNoticeFacts;
  readonly account: PreparedRoutineSubscriptionAccount;
  readonly request: Readonly<RoutineSubscriptionNoticeRequest>;
}
const notices = new WeakMap<PreparedRoutineSubscriptionDeliveryNotice, { input: Readonly<RoutineSubscriptionDeliveryNoticeInput>; tx: DbClient }>();
const bounded = (value: unknown, max: number): value is string => typeof value === 'string'
  && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);

function input(value: RoutineSubscriptionDeliveryNoticeInput): RoutineSubscriptionDeliveryNoticeInput {
  const r = subscriptionObject(value, ['deliveryId', 'eventKey']);
  if (!subscriptionInteger(r.deliveryId) || typeof r.eventKey !== 'string'
    || !routineSubscriptionNoticeKey(r.eventKey))
    return routineSubscriptionUnavailable();
  return Object.freeze({ deliveryId: r.deliveryId, eventKey: r.eventKey });
}
function environment(env: Env): Env {
  const signing = captureRoutineSubscriptionEnv(env), connectionString = env.HYPERDRIVE?.connectionString;
  return Object.freeze({ ...signing, HYPERDRIVE: connectionString === undefined ? undefined : Object.freeze({ connectionString }) }) as Env;
}
function root(container: Container) {
  if (!Object.hasOwn(container.db, '$client') || !container.db.$client) return routineSubscriptionUnavailable();
}
export async function acquireRoutineSubscriptionNoticeSourceGatesTx(tx: DbClient) {
  // Every lower maintenance gate is taken before physical source/identity locks.
  // Reentrant guards in the original, ownership, witness and NativeApp readers
  // cannot introduce a new lower-order dependency inside this transaction.
  for (const first of [731663, 731664, 731669, 731714, 731716, 731717, 731718, 731725, 731726]) {
    const [row] = await tx.execute<{ locked: boolean }>(sql`SELECT pg_catalog.pg_try_advisory_xact_lock_shared(${first},0) AS locked`);
    if (row?.locked !== true) return routineSubscriptionUnavailable();
  }
  if (!await assertRoutineSubscriptionReadyTx(tx)) return routineSubscriptionUnavailable();
}
function immutableDelivery(row: typeof orderNotificationDelivery.$inferSelect) {
  return { id: row.id, outboxId: row.outboxId, eventKey: row.eventKey, orderId: row.orderId,
    withdrawalId: row.withdrawalId, userId: row.userId, noticeMark: row.noticeMark, channel: row.channel,
    target: row.target, templateCode: row.templateCode, payload: row.payload, addTime: row.addTime };
}
export interface RoutineSubscriptionNoticeAuthorInput { outboxId: number; eventKey: string }
const authorSlot = Symbol('routine.subscription.notice-author.v2');
export interface PreparedRoutineSubscriptionNoticeAuthor {
  readonly [authorSlot]: true; readonly facts: RoutineSubscriptionDeliveryNoticeFacts;
  readonly account: PreparedRoutineSubscriptionAccount; readonly request: Readonly<RoutineSubscriptionNoticeRequest>;
  readonly renderedAt: number; readonly requestSignature: string;
}
const authors = new WeakMap<PreparedRoutineSubscriptionNoticeAuthor, DbClient>();
export function assertRoutineSubscriptionNoticeAuthorTx(tx: DbClient, value: PreparedRoutineSubscriptionNoticeAuthor) {
  if (authors.get(value) !== tx) return routineSubscriptionUnavailable(); return value;
}
function business(payload: OrderDeliveryNoticeOutboxPayload) {
  return { orderId: payload.orderId, orderNo: payload.orderNo, userId: payload.userId, deliveryType: payload.deliveryType,
    deliveryName: payload.deliveryName, deliveryId: payload.deliveryId, userAddress: payload.userAddress,
    ...(payload.cityDeliveryJobId === undefined ? {} : { cityDeliveryJobId: payload.cityDeliveryJobId }) };
}
async function versionedRequest(tx: DbClient, env: Env, event: typeof storeOrderOutbox.$inferSelect) {
  const payload = event.payload as OrderDeliveryNoticeOutboxPayload | OrderRefundRefusedNoticeOutboxPayload | OrderRefundSuccessNoticeOutboxPayload | OrderPinkSuccessNoticeOutboxPayload;
  if (!Object.hasOwn(payload, 'routineSubscriptionRequest') || Object.hasOwn(payload, 'routineAppId')) return routineSubscriptionUnavailable();
  const success = event.eventType === ORDER_REFUND_SUCCESS_NOTICE_EVENT;
  const refusal = event.eventType === ORDER_REFUND_REFUSED_NOTICE_EVENT, pink = event.eventType === ORDER_PINK_SUCCESS_NOTICE_EVENT, scope = await routineSubscriptionScopeTx(tx);
  const r = success ? Object.hasOwn(payload, 'materializedRefund')
    ? parseRoutineSubscriptionMaterializedRefundSuccessRequest(env, payload.routineSubscriptionRequest, scope)
    : parseRoutineSubscriptionRefundSuccessRequest(env, payload.routineSubscriptionRequest, scope)
    : pink ? parseRoutineSubscriptionPinkRequest(env, payload.routineSubscriptionRequest, scope)
    : refusal ? parseRoutineSubscriptionRefusalRequest(env, payload.routineSubscriptionRequest, scope)
    : parseRoutineSubscriptionNoticeRequest(env, payload.routineSubscriptionRequest, scope);
  const expected = pink ? { orderId: payload.orderId, orderNo: payload.orderNo, userId: payload.userId,
    pinkId: (payload as OrderPinkSuccessNoticeOutboxPayload).pinkId, people: (payload as OrderPinkSuccessNoticeOutboxPayload).people }
    : refusal || success ? { orderId: payload.orderId, orderNo: payload.orderNo, refundId: (payload as OrderRefundRefusedNoticeOutboxPayload).refundId,
    userId: payload.userId, payPrice: (payload as OrderRefundRefusedNoticeOutboxPayload).payPrice,
      ...(success && Object.hasOwn(payload, 'materializedRefund') ? { materializedRefund: (payload as OrderRefundSuccessNoticeOutboxPayload).materializedRefund } : {}) } : business(payload as OrderDeliveryNoticeOutboxPayload);
  if (r.eventKey !== event.eventKey || r.aggregateId !== event.aggregateId || r.eventTime !== event.addTime || !subscriptionSame(r.body, expected))
    return routineSubscriptionUnavailable();
  return r;
}
async function readSource(tx: DbClient, env: Env, expected: Readonly<RoutineSubscriptionDeliveryNoticeInput> | Readonly<RoutineSubscriptionNoticeAuthorInput>) {
  await acquireRoutineSubscriptionNoticeSourceGatesTx(tx);
  if(routineSubscriptionRechargeRefundKey(expected.eventKey))return readRoutineSubscriptionRechargeRefundNoticeSourceTx(tx,env,expected);
  if(routineSubscriptionRechargeKey(expected.eventKey))return readRoutineSubscriptionRechargeNoticeSourceTx(tx,env,expected);
  if (routineSubscriptionMembershipKey(expected.eventKey)) return readRoutineSubscriptionMembershipNoticeSourceTx(tx, env, expected);
  if (routineSubscriptionPaidKey(expected.eventKey)) return readRoutineSubscriptionPaidNoticeSourceTx(tx, env, expected);
  const author = 'outboxId' in expected;
  if (author) {
    if (!await assertRoutineSubscriptionDeliveryReadyTx(tx)) return routineSubscriptionUnavailable();
    await tx.execute(sql`LOCK TABLE ONLY public.store_order_outbox, ONLY public.order_notification_delivery IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
  }
  const hint = !author ? (await tx.select().from(orderNotificationDelivery).where(eq(orderNotificationDelivery.id, expected.deliveryId)).limit(1))[0] : undefined;
  const eventHint = (await tx.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id, author ? expected.outboxId : hint?.outboxId ?? 0)).limit(1))[0];
  const success = eventHint?.eventType === ORDER_REFUND_SUCCESS_NOTICE_EVENT;
  const materialized = success && Object.hasOwn(eventHint!.payload, 'materializedRefund');
  const refusal = eventHint?.eventType === ORDER_REFUND_REFUSED_NOTICE_EVENT;
  const pink = eventHint?.eventType === ORDER_PINK_SUCCESS_NOTICE_EVENT;
  if (!eventHint || ![ORDER_DELIVERY_NOTICE_EVENT, ORDER_REFUND_REFUSED_NOTICE_EVENT, ORDER_REFUND_SUCCESS_NOTICE_EVENT, ORDER_PINK_SUCCESS_NOTICE_EVENT].includes(eventHint.eventType)) return routineSubscriptionUnavailable();
  const tables = ['store_order', 'store_order_cart_info', 'user_recharge', 'other_order', 'store_order_outbox', 'order_notification_delivery', 'user', 'wechat_user',
    ...(refusal || success ? ['store_order_refund', 'store_order_refund_payment', ...(materialized ? ['store_order_refund_split'] : [])] : pink ? ['store_order_refund', 'store_pink'] : [])];
  for (const table of tables) {
    const [resolution] = await tx.execute<{ ready: boolean }>(sql`SELECT
      pg_catalog.to_regclass(${table})=pg_catalog.to_regclass(${'public.' + table}) AS ready`);
    if (resolution?.ready !== true) return routineSubscriptionUnavailable();
  }
  await tx.execute(sql`LOCK TABLE ONLY public.store_order, ONLY public.store_order_cart_info, ONLY public.user_recharge, ONLY public.other_order,
    ONLY public.store_order_outbox, ONLY public.order_notification_delivery IN SHARE MODE NOWAIT`);
  if (refusal || success) await tx.execute(sql`LOCK TABLE ONLY public.store_order_refund, ONLY public.store_order_refund_payment IN SHARE MODE NOWAIT`);
  if (pink) await tx.execute(sql`LOCK TABLE ONLY public.store_order_refund, ONLY public.store_pink IN SHARE MODE NOWAIT`);
  if (materialized) await tx.execute(sql`LOCK TABLE ONLY public.store_order_refund_split IN ACCESS SHARE MODE NOWAIT`);
  if (author ? eventHint.eventKey !== expected.eventKey
    : !hint || hint.channel !== 'wechat_routine' || hint.eventKey !== expected.eventKey || !subscriptionInteger(hint.orderId)
      || hint.withdrawalId !== null || !['PENDING', 'ENQUEUED', 'PROCESSING', 'RETRYABLE'].includes(hint.status)
      || Buffer.byteLength(JSON.stringify(hint.payload), 'utf8') > (Object.hasOwn(hint.payload, 'routineSubscriptionIntent') ? 65536 : 32768)) return routineSubscriptionUnavailable();
  const childId = author ? eventHint!.aggregateId : hint!.orderId!;
  const [orderHint] = await tx.select({ id: storeOrder.id, pid: storeOrder.pid }).from(storeOrder).where(eq(storeOrder.id, childId)).limit(1);
  if (!orderHint) return routineSubscriptionUnavailable();
  const rootId = orderHint.pid > 0 ? orderHint.pid : orderHint.id;
  const family = await tx.select().from(storeOrder).where(or(eq(storeOrder.id, rootId), eq(storeOrder.pid, rootId)))
    .orderBy(asc(storeOrder.id)).limit(66).for('share', { noWait: true });
  if (!family.length || family.length > 65 || Buffer.byteLength(JSON.stringify(family), 'utf8') > 1048576) return routineSubscriptionUnavailable();
  const parent = family.find(row => row.id === rootId), child = family.find(row => row.id === childId);
  if (!parent || !child || ![0, -1].includes(parent.pid) || (child.pid > 0 ? child.pid : child.id) !== rootId
    || !subscriptionInteger(parent.uid) || parent.paid !== 1 || parent.payType !== 'weixin' || !bounded(parent.tradeNo, 100) || !parent.tradeNo)
    return routineSubscriptionUnavailable();
  const total = amountToCents(parent.payPrice), split = parent.pid === -1;
  const leaves = split ? family.filter(row => row.pid === rootId) : [parent];
  if (total === null || total <= 0 || (split ? (pink ? child.id !== rootId : child.pid !== rootId) || leaves.length < 2 || family.length !== leaves.length + 1
    : child.id !== rootId || family.length !== 1)) return routineSubscriptionUnavailable();
  if (family.some(row => row.uid !== parent.uid || row.paid !== 1 || row.payType !== 'weixin'
    || row.isDel !== 0 || row.isSystemDel !== 0 || row.tradeNo !== parent.tradeNo)) return routineSubscriptionUnavailable();
  const amounts = leaves.map(row => amountToCents(row.payPrice));
  if (amounts.some(value => value === null || value < 0) || amounts.reduce<number>((sum, value) => sum + (value ?? 0), 0) !== total)
    return routineSubscriptionUnavailable();
  const candidates = await tx.execute<{ domain: string; id: number }>(sql`
    SELECT 'store_order' AS domain,id FROM public.store_order WHERE order_id=${parent.orderId} OR trade_no=${parent.tradeNo}
    UNION ALL SELECT 'recharge',id FROM public.user_recharge WHERE order_id=${parent.orderId} OR trade_no=${parent.tradeNo}
    UNION ALL SELECT 'membership',id FROM public.other_order WHERE order_id=${parent.orderId} OR trade_no=${parent.tradeNo}
    LIMIT 66`);
  if (!candidates.length || candidates.length > 65 || new Set(family.map(row => row.orderId)).size !== family.length
    || candidates.some(candidate => candidate.domain !== 'store_order' || !family.some(row => row.id === candidate.id)))
    return routineSubscriptionUnavailable();
  const [event] = await tx.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id, author ? expected.outboxId : hint!.outboxId)).limit(1).for('share', { noWait: true });
  const delivery = !author ? (await tx.select().from(orderNotificationDelivery).where(eq(orderNotificationDelivery.id, expected.deliveryId)).limit(1).for('share', { noWait: true }))[0] : undefined;
  if (!event || event.eventKey !== expected.eventKey || event.eventType !== eventHint.eventType || event.aggregateType !== 'order' || event.aggregateId !== child.id
    || !author && (!delivery || !hint || !subscriptionSame(immutableDelivery(hint), immutableDelivery(delivery)) || delivery.userId !== parent.uid))
    return routineSubscriptionUnavailable();
  assertOrderNotificationPayload(event.payload, event.eventType, event.aggregateId);
  const payload = event.payload as OrderDeliveryNoticeOutboxPayload | OrderRefundRefusedNoticeOutboxPayload | OrderRefundSuccessNoticeOutboxPayload | OrderPinkSuccessNoticeOutboxPayload;
  const signedRequest = Object.hasOwn(payload, 'routineSubscriptionRequest') ? await versionedRequest(tx, env, event) : undefined;
  if (author && !signedRequest) return routineSubscriptionUnavailable();
  if (!success && payload.orderNo !== child.orderId || payload.userId !== parent.uid || payload.orderId !== child.id) return routineSubscriptionUnavailable();
  let refund: typeof storeOrderRefund.$inferSelect | MaterializedRefundSuccessPublicRefund | undefined;
  let materializedSource: { materializationDigest: string; selectedDigest: string } | undefined;
  let refundPayment: typeof storeOrderRefundPayment.$inferSelect | undefined;
  let pinkTarget: Awaited<ReturnType<typeof readRoutineSubscriptionPinkTargetTx>> | undefined;
  if (pink) {
    if (!signedRequest || signedRequest.format !== 4 || child.id !== rootId || event.eventKey !== `order.pink.success.notice:${child.id}`)
      return routineSubscriptionUnavailable();
    pinkTarget = await readRoutineSubscriptionPinkTargetTx(tx, env, signedRequest);
  } else if (success) {
    const p = payload as OrderRefundSuccessNoticeOutboxPayload;
    if (!signedRequest || (signedRequest.format !== 5 && signedRequest.format !== 6)
      || event.eventKey !== orderRefundSuccessNoticeEventKey(p.refundId) || p.payPrice !== child.payPrice)
      return routineSubscriptionUnavailable();
    if (signedRequest.format === 6) {
      if (!p.materializedRefund || p.materializedRefund.paymentOrderId !== rootId) return routineSubscriptionUnavailable();
      const source = await readRoutineMaterializedRefundSuccessSourceTx(tx, signedRequest.body);
      refund = source.refund;
      materializedSource = { materializationDigest: source.materializationDigest, selectedDigest: source.selectedDigest };
      assertRoutineSubscriptionMaterializedRefundSuccessDecision(env, signedRequest, refund, materializedSource);
      if (refund.refundedTime < parent.payTime) return routineSubscriptionUnavailable();
    } else {
      if (materialized || split || child.type !== 0 || child.pid !== 0 || child.refundType !== 6 || child.refundStatus !== 2
        || child.refundPrice !== p.payPrice) return routineSubscriptionUnavailable();
      refund = (await tx.select().from(storeOrderRefund).where(eq(storeOrderRefund.id, p.refundId)).limit(1).for('share', { noWait: true }))[0];
      if (!refund || refund.storeOrderId !== child.id || refund.uid !== parent.uid || refund.storeId !== child.storeId
        || refund.supplierId !== child.supplierId || refund.orderId !== p.orderNo || !subscriptionInteger(child.totalNum)
        || refund.refundNum !== child.totalNum || refund.refundedTime < parent.payTime) return routineSubscriptionUnavailable();
      assertRoutineSubscriptionRefundSuccessDecision(env, signedRequest, refund);
    }
    const payments = await tx.select().from(storeOrderRefundPayment).where(eq(storeOrderRefundPayment.refundId, refund.id)).limit(2).for('share', { noWait: true });
    if (payments.length !== 1 || payments[0].storeOrderId !== (p.materializedRefund?.sourceOrderId ?? child.id) || payments[0].provider !== 'wechat'
      || payments[0].providerStatus !== 'SUCCESS' || payments[0].requestAmount !== amountToCents(p.materializedRefund?.refundAmount ?? p.payPrice)) return routineSubscriptionUnavailable();
    refundPayment = payments[0];
    const { assertRoutineRefundProjectionTx } = await import('../payment/RoutineRefundProvider');
    if (!await assertRoutineRefundProjectionTx(tx, env, refund.id)) return routineSubscriptionUnavailable();
    if (Buffer.byteLength(JSON.stringify(refund), 'utf8') > 1048576) return routineSubscriptionUnavailable();
  } else if (refusal) {
    const p = payload as OrderRefundRefusedNoticeOutboxPayload;
    if (!signedRequest || signedRequest.format !== 3 || event.eventKey !== orderRefundRefusedNoticeEventKey(p.refundId)
      || p.payPrice !== child.payPrice || amountToCents(p.payPrice) === null) return routineSubscriptionUnavailable();
    refund = (await tx.select().from(storeOrderRefund).where(eq(storeOrderRefund.id, p.refundId)).limit(1).for('share', { noWait: true }))[0];
    if (!refund || refund.storeOrderId !== child.id || refund.uid !== parent.uid || refund.storeId !== child.storeId
      || refund.supplierId !== child.supplierId || refund.refundedTime < parent.payTime) return routineSubscriptionUnavailable();
    assertRoutineSubscriptionRefusalDecision(env, signedRequest, refund);
    const payments = await tx.select().from(storeOrderRefundPayment).where(eq(storeOrderRefundPayment.refundId, refund.id)).limit(2).for('share', { noWait: true });
    if (payments.length > 1 || payments.some(p => p.storeOrderId !== child.id || !['CREATED', 'FAILED', 'CLOSED'].includes(p.providerStatus))) return routineSubscriptionUnavailable();
    refundPayment = payments[0];
    if (Buffer.byteLength(JSON.stringify(refund), 'utf8') > 1048576) return routineSubscriptionUnavailable();
  } else {
    const p = payload as OrderDeliveryNoticeOutboxPayload;
    if (event.eventKey !== orderDeliveryNoticeEventKey(child.id, p.cityDeliveryJobId) || child.status < 1 || !['express', 'send', 'city_delivery'].includes(p.deliveryType)
      || p.deliveryType !== child.deliveryType || p.deliveryName !== child.deliveryName
      || p.deliveryType !== 'city_delivery' && p.deliveryId !== child.deliveryId || !await customerCityNoticeIsActive(tx, p)) return routineSubscriptionUnavailable();
  }
  const original = await readRoutineSubscriptionOriginalTx(tx, env, { rootId, buyerUid: parent.uid, orderNo: parent.orderId,
    transactionId: parent.tradeNo, totalAmount: total });
  await assertNativeAppExcludedForRoutineSubscriptionTx(tx, env, original);
  const appId = original.evidence.payload.observation.facts.appId;
  const owner = await readRoutineIdentityOwnerForUidTx(tx, env, { uid: parent.uid, appId });
  if (!owner) return routineSubscriptionUnavailable();
  const templateMark = pink ? '3098' as const : refusal || success ? '1451' as const : (payload as OrderDeliveryNoticeOutboxPayload).deliveryType === 'express' ? '1458' as const : '1128' as const;
  const account = await prepareRoutineSubscriptionAccountTx(tx, env, appId, templateMark);
  if (account.template.templateId.length > 100) return routineSubscriptionUnavailable();
  const renderedAt = author ? await routineSubscriptionClockTx(tx) : delivery!.addTime;
  const data = pink ? await readRoutinePinkSuccessNotificationDataTx(tx, payload as OrderPinkSuccessNoticeOutboxPayload, pinkTarget!)
    : success ? await readRoutineRefundSuccessNotificationDataTx(tx, payload as OrderRefundSuccessNoticeOutboxPayload)
    : refusal ? await readRoutineRefundRefusalNotificationDataTx(tx, payload as OrderRefundRefusedNoticeOutboxPayload)
    : await readRoutineDeliveryNotificationDataTx(tx, payload as OrderDeliveryNoticeOutboxPayload, renderedAt);
  if (Object.values(data).some(value => !bounded(value, 500))) return routineSubscriptionUnavailable();
  const url = refusal || success ? `/pages/goods/order_after_details/index?order_id=${payload.orderNo}&isReturen=1`
    : `/pages/goods/order_details/index?order_id=${payload.orderNo}`;
  const request = freezeSubscription({ touser: owner.owner.openid, template_id: account.template.templateId, page: url,
    data: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, { value }])) });
  if (!author) {
    const expectedKeys = ['kind', 'routineAppId', 'data', 'url', ...(signedRequest ? ['routineSubscriptionIntent'] : [])];
    const rendered = subscriptionObject(delivery!.payload, expectedKeys);
    const expectedMark = success ? 'order_refund' : pink ? 'order_user_groups_success' : refusal ? 'send_order_refund_no_status'
      : (payload as OrderDeliveryNoticeOutboxPayload).deliveryType === 'express' ? 'order_postage_success' : 'order_deliver_success';
    if (rendered.kind !== 'wechat_routine' || rendered.routineAppId !== appId || !signedRequest && payload.routineAppId !== appId
      || delivery!.target !== owner.owner.openid || delivery!.noticeMark !== expectedMark || delivery!.templateCode !== account.template.templateId
      || rendered.url !== url || !subscriptionSame(rendered.data, data)) return routineSubscriptionUnavailable();
    if (signedRequest) {
      const intent = parseRoutineSubscriptionNoticeIntent(env, rendered.routineSubscriptionIntent, await routineSubscriptionScopeTx(tx));
      if (intent.format !== signedRequest.format || intent.deliveryId !== delivery!.id || intent.outboxId !== event.id || intent.eventKey !== event.eventKey || intent.createdAt !== delivery!.addTime
        || intent.requestSignature !== signedRequest.signature || intent.source.orderId !== child.id || intent.source.rootId !== rootId
        || intent.source.buyerUid !== parent.uid || intent.source.appId !== appId || !subscriptionSame(intent.request, request)) return routineSubscriptionUnavailable();
    }
  }
  const identity = { deliveryId: delivery?.id ?? 0, outboxId: event.id, eventKey: event.eventKey, orderId: child.id, rootId,
    buyerUid: parent.uid, appId, ownershipId: owner.owner.ownershipId, bindingId: owner.owner.bindingId,
    observationId: owner.owner.observationId, evidenceId: original.evidence.evidence_id, evidenceSignature: original.evidence.signature,
    relatedDigest: original.relatedDigest, approvedUseDigest: original.approvedUseDigest, templateMark };
  const eventIdentity = { id: event.id, eventKey: event.eventKey, eventType: event.eventType, aggregateType: event.aggregateType,
    aggregateId: event.aggregateId, payload: event.payload, addTime: event.addTime };
  const digestFacts = [identity, family, eventIdentity, delivery ? immutableDelivery(delivery) : null, owner, account.account, request];
  const sourceDigest = subscriptionMac(env, author ? 'notice-author-source' : 'delivery-notice-source',
    pink ? [...digestFacts, pinkTarget] : refusal || success ? [...digestFacts, refund, refundPayment ?? null, ...(materializedSource ? [materializedSource] : [])] : digestFacts);
  const [tail] = await tx.execute<{ ready: boolean }>(sql`SELECT pg_catalog.clock_timestamp()<=pg_catalog.transaction_timestamp()+interval '5 seconds'
    AND pg_catalog.clock_timestamp()<pg_catalog.to_timestamp(${account.account.payload.data.validUntil}) AS ready`);
  if (tail?.ready !== true) return routineSubscriptionUnavailable();
  return { facts: freezeSubscription({ ...identity, sourceDigest }), account, request, renderedAt, requestSignature: signedRequest?.signature ?? '' };
}
async function prepare(tx: DbClient, env: Env, expected: Readonly<RoutineSubscriptionDeliveryNoticeInput>) {
  const source = await readSource(tx, env, expected);
  const prepared = Object.freeze({ [noticeSlot]: true as const, facts: source.facts, account: source.account, request: source.request });
  notices.set(prepared, { input: expected, tx }); return prepared;
}
export async function prepareRoutineSubscriptionNoticeAuthorTx(tx: DbClient, env: Env, raw: RoutineSubscriptionNoticeAuthorInput): Promise<PreparedRoutineSubscriptionNoticeAuthor> {
  const r = subscriptionObject(raw, ['outboxId', 'eventKey']);
  if (!subscriptionInteger(r.outboxId) || typeof r.eventKey !== 'string' || r.eventKey.length > 128
    || !routineSubscriptionNoticeKey(r.eventKey)) return routineSubscriptionUnavailable();
  const captured = Object.freeze({ outboxId: r.outboxId, eventKey: r.eventKey }), signing = environment(env);
  try {
    const source = await readSource(tx, signing, captured), prepared = Object.freeze({ [authorSlot]: true as const, ...source });
    authors.set(prepared, tx); return prepared;
  } catch { return routineSubscriptionUnavailable(); }
}

/** Same-transaction fresh source for the immutable dispatch author. The caller
 * must enter before its physical locks; all lower maintenance gates are first. */
export async function prepareRoutineSubscriptionDeliveryNoticeTx(tx: DbClient, env: Env, raw: RoutineSubscriptionDeliveryNoticeInput) {
  const captured = input(raw), signing = environment(env);
  try { return await prepare(tx, signing, captured); }
  catch (error) {
    // Preserve only the new member protocol's bounded SQL cause. The dispatch
    // author still decides whether an untouched pre-attempt claim may retry;
    // durable admission/possible POST failures remain UNKNOWN.
    if ((routineSubscriptionMembershipKey(captured.eventKey)||routineSubscriptionRechargeKey(captured.eventKey)||routineSubscriptionRechargeRefundKey(captured.eventKey)) && membershipSubscriptionTransientSqlState(error)) throw error;
    return routineSubscriptionUnavailable();
  }
}
export function assertRoutineSubscriptionDeliveryNoticeTx(tx: DbClient, value: PreparedRoutineSubscriptionDeliveryNotice) {
  if (notices.get(value)?.tx !== tx) return routineSubscriptionUnavailable(); return value;
}

/** Prospective delivery-notice evidence only. It neither creates an attempt nor
 * authorizes a POST; durable dispatch/result admission must still precede send.
 * Dispatch admission additionally requires its same-transaction API above. */
export async function prepareRoutineSubscriptionDeliveryNotice(container: Container, env: Env, raw: RoutineSubscriptionDeliveryNoticeInput) {
  root(container); const captured = input(raw), signing = environment(env);
  try { return await withTx(container, tx => prepare(tx, signing, captured)); }
  catch (error) {
    // Older notice formats keep their existing conservative normalization.
    // A member SQL lock/timeout must reach the pre-attempt retry classifier.
    if ((routineSubscriptionMembershipKey(captured.eventKey)||routineSubscriptionRechargeKey(captured.eventKey)||routineSubscriptionRechargeRefundKey(captured.eventKey)) && membershipSubscriptionTransientSqlState(error)) throw error;
    return routineSubscriptionUnavailable();
  }
}
export function assertPreparedRoutineSubscriptionDeliveryNotice(value: PreparedRoutineSubscriptionDeliveryNotice) {
  if (!notices.has(value)) return routineSubscriptionUnavailable(); return value;
}
/** Re-read all source, target and latest template/material facts in a new short
 * actual-App transaction. A token return alone never replaces this boundary. */
export async function recheckRoutineSubscriptionDeliveryNotice(container: Container, env: Env, value: PreparedRoutineSubscriptionDeliveryNotice) {
  assertPreparedRoutineSubscriptionDeliveryNotice(value);
  const current = await prepareRoutineSubscriptionDeliveryNotice(container, env, notices.get(value)!.input);
  if (current.facts.sourceDigest !== value.facts.sourceDigest || !subscriptionSame(current.request, value.request))
    return routineSubscriptionUnavailable();
  return current;
}
