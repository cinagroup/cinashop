import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { DbClient } from "@/lib/di";
import {
  storeOrderCartInfo,
  storeOrder,
  storeOrderOutbox,
  notificationTemplate,
  orderNotificationDelivery,
  systemConfig,
  systemMessage,
  systemNotification,
  user,
  wechatUser,
  type OrderDeliveryNoticeOutboxPayload,
  type OrderNotificationChannel,
  type OrderNotificationDeliveryPayload,
  type OrderOutboxPayload,
  type OrderRefundRefusedNoticeOutboxPayload,
  type OrderSecondCardNoticeOutboxPayload,
} from "@/models/schema";
import { normalizeConfigScalar } from "@/utils/config";

export const ORDER_DELIVERY_NOTICE_EVENT = "order.delivery.notice";
export const ORDER_REFUND_REFUSED_NOTICE_EVENT = "order.refund.refused.notice";
export const ORDER_SECOND_CARD_ADVENT_NOTICE_EVENT = "order.second_card.advent.notice";
export const ORDER_SECOND_CARD_EXPIRED_NOTICE_EVENT = "order.second_card.expired.notice";

export type OrderNotificationEventType =
  | typeof ORDER_DELIVERY_NOTICE_EVENT
  | typeof ORDER_REFUND_REFUSED_NOTICE_EVENT
  | typeof ORDER_SECOND_CARD_ADVENT_NOTICE_EVENT
  | typeof ORDER_SECOND_CARD_EXPIRED_NOTICE_EVENT;

export interface OrderNotificationOutboxEvent {
  id: number;
  eventKey: string;
  aggregateId: number;
  eventType: string;
  payload: OrderOutboxPayload;
}

export interface DeliveryNoticeInput {
  orderId: number;
  orderNo: string;
  userId: number;
  userAddress: string;
  deliveryType: "express" | "send" | "fictitious";
  deliveryName: string;
  deliveryId: string;
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

type NotificationResult = "created" | "already-created" | "disabled";

interface NoticeContext {
  values: Record<string, string>;
  storeName: string;
  shippingItemDescription: string;
  officialOpenid: string;
  routineOpenid: string;
  secondCardActive: boolean;
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

export function orderDeliveryNoticeEventKey(orderId: number): string {
  return `${ORDER_DELIVERY_NOTICE_EVENT}:${positiveId(orderId, "订单 ID")}`;
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

async function insertImmutableNotificationEvent(
  db: DbClient,
  input: {
    eventKey: string;
    aggregateId: number;
    eventType: OrderNotificationEventType;
    payload:
      | OrderDeliveryNoticeOutboxPayload
      | OrderRefundRefusedNoticeOutboxPayload
      | OrderSecondCardNoticeOutboxPayload;
    now: number;
  },
): Promise<{ id: number; eventKey: string }> {
  const inserted = await db
    .insert(storeOrderOutbox)
    .values({
      eventKey: input.eventKey,
      aggregateType: "order",
      aggregateId: input.aggregateId,
      eventType: input.eventType,
      payload: input.payload,
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
    !payloadEquals(event.payload, input.payload)
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
): Promise<{ id: number; eventKey: string }> {
  const orderId = positiveId(input.orderId, "订单 ID");
  const userId = positiveId(input.userId, "用户 ID");
  const orderNo = requiredString(input.orderNo, "订单号", 32);
  if (!["express", "send", "fictitious"].includes(input.deliveryType)) {
    throw new Error("发货类型无效");
  }
  const payload: OrderDeliveryNoticeOutboxPayload = {
    orderId,
    orderNo,
    userId,
    deliveryType: input.deliveryType,
    deliveryName: boundedString(input.deliveryName, "配送名称", 64),
    deliveryId: boundedString(input.deliveryId, "配送单号", 64),
    userAddress: boundedString(input.userAddress, "收货地址", 100),
  };
  return insertImmutableNotificationEvent(db, {
    eventKey: orderDeliveryNoticeEventKey(orderId),
    aggregateId: orderId,
    eventType: ORDER_DELIVERY_NOTICE_EVENT,
    payload,
    now,
  });
}

/** Must be called in the same transaction that commits the refusal decision. */
export async function enqueueOrderRefundRefusedNoticeEvent(
  db: DbClient,
  input: RefundRefusedNoticeInput,
  now = Math.floor(Date.now() / 1_000),
): Promise<{ id: number; eventKey: string }> {
  const orderId = positiveId(input.orderId, "订单 ID");
  const refundId = positiveId(input.refundId, "售后 ID");
  const payload: OrderRefundRefusedNoticeOutboxPayload = {
    orderId,
    orderNo: requiredString(input.orderNo, "订单号", 32),
    refundId,
    userId: positiveId(input.userId, "用户 ID"),
    payPrice: requiredString(input.payPrice, "订单金额", 32),
  };
  return insertImmutableNotificationEvent(db, {
    eventKey: orderRefundRefusedNoticeEventKey(refundId),
    aggregateId: orderId,
    eventType: ORDER_REFUND_REFUSED_NOTICE_EVENT,
    payload,
    now,
  });
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

export function assertOrderNotificationPayload(
  value: unknown,
  eventType: string,
  aggregateId: number,
): asserts value is
  | OrderDeliveryNoticeOutboxPayload
  | OrderRefundRefusedNoticeOutboxPayload
  | OrderSecondCardNoticeOutboxPayload {
  if (!value || typeof value !== "object") throw new Error("通知 outbox payload 不是对象");
  const payload = value as Record<string, unknown>;
  positiveId(payload.orderId, "通知订单 ID");
  positiveId(payload.userId, "通知用户 ID");
  if (payload.orderId !== aggregateId) throw new Error("通知 outbox 聚合 ID 不匹配");
  requiredString(payload.orderNo, "通知订单号", 32);

  if (eventType === ORDER_DELIVERY_NOTICE_EVENT) {
    if (!["express", "send", "fictitious"].includes(String(payload.deliveryType))) {
      throw new Error("通知发货类型无效");
    }
    boundedString(payload.deliveryName, "通知配送名称", 64);
    boundedString(payload.deliveryId, "通知配送单号", 64);
    boundedString(payload.userAddress, "通知收货地址", 100);
    return;
  }
  if (eventType === ORDER_REFUND_REFUSED_NOTICE_EVENT) {
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

function noticeMark(
  eventType: string,
  payload:
    | OrderDeliveryNoticeOutboxPayload
    | OrderRefundRefusedNoticeOutboxPayload
    | OrderSecondCardNoticeOutboxPayload,
): string {
  if (eventType === ORDER_REFUND_REFUSED_NOTICE_EVENT) return "send_order_refund_no_status";
  if (eventType === ORDER_SECOND_CARD_ADVENT_NOTICE_EVENT) return "reminder_brink_death";
  if (eventType === ORDER_SECOND_CARD_EXPIRED_NOTICE_EVENT) return "expiration_reminder";
  const delivery = payload as OrderDeliveryNoticeOutboxPayload;
  if (delivery.deliveryType === "express") return "order_postage_success";
  if (delivery.deliveryType === "send") return "order_deliver_success";
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

function shippingTitleFromSnapshot(value: string | null): string {
  if (!value || value.length > 1_048_576) return "";
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const productInfo = parsed.productInfo;
    if (!productInfo || typeof productInfo !== "object" || Array.isArray(productInfo)) return "";
    const storeName = (productInfo as Record<string, unknown>).store_name;
    if (typeof storeName !== "string" || !storeName) return "";
    const cartNum = parsed.cart_num;
    return typeof cartNum === "number" || typeof cartNum === "string"
      ? `${storeName} * ${String(cartNum)}`
      : storeName;
  } catch {
    return "";
  }
}

function utf8Prefix(value: string, characters: number): string {
  return [...value].slice(0, characters).join("");
}

async function noticeContext(
  tx: DbClient,
  eventType: string,
  payload:
    | OrderDeliveryNoticeOutboxPayload
    | OrderRefundRefusedNoticeOutboxPayload
    | OrderSecondCardNoticeOutboxPayload,
): Promise<NoticeContext> {
  const isSecondCard = eventType === ORDER_SECOND_CARD_ADVENT_NOTICE_EVENT
    || eventType === ORDER_SECOND_CARD_EXPIRED_NOTICE_EVENT;
  const secondCard = isSecondCard ? payload as OrderSecondCardNoticeOutboxPayload : undefined;
  const cartQuery = secondCard
    ? tx
        .select({
          cartInfo: storeOrderCartInfo.cartInfo,
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
          isWriteoff: storeOrderCartInfo.isWriteoff,
        })
        .from(storeOrderCartInfo)
        .where(eq(storeOrderCartInfo.oid, payload.orderId))
        .orderBy(asc(storeOrderCartInfo.id));
  const [buyerRows, cartRows, orderRows, identities] = await Promise.all([
    tx.select({ nickname: user.nickname }).from(user).where(eq(user.uid, payload.userId)).limit(1),
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
      })
      .from(storeOrder)
      .where(eq(storeOrder.id, payload.orderId))
      .limit(1),
    tx
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
  if (!order || order.uid !== payload.userId || order.orderId !== payload.orderNo) {
    throw new Error("通知订单快照与当前订单不匹配");
  }
  const storeName = secondCard?.storeName ?? utf8Prefix(
    cartRows.map((row) => productTitleFromSnapshot(row.cartInfo)).filter(Boolean).join("|"),
    20,
  );
  const shippingItemDescription = cartRows
    .map((row) => shippingTitleFromSnapshot(row.cartInfo))
    .filter(Boolean)
    .join(" | ");
  const openid = (type: "wechat" | "routine") =>
    identities.find((identity) => identity.userType === type && identity.openid.trim())?.openid.trim()
      ?? "";
  let values: Record<string, string>;
  if (eventType === ORDER_REFUND_REFUSED_NOTICE_EVENT) {
    const refusal = payload as OrderRefundRefusedNoticeOutboxPayload;
    values = {
      order_id: refusal.orderNo,
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

async function configuredTemplate(
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

async function createImmutableDelivery(
  tx: DbClient,
  input: {
    event: OrderNotificationOutboxEvent;
    payload:
      | OrderDeliveryNoticeOutboxPayload
      | OrderRefundRefusedNoticeOutboxPayload
      | OrderSecondCardNoticeOutboxPayload;
    mark: string;
    channel: OrderNotificationChannel;
    target: string;
    templateCode: string;
    deliveryPayload: OrderNotificationDeliveryPayload;
    skipReason?: string;
    now: number;
  },
): Promise<void> {
  const status = input.skipReason ? "SKIPPED" : "PENDING";
  const inserted = await tx
    .insert(orderNotificationDelivery)
    .values({
      outboxId: input.event.id,
      eventKey: input.event.eventKey,
      orderId: input.payload.orderId,
      userId: input.payload.userId,
      noticeMark: input.mark,
      channel: input.channel,
      target: input.target,
      templateCode: input.templateCode,
      payload: input.deliveryPayload,
      status,
      availableTime: input.now,
      lastError: input.skipReason ?? "",
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
    !row || row.outboxId !== input.event.id || row.orderId !== input.payload.orderId ||
    row.userId !== input.payload.userId || row.noticeMark !== input.mark ||
    row.target !== input.target || row.templateCode !== input.templateCode ||
    canonicalJson(row.payload) !== canonicalJson(input.deliveryPayload)
  ) {
    throw new Error(`外部通知 ${input.event.eventKey}:${input.channel} 不可变字段冲突`);
  }
}

async function stageExternalNotifications(
  tx: DbClient,
  event: OrderNotificationOutboxEvent,
  payload:
    | OrderDeliveryNoticeOutboxPayload
    | OrderRefundRefusedNoticeOutboxPayload
    | OrderSecondCardNoticeOutboxPayload,
  mark: string,
  config: NoticeConfig | undefined,
  context: NoticeContext,
  now: number,
): Promise<void> {
  const isRefund = event.eventType === ORDER_REFUND_REFUSED_NOTICE_EVENT;
  const isSecondCard = event.eventType === ORDER_SECOND_CARD_ADVENT_NOTICE_EVENT
    || event.eventType === ORDER_SECOND_CARD_EXPIRED_NOTICE_EVENT;
  const delivery = isRefund || isSecondCard
    ? undefined
    : payload as OrderDeliveryNoticeOutboxPayload;
  if (config?.isSms === 1) {
    const params: Record<string, string> = isSecondCard
      ? context.values
      : isRefund
        ? { order_id: payload.orderNo }
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
  if (isSecondCard) return;

  const officialEnabled = config?.isWechat === 1 &&
    (isRefund || delivery?.deliveryType === "express");
  if (officialEnabled) {
    const templateMark = isRefund ? "46232" : "42984";
    const templateCode = await configuredTemplate(tx, templateMark, 1);
    const data: Record<string, string> = isRefund
      ? {
          amount5: context.order.payPrice,
          character_string8: payload.orderNo,
          thing6: "审核未通过",
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
    (isRefund || delivery?.deliveryType === "express" || delivery?.deliveryType === "send");
  if (routineEnabled) {
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
      : delivery?.deliveryType === "express"
        ? {
            character_string2: delivery.deliveryId,
            thing1: utf8Prefix(delivery.deliveryName, 20),
            time3: chinaDateTime(now),
            thing5: context.storeName,
          }
        : {
            thing8: context.storeName,
            character_string1: payload.orderNo,
            name4: routineDeliveryName(delivery?.deliveryName ?? ""),
            phone_number10: delivery?.deliveryId ?? "",
          };
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
  if (!shippingOpen || context.order.isChannel !== 1 || context.order.payType !== "weixin") return;

  let rootOrderNo = context.order.orderId;
  let isAllDelivered = true;
  const deliveryMode: 1 | 2 = context.order.pid > 0 ? 2 : 1;
  if (deliveryMode === 2) {
    const [rootRows, pendingRows] = await Promise.all([
      tx.select({ orderId: storeOrder.orderId }).from(storeOrder)
        .where(eq(storeOrder.id, context.order.pid)).limit(1),
      tx.select({ id: storeOrder.id }).from(storeOrder).where(and(
        eq(storeOrder.pid, context.order.pid),
        eq(storeOrder.status, 0),
      )).limit(1),
    ]);
    if (!rootRows[0]) throw new Error("拆单根订单不存在");
    rootOrderNo = rootRows[0].orderId;
    isAllDelivered = pendingRows.length === 0;
  }
  const logisticsType = context.order.shippingType !== 1
    ? 4
    : delivery.deliveryType === "express" ? 1 : delivery.deliveryType === "send" ? 2 : 3;
  const transactionId = context.order.tradeNo.trim();
  const target = context.routineOpenid;
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
    skipReason: !target
      ? "target_not_configured"
      : !transactionId ? "transaction_not_configured" : undefined,
    now,
  });
}

/** Persist the PHP-compatible in-app notice; external SMS/WeChat channels are separate migrations. */
export async function processOrderNotificationOutboxEvent(
  tx: DbClient,
  event: OrderNotificationOutboxEvent,
  now: number,
): Promise<NotificationResult> {
  assertOrderNotificationPayload(event.payload, event.eventType, event.aggregateId);
  const payload = event.payload as
    | OrderDeliveryNoticeOutboxPayload
    | OrderRefundRefusedNoticeOutboxPayload
    | OrderSecondCardNoticeOutboxPayload;
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
  const context = await noticeContext(tx, event.eventType, payload);
  if (
    (event.eventType === ORDER_SECOND_CARD_ADVENT_NOTICE_EVENT
      || event.eventType === ORDER_SECOND_CARD_EXPIRED_NOTICE_EVENT)
    && !context.secondCardActive
  ) {
    return "disabled";
  }
  await stageExternalNotifications(tx, event, payload, mark, template, context, now);
  if (!template || template.isSystem !== 1) return "disabled";

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
      addTime: now,
      isDel: 0,
    })
    .onConflictDoNothing({ target: systemMessage.eventKey })
    .returning({ id: systemMessage.id });
  if (inserted[0]) return "created";

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
  return "already-created";
}
