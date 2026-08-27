import {
  and,
  asc,
  desc,
  eq,
  inArray,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  storeCouponUser,
  storeOrderOutbox,
  storeOrderStatus,
  user,
  type OrderOutboxPayload,
  type OrderPaidOutboxPayload,
} from "@/models/schema";
import { withTx, type Container, type DbClient } from "@/lib/di";
import type {
  OrderMessage,
  OrderNotificationOutboxMessage,
  OrderPaidOutboxMessage,
} from "@/env";
import { NotFoundException, ValidateException } from "@/utils/errors";
import { allocatePaidOrderBySupplier } from "@/services/order/OrderSupplierAllocationService";
import { recordSupplierPayment } from "@/services/supplier/SupplierFinanceService";
import { grantPaidOrderProductCoupons } from "@/services/activity/ProductCouponService";
import { grantLotteryEntitlement } from "@/services/activity/LotteryService";
import { deliverPaidVirtualOrders } from "@/services/order/VirtualProductDeliveryService";
import {
  ORDER_DELIVERY_NOTICE_EVENT,
  ORDER_REFUND_REFUSED_NOTICE_EVENT,
  processOrderNotificationOutboxEvent,
} from "@/services/order/OrderNotificationOutboxService";
import { enqueueAutomaticReceiptPrintJobs } from "@/services/printing/ReceiptPrintJobService";

export const ORDER_PAID_EVENT = "order.paid";
export const OUTBOX_PROCESS_LEASE_SECONDS = 120;
export const OUTBOX_DELIVERY_LEASE_SECONDS = 600;
export const OUTBOX_MAX_ATTEMPTS = 8;

const OUTBOX_STATUSES = [
  "PENDING",
  "ENQUEUING",
  "ENQUEUED",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
  "DEAD",
] as const;

export type OrderOutboxStatus = (typeof OUTBOX_STATUSES)[number];

export interface OrderOutboxEnvironment {
  ORDER_QUEUE: Queue<OrderMessage>;
}

interface PaymentOrder {
  id: number;
  uid: number;
  orderId: string;
  paid: number;
  couponId: number;
}

interface ClaimedEvent {
  id: number;
  eventKey: string;
  aggregateId: number;
  eventType: string;
  payload: OrderOutboxPayload;
  leaseToken: string;
  attemptCount: number;
}

export function orderPaidEventKey(orderId: number): string {
  if (!Number.isSafeInteger(orderId) || orderId <= 0) {
    throw new Error("订单 ID 无效");
  }
  return `${ORDER_PAID_EVENT}:${orderId}`;
}

export function outboxRetryDelaySeconds(attemptCount: number): number {
  const normalized = Math.max(1, Math.min(Math.trunc(attemptCount), OUTBOX_MAX_ATTEMPTS));
  return Math.min(30 * 2 ** (normalized - 1), 3600);
}

export function isOrderPaidOutboxMessage(value: unknown): value is OrderPaidOutboxMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (
    message.action !== "processOrderPaidOutbox" ||
    typeof message.outboxId !== "number" ||
    !Number.isSafeInteger(message.outboxId) ||
    message.outboxId <= 0 ||
    typeof message.eventKey !== "string" ||
    !/^order\.paid:\d+$/.test(message.eventKey)
  ) return false;
  const aggregateId = Number(message.eventKey.slice(`${ORDER_PAID_EVENT}:`.length));
  return Number.isSafeInteger(aggregateId) && aggregateId > 0;
}

export function isOrderNotificationOutboxMessage(
  value: unknown,
): value is OrderNotificationOutboxMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return (
    message.action === "processOrderNotificationOutbox" &&
    typeof message.outboxId === "number" &&
    Number.isSafeInteger(message.outboxId) &&
    message.outboxId > 0 &&
    typeof message.eventKey === "string" &&
    /^(?:order\.delivery\.notice|order\.refund\.refused\.notice):\d+$/.test(message.eventKey) &&
    !message.eventKey.endsWith(":0")
  );
}

export function outboxFailureDisposition(attemptCount: number, now: number): {
  status: "FAILED" | "DEAD";
  availableTime: number;
} {
  if (!Number.isSafeInteger(attemptCount) || attemptCount <= 0) {
    throw new Error("outbox 尝试次数无效");
  }
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("当前时间无效");
  const dead = attemptCount >= OUTBOX_MAX_ATTEMPTS;
  return {
    status: dead ? "DEAD" : "FAILED",
    availableTime: dead ? 0 : now + outboxRetryDelaySeconds(attemptCount),
  };
}

function queueMessageForOutboxEvent(event: {
  id: number;
  eventKey: string;
  eventType: string;
}): OrderPaidOutboxMessage | OrderNotificationOutboxMessage {
  if (event.eventType === ORDER_PAID_EVENT) {
    return {
      action: "processOrderPaidOutbox",
      outboxId: event.id,
      eventKey: event.eventKey,
    };
  }
  if (
    event.eventType === ORDER_DELIVERY_NOTICE_EVENT ||
    event.eventType === ORDER_REFUND_REFUSED_NOTICE_EVENT
  ) {
    return {
      action: "processOrderNotificationOutbox",
      outboxId: event.id,
      eventKey: event.eventKey,
    };
  }
  throw new Error(`不支持的订单 outbox 事件类型: ${event.eventType}`);
}

/**
 * Persist the immutable order-paid event inside the caller's payment
 * transaction. Queue delivery deliberately remains outside this helper.
 */
export async function enqueueOrderPaidEvent(
  db: DbClient,
  order: { id: number; orderId: string },
  now = Math.floor(Date.now() / 1000),
): Promise<{ id: number; eventKey: string }> {
  const eventKey = orderPaidEventKey(order.id);
  const inserted = await db
    .insert(storeOrderOutbox)
    .values({
      eventKey,
      aggregateType: "order",
      aggregateId: order.id,
      eventType: ORDER_PAID_EVENT,
      payload: { orderId: order.id, orderNo: order.orderId },
      status: "PENDING",
      availableTime: now,
      addTime: now,
      updateTime: now,
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
    .where(eq(storeOrderOutbox.eventKey, eventKey))
    .limit(1);
  if (!existing[0]) throw new Error("支付 outbox 写入失败");
  assertOrderPaidPayload(existing[0].payload, existing[0].aggregateId);
  if (
    existing[0].eventType !== ORDER_PAID_EVENT ||
    existing[0].aggregateId !== order.id ||
    existing[0].payload.orderNo !== order.orderId
  ) {
    throw new Error("支付 outbox 不可变字段冲突");
  }
  return { id: existing[0].id, eventKey: existing[0].eventKey };
}

export class OrderOutboxService {
  constructor(
    private readonly container: Container,
    private readonly env: OrderOutboxEnvironment,
  ) {}

  /** 必须在订单 paid=0→1 的同一事务中调用。 */
  async enqueueOrderPaid(
    db: DbClient,
    order: { id: number; orderId: string },
    now = Math.floor(Date.now() / 1000),
  ): Promise<{ id: number; eventKey: string }> {
    return enqueueOrderPaidEvent(db, order, now);
  }

  /**
   * 原子认领待投递事件，事务提交后再调用 Queue；发送结果未知时允许重复投递。
   * 业务处理本身在 PostgreSQL 事务内幂等，因此重复消息不会重复分佣。
   */
  async dispatchPending(limit = 20, onlyId?: number): Promise<{ claimed: number; enqueued: number }> {
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 100));
    const now = Math.floor(Date.now() / 1000);
    const leaseToken = crypto.randomUUID();
    const eligible = or(
      and(
        inArray(storeOrderOutbox.status, ["PENDING", "FAILED"]),
        lte(storeOrderOutbox.availableTime, now),
      ),
      and(
        inArray(storeOrderOutbox.status, ["ENQUEUING", "ENQUEUED", "PROCESSING"]),
        lte(storeOrderOutbox.leaseUntil, now),
      ),
    );

    const claimed = await withTx(this.container, async (tx) => {
      const rows = await tx
        .select({
          id: storeOrderOutbox.id,
          eventKey: storeOrderOutbox.eventKey,
          eventType: storeOrderOutbox.eventType,
        })
        .from(storeOrderOutbox)
        .where(onlyId ? and(eq(storeOrderOutbox.id, onlyId), eligible) : eligible)
        .orderBy(asc(storeOrderOutbox.id))
        .limit(boundedLimit)
        .for("update", { skipLocked: true });
      if (!rows.length) return rows;

      await tx
        .update(storeOrderOutbox)
        .set({
          status: "ENQUEUING",
          dispatchCount: sql`${storeOrderOutbox.dispatchCount} + 1`,
          leaseToken,
          leaseUntil: now + OUTBOX_PROCESS_LEASE_SECONDS,
          updateTime: now,
        })
        .where(inArray(storeOrderOutbox.id, rows.map((row) => row.id)));
      return rows;
    });

    if (!claimed.length) return { claimed: 0, enqueued: 0 };

    try {
      const messages = claimed.map((event) => ({
        body: queueMessageForOutboxEvent(event),
        contentType: "json" as const,
      }));
      await this.env.ORDER_QUEUE.sendBatch(messages);
      await this.container.db
        .update(storeOrderOutbox)
        .set({
          status: "ENQUEUED",
          leaseToken: "",
          leaseUntil: now + OUTBOX_DELIVERY_LEASE_SECONDS,
          enqueuedTime: now,
          lastError: "",
          updateTime: now,
        })
        .where(
          and(
            inArray(storeOrderOutbox.id, claimed.map((event) => event.id)),
            eq(storeOrderOutbox.status, "ENQUEUING"),
            eq(storeOrderOutbox.leaseToken, leaseToken),
          ),
        );
      return { claimed: claimed.length, enqueued: claimed.length };
    } catch (error) {
      const message = errorMessage(error);
      await this.container.db
        .update(storeOrderOutbox)
        .set({
          status: "FAILED",
          leaseToken: "",
          leaseUntil: 0,
          availableTime: now + 60,
          lastError: truncateError(`Queue 投递失败: ${message}`),
          updateTime: now,
        })
        .where(
          and(
            inArray(storeOrderOutbox.id, claimed.map((event) => event.id)),
            eq(storeOrderOutbox.status, "ENQUEUING"),
            eq(storeOrderOutbox.leaseToken, leaseToken),
          ),
        );
      throw error;
    }
  }

  async dispatchById(id: number): Promise<{ claimed: number; enqueued: number }> {
    return this.dispatchPending(1, id);
  }

  async processMessage(
    message: OrderPaidOutboxMessage | OrderNotificationOutboxMessage,
  ): Promise<
    "completed" | "already-completed" | "busy" | "dead"
  > {
    const claim = await this.claimForProcessing(message);
    if (typeof claim === "string") return claim;

    try {
      await this.runClaimedEvent(claim);
      return "completed";
    } catch (error) {
      await this.recordFailure(claim, error);
      throw error;
    }
  }

  async replay(id: number): Promise<void> {
    if (!Number.isSafeInteger(id) || id <= 0) throw new ValidateException("outbox ID 无效");
    const now = Math.floor(Date.now() / 1000);
    await withTx(this.container, async (tx) => {
      const rows = await tx
        .select()
        .from(storeOrderOutbox)
        .where(eq(storeOrderOutbox.id, id))
        .limit(1)
        .for("update");
      const event = rows[0];
      if (!event) throw new NotFoundException("outbox 事件不存在");
      if (event.status === "COMPLETED") throw new ValidateException("已完成事件不能重放");
      if (event.status === "PROCESSING" && event.leaseUntil > now) {
        throw new ValidateException("事件正在处理，请稍后重试");
      }
      await tx
        .update(storeOrderOutbox)
        .set({
          status: "PENDING",
          attemptCount: 0,
          replayCount: sql`${storeOrderOutbox.replayCount} + 1`,
          availableTime: now,
          leaseUntil: 0,
          leaseToken: "",
          lastError: "",
          updateTime: now,
        })
        .where(eq(storeOrderOutbox.id, id));
    });
  }

  async list(params: { status?: string; afterId?: number; limit?: number }) {
    const limit = Math.max(1, Math.min(Math.trunc(params.limit ?? 20), 100));
    const normalizedStatus = params.status?.toUpperCase();
    if (normalizedStatus && !OUTBOX_STATUSES.includes(normalizedStatus as OrderOutboxStatus)) {
      throw new ValidateException("outbox 状态无效");
    }
    const conditions: SQL[] = [];
    if (normalizedStatus) conditions.push(eq(storeOrderOutbox.status, normalizedStatus));
    if (params.afterId && params.afterId > 0) conditions.push(lt(storeOrderOutbox.id, params.afterId));
    const rows = await this.container.db
      .select()
      .from(storeOrderOutbox)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(storeOrderOutbox.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    return {
      list: data,
      next_cursor: hasMore ? data.at(-1)?.id ?? null : null,
    };
  }

  private async claimForProcessing(
    message: OrderPaidOutboxMessage | OrderNotificationOutboxMessage,
  ): Promise<ClaimedEvent | "already-completed" | "busy" | "dead"> {
    const now = Math.floor(Date.now() / 1000);
    const leaseToken = crypto.randomUUID();
    return withTx(this.container, async (tx) => {
      const rows = await tx
        .select()
        .from(storeOrderOutbox)
        .where(eq(storeOrderOutbox.id, message.outboxId))
        .limit(1)
        .for("update");
      const event = rows[0];
      if (!event) throw new NotFoundException("outbox 事件不存在");
      if (event.eventKey !== message.eventKey) throw new ValidateException("outbox 事件键不匹配");
      if (
        (message.action === "processOrderPaidOutbox" && event.eventType !== ORDER_PAID_EVENT) ||
        (message.action === "processOrderNotificationOutbox" &&
          event.eventType !== ORDER_DELIVERY_NOTICE_EVENT &&
          event.eventType !== ORDER_REFUND_REFUSED_NOTICE_EVENT)
      ) {
        throw new ValidateException("outbox 消息动作与事件类型不匹配");
      }
      if (event.status === "COMPLETED") return "already-completed";
      if (event.status === "DEAD") return "dead";
      if (event.status === "PROCESSING" && event.leaseUntil > now) return "busy";

      const attemptCount = event.attemptCount + 1;
      await tx
        .update(storeOrderOutbox)
        .set({
          status: "PROCESSING",
          attemptCount,
          leaseToken,
          leaseUntil: now + OUTBOX_PROCESS_LEASE_SECONDS,
          updateTime: now,
        })
        .where(eq(storeOrderOutbox.id, event.id));
      return {
        id: event.id,
        eventKey: event.eventKey,
        aggregateId: event.aggregateId,
        eventType: event.eventType,
        payload: event.payload,
        leaseToken,
        attemptCount,
      };
    });
  }

  private async runClaimedEvent(claim: ClaimedEvent): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await withTx(this.container, async (tx) => {
      const eventRows = await tx
        .select()
        .from(storeOrderOutbox)
        .where(eq(storeOrderOutbox.id, claim.id))
        .limit(1)
        .for("update");
      const event = eventRows[0];
      if (
        !event ||
        event.status !== "PROCESSING" ||
        event.leaseToken !== claim.leaseToken
      ) {
        throw new Error("outbox 处理租约已失效");
      }
      if (
        event.eventKey !== claim.eventKey ||
        event.eventType !== claim.eventType ||
        event.aggregateId !== claim.aggregateId
      ) {
        throw new Error("outbox 处理期间不可变字段发生变化");
      }

      if (event.eventType === ORDER_PAID_EVENT) {
        assertOrderPaidPayload(event.payload, event.aggregateId);

        const allocation = await allocatePaidOrderBySupplier(
          tx,
          event.payload.orderId,
          event.payload.orderNo,
          now,
        );
        const order = allocation.paymentOrder;

      // PHP 的 OrderPayHandelJob 在支付后异步发卡。这里复用同一个可重放
      // outbox，并把卡密认领、订单发货状态和其余支付后置任务放进同一事务。
        await deliverPaidVirtualOrders(tx, allocation.fulfillmentOrders, now);

        // The payment outbox and printer jobs commit together. Split-order roots
        // never print; each fulfillment order selects printers in its own scope.
        await enqueueAutomaticReceiptPrintJobs(tx, allocation.fulfillmentOrders, "paid", now);

        if (order.couponId > 0) {
          await tx
            .update(storeCouponUser)
            .set({ status: 1, useTime: new Date(now * 1000) })
            .where(
              and(
                eq(storeCouponUser.id, order.couponId),
                inArray(storeCouponUser.status, [0, 3]),
              ),
            );
        }

        await grantPaidOrderProductCoupons(tx, order.id, order.uid, now);
        if (order.payType !== "offline" && order.type !== 8) {
          await grantLotteryEntitlement(tx, {
            uid: order.uid,
            factor: 3,
            sourceType: "order",
            sourceId: order.id,
            now,
          });
        }

        for (const fulfillmentOrder of allocation.fulfillmentOrders) {
          await recordSupplierPayment(tx, fulfillmentOrder, now);
        }

        await this.incrementBuyerPayCount(tx, order);
        await tx.insert(storeOrderStatus).values({
          oid: order.id,
          changeType: "pay_success",
          changeMessage: allocation.split
            ? `订单支付成功，已生成 ${allocation.fulfillmentOrders.length} 个履约子单`
            : "订单支付成功，后置任务处理完成",
          changeTime: now,
        });
      } else if (
        event.eventType === ORDER_DELIVERY_NOTICE_EVENT ||
        event.eventType === ORDER_REFUND_REFUSED_NOTICE_EVENT
      ) {
        await processOrderNotificationOutboxEvent(tx, event, now);
      } else {
        throw new Error(`不支持的订单 outbox 事件类型: ${event.eventType}`);
      }

      const completed = await tx
        .update(storeOrderOutbox)
        .set({
          status: "COMPLETED",
          leaseUntil: 0,
          leaseToken: "",
          lastError: "",
          processedTime: now,
          updateTime: now,
        })
        .where(
          and(
            eq(storeOrderOutbox.id, claim.id),
            eq(storeOrderOutbox.status, "PROCESSING"),
            eq(storeOrderOutbox.leaseToken, claim.leaseToken),
          ),
        )
        .returning({ id: storeOrderOutbox.id });
      if (!completed[0]) throw new Error("outbox 完成状态写入失败");
    });
  }

  private async incrementBuyerPayCount(
    tx: DbClient,
    order: PaymentOrder,
  ): Promise<void> {
    const updated = await tx
      .update(user)
      .set({ payCount: sql`${user.payCount} + 1` })
      .where(eq(user.uid, order.uid))
      .returning({ uid: user.uid });
    if (!updated[0]) throw new Error("支付订单用户不存在");
  }

  private async recordFailure(claim: ClaimedEvent, error: unknown): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const disposition = outboxFailureDisposition(claim.attemptCount, now);
    await withTx(this.container, async (tx) => {
      await tx
        .update(storeOrderOutbox)
        .set({
          status: disposition.status,
          availableTime: disposition.availableTime,
          leaseUntil: 0,
          leaseToken: "",
          lastError: truncateError(errorMessage(error)),
          updateTime: now,
        })
        .where(
          and(
            eq(storeOrderOutbox.id, claim.id),
            eq(storeOrderOutbox.status, "PROCESSING"),
            eq(storeOrderOutbox.leaseToken, claim.leaseToken),
          ),
        );
    });
  }
}

function assertOrderPaidPayload(value: unknown, aggregateId: number): asserts value is OrderPaidOutboxPayload {
  if (!value || typeof value !== "object") throw new Error("outbox payload 不是对象");
  const payload = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(payload.orderId) ||
    payload.orderId !== aggregateId ||
    typeof payload.orderNo !== "string" ||
    !payload.orderNo
  ) {
    throw new Error("outbox payload 无效");
  }
}

function truncateError(message: string): string {
  return message.slice(0, 1000);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
