import { and, asc, desc, eq, inArray, or } from "drizzle-orm";
import { createRoutineSubscriptionNoticeRequestTx } from '@/services/wechat/RoutineSubscriptionNoticeRequest';
import { createRoutineSubscriptionRefundSuccessRequestTx } from '@/services/wechat/RoutineSubscriptionRefundSuccessRequest';
import { createRoutineSubscriptionMaterializedRefundSuccessRequestTx, captureRoutineSubscriptionMaterializedRefundSuccessBusiness } from '@/services/wechat/RoutineSubscriptionMaterializedRefundSuccessRequest';
import { readRoutineMaterializedRefundSuccessSourceTx } from '@/services/wechat/RoutineSubscriptionMaterializedRefundSource';
import { createRoutineSubscriptionRefusalRequestTx } from '@/services/wechat/RoutineSubscriptionRefusalRequest';
import { prepareRoutineSubscriptionPinkRequestsTx, createRoutineSubscriptionPinkRequestTx,
  type PreparedRoutineSubscriptionPinkRequests } from '@/services/wechat/RoutineSubscriptionPinkRequest';
import { stageRoutineSubscriptionNoticeTx, type RoutineSubscriptionNoticeEnvironment } from '@/services/wechat/RoutineSubscriptionNoticeAuthor';
import { createContainerFromDb, withTx, type DbClient } from "@/lib/di";
import {
  storeOrderCartInfo,
  storeOrder,
  storeOrderRefund,
  storePink,
  storeOrderOutbox,
  notificationTemplate,
  orderNotificationDelivery,
  systemConfig,
  systemMessage,
  systemNotification,
  user,
  wechatUser,
  storeDeliveryOrder,
  customerCityDeliveryJob,
  customerCityDeliveryAttempt,
  customerCityDeliveryBinding,
  type OrderDeliveryNoticeOutboxPayload,
  type OrderNotificationChannel,
  type OrderNotificationDeliveryPayload,
  type OrderOutboxPayload,
  type OrderRefundRefusedNoticeOutboxPayload,
  type OrderRefundSuccessNoticeOutboxPayload,
  type OrderSecondCardNoticeOutboxPayload,
  type OrderPinkSuccessNoticeOutboxPayload,
} from "@/models/schema";
import { normalizeConfigScalar } from "@/utils/config";
import { ValidateException } from '@/utils/errors';
import { assertCustomerCityDeliveryReady } from '@/migrations/customerCityDelivery';
import {assertGuestRefundRefusedNoticeSource} from './GuestRefundRefusedNoticeSource';
import { readRoutineNotificationAppIdInTx, RoutineConfigurationError } from '@/services/wechat/RoutineRuntimeConfig';
import { routineShippingLogisticsType } from '@/services/wechat/RoutineShippingLogistics';

export const ORDER_DELIVERY_NOTICE_EVENT = "order.delivery.notice";
export const ORDER_REFUND_SUCCESS_NOTICE_EVENT = "order.refund.success.notice";
export const ORDER_REFUND_REFUSED_NOTICE_EVENT = "order.refund.refused.notice";
export const ORDER_SECOND_CARD_ADVENT_NOTICE_EVENT = "order.second_card.advent.notice";
export const ORDER_SECOND_CARD_EXPIRED_NOTICE_EVENT = "order.second_card.expired.notice";
export const ORDER_PINK_SUCCESS_NOTICE_EVENT = 'order.pink.success.notice';

export type OrderNotificationEventType =
  | typeof ORDER_DELIVERY_NOTICE_EVENT
  | typeof ORDER_REFUND_REFUSED_NOTICE_EVENT
  | typeof ORDER_REFUND_SUCCESS_NOTICE_EVENT
  | typeof ORDER_SECOND_CARD_ADVENT_NOTICE_EVENT
  | typeof ORDER_SECOND_CARD_EXPIRED_NOTICE_EVENT
  | typeof ORDER_PINK_SUCCESS_NOTICE_EVENT;

export interface OrderNotificationOutboxEvent {
  id: number;
  eventKey: string;
  aggregateId: number;
  aggregateType?: string;
  eventType: string;
  payload: OrderOutboxPayload;
  addTime?: number;
}

export interface DeliveryNoticeInput {
  orderId: number;
  orderNo: string;
  userId: number;
  userAddress: string;
  deliveryType: "express" | "send" | "fictitious" | "city_delivery";
  deliveryName: string;
  deliveryId: string;
  cityDeliveryJobId?: number;
}

export interface RefundRefusedNoticeInput {
  orderId: number;
  orderNo: string;
  refundId: number;
  userId: number;
  payPrice: string;
}

export interface SecondCardNoticeInput {
  orderId: number;
  orderNo: string;
  cartInfoId: number;
  userId: number;
  kind: "advent" | "expired";
  writeEnd: number;
  payTime: number;
  storeName: string;
}

type NotificationResult = "created" | "already-created" | "disabled" | "deferred";

interface NoticeContext {
  values: Record<string, string>;
  storeName: string;
  buyerPhone: string;
  shippingItemDescription: string;
  officialOpenid: string;
  routineOpenid: string;
  secondCardActive: boolean;
  pinkSuccessActive: boolean;
  order: {
    id: number;
    orderId: string;
    uid: number;
    userPhone: string;
    payPrice: string;
    addTime: number;
    tradeNo: string;
    pid: number;
    shippingType: number;
    isChannel: number;
    payType: string;
    status: number;
    payTime: number;
    paid: number;
    isDel: number;
    isSystemDel: number;
    refundStatus: number;
    type: number;
    staffId: number;
    couponId: number;
    activityId: number;
    pinkId: number;
    unique: string | null;
  };
}

interface NoticeConfig {
  mark: string;
  isSystem: number;
  isSms: number;
  isWechat: number;
  isRoutine: number;
  smsId: string;
  title: string;
  content: string;
}

function positiveId(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${label} 无效`);
  return Number(value);
}

function assertAssistedGuestDeliverySource(order: {
  uid: number; type: number; isChannel: number; staffId: number; couponId: number;
} | undefined): void {
  if (!order || order.uid !== 0 || order.type !== 0 || order.isChannel !== 2
    || order.staffId <= 0 || order.couponId !== 0) throw new Error('游客发货通知订单来源无效');
}

function requiredString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || !value || [...value].length > maxLength) {
    throw new Error(`${label} 无效`);
  }
  return value;
}

function boundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || [...value].length > maxLength) {
    throw new Error(`${label} 无效`);
  }
  return value;
}

export function orderDeliveryNoticeEventKey(orderId: number, cityDeliveryJobId?: number): string {
  return `${ORDER_DELIVERY_NOTICE_EVENT}:${positiveId(orderId, "订单 ID")}`
    + (cityDeliveryJobId === undefined ? '' : `:city:${positiveId(cityDeliveryJobId, '同城任务 ID')}`);
}

export function orderRefundSuccessNoticeEventKey(refundId: number): string {
  return `${ORDER_REFUND_SUCCESS_NOTICE_EVENT}:${positiveId(refundId, '售后 ID')}`;
}

export function orderRefundRefusedNoticeEventKey(refundId: number): string {
  return `${ORDER_REFUND_REFUSED_NOTICE_EVENT}:${positiveId(refundId, "售后 ID")}`;
}

export function orderSecondCardNoticeEventKey(
  kind: "advent" | "expired",
  cartInfoId: number,
  writeEnd: number,
): string {
  const eventType = kind === "advent"
    ? ORDER_SECOND_CARD_ADVENT_NOTICE_EVENT
    : ORDER_SECOND_CARD_EXPIRED_NOTICE_EVENT;
  return `${eventType}:${positiveId(cartInfoId, "次卡行 ID")}:${positiveId(writeEnd, "次卡到期时间")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function payloadEquals(left: OrderOutboxPayload, right: OrderOutboxPayload): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function deliveryBusinessEquals(left: OrderOutboxPayload, right: OrderOutboxPayload) {
  const body = (value: OrderOutboxPayload) => {
    const { routineAppId: _pin, routineSubscriptionRequest: _request, ...rest } = value as OrderDeliveryNoticeOutboxPayload | OrderRefundRefusedNoticeOutboxPayload | OrderRefundSuccessNoticeOutboxPayload | OrderPinkSuccessNoticeOutboxPayload;
    return rest;
  };
  return canonicalJson(body(left)) === canonicalJson(body(right));
}

/** Record delivery intent in the original business transaction, before Queue
 * delay. Existing events retain their exact pin or historical absence. This
 * account is not a witness for ownership of an old UID or payment. */
export async function captureRoutineNotificationAccount<T extends OrderOutboxPayload>(
  tx: DbClient, eventKey: string, payload: T,
): Promise<T & { routineAppId?: string }> {
  const output = { ...payload } as T & { routineAppId?: string };
  delete output.routineAppId;
  const [existing] = await tx.select({ payload: storeOrderOutbox.payload }).from(storeOrderOutbox)
    .where(eq(storeOrderOutbox.eventKey, eventKey)).limit(1);
  if (existing) {
    if (Object.hasOwn(existing.payload, 'routineAppId'))
      output.routineAppId = (existing.payload as { routineAppId?: string }).routineAppId;
  } else {
    try { output.routineAppId = await readRoutineNotificationAppIdInTx(tx); }
    catch (error) {
      // Invalid optional Mini configuration must not roll back money, SMS or
      // inbox effects. SQL faults still propagate; no cache supplies history.
      if (!(error instanceof RoutineConfigurationError)) throw error;
      output.routineAppId = '';
    }
  }
  return output;
}

async function insertImmutableNotificationEvent(
  db: DbClient,
  input: {
    eventKey: string;
    aggregateId: number;
    eventType: OrderNotificationEventType;
    payload:
      | OrderDeliveryNoticeOutboxPayload
      | OrderRefundRefusedNoticeOutboxPayload | OrderRefundSuccessNoticeOutboxPayload
      | OrderPinkSuccessNoticeOutboxPayload
      | OrderSecondCardNoticeOutboxPayload;
    now: number;
    noticeEnv?: Readonly<{ APP_KEY?: string }>;
    pinkRequests?: PreparedRoutineSubscriptionPinkRequests;
  },
): Promise<{ id: number; eventKey: string }> {
  const key = input.noticeEnv && Object.getOwnPropertyDescriptor(input.noticeEnv, 'APP_KEY');
  const noticeEnv = key?.enumerable && 'value' in key && typeof key.value === 'string'
    ? Object.freeze({ APP_KEY: key.value }) : undefined;
  const success = input.eventType === ORDER_REFUND_SUCCESS_NOTICE_EVENT;
  const refusal = input.eventType === ORDER_REFUND_REFUSED_NOTICE_EVENT;
  const pink = input.eventType === ORDER_PINK_SUCCESS_NOTICE_EVENT;
  const versioned = input.payload.userId > 0 && (success || refusal || pink || input.eventType === ORDER_DELIVERY_NOTICE_EVENT
    && 'deliveryType' in input.payload && input.payload.deliveryType !== 'fictitious');
  let payload: typeof input.payload;
  if (versioned) {
    const [prior] = await db.select({ payload: storeOrderOutbox.payload }).from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey, input.eventKey)).limit(1);
    if (prior) {
      // Preserve the version winner, its original signature/pin/absence. No
      // re-signing, repinning or later adoption of a committed legacy event.
      const source = prior.payload as OrderDeliveryNoticeOutboxPayload | OrderRefundRefusedNoticeOutboxPayload | OrderRefundSuccessNoticeOutboxPayload | OrderPinkSuccessNoticeOutboxPayload;
      payload = { ...input.payload, ...(Object.hasOwn(source, 'routineAppId') ? { routineAppId: source.routineAppId } : {}),
        ...(Object.hasOwn(source, 'routineSubscriptionRequest') ? { routineSubscriptionRequest: source.routineSubscriptionRequest } : {}) } as typeof input.payload;
    } else {
      let resolved: Awaited<ReturnType<typeof createRoutineSubscriptionNoticeRequestTx> | ReturnType<typeof createRoutineSubscriptionRefusalRequestTx> | ReturnType<typeof createRoutineSubscriptionRefundSuccessRequestTx> | ReturnType<typeof createRoutineSubscriptionMaterializedRefundSuccessRequestTx>
        | ReturnType<typeof createRoutineSubscriptionPinkRequestTx>>;
      try {
        resolved = pink ? createRoutineSubscriptionPinkRequestTx(db,
          input.pinkRequests ?? await prepareRoutineSubscriptionPinkRequestsTx(db, noticeEnv,
            { pinkId: (input.payload as OrderPinkSuccessNoticeOutboxPayload).pinkId, now: input.now }),
          { eventKey: input.eventKey, aggregateId: input.aggregateId, payload: input.payload as OrderPinkSuccessNoticeOutboxPayload, now: input.now })
          : await withTx(createContainerFromDb(db), async nested => success
          ? Object.hasOwn(input.payload, 'materializedRefund')
          ? createRoutineSubscriptionMaterializedRefundSuccessRequestTx(nested, noticeEnv, { eventKey: input.eventKey, aggregateId: input.aggregateId,
            payload: captureRoutineSubscriptionMaterializedRefundSuccessBusiness(input.payload), now: input.now })
          : createRoutineSubscriptionRefundSuccessRequestTx(nested, noticeEnv, { eventKey: input.eventKey, aggregateId: input.aggregateId,
            payload: input.payload as OrderRefundSuccessNoticeOutboxPayload, now: input.now })
          : refusal
          ? createRoutineSubscriptionRefusalRequestTx(nested, noticeEnv, { eventKey: input.eventKey, aggregateId: input.aggregateId,
            payload: input.payload as OrderRefundRefusedNoticeOutboxPayload, now: input.now })
          : createRoutineSubscriptionNoticeRequestTx(nested, noticeEnv, { eventKey: input.eventKey, aggregateId: input.aggregateId,
            payload: input.payload as OrderDeliveryNoticeOutboxPayload, now: input.now }));
      } catch {
        // Mini-only metadata/SQL faults roll back their actual SAVEPOINT.
        // Keep fulfillment and other notices, without falling back to a pin.
        resolved = success ? Object.hasOwn(input.payload, 'materializedRefund')
          ? { kind: 'original', request: { format: 6, unavailable: true } }
          : { kind: 'original', request: { format: 5, unavailable: true } } : pink ? { kind: 'original', request: { format: 4, unavailable: true } }
          : refusal ? { kind: 'original', request: { format: 3, unavailable: true } }
          : { kind: 'original', request: { format: 2, unavailable: true } };
      }
      payload = resolved.kind === 'original' ? { ...input.payload, routineSubscriptionRequest: resolved.request } as typeof input.payload
        : await captureRoutineNotificationAccount(db, input.eventKey, input.payload);
    }
  } else payload = input.payload.userId > 0 && ![ORDER_SECOND_CARD_ADVENT_NOTICE_EVENT, ORDER_SECOND_CARD_EXPIRED_NOTICE_EVENT].includes(input.eventType)
    ? await captureRoutineNotificationAccount(db, input.eventKey, input.payload) : input.payload;
  const inserted = await db
    .insert(storeOrderOutbox)
    .values({
      eventKey: input.eventKey,
      aggregateType: "order",
      aggregateId: input.aggregateId,
      eventType: input.eventType,
      payload,
      status: "PENDING",
      availableTime: input.now,
      addTime: input.now,
      updateTime: input.now,
    })
    .onConflictDoNothing({ target: storeOrderOutbox.eventKey })
    .returning({ id: storeOrderOutbox.id, eventKey: storeOrderOutbox.eventKey });
  if (inserted[0]) return inserted[0];

  const existing = await db
    .select({
      id: storeOrderOutbox.id,
      eventKey: storeOrderOutbox.eventKey,
      aggregateId: storeOrderOutbox.aggregateId,
      eventType: storeOrderOutbox.eventType,
      payload: storeOrderOutbox.payload,
    })
    .from(storeOrderOutbox)
    .where(eq(storeOrderOutbox.eventKey, input.eventKey))
    .limit(1);
  const event = existing[0];
  if (!event) throw new Error("通知 outbox 写入失败");
  if (
    event.aggregateId !== input.aggregateId ||
    event.eventType !== input.eventType ||
    !(versioned ? deliveryBusinessEquals(event.payload, input.payload) : payloadEquals(event.payload, payload))
  ) {
    throw new Error("通知 outbox 不可变字段冲突");
  }
  return { id: event.id, eventKey: event.eventKey };
}

/** Must be called in the same transaction that changes the order to delivered. */
export async function enqueueOrderDeliveryNoticeEvent(
  db: DbClient,
  input: DeliveryNoticeInput,
  now = Math.floor(Date.now() / 1_000),
  noticeEnv?: Readonly<{ APP_KEY?: string }>,
): Promise<{ id: number; eventKey: string }> {
  const orderId = positiveId(input.orderId, "订单 ID");
  const userId = input.userId === 0 ? 0 : positiveId(input.userId, "用户 ID");
  const orderNo = requiredString(input.orderNo, "订单号", 32);
  if (userId === 0) {
    // Guest delivery still has an order-specific SMS destination. It must never
    // borrow a UID=0 account, inbox or WeChat identity. Check the SQL source,
    // not an optional caller-provided guest flag, in the delivery transaction.
    const [order] = await db.select({ uid: storeOrder.uid, type: storeOrder.type,
      isChannel: storeOrder.isChannel, staffId: storeOrder.staffId, couponId: storeOrder.couponId,
    }).from(storeOrder).where(and(eq(storeOrder.id, orderId), eq(storeOrder.orderId, orderNo))).limit(1);
    assertAssistedGuestDeliverySource(order);
  }
  if (!["express", "send", "fictitious", "city_delivery"].includes(input.deliveryType)) {
    throw new Error("发货类型无效");
  }
  const cityDeliveryJobId=input.deliveryType==='city_delivery'?positiveId(input.cityDeliveryJobId,'同城任务 ID'):undefined;
  if(input.deliveryType!=='city_delivery'&&input.cityDeliveryJobId!==undefined)throw Error('同城任务不能用于其他发货通知');
  const payload: OrderDeliveryNoticeOutboxPayload = {
    orderId,
    orderNo,
    userId,
    deliveryType: input.deliveryType,
    deliveryName: boundedString(input.deliveryName, "配送名称", 64),
    deliveryId: boundedString(input.deliveryId, "配送单号", 64),
    userAddress: boundedString(input.userAddress, "收货地址", 100),
    ...(cityDeliveryJobId===undefined?{}:{cityDeliveryJobId}),
  };
  return insertImmutableNotificationEvent(db, {
    eventKey: orderDeliveryNoticeEventKey(orderId,cityDeliveryJobId),
    aggregateId: orderId,
    eventType: ORDER_DELIVERY_NOTICE_EVENT,
    payload,
    now, noticeEnv,
  });
}

/** Must be called in the same transaction that commits the refusal decision. */
export async function enqueueOrderRefundRefusedNoticeEvent(
  db: DbClient,
  input: RefundRefusedNoticeInput,
  now = Math.floor(Date.now() / 1_000),
  noticeEnv?: Readonly<{ APP_KEY?: string }>,
): Promise<{ id: number; eventKey: string }> {
  const orderId = positiveId(input.orderId, "订单 ID");
  const refundId = positiveId(input.refundId, "售后 ID");
  const payload: OrderRefundRefusedNoticeOutboxPayload = {
    orderId,
    orderNo: requiredString(input.orderNo, "订单号", 32),
    refundId,
    userId: input.userId===0?0:positiveId(input.userId, "用户 ID"),
    payPrice: requiredString(input.payPrice, "订单金额", 32),
  };
  if(payload.userId===0)await assertGuestRefundRefusedNoticeSource(db,payload,true);
  return insertImmutableNotificationEvent(db, {
    eventKey: orderRefundRefusedNoticeEventKey(refundId),
    aggregateId: orderId,
    eventType: ORDER_REFUND_REFUSED_NOTICE_EVENT,
    payload,
    now, noticeEnv,
  });
}

/** Newly completed refund only, inside its business transaction.
 * orderNo is the refund business number, as in PHP's order_refund renderer. */
export async function enqueueOrderRefundSuccessNoticeEvent(db: DbClient, input: RefundRefusedNoticeInput & Pick<OrderRefundSuccessNoticeOutboxPayload, 'materializedRefund'>,
  now = Math.floor(Date.now() / 1000), noticeEnv?: Readonly<{ APP_KEY?: string }>) {
  const payload: OrderRefundSuccessNoticeOutboxPayload = { orderId: positiveId(input.orderId, '订单 ID'),
    orderNo: requiredString(input.orderNo, '退款单号', 50), refundId: positiveId(input.refundId, '售后 ID'),
    userId: positiveId(input.userId, '用户 ID'), payPrice: requiredString(input.payPrice, '订单金额', 32) };
  if (Object.hasOwn(input, 'materializedRefund')) payload.materializedRefund = captureRoutineSubscriptionMaterializedRefundSuccessBusiness({
    ...payload, materializedRefund: input.materializedRefund }).materializedRefund;
  return insertImmutableNotificationEvent(db, { eventKey: orderRefundSuccessNoticeEventKey(payload.refundId),
    aggregateId: payload.orderId, eventType: ORDER_REFUND_SUCCESS_NOTICE_EVENT, payload, now, noticeEnv });
}

/** Financial's same-transaction effect verifier retains the exact notification
 * version written by the refusal author. It verifies business facts without
 * recreating a current pin or authenticating any provider send. */
export async function readRefundRefusalNoticePayloadTx(tx: DbClient, eventKey: string, expected: RefundRefusedNoticeInput) {
  const rows = await tx.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey, eventKey)).limit(2);
  const row = rows[0], base = { orderId: expected.orderId, orderNo: expected.orderNo, refundId: expected.refundId,
    userId: expected.userId, payPrice: expected.payPrice };
  if (rows.length !== 1 || !row || row.aggregateType !== 'order' || row.aggregateId !== base.orderId
    || row.eventType !== ORDER_REFUND_REFUSED_NOTICE_EVENT || eventKey !== orderRefundRefusedNoticeEventKey(base.refundId)
    || !(base.userId === 0 ? payloadEquals(row.payload, base) : deliveryBusinessEquals(row.payload, base)))
    throw new ValidateException('实际支付或拒绝通知事件未完整持久化');
  return row.payload as OrderRefundRefusedNoticeOutboxPayload;
}

/** Persist one immutable second-card reminder before any provider side effect. */
export async function enqueueSecondCardNoticeEvent(
  db: DbClient,
  input: SecondCardNoticeInput,
  now = Math.floor(Date.now() / 1_000),
): Promise<{ id: number; eventKey: string }> {
  const orderId = positiveId(input.orderId, "订单 ID");
  const cartInfoId = positiveId(input.cartInfoId, "次卡行 ID");
  const userId = positiveId(input.userId, "用户 ID");
  const writeEnd = positiveId(input.writeEnd, "次卡到期时间");
  if (!Number.isSafeInteger(input.payTime) || input.payTime < 0) {
    throw new Error("订单支付时间无效");
  }
  const payload: OrderSecondCardNoticeOutboxPayload = {
    orderId,
    orderNo: requiredString(input.orderNo, "订单号", 32),
    cartInfoId,
    userId,
    kind: input.kind,
    writeEnd,
    payTime: input.payTime,
    storeName: requiredString(input.storeName, "次卡商品名", 40),
  };
  const eventType = input.kind === "advent"
    ? ORDER_SECOND_CARD_ADVENT_NOTICE_EVENT
    : ORDER_SECOND_CARD_EXPIRED_NOTICE_EVENT;
  return insertImmutableNotificationEvent(db, {
    eventKey: orderSecondCardNoticeEventKey(input.kind, cartInfoId, writeEnd),
    aggregateId: orderId,
    eventType,
    payload,
    now,
  });
}

export async function enqueueOrderPinkSuccessNoticeEvent(
  db: DbClient,
  input: OrderPinkSuccessNoticeOutboxPayload,
  now = Math.floor(Date.now() / 1000),
  noticeEnv?: Readonly<{ APP_KEY?: string }>,
  pinkRequests?: PreparedRoutineSubscriptionPinkRequests,
): Promise<{ id: number; eventKey: string }> {
  assertOrderNotificationPayload(input, ORDER_PINK_SUCCESS_NOTICE_EVENT, input.orderId);
  return insertImmutableNotificationEvent(db, {
    eventKey: `${ORDER_PINK_SUCCESS_NOTICE_EVENT}:${input.orderId}`,
    aggregateId: input.orderId, eventType: ORDER_PINK_SUCCESS_NOTICE_EVENT,
    payload: { orderId: input.orderId, orderNo: input.orderNo, userId: input.userId, pinkId: input.pinkId, people: input.people }, now, noticeEnv, pinkRequests,
  });
}

export function assertOrderNotificationPayload(
  value: unknown,
  eventType: string,
  aggregateId: number,
): asserts value is
  | OrderDeliveryNoticeOutboxPayload
  | OrderRefundRefusedNoticeOutboxPayload | OrderRefundSuccessNoticeOutboxPayload
  | OrderPinkSuccessNoticeOutboxPayload
  | OrderSecondCardNoticeOutboxPayload {
  if (!value || typeof value !== "object") throw new Error("通知 outbox payload 不是对象");
  const payload = value as Record<string, unknown>;
  positiveId(payload.orderId, "通知订单 ID");
  if (!([ORDER_DELIVERY_NOTICE_EVENT,ORDER_REFUND_REFUSED_NOTICE_EVENT].includes(eventType) && payload.userId === 0)) positiveId(payload.userId, "通知用户 ID");
  if (payload.orderId !== aggregateId) throw new Error("通知 outbox 聚合 ID 不匹配");
  requiredString(payload.orderNo, "通知订单号", eventType === ORDER_REFUND_SUCCESS_NOTICE_EVENT ? 50 : 32);

  if (eventType === ORDER_PINK_SUCCESS_NOTICE_EVENT) {
    positiveId(payload.pinkId, '通知团长 ID');
    if (Number(payload.pinkId) > 2_147_483_647 || Number(payload.orderId) > 2_147_483_647 || Number(payload.userId) > 2_147_483_647) throw new Error('通知身份超出范围');
    if (!Number.isSafeInteger(payload.people) || Number(payload.people) < 2 || Number(payload.people) > 500) throw new Error('通知成团人数无效');
    return;
  }

  if (eventType === ORDER_DELIVERY_NOTICE_EVENT) {
    if (!["express", "send", "fictitious", "city_delivery"].includes(String(payload.deliveryType))) {
      throw new Error("通知发货类型无效");
    }
    boundedString(payload.deliveryName, "通知配送名称", 64);
    boundedString(payload.deliveryId, "通知配送单号", 64);
    boundedString(payload.userAddress, "通知收货地址", 100);
    if(payload.deliveryType==='city_delivery')positiveId(payload.cityDeliveryJobId,'通知同城任务 ID');
    else if(payload.cityDeliveryJobId!==undefined)throw Error('同城任务不能用于其他发货通知');
    return;
  }
  if (eventType === ORDER_REFUND_REFUSED_NOTICE_EVENT || eventType === ORDER_REFUND_SUCCESS_NOTICE_EVENT) {
    if (Object.hasOwn(payload, 'materializedRefund')) {
      if (eventType !== ORDER_REFUND_SUCCESS_NOTICE_EVENT) throw Error('实体退款成功来源不能用于其他事件');
      const { routineAppId: _pin, routineSubscriptionRequest: _request, ...body } = payload;
      captureRoutineSubscriptionMaterializedRefundSuccessBusiness(body);
    }
    if(payload.userId===0&&Object.keys(payload).sort().join(',')!==['orderId','orderNo','refundId','userId','payPrice'].sort().join(','))throw Error('游客拒绝通知字段无效');
    positiveId(payload.refundId, "通知售后 ID");
    requiredString(payload.payPrice, "通知订单金额", 32);
    return;
  }
  if (
    eventType === ORDER_SECOND_CARD_ADVENT_NOTICE_EVENT
    || eventType === ORDER_SECOND_CARD_EXPIRED_NOTICE_EVENT
  ) {
    positiveId(payload.cartInfoId, "通知次卡行 ID");
    positiveId(payload.writeEnd, "通知次卡到期时间");
    if (!Number.isSafeInteger(payload.payTime) || Number(payload.payTime) < 0) {
      throw new Error("通知订单支付时间无效");
    }
    requiredString(payload.storeName, "通知次卡商品名", 40);
    const expectedKind = eventType === ORDER_SECOND_CARD_ADVENT_NOTICE_EVENT
      ? "advent"
      : "expired";
    if (payload.kind !== expectedKind) throw new Error("通知次卡类型与事件不匹配");
    return;
  }
  throw new Error("通知 outbox 事件类型不受支持");
}

/** A cancelled historical city attempt must never materialize a fresh notice
 * for a later attempt. Rider callbacks may replace order deliveryId with the
 * rider phone; use the exact durable provider record instead. */
export async function customerCityNoticeIsActive(tx:DbClient,payload:OrderDeliveryNoticeOutboxPayload) {
  if(payload.deliveryType!=='city_delivery')return true;
  const id=positiveId(payload.cityDeliveryJobId,'通知同城任务 ID');
  await assertCustomerCityDeliveryReady(tx,false);
  const rows=await tx.select({job:customerCityDeliveryJob,binding:customerCityDeliveryBinding,attempt:customerCityDeliveryAttempt,delivery:storeDeliveryOrder,order:storeOrder})
    .from(customerCityDeliveryJob).innerJoin(customerCityDeliveryBinding,eq(customerCityDeliveryBinding.jobId,customerCityDeliveryJob.id))
    .innerJoin(customerCityDeliveryAttempt,eq(customerCityDeliveryAttempt.id,customerCityDeliveryBinding.attemptId))
    .innerJoin(storeDeliveryOrder,eq(storeDeliveryOrder.id,customerCityDeliveryBinding.deliveryOrderId))
    .innerJoin(storeOrder,eq(storeOrder.id,customerCityDeliveryBinding.orderId)).where(eq(customerCityDeliveryJob.id,id)).limit(1);
  const row=rows[0];if(!row)return false;
  const {job,binding,attempt,delivery,order}=row,result=attempt.result;
  return ['ADMITTED','DELIVERED'].includes(job.status)&&binding.active===1&&attempt.phase==='ACCEPTED'
    &&attempt.jobId===job.id&&attempt.requestKey===job.requestKey
    &&binding.rootOrderId===job.rootOrderId&&binding.provider===job.provider&&binding.providerOrderId===job.providerOrderId
    &&binding.customerUid===job.customerUid&&binding.storeId===job.storeId&&binding.supplierId===job.supplierId
    &&binding.orderId===payload.orderId&&order.id===payload.orderId&&order.orderId===payload.orderNo&&order.uid===payload.userId
    &&order.uid===binding.customerUid&&order.storeId===binding.storeId&&order.supplierId===binding.supplierId
    &&(order.pid>0?order.pid:order.id)===binding.rootOrderId&&order.deliveryType==='city_delivery'
    &&order.paid===1&&order.isDel===0&&order.isSystemDel===0&&[1,2,3,4,5].includes(order.status)&&[0,3].includes(order.refundStatus)
    &&delivery.oid===order.id&&delivery.uid===order.uid&&delivery.orderId===binding.providerOrderId
    &&delivery.stationType===(job.provider==='dada'?1:2)&&delivery.deliveryNo===payload.deliveryId
    &&result.provider_order_id===delivery.orderId&&result.delivery_no===delivery.deliveryNo;
}

export async function customerCityQueuedNoticeIsActive(tx:DbClient,eventKey:string) {
  if(!eventKey.startsWith(ORDER_DELIVERY_NOTICE_EVENT+':')||!eventKey.includes(':city:'))return true;
  const [event]=await tx.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey,eventKey)).limit(1);
  if(!event||event.eventType!==ORDER_DELIVERY_NOTICE_EVENT)return false;
  assertOrderNotificationPayload(event.payload,event.eventType,event.aggregateId);
  const payload=event.payload as OrderDeliveryNoticeOutboxPayload;
  if(payload.deliveryType!=='city_delivery'||orderDeliveryNoticeEventKey(payload.orderId,payload.cityDeliveryJobId)!==eventKey)return false;
  return customerCityNoticeIsActive(tx,payload);
}

function noticeMark(
  eventType: string,
  payload:
    | OrderDeliveryNoticeOutboxPayload
    | OrderRefundRefusedNoticeOutboxPayload | OrderRefundSuccessNoticeOutboxPayload
    | OrderPinkSuccessNoticeOutboxPayload
    | OrderSecondCardNoticeOutboxPayload,
): string {
  if (eventType === ORDER_REFUND_SUCCESS_NOTICE_EVENT) return "order_refund";
  if (eventType === ORDER_REFUND_REFUSED_NOTICE_EVENT) return "send_order_refund_no_status";
  if (eventType === ORDER_PINK_SUCCESS_NOTICE_EVENT) return 'order_user_groups_success';
  if (eventType === ORDER_SECOND_CARD_ADVENT_NOTICE_EVENT) return "reminder_brink_death";
  if (eventType === ORDER_SECOND_CARD_EXPIRED_NOTICE_EVENT) return "expiration_reminder";
  const delivery = payload as OrderDeliveryNoticeOutboxPayload;
  if (delivery.deliveryType === "express") return "order_postage_success";
  if ((delivery.deliveryType === "send" || delivery.deliveryType === "city_delivery")) return "order_deliver_success";
  return "order_fictitious_success";
}

function renderTemplate(template: string, values: Record<string, string>): string {
  let rendered = template;
  for (const [key, value] of Object.entries(values)) {
    rendered = rendered.replaceAll(`{${key}}`, value);
  }
  return rendered;
}

function productTitleFromSnapshot(value: string | null): string {
  if (!value || value.length > 1_048_576) return "";
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const productInfo = parsed.productInfo;
    if (!productInfo || typeof productInfo !== "object" || Array.isArray(productInfo)) return "";
    const storeName = (productInfo as Record<string, unknown>).store_name;
    return typeof storeName === "string" ? storeName : "";
  } catch {
    return "";
  }
}

function pinkProductTitleFromSnapshot(value: string | null): string {
  if (!value || value.length > 1_048_576) return '';
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const product = parsed.product;
    if (product && typeof product === 'object' && !Array.isArray(product)) {
      const name = (product as Record<string, unknown>).storeName;
      if (typeof name === 'string' && name) return name;
    }
    return productTitleFromSnapshot(value);
  } catch { return ''; }
}

function shippingTitleFromSnapshot(value: string | null, quantity: number): string {
  if (!value || value.length > 1_048_576 || !Number.isSafeInteger(quantity) || quantity <= 0) return "";
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const canonical = Object.hasOwn(parsed, 'product');
    const info = canonical ? parsed.product : parsed.productInfo;
    if (!info || typeof info !== 'object' || Array.isArray(info)) return '';
    const name = (info as Record<string, unknown>)[canonical ? 'storeName' : 'store_name'];
    return typeof name === 'string' && name ? `${name} * ${quantity}` : '';
  } catch { return ''; }
}

function utf8Prefix(value: string, characters: number): string {
  return [...value].slice(0, characters).join("");
}

async function noticeContext(
  tx: DbClient,
  eventType: string,
  payload:
    | OrderDeliveryNoticeOutboxPayload
    | OrderRefundRefusedNoticeOutboxPayload | OrderRefundSuccessNoticeOutboxPayload
    | OrderPinkSuccessNoticeOutboxPayload
    | OrderSecondCardNoticeOutboxPayload,
): Promise<NoticeContext> {
  const isSecondCard = eventType === ORDER_SECOND_CARD_ADVENT_NOTICE_EVENT
    || eventType === ORDER_SECOND_CARD_EXPIRED_NOTICE_EVENT;
  const secondCard = isSecondCard ? payload as OrderSecondCardNoticeOutboxPayload : undefined;
  const cartQuery = secondCard
    ? tx
        .select({
          cartInfo: storeOrderCartInfo.cartInfo,
          cartNum: storeOrderCartInfo.cartNum,
          isWriteoff: storeOrderCartInfo.isWriteoff,
        })
        .from(storeOrderCartInfo)
        .where(and(
          eq(storeOrderCartInfo.id, secondCard.cartInfoId),
          eq(storeOrderCartInfo.oid, secondCard.orderId),
          eq(storeOrderCartInfo.writeEnd, secondCard.writeEnd),
        ))
        .limit(1)
    : tx
        .select({
          cartInfo: storeOrderCartInfo.cartInfo,
          cartNum: storeOrderCartInfo.cartNum,
          isWriteoff: storeOrderCartInfo.isWriteoff,
        })
        .from(storeOrderCartInfo)
        .where(eq(storeOrderCartInfo.oid, payload.orderId))
        .orderBy(asc(storeOrderCartInfo.id));
  const [buyerRows, cartRows, orderRows, identities] = await Promise.all([
    payload.userId === 0 ? Promise.resolve([]) : tx.select({ nickname: user.nickname, phone: user.phone }).from(user).where(eq(user.uid, payload.userId)).limit(1),
    cartQuery,
    tx
      .select({
        id: storeOrder.id,
        orderId: storeOrder.orderId,
        uid: storeOrder.uid,
        userPhone: storeOrder.userPhone,
        payPrice: storeOrder.payPrice,
        addTime: storeOrder.addTime,
        tradeNo: storeOrder.tradeNo,
        pid: storeOrder.pid,
        shippingType: storeOrder.shippingType,
        isChannel: storeOrder.isChannel,
        payType: storeOrder.payType,
        status: storeOrder.status,
        payTime: storeOrder.payTime,
        paid: storeOrder.paid,
        isDel: storeOrder.isDel,
        isSystemDel: storeOrder.isSystemDel,
        refundStatus: storeOrder.refundStatus,
        type: storeOrder.type,
        staffId: storeOrder.staffId,
        couponId: storeOrder.couponId,
        activityId: storeOrder.activityId,
        pinkId: storeOrder.pinkId,
        unique: storeOrder.unique,
      })
      .from(storeOrder)
      .where(eq(storeOrder.id, payload.orderId))
      .limit(1),
    payload.userId === 0 ? Promise.resolve([]) : tx
      .select({
        id: wechatUser.id,
        userType: wechatUser.userType,
        openid: wechatUser.openid,
      })
      .from(wechatUser)
      .where(and(
        eq(wechatUser.uid, payload.userId),
        inArray(wechatUser.userType, ["wechat", "routine"]),
      ))
      .orderBy(desc(wechatUser.id)),
  ]);
  const order = orderRows[0];
  if (!order || order.uid !== payload.userId || eventType !== ORDER_REFUND_SUCCESS_NOTICE_EVENT && order.orderId !== payload.orderNo) {
    throw new Error("通知订单快照与当前订单不匹配");
  }
  if (eventType === ORDER_REFUND_SUCCESS_NOTICE_EVENT) {
    const p = payload as OrderRefundSuccessNoticeOutboxPayload;
    if (p.materializedRefund) {
      await readRoutineMaterializedRefundSuccessSourceTx(tx, captureRoutineSubscriptionMaterializedRefundSuccessBusiness({
        orderId: p.orderId, orderNo: p.orderNo, refundId: p.refundId, userId: p.userId, payPrice: p.payPrice, materializedRefund: p.materializedRefund }));
    } else {
    const rows = await tx.select().from(storeOrderRefund).where(eq(storeOrderRefund.id, p.refundId)).limit(2);
    const r = rows[0];
    if (rows.length !== 1 || !r || r.storeOrderId !== order.id || r.uid !== payload.userId || r.orderId !== p.orderNo
      || r.refundType !== 6 || r.isCancel !== 0 || r.isDel !== 0 || r.refundedPrice !== p.payPrice || order.payPrice !== p.payPrice)
      throw Error('成功退款通知与完成申请不匹配');
    }
  }
  if (payload.userId === 0) {
    if(eventType===ORDER_REFUND_REFUSED_NOTICE_EVENT)await assertGuestRefundRefusedNoticeSource(tx,payload as OrderRefundRefusedNoticeOutboxPayload);
    else assertAssistedGuestDeliverySource(order);
  }
  const storeName = secondCard?.storeName ?? utf8Prefix(
    cartRows.map((row) => eventType === ORDER_PINK_SUCCESS_NOTICE_EVENT
      ? pinkProductTitleFromSnapshot(row.cartInfo) : productTitleFromSnapshot(row.cartInfo)).filter(Boolean).join("|"),
    20,
  );
  const shippingItemDescription = cartRows
    .map((row) => shippingTitleFromSnapshot(row.cartInfo, row.cartNum))
    .filter(Boolean)
    .join(" | ");
  const openid = (type: "wechat" | "routine") =>
    identities.find((identity) => identity.userType === type && identity.openid.trim())?.openid.trim()
      ?? "";
  let values: Record<string, string>;
  let pinkSuccessActive = true;
  if (eventType === ORDER_PINK_SUCCESS_NOTICE_EVENT) {
    const pink = payload as OrderPinkSuccessNoticeOutboxPayload;
    const pendingRefunds = await tx.select({ id: storeOrderRefund.id }).from(storeOrderRefund).where(and(
      eq(storeOrderRefund.storeOrderId, order.id), eq(storeOrderRefund.isCancel, 0), eq(storeOrderRefund.isDel, 0),
      inArray(storeOrderRefund.refundType, [0, 1, 2, 4, 5]),
    )).limit(1);
    const [leader] = await tx.select().from(storePink).where(eq(storePink.id, pink.pinkId)).limit(1);
    const members = await tx.select().from(storePink).where(and(
      eq(storePink.uid, pink.userId), eq(storePink.isVirtual, 0), eq(storePink.status, 2), eq(storePink.isRefund, 0),
      or(eq(storePink.id, pink.pinkId), eq(storePink.kId, pink.pinkId)),
    )).orderBy(asc(storePink.id)).limit(2);
    const member = members[0];
    pinkSuccessActive = Boolean(leader && member && members.length === 1 && leader.kId === 0 && leader.status === 2 &&
      leader.isRefund === 0 && leader.isVirtual === 0 && leader.uid > 0 && leader.people === pink.people && order.type === 3 && order.paid === 1 &&
      order.pinkId === pink.pinkId && order.activityId === leader.combinationId &&
      order.isDel === 0 && order.isSystemDel === 0 && [0, 3].includes(order.refundStatus) && pendingRefunds.length === 0 &&
      member.combinationId === leader.combinationId && member.productId === leader.productId &&
      (member.orderId === '' || member.orderId === '0' || member.orderId === order.orderId) &&
      (member.orderIdKey === '' || member.orderIdKey === '0' || member.orderIdKey === String(order.id) || member.orderIdKey === order.unique) &&
      (member.orderId === order.orderId || member.orderIdKey === String(order.id) || member.orderIdKey === order.unique));
    values = { title: storeName, store_name: storeName, nickname: leader?.nickname ?? '', count: String(pink.people),
      pink_time: chinaDateTime(member?.addTime ?? order.payTime), order_id: order.orderId };
  } else if (eventType === ORDER_REFUND_REFUSED_NOTICE_EVENT || eventType === ORDER_REFUND_SUCCESS_NOTICE_EVENT) {
    const refusal = payload as OrderRefundRefusedNoticeOutboxPayload;
    values = {
      order_id: eventType === ORDER_REFUND_SUCCESS_NOTICE_EVENT ? order.orderId : refusal.orderNo,
      ...(eventType === ORDER_REFUND_SUCCESS_NOTICE_EVENT ? { refund_price: (payload as OrderRefundSuccessNoticeOutboxPayload).materializedRefund?.refundAmount ?? refusal.payPrice } : {}),
      pay_price: refusal.payPrice,
      store_name: storeName,
    };
  } else if (secondCard) {
    values = secondCard.kind === "advent"
      ? {
          store_name: secondCard.storeName,
          pay_time: chinaDateTime(secondCard.payTime).slice(0, 16),
          end_time: chinaDateTime(secondCard.writeEnd).slice(0, 16),
        }
      : {
          store_name: secondCard.storeName,
          end_time: chinaDateTime(secondCard.writeEnd).slice(0, 16),
        };
  } else {
    const delivery = payload as OrderDeliveryNoticeOutboxPayload;
    values = {
      nickname: buyerRows[0]?.nickname ?? "",
      store_name: storeName,
      order_id: delivery.orderNo,
      delivery_name: delivery.deliveryName,
      delivery_id: delivery.deliveryId,
      user_address: delivery.userAddress,
    };
  }
  return {
    values,
    storeName,
    buyerPhone: buyerRows[0]?.phone.trim() ?? '',
    shippingItemDescription,
    officialOpenid: openid("wechat"),
    routineOpenid: openid("routine"),
    secondCardActive: !secondCard || Boolean(
      cartRows[0]
      && cartRows[0].isWriteoff === 0
      && order.paid === 1
      && order.isDel === 0
      && order.isSystemDel === 0
      && [0, 3].includes(order.refundStatus)
    ),
    pinkSuccessActive,
    order,
  };
}

function chinaDateTime(seconds: number): string {
  return new Date((seconds + 8 * 3_600) * 1_000).toISOString().slice(0, 19).replace("T", " ");
}

function routineDeliveryName(value: string): string {
  const chars = [...value];
  const truncated = chars.length > 10 ? `${chars.slice(0, 7).join("")}...` : value;
  return truncated.replace(/[0-9]/g, "");
}

function routineDeliveryNotificationData(storeName: string, delivery: OrderDeliveryNoticeOutboxPayload, now: number): Record<string, string> {
  return delivery.deliveryType === 'express'
    ? { character_string2: delivery.deliveryId, thing1: utf8Prefix(delivery.deliveryName, 20),
        time3: chinaDateTime(now), thing5: storeName }
    : { thing8: storeName, character_string1: delivery.orderNo,
        name4: routineDeliveryName(delivery.deliveryName), phone_number10: delivery.deliveryId };
}

/** Same product renderer as staging, using a captured original rendering time.
 * It supplies no target/account/template permission and performs no provider I/O. */
export async function readRoutineDeliveryNotificationDataTx(tx: DbClient, payload: OrderDeliveryNoticeOutboxPayload, at: number): Promise<Record<string, string>> {
  if (!Number.isSafeInteger(at) || at <= 0 || at > 2147483647) throw Error('通知渲染时间无效');
  return routineDeliveryNotificationData(await readRoutineOrderNotificationTitleTx(tx, payload), payload, at);
}
async function readRoutineOrderNotificationTitleTx(tx: DbClient, payload: { orderId: number; userId: number }, pink = false) {
  const rows = await tx.select({ cartInfo: storeOrderCartInfo.cartInfo, uid: storeOrderCartInfo.uid, cartNum: storeOrderCartInfo.cartNum })
    .from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, payload.orderId)).orderBy(asc(storeOrderCartInfo.id)).limit(201).for('share', { noWait: true });
  if (!rows.length || rows.length > 200 || new TextEncoder().encode(JSON.stringify(rows)).byteLength > 1048576
    || rows.some(row => row.uid !== payload.userId || !Number.isSafeInteger(row.cartNum) || row.cartNum <= 0))
    throw Error('通知商品渲染来源超限或不匹配');
  return utf8Prefix(rows.map(row => pink ? pinkProductTitleFromSnapshot(row.cartInfo) : productTitleFromSnapshot(row.cartInfo)).filter(Boolean).join('|'), 20);
}
/** Original order amount and full-order product title follow the existing
 * 1451 contract; a refund request amount does not replace the order amount. */
export async function readRoutineRefundRefusalNotificationDataTx(tx: DbClient, payload: OrderRefundRefusedNoticeOutboxPayload): Promise<Record<string, string>> {
  return { thing1: '退款失败', thing2: await readRoutineOrderNotificationTitleTx(tx, payload),
    amount3: payload.payPrice, character_string6: payload.orderNo };
}

/** PHP order_refund uses the refund number and the original full order amount. */
export async function readRoutineRefundSuccessNotificationDataTx(tx: DbClient, payload: OrderRefundSuccessNoticeOutboxPayload): Promise<Record<string, string>> {
  return { thing1: '已成功退款', thing2: await readRoutineOrderNotificationTitleTx(tx, payload),
    amount3: payload.payPrice, character_string6: payload.orderNo };
}

/** Preserve the existing 3098 contract: title from the target order, nickname
 * from its leader, but the date belongs to this member rather than the leader. */
export async function readRoutinePinkSuccessNotificationDataTx(tx: DbClient, payload: OrderPinkSuccessNoticeOutboxPayload,
  source: { leaderNickname: string; memberAddTime: number }): Promise<Record<string, string>> {
  if (!Number.isSafeInteger(source.memberAddTime) || source.memberAddTime <= 0 || source.memberAddTime > 2147483647)
    throw Error('成团通知成员时间无效');
  return { thing1: await readRoutineOrderNotificationTitleTx(tx, payload, true), name3: routineDeliveryName(source.leaderNickname),
    date5: chinaDateTime(source.memberAddTime), number2: String(payload.people) };
}

export async function configuredTemplate(
  tx: DbClient,
  mark: string,
  legacyType: 0 | 1,
): Promise<string> {
  const rows = await tx
    .select({ tempid: notificationTemplate.tempid })
    .from(notificationTemplate)
    .where(and(
      eq(notificationTemplate.mark, mark),
      eq(notificationTemplate.legacyType, legacyType),
      eq(notificationTemplate.status, 1),
    ))
    .orderBy(desc(notificationTemplate.id))
    .limit(2);
  if (rows.length > 1) throw new Error(`外部通知模板 ${legacyType}:${mark} 存在重复启用来源`);
  return rows[0]?.tempid.trim() ?? "";
}

export async function createImmutableDelivery(
  tx: DbClient,
  input: {
    event: OrderNotificationOutboxEvent;
    payload: { userId: number } & ({ orderId: number; withdrawalId?: never } | { orderId?: never; withdrawalId: number });
    mark: string;
    channel: OrderNotificationChannel;
    target: string;
    templateCode: string;
    deliveryPayload: OrderNotificationDeliveryPayload;
    skipReason?: string;
    now: number;
  },
): Promise<void> {
  if (input.channel !== 'wechat_routine' && input.event.payload != null && Object.hasOwn(input.event.payload, 'routineSubscriptionRequest')) {
    const [prior] = await tx.select().from(orderNotificationDelivery).where(and(eq(orderNotificationDelivery.eventKey, input.event.eventKey),
      eq(orderNotificationDelivery.channel, input.channel))).limit(1);
    if (prior) {
      // V2 may commit SMS/official/shipping while only Mini resolution waits.
      // Configuration/identity changes on a later retry cannot rewrite those
      // already committed intents or make their original rendering conflict.
      if (prior.outboxId !== input.event.id || prior.orderId !== (input.payload.orderId ?? null)
        || prior.withdrawalId !== (input.payload.withdrawalId ?? null) || prior.userId !== input.payload.userId
        || prior.noticeMark !== input.mark || prior.payload.kind !== input.channel) throw new Error('版本化通知重放与原渠道意图冲突');
      return;
    }
  }
  // Pin only at creation. Consumption never fills a historical missing account
  // with today's AppID. Immutable-conflict checks also cover this new field.
  let deliveryPayload = input.deliveryPayload;
  let routineAppId: string | undefined;
  if (input.deliveryPayload.kind === 'wechat_routine') {
    const [existing] = await tx.select({ payload: orderNotificationDelivery.payload }).from(orderNotificationDelivery)
      .where(and(eq(orderNotificationDelivery.eventKey, input.event.eventKey), eq(orderNotificationDelivery.channel, input.channel))).limit(1);
    const { routineAppId: _untrusted, ...unbound } = input.deliveryPayload;
    if (existing?.payload.kind === 'wechat_routine') {
      const source = input.event.payload as { routineAppId?: unknown };
      if (typeof source.routineAppId === 'string' && existing.payload.routineAppId !== source.routineAppId)
        throw new Error('外部通知原事件与投递账号不可变字段冲突');
      // Replays retain the original account, including historical absence. They
      // never repin a committed intent after configuration changes.
      deliveryPayload = Object.hasOwn(existing.payload, 'routineAppId')
        ? { ...unbound, routineAppId: existing.payload.routineAppId } : unbound;
    } else {
      // An old business outbox without an account must not adopt today's
      // configuration while rendering a new delivery after a Queue delay.
      const source = input.event.payload as { routineAppId?: unknown };
      if (typeof source.routineAppId === 'string') {
        routineAppId = source.routineAppId;
        deliveryPayload = { ...unbound, routineAppId };
      } else deliveryPayload = unbound;
    }
  }
  const skipReason = input.skipReason ?? (input.deliveryPayload.kind === 'wechat_routine'
    && !Object.hasOwn(deliveryPayload, 'routineAppId') ? 'routine_account_evidence_required'
    : routineAppId === '' ? 'routine_account_not_configured' : undefined);
  const status = skipReason ? "SKIPPED" : "PENDING";
  const inserted = await tx
    .insert(orderNotificationDelivery)
    .values({
      outboxId: input.event.id,
      eventKey: input.event.eventKey,
      orderId: input.payload.orderId ?? null,
      withdrawalId: input.payload.withdrawalId ?? null,
      userId: input.payload.userId,
      noticeMark: input.mark,
      channel: input.channel,
      target: input.target,
      templateCode: input.templateCode,
      payload: deliveryPayload,
      status,
      availableTime: input.now,
      lastError: skipReason ?? "",
      addTime: input.now,
      updateTime: input.now,
    })
    .onConflictDoNothing({
      target: [orderNotificationDelivery.eventKey, orderNotificationDelivery.channel],
    })
    .returning({ id: orderNotificationDelivery.id });
  if (inserted[0]) return;

  const existing = await tx
    .select({
      outboxId: orderNotificationDelivery.outboxId,
      orderId: orderNotificationDelivery.orderId,
      withdrawalId: orderNotificationDelivery.withdrawalId,
      userId: orderNotificationDelivery.userId,
      noticeMark: orderNotificationDelivery.noticeMark,
      target: orderNotificationDelivery.target,
      templateCode: orderNotificationDelivery.templateCode,
      payload: orderNotificationDelivery.payload,
    })
    .from(orderNotificationDelivery)
    .where(and(
      eq(orderNotificationDelivery.eventKey, input.event.eventKey),
      eq(orderNotificationDelivery.channel, input.channel),
    ))
    .limit(1);
  const row = existing[0];
  if (
    !row || row.outboxId !== input.event.id || row.orderId !== (input.payload.orderId ?? null) ||
    row.withdrawalId !== (input.payload.withdrawalId ?? null) ||
    row.userId !== input.payload.userId || row.noticeMark !== input.mark ||
    row.target !== input.target || row.templateCode !== input.templateCode ||
    canonicalJson(row.payload) !== canonicalJson(deliveryPayload)
  ) {
    throw new Error(`外部通知 ${input.event.eventKey}:${input.channel} 不可变字段冲突`);
  }
}

async function stageExternalNotifications(
  tx: DbClient,
  event: OrderNotificationOutboxEvent,
  payload:
    | OrderDeliveryNoticeOutboxPayload
    | OrderRefundRefusedNoticeOutboxPayload | OrderRefundSuccessNoticeOutboxPayload
    | OrderPinkSuccessNoticeOutboxPayload
    | OrderSecondCardNoticeOutboxPayload,
  mark: string,
  config: NoticeConfig | undefined,
  context: NoticeContext,
  now: number,
  suppressRoutine = false,
): Promise<void> {
  if (event.eventType === ORDER_PINK_SUCCESS_NOTICE_EVENT) {
    // The old success callback invokes system, SMS and routine channels;
    // its official-account callback is commented out, so do not invent it.
    if (config?.isSms === 1) await createImmutableDelivery(tx, {
      event, payload, mark, channel: 'sms', target: context.buyerPhone, templateCode: config.smsId.trim(),
      deliveryPayload: { kind: 'sms', params: { title: context.storeName, nickname: context.values.nickname } },
      skipReason: !context.buyerPhone ? 'target_not_configured' : !config.smsId.trim() ? 'template_not_configured' : undefined, now,
    });
    if (config?.isRoutine === 1 && !suppressRoutine) {
      const templateCode = await configuredTemplate(tx, '3098', 0);
      await createImmutableDelivery(tx, {
        event, payload, mark, channel: 'wechat_routine', target: context.routineOpenid, templateCode,
        deliveryPayload: { kind: 'wechat_routine', data: { thing1: utf8Prefix(context.storeName, 20),
          name3: routineDeliveryName(context.values.nickname), date5: context.values.pink_time, number2: context.values.count },
          url: `/pages/goods/order_details/index?order_id=${payload.orderNo}` },
        skipReason: !context.routineOpenid ? 'target_not_configured' : !templateCode ? 'template_not_configured' : undefined, now,
      });
    }
    return;
  }
  const success = event.eventType === ORDER_REFUND_SUCCESS_NOTICE_EVENT;
  const isRefund = success || event.eventType === ORDER_REFUND_REFUSED_NOTICE_EVENT;
  const isSecondCard = event.eventType === ORDER_SECOND_CARD_ADVENT_NOTICE_EVENT
    || event.eventType === ORDER_SECOND_CARD_EXPIRED_NOTICE_EVENT;
  const delivery = isRefund || isSecondCard
    ? undefined
    : payload as OrderDeliveryNoticeOutboxPayload;
  if (config?.isSms === 1) {
    const params: Record<string, string> = isSecondCard
      ? context.values
      : isRefund
        ? success ? { order_id: context.order.orderId, refund_price: context.values.refund_price! } : { order_id: payload.orderNo }
        : {
          order_id: payload.orderNo,
          store_name: context.storeName,
          nickname: context.values.nickname ?? "",
        };
    const target = context.order.userPhone.trim();
    const templateCode = config.smsId.trim();
    await createImmutableDelivery(tx, {
      event, payload, mark, channel: "sms", target, templateCode,
      deliveryPayload: { kind: "sms", params },
      skipReason: !target ? "target_not_configured" : !templateCode ? "template_not_configured" : undefined,
      now,
    });
  }

  // The PHP second-card notices only had system-message and SMS consumers.
  if (isSecondCard || payload.userId === 0) return;

  const officialEnabled = config?.isWechat === 1 &&
    (isRefund || delivery?.deliveryType === "express");
  if (officialEnabled) {
    const templateMark = isRefund ? success ? "48058" : "46232" : "42984";
    const templateCode = await configuredTemplate(tx, templateMark, 1);
    const data: Record<string, string> = success
      ? { amount2: context.values.refund_price!, time4: chinaDateTime(context.order.addTime), character_string5: payload.orderNo }
      : isRefund
      ? {
          amount5: context.order.payPrice,
          character_string8: payload.orderNo,
          thing6: success ? "退款成功" : "审核未通过",
          time9: chinaDateTime(context.order.addTime),
        }
      : {
          character_string2: payload.orderNo,
          thing4: context.storeName,
          thing13: delivery?.deliveryName ?? "",
          character_string14: delivery?.deliveryId ?? "",
          time12: chinaDateTime(now),
        };
    await createImmutableDelivery(tx, {
      event, payload, mark, channel: "wechat_official", target: context.officialOpenid,
      templateCode,
      deliveryPayload: {
        kind: "wechat_official",
        data,
        url: `/pages/goods/order_details/index?order_id=${payload.orderNo}`,
      },
      skipReason: !context.officialOpenid
        ? "target_not_configured"
        : !templateCode ? "template_not_configured" : undefined,
      now,
    });
  }

  const routineEnabled = config?.isRoutine === 1 &&
    (isRefund || delivery?.deliveryType === "express" || (delivery?.deliveryType === "send" || delivery?.deliveryType === "city_delivery"));
  // Success is a new opt-in author: only Request5 staging above may select a
  // Mini account. An absent delivery namespace keeps SMS/inbox, never a B send.
  if (routineEnabled && !suppressRoutine && !success) {
    const templateMark = isRefund
      ? "1451"
      : delivery?.deliveryType === "express" ? "1458" : "1128";
    const templateCode = await configuredTemplate(tx, templateMark, 0);
    const data: Record<string, string> = isRefund
      ? {
          thing1: "退款失败",
          thing2: context.storeName,
          amount3: context.order.payPrice,
          character_string6: payload.orderNo,
        }
      : routineDeliveryNotificationData(context.storeName, delivery!, now);
    await createImmutableDelivery(tx, {
      event, payload, mark, channel: "wechat_routine", target: context.routineOpenid,
      templateCode,
      deliveryPayload: {
        kind: "wechat_routine",
        data,
        url: isRefund
          ? `/pages/goods/order_after_details/index?order_id=${payload.orderNo}&isReturen=1`
          : `/pages/goods/order_details/index?order_id=${payload.orderNo}`,
      },
      skipReason: !context.routineOpenid
        ? "target_not_configured"
        : !templateCode ? "template_not_configured" : undefined,
      now,
    });
  }

  if (!delivery) return;
  const shippingConfigs = await tx
    .select({ value: systemConfig.value })
    .from(systemConfig)
    .where(eq(systemConfig.menuName, "order_shipping_open"))
    .orderBy(desc(systemConfig.id))
    .limit(2);
  if (shippingConfigs.length > 1) throw new Error("小程序发货开关存在重复配置来源");
  const shippingOpen = ["1", "true"].includes(
    normalizeConfigScalar(shippingConfigs[0]?.value).toLowerCase(),
  );
  if (!shippingOpen || context.order.payType !== "weixin") return;

  let rootOrderNo = context.order.orderId;
  let transactionId = context.order.tradeNo.trim();
  let isAllDelivered = true;
  const deliveryMode: 1 | 2 = context.order.pid > 0 ? 2 : 1;
  if (deliveryMode === 2) {
    const [rootRows, pendingRows] = await Promise.all([
      tx.select({ orderId: storeOrder.orderId, tradeNo: storeOrder.tradeNo }).from(storeOrder)
        .where(eq(storeOrder.id, context.order.pid)).limit(1),
      tx.select({ id: storeOrder.id }).from(storeOrder).where(and(
        eq(storeOrder.pid, context.order.pid),
        eq(storeOrder.status, 0),
      )).limit(1),
    ]);
    if (!rootRows[0]) throw new Error("拆单根订单不存在");
    rootOrderNo = rootRows[0].orderId;
    transactionId = rootRows[0].tradeNo.trim();
    isAllDelivered = pendingRows.length === 0;
  }
  const logisticsType = routineShippingLogisticsType(context.order.shippingType,delivery.deliveryType);
  if(logisticsType===null)return;
  // The real payer is resolved from authenticated original payment evidence at
  // consumption. Retain a committed historical target only for immutable replay.
  const [historicalShipping] = await tx.select({ target: orderNotificationDelivery.target, payload: orderNotificationDelivery.payload }).from(orderNotificationDelivery)
    .where(and(eq(orderNotificationDelivery.eventKey,event.eventKey),eq(orderNotificationDelivery.channel,'wechat_shipping'))).limit(1);
  // New explicit pickup uses the paid outbox as its source. Retain any old
  // committed delivery intent, but do not create a second payment-side effect.
  if(context.order.shippingType===2&&!historicalShipping)return;
  const target = historicalShipping?.target ?? '';
  if (historicalShipping?.payload.kind === 'wechat_shipping') transactionId = historicalShipping.payload.transactionId;
  await createImmutableDelivery(tx, {
    event, payload, mark, channel: "wechat_shipping", target, templateCode: "",
    deliveryPayload: {
      kind: "wechat_shipping",
      transactionId,
      logisticsType,
      deliveryMode,
      isAllDelivered,
      itemDescription: context.shippingItemDescription,
      trackingNumber: logisticsType === 1 ? delivery.deliveryId : "",
      expressCompanyName: logisticsType === 1 ? delivery.deliveryName : "",
      receiverContact: logisticsType === 1 ? context.order.userPhone : "",
      path: `pages/goods/order_details/index?order_id=${rootOrderNo}`,
    },
    skipReason: !transactionId ? "transaction_not_configured" : undefined,
    now,
  });
}

/** Persist the PHP-compatible in-app notice; external SMS/WeChat channels are separate migrations. */
export async function processOrderNotificationOutboxEvent(
  tx: DbClient,
  event: OrderNotificationOutboxEvent,
  now: number,
  routine?: { env: Readonly<RoutineSubscriptionNoticeEnvironment>; earlyReady: boolean },
): Promise<NotificationResult> {
  assertOrderNotificationPayload(event.payload, event.eventType, event.aggregateId);
  const payload = event.payload as
    | OrderDeliveryNoticeOutboxPayload
    | OrderRefundRefusedNoticeOutboxPayload | OrderRefundSuccessNoticeOutboxPayload
    | OrderPinkSuccessNoticeOutboxPayload
    | OrderSecondCardNoticeOutboxPayload;
  const versionedRoutine = [ORDER_DELIVERY_NOTICE_EVENT, ORDER_REFUND_REFUSED_NOTICE_EVENT, ORDER_REFUND_SUCCESS_NOTICE_EVENT, ORDER_PINK_SUCCESS_NOTICE_EVENT].includes(event.eventType) && Object.hasOwn(payload, 'routineSubscriptionRequest');
  const renderAt = versionedRoutine && Number.isSafeInteger(event.addTime) ? event.addTime! : now;
  let routineDeferred = false;
  const mark = noticeMark(event.eventType, payload);
  const templates = await tx
    .select({
      mark: systemNotification.mark,
      isSystem: systemNotification.isSystem,
      isSms: systemNotification.isSms,
      isWechat: systemNotification.isWechat,
      isRoutine: systemNotification.isRoutine,
      smsId: systemNotification.smsId,
      title: systemNotification.systemTitle,
      content: systemNotification.systemText,
    })
    .from(systemNotification)
    .where(eq(systemNotification.mark, mark))
    .orderBy(desc(systemNotification.id))
    .limit(2);
  if (templates.length > 1) throw new Error(`通知模板 ${mark} 存在重复启用来源`);
  const template = templates[0];
  if(event.eventType===ORDER_DELIVERY_NOTICE_EVENT&&!await customerCityNoticeIsActive(tx,payload as OrderDeliveryNoticeOutboxPayload))return 'disabled';
  const context = await noticeContext(tx, event.eventType, payload);
  if (event.eventType === ORDER_PINK_SUCCESS_NOTICE_EVENT && !context.pinkSuccessActive) return 'disabled';
  if (
    (event.eventType === ORDER_SECOND_CARD_ADVENT_NOTICE_EVENT
      || event.eventType === ORDER_SECOND_CARD_EXPIRED_NOTICE_EVENT)
    && !context.secondCardActive
  ) {
    return "disabled";
  }
  if (versionedRoutine && template?.isRoutine === 1 && ([ORDER_REFUND_REFUSED_NOTICE_EVENT, ORDER_REFUND_SUCCESS_NOTICE_EVENT, ORDER_PINK_SUCCESS_NOTICE_EVENT].includes(event.eventType)
    || 'deliveryType' in payload && ['express', 'send', 'city_delivery'].includes(payload.deliveryType))) {
    routineDeferred = await stageRoutineSubscriptionNoticeTx(tx, routine?.env ?? {}, event, mark, routine?.earlyReady === true, renderAt) === 'deferred';
  }
  await stageExternalNotifications(tx, event, payload, mark, template, context, renderAt, versionedRoutine);
  if (!template || template.isSystem !== 1 || payload.userId === 0) return routineDeferred ? "deferred" : "disabled";

  if (versionedRoutine) {
    const [prior] = await tx.select({ mark: systemMessage.mark, userId: systemMessage.userId }).from(systemMessage)
      .where(eq(systemMessage.eventKey, event.eventKey)).limit(1);
    if (prior) {
      if (prior.mark !== mark || prior.userId !== payload.userId) throw new Error('版本化通知重放与原站内消息冲突');
      return routineDeferred ? 'deferred' : 'already-created';
    }
  }
  const title = renderTemplate(template.title, context.values);
  const content = renderTemplate(template.content, context.values);
  if ([...title].length > 256) throw new Error(`通知模板 ${mark} 渲染后的标题过长`);

  const inserted = await tx
    .insert(systemMessage)
    .values({
      eventKey: event.eventKey,
      mark,
      title,
      content,
      userId: payload.userId,
      look: 0,
      type: 1,
      status: 1,
      addTime: renderAt,
      isDel: 0,
    })
    .onConflictDoNothing({ target: systemMessage.eventKey })
    .returning({ id: systemMessage.id });
  if (inserted[0]) return routineDeferred ? "deferred" : "created";

  const existing = await tx
    .select({
      mark: systemMessage.mark,
      title: systemMessage.title,
      content: systemMessage.content,
      userId: systemMessage.userId,
    })
    .from(systemMessage)
    .where(eq(systemMessage.eventKey, event.eventKey))
    .limit(1);
  if (!existing[0]) throw new Error("站内通知幂等证据丢失");
  if (
    existing[0].mark !== mark ||
    existing[0].title !== title ||
    existing[0].content !== content ||
    existing[0].userId !== payload.userId
  ) {
    throw new Error("站内通知事件键与既有消息冲突");
  }
  return routineDeferred ? "deferred" : "already-created";
}
