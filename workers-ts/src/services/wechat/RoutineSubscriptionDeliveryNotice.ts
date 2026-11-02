import { Buffer } from 'node:buffer';
import { asc, eq, or, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { orderNotificationDelivery, storeOrder, storeOrderOutbox, type OrderDeliveryNoticeOutboxPayload } from '@/models/schema';
import { assertRoutineSubscriptionReadyTx } from '@/migrations/routineSubscription';
import { amountToCents } from '@/services/payment/RefundGateway';
import { assertOrderNotificationPayload, customerCityNoticeIsActive, ORDER_DELIVERY_NOTICE_EVENT,
  orderDeliveryNoticeEventKey, readRoutineDeliveryNotificationDataTx } from '@/services/order/OrderNotificationOutboxService';
import { readRoutineIdentityOwnerForUidTx } from './RoutineIdentityOwnership';
import { readRoutineSubscriptionOriginalTx } from './RoutineSubscriptionOriginal';
import { assertNativeAppExcludedForRoutineSubscriptionTx } from './NativeAppRoutineSubscriptionAuthority';
import { captureRoutineSubscriptionEnv, freezeSubscription, prepareRoutineSubscriptionAccountTx,
  routineSubscriptionUnavailable, subscriptionInteger, subscriptionMac, subscriptionObject, subscriptionSame,
  type PreparedRoutineSubscriptionAccount } from './RoutineSubscriptionAccount';

export interface RoutineSubscriptionDeliveryNoticeInput { deliveryId: number; eventKey: string }
export interface RoutineSubscriptionNoticeRequest {
  touser: string; template_id: string; page: string; data: Record<string, { value: string }>;
}
export interface RoutineSubscriptionDeliveryNoticeFacts {
  readonly deliveryId: number; readonly outboxId: number; readonly eventKey: string;
  readonly orderId: number; readonly rootId: number; readonly buyerUid: number; readonly appId: string;
  readonly ownershipId: string; readonly bindingId: number; readonly observationId: string;
  readonly evidenceId: string; readonly evidenceSignature: string;
  readonly relatedDigest: string; readonly approvedUseDigest: string;
  readonly templateMark: '1458' | '1128'; readonly sourceDigest: string;
}
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
    || !/^order\.delivery\.notice:[1-9]\d*(?::city:[1-9]\d*)?$/u.test(r.eventKey) || r.eventKey.length > 128)
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
async function gates(tx: DbClient) {
  // Every lower maintenance gate is taken before physical source/identity locks.
  // Reentrant guards in the original, ownership, witness and NativeApp readers
  // cannot introduce a new lower-order dependency inside this transaction.
  for (const first of [731663, 731664, 731669, 731714, 731716, 731717, 731725, 731726]) {
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
async function prepare(tx: DbClient, env: Env, expected: Readonly<RoutineSubscriptionDeliveryNoticeInput>) {
  await gates(tx);
  const tables = ['store_order', 'store_order_cart_info', 'user_recharge', 'other_order', 'store_order_outbox', 'order_notification_delivery', 'user', 'wechat_user'];
  for (const table of tables) {
    const [resolution] = await tx.execute<{ ready: boolean }>(sql`SELECT
      pg_catalog.to_regclass(${table})=pg_catalog.to_regclass(${'public.' + table}) AS ready`);
    if (resolution?.ready !== true) return routineSubscriptionUnavailable();
  }
  // Stabilize the complete same-number universe, including absent candidates,
  // before deriving a root. No order, delivery or identity mutation is made.
  await tx.execute(sql`LOCK TABLE ONLY public.store_order, ONLY public.store_order_cart_info, ONLY public.user_recharge, ONLY public.other_order,
    ONLY public.store_order_outbox, ONLY public.order_notification_delivery IN SHARE MODE NOWAIT`);
  const [hint] = await tx.select().from(orderNotificationDelivery).where(eq(orderNotificationDelivery.id, expected.deliveryId)).limit(1);
  if (!hint || hint.channel !== 'wechat_routine' || hint.eventKey !== expected.eventKey || !subscriptionInteger(hint.orderId)
    || hint.withdrawalId !== null || !['PENDING', 'ENQUEUED', 'PROCESSING', 'RETRYABLE'].includes(hint.status)
    || Buffer.byteLength(JSON.stringify(hint.payload), 'utf8') > 32768) return routineSubscriptionUnavailable();
  const [orderHint] = await tx.select({ id: storeOrder.id, pid: storeOrder.pid }).from(storeOrder).where(eq(storeOrder.id, hint.orderId)).limit(1);
  if (!orderHint) return routineSubscriptionUnavailable();
  const rootId = orderHint.pid > 0 ? orderHint.pid : orderHint.id;
  const family = await tx.select().from(storeOrder).where(or(eq(storeOrder.id, rootId), eq(storeOrder.pid, rootId)))
    .orderBy(asc(storeOrder.id)).limit(66).for('share', { noWait: true });
  if (!family.length || family.length > 65 || Buffer.byteLength(JSON.stringify(family), 'utf8') > 1048576) return routineSubscriptionUnavailable();
  const parent = family.find(row => row.id === rootId), child = family.find(row => row.id === hint.orderId);
  if (!parent || !child || ![0, -1].includes(parent.pid) || (child.pid > 0 ? child.pid : child.id) !== rootId
    || !subscriptionInteger(parent.uid) || parent.paid !== 1 || parent.payType !== 'weixin' || !bounded(parent.tradeNo, 100) || !parent.tradeNo)
    return routineSubscriptionUnavailable();
  const total = amountToCents(parent.payPrice), split = parent.pid === -1;
  const leaves = split ? family.filter(row => row.pid === rootId) : [parent];
  if (total === null || total <= 0 || (split ? child.pid !== rootId || leaves.length < 2 || family.length !== leaves.length + 1
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
  const [event] = await tx.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id, hint.outboxId)).limit(1).for('share', { noWait: true });
  const [delivery] = await tx.select().from(orderNotificationDelivery).where(eq(orderNotificationDelivery.id, expected.deliveryId)).limit(1).for('share', { noWait: true });
  if (!event || !delivery || !subscriptionSame(immutableDelivery(hint), immutableDelivery(delivery))
    || event.eventKey !== expected.eventKey || event.eventType !== ORDER_DELIVERY_NOTICE_EVENT
    || event.aggregateType !== 'order' || event.aggregateId !== child.id || delivery.userId !== parent.uid)
    return routineSubscriptionUnavailable();
  assertOrderNotificationPayload(event.payload, event.eventType, event.aggregateId);
  const payload = event.payload as OrderDeliveryNoticeOutboxPayload;
  if (event.eventKey !== orderDeliveryNoticeEventKey(child.id, payload.cityDeliveryJobId) || payload.orderNo !== child.orderId
    || payload.userId !== parent.uid || payload.orderId !== child.id || child.status < 1 || !['express', 'send', 'city_delivery'].includes(payload.deliveryType)
    || payload.deliveryType !== child.deliveryType || payload.deliveryName !== child.deliveryName
    || payload.deliveryType !== 'city_delivery' && payload.deliveryId !== child.deliveryId
    || !await customerCityNoticeIsActive(tx, payload)) return routineSubscriptionUnavailable();
  const original = await readRoutineSubscriptionOriginalTx(tx, env, { rootId, buyerUid: parent.uid, orderNo: parent.orderId,
    transactionId: parent.tradeNo, totalAmount: total });
  await assertNativeAppExcludedForRoutineSubscriptionTx(tx, env, original);
  const appId = original.evidence.payload.observation.facts.appId;
  const owner = await readRoutineIdentityOwnerForUidTx(tx, env, { uid: parent.uid, appId });
  if (!owner) return routineSubscriptionUnavailable();
  const templateMark = payload.deliveryType === 'express' ? '1458' as const : '1128' as const;
  const account = await prepareRoutineSubscriptionAccountTx(tx, env, appId, templateMark);
  const rendered = subscriptionObject(delivery.payload, ['kind', 'routineAppId', 'data', 'url']);
  const expectedMark = payload.deliveryType === 'express' ? 'order_postage_success' : 'order_deliver_success';
  // A committed B pin, bare target or unrelated template is never repinned to A.
  if (rendered.kind !== 'wechat_routine' || rendered.routineAppId !== appId || payload.routineAppId !== appId
    || delivery.target !== owner.owner.openid || delivery.noticeMark !== expectedMark || delivery.templateCode !== account.template.templateId
    || account.template.templateId.length > 100 || !bounded(rendered.url, 512)) return routineSubscriptionUnavailable();
  const url = `/pages/goods/order_details/index?order_id=${payload.orderNo}`;
  if (rendered.url !== url || !rendered.data || typeof rendered.data !== 'object' || Array.isArray(rendered.data)) return routineSubscriptionUnavailable();
  const ds = Object.getOwnPropertyDescriptors(rendered.data), entries = Object.entries(ds);
  const keys = payload.deliveryType === 'express' ? ['character_string2', 'thing1', 'thing5', 'time3'] : ['character_string1', 'name4', 'phone_number10', 'thing8'];
  if (!subscriptionSame(Reflect.ownKeys(rendered.data).sort(), keys) || entries.some(([key, d]) => !keys.includes(key)
    || !d.enumerable || !('value' in d) || !bounded(d.value, 500))) return routineSubscriptionUnavailable();
  if (!subscriptionSame(rendered.data, await readRoutineDeliveryNotificationDataTx(tx, payload, delivery.addTime)))
    return routineSubscriptionUnavailable();
  const request = freezeSubscription({ touser: owner.owner.openid, template_id: account.template.templateId, page: url,
    data: Object.fromEntries(entries.map(([key, d]) => [key, { value: d.value as string }])) });
  const identity = { deliveryId: delivery.id, outboxId: event.id, eventKey: event.eventKey, orderId: child.id, rootId,
    buyerUid: parent.uid, appId, ownershipId: owner.owner.ownershipId, bindingId: owner.owner.bindingId,
    observationId: owner.owner.observationId, evidenceId: original.evidence.evidence_id, evidenceSignature: original.evidence.signature,
    relatedDigest: original.relatedDigest, approvedUseDigest: original.approvedUseDigest, templateMark };
  const eventIdentity = { id: event.id, eventKey: event.eventKey, eventType: event.eventType, aggregateType: event.aggregateType,
    aggregateId: event.aggregateId, payload: event.payload, addTime: event.addTime };
  const sourceDigest = subscriptionMac(env, 'delivery-notice-source', [identity, family, eventIdentity, immutableDelivery(delivery), owner, account.account, request]);
  const [tail] = await tx.execute<{ ready: boolean }>(sql`SELECT pg_catalog.clock_timestamp()<=pg_catalog.transaction_timestamp()+interval '5 seconds'
    AND pg_catalog.clock_timestamp()<pg_catalog.to_timestamp(${account.account.payload.data.validUntil}) AS ready`);
  if (tail?.ready !== true) return routineSubscriptionUnavailable();
  const prepared = Object.freeze({ [noticeSlot]: true as const, facts: freezeSubscription({ ...identity, sourceDigest }), account, request });
  notices.set(prepared, { input: expected, tx }); return prepared;
}

/** Same-transaction fresh source for the immutable dispatch author. The caller
 * must enter before its physical locks; all lower maintenance gates are first. */
export async function prepareRoutineSubscriptionDeliveryNoticeTx(tx: DbClient, env: Env, raw: RoutineSubscriptionDeliveryNoticeInput) {
  const captured = input(raw), signing = environment(env);
  try { return await prepare(tx, signing, captured); } catch { return routineSubscriptionUnavailable(); }
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
  catch { return routineSubscriptionUnavailable(); }
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
