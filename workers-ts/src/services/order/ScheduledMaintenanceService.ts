import {
  and,
  asc,
  eq,
  gt,
  inArray,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { storeOrder, storeOrderStatus, storePink } from "@/models/schema";
import type { Container } from "@/lib/di";
import type {
  Env,
  OrderMessage,
  PinkTimeoutMessage,
  ScheduledMaintenanceJob,
  ScheduledMaintenanceMessage,
  ScheduledOrderMessage,
} from "@/env";
import { parseConfigInteger } from "@/utils/config";
import { SystemConfigService } from "@/services/system/SystemConfigService";
import { OrderOutboxService } from "@/services/order/OrderOutboxService";
import { OrderNotificationDeliveryService } from "@/services/order/OrderNotificationDeliveryService";
import { ReceiptPrintJobService } from "@/services/printing/ReceiptPrintJobService";
import { OrderWaybillJobService } from "@/services/waybill/OrderWaybillJobService";
import { completeOrderReceipt } from "@/services/order/OrderBrokerageService";
import { StoreOrderRefundService } from "@/services/order/StoreOrderRefundService";
import { ReplyService } from "@/services/product/ReplyService";
import { WechatLiveService } from "@/services/wechat/WechatLiveService";
import { StoreOrderCreateService } from "@/services/order/StoreOrderCreateService";
import { PinkTimeoutService } from "@/services/activity/PinkTimeoutService";
import {
  isSignReminderDispatchTime,
  SignReminderService,
} from "@/services/message/SignReminderService";

export const SCHEDULED_ORDER_PAGE_SIZE = 80;
export const SCHEDULED_OUTBOX_PAGE_SIZE = 20;
export const SCHEDULED_REFUND_PAGE_SIZE = 20;
export const SCHEDULED_PINK_PAGE_SIZE = 20;

const ROOT_JOBS: readonly ScheduledMaintenanceJob[] = [
  "payment_outbox_dispatch",
  "notification_delivery_dispatch",
  "print_job_dispatch",
  "waybill_job_dispatch",
  "unpaid_order_cancel",
  "pink_timeout",
  "auto_receipt",
  "auto_comment",
  "live_room_sync",
  "live_goods_sync",
  "live_anchor_sync",
  "refund_reconciliation",
  "sign_remind_time",
];

const ORDER_JOBS = ["auto_receipt", "auto_comment", "unpaid_order_cancel"] as const;
type ScheduledOrderJob = (typeof ORDER_JOBS)[number];
type FulfillmentOrderJob = Exclude<ScheduledOrderJob, "unpaid_order_cancel">;

const STATUS_TYPES: Record<FulfillmentOrderJob, readonly string[]> = {
  auto_receipt: [
    "delivery_goods",
    "delivery_fictitious",
    "delivery",
    "city_delivery",
  ],
  auto_comment: ["user_take_delivery", "take_delivery", "writeoff"],
};

const CONFIG_KEYS: Record<FulfillmentOrderJob, string> = {
  auto_receipt: "system_delivery_time",
  auto_comment: "system_comment_time",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isScheduledOrderJob(value: unknown): value is ScheduledOrderJob {
  return ORDER_JOBS.includes(value as ScheduledOrderJob);
}

function isScheduledMaintenanceJob(value: unknown): value is ScheduledMaintenanceJob {
  return ROOT_JOBS.includes(value as ScheduledMaintenanceJob);
}

export function scheduledRunId(scheduledAt: number): string {
  if (!Number.isSafeInteger(scheduledAt) || scheduledAt <= 0) {
    throw new Error("scheduledAt must be a positive safe integer");
  }
  return `scheduled:${scheduledAt}`;
}

export function createScheduledRunMessages(scheduledAt: number): ScheduledMaintenanceMessage[] {
  const runId = scheduledRunId(scheduledAt);
  const jobs = isSignReminderDispatchTime(scheduledAt)
    ? ROOT_JOBS
    : ROOT_JOBS.filter((job) => job !== "sign_remind_time");
  return jobs.map((job) => ({
    action: "runScheduledMaintenance",
    job,
    runId,
    scheduledAt,
    cursor: 0,
    threshold: null,
  }));
}

export function isScheduledMaintenanceMessage(
  value: unknown,
): value is ScheduledMaintenanceMessage {
  if (!isRecord(value)) return false;
  if (
    value.action !== "runScheduledMaintenance" ||
    !isScheduledMaintenanceJob(value.job) ||
    !isSafeNonNegativeInteger(value.scheduledAt) ||
    value.scheduledAt === 0 ||
    !isSafeNonNegativeInteger(value.cursor) ||
    !(
      value.threshold === null ||
      isSafeNonNegativeInteger(value.threshold)
    ) ||
    typeof value.runId !== "string"
  ) {
    return false;
  }
  return value.runId === `scheduled:${value.scheduledAt}`;
}

export function isScheduledOrderMessage(value: unknown): value is ScheduledOrderMessage {
  if (!isRecord(value)) return false;
  if (
    value.action !== "processScheduledOrder" ||
    !isScheduledOrderJob(value.job) ||
    !isSafeNonNegativeInteger(value.scheduledAt) ||
    value.scheduledAt === 0 ||
    !isSafeNonNegativeInteger(value.orderId) ||
    value.orderId === 0 ||
    !isSafeNonNegativeInteger(value.threshold) ||
    typeof value.runId !== "string"
  ) {
    return false;
  }
  return value.runId === `scheduled:${value.scheduledAt}`;
}

export function isPinkTimeoutMessage(value: unknown): value is PinkTimeoutMessage {
  if (!isRecord(value)) return false;
  return value.action === "processPinkTimeout"
    && value.job === "pink_timeout"
    && isSafeNonNegativeInteger(value.scheduledAt)
    && value.scheduledAt > 0
    && isSafeNonNegativeInteger(value.pinkId)
    && value.pinkId > 0
    && typeof value.runId === "string"
    && value.runId === `scheduled:${value.scheduledAt}`;
}

export function scheduledRetryDelaySeconds(attempt: number): number {
  const normalized = Math.max(1, Math.trunc(attempt));
  return Math.min(30 * 2 ** Math.min(normalized - 1, 5), 900);
}

export async function enqueueScheduledRun(env: Env, scheduledAt: number): Promise<void> {
  await sendOrderMessages(env, createScheduledRunMessages(scheduledAt));
}

export class ScheduledMaintenanceService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  async processMaintenance(message: ScheduledMaintenanceMessage): Promise<Record<string, unknown>> {
    switch (message.job) {
      case "payment_outbox_dispatch":
        return this.dispatchPaymentOutbox(message);
      case "notification_delivery_dispatch":
        return this.dispatchNotificationDeliveries(message);
      case "print_job_dispatch":
        return this.dispatchPrintJobs(message);
      case "waybill_job_dispatch":
        return this.dispatchWaybillJobs(message);
      case "unpaid_order_cancel":
        return this.scanUnpaidOrders(message);
      case "pink_timeout":
        return this.scanPinkTimeouts(message);
      case "auto_receipt":
      case "auto_comment":
        return this.scanOrders(message);
      case "live_room_sync":
        return new WechatLiveService(this.container, this.env).syncRooms(message);
      case "live_goods_sync":
        return new WechatLiveService(this.container, this.env).syncGoods(message);
      case "live_anchor_sync":
        return new WechatLiveService(this.container, this.env).syncAnchors(message);
      case "refund_reconciliation":
        return this.reconcileRefunds(message);
      case "sign_remind_time":
        return new SignReminderService(this.container, this.env).scan(message);
    }
  }

  async processOrder(message: ScheduledOrderMessage): Promise<Record<string, unknown>> {
    if (message.job === "unpaid_order_cancel") {
      const rows = await this.container.db
        .select({ id: storeOrder.id, uid: storeOrder.uid, orderId: storeOrder.orderId })
        .from(storeOrder)
        .where(
          and(
            eq(storeOrder.id, message.orderId),
            eq(storeOrder.paid, 0),
            eq(storeOrder.status, 0),
            eq(storeOrder.isDel, 0),
            lte(storeOrder.addTime, message.threshold),
          ),
        )
        .limit(1);
      if (!rows[0]) {
        return {
          event: "scheduled_order_skipped",
          job: message.job,
          runId: message.runId,
          orderId: message.orderId,
          reason: "no_longer_eligible",
        };
      }
      await new StoreOrderCreateService(this.container, this.env).cancel(
        rows[0].uid,
        rows[0].orderId,
      );
      return {
        event: "scheduled_order_processed",
        job: message.job,
        runId: message.runId,
        orderId: message.orderId,
        completed: true,
      };
    }
    const eligible = await this.findEligibleOrders(
      message.job,
      message.threshold,
      0,
      1,
      message.orderId,
    );
    if (!eligible.length) {
      return {
        event: "scheduled_order_skipped",
        job: message.job,
        runId: message.runId,
        orderId: message.orderId,
        reason: "no_longer_eligible",
      };
    }

    if (message.job === "auto_receipt") {
      const completed = await completeOrderReceipt(this.container, this.env, {
        orderId: message.orderId,
        actor: "scheduled",
        message: "已收货[自动收货]",
      });
      return {
        event: "scheduled_order_processed",
        job: message.job,
        runId: message.runId,
        orderId: message.orderId,
        completed,
      };
    }

    const result = await new ReplyService(this.container).autoCommentOrder(message.orderId);
    return {
      event: "scheduled_order_processed",
      job: message.job,
      runId: message.runId,
      orderId: message.orderId,
      ...result,
    };
  }

  async processPinkTimeout(message: PinkTimeoutMessage): Promise<Record<string, unknown>> {
    const result = await new PinkTimeoutService(this.container, this.env).expireGroup(
      message.pinkId,
      Math.floor(message.scheduledAt / 1_000),
    );
    return {
      event: "scheduled_pink_timeout_processed",
      job: message.job,
      runId: message.runId,
      pinkId: message.pinkId,
      ...result,
    };
  }

  private async dispatchPaymentOutbox(
    message: ScheduledMaintenanceMessage,
  ): Promise<Record<string, unknown>> {
    const result = await new OrderOutboxService(this.container, this.env).dispatchPending(
      SCHEDULED_OUTBOX_PAGE_SIZE,
    );
    const hasMore = result.claimed === SCHEDULED_OUTBOX_PAGE_SIZE;
    if (hasMore) {
      await this.sendContinuation(message, message.cursor + result.claimed);
    }
    return {
      event: "scheduled_payment_outbox_dispatch",
      job: message.job,
      runId: message.runId,
      cursor: message.cursor,
      hasMore,
      ...result,
    };
  }

  private async dispatchNotificationDeliveries(
    message: ScheduledMaintenanceMessage,
  ): Promise<Record<string, unknown>> {
    const result = await new OrderNotificationDeliveryService(this.container, this.env)
      .dispatchPending(SCHEDULED_OUTBOX_PAGE_SIZE);
    const hasMore = result.claimed === SCHEDULED_OUTBOX_PAGE_SIZE;
    if (hasMore) await this.sendContinuation(message, message.cursor + result.claimed);
    return {
      event: "scheduled_notification_delivery_dispatch",
      job: message.job,
      runId: message.runId,
      cursor: message.cursor,
      hasMore,
      ...result,
    };
  }

  private async dispatchPrintJobs(
    message: ScheduledMaintenanceMessage,
  ): Promise<Record<string, unknown>> {
    const result = await new ReceiptPrintJobService(this.container, this.env)
      .dispatchPending(SCHEDULED_OUTBOX_PAGE_SIZE);
    const hasMore = result.claimed === SCHEDULED_OUTBOX_PAGE_SIZE;
    if (hasMore) await this.sendContinuation(message, message.cursor + result.claimed);
    return {
      event: "scheduled_print_job_dispatch",
      job: message.job,
      runId: message.runId,
      cursor: message.cursor,
      hasMore,
      ...result,
    };
  }

  private async dispatchWaybillJobs(
    message: ScheduledMaintenanceMessage,
  ): Promise<Record<string, unknown>> {
    const result = await new OrderWaybillJobService(this.container, this.env)
      .dispatchPending(SCHEDULED_OUTBOX_PAGE_SIZE);
    const hasMore = result.claimed === SCHEDULED_OUTBOX_PAGE_SIZE;
    if (hasMore) await this.sendContinuation(message, message.cursor + result.claimed);
    return {
      event: "scheduled_waybill_job_dispatch",
      job: message.job,
      runId: message.runId,
      cursor: message.cursor,
      hasMore,
      ...result,
    };
  }

  private async scanOrders(
    message: ScheduledMaintenanceMessage,
  ): Promise<Record<string, unknown>> {
    if (!isScheduledOrderJob(message.job) || message.job === "unpaid_order_cancel") {
      throw new Error(`Unsupported scheduled order job: ${message.job}`);
    }
    const job = message.job;
    const threshold = await this.resolveThreshold(message, job);
    if (threshold === null) {
      return {
        event: "scheduled_order_scan_disabled",
        job,
        runId: message.runId,
      };
    }

    const candidates = await this.findEligibleOrders(
      job,
      threshold,
      message.cursor,
      SCHEDULED_ORDER_PAGE_SIZE,
    );
    const nextCursor = candidates.at(-1)?.id ?? message.cursor;
    const hasMore = candidates.length === SCHEDULED_ORDER_PAGE_SIZE;
    const work: OrderMessage[] = candidates.map((candidate) => ({
      action: "processScheduledOrder",
      job,
      runId: message.runId,
      scheduledAt: message.scheduledAt,
      orderId: candidate.id,
      threshold,
    }));
    if (hasMore) {
      work.push({ ...message, cursor: nextCursor, threshold });
    }
    if (work.length) await sendOrderMessages(this.env, work);

    return {
      event: "scheduled_order_scan",
      job,
      runId: message.runId,
      cursor: message.cursor,
      nextCursor,
      candidates: candidates.length,
      hasMore,
    };
  }

  private async scanUnpaidOrders(
    message: ScheduledMaintenanceMessage,
  ): Promise<Record<string, unknown>> {
    const config = await new SystemConfigService(this.container, this.env).getMany([
      "order_cancel_time",
      "order_activity_time",
      "order_pink_time",
    ]);
    const normalHours = configHours(config.order_cancel_time, 1);
    const activityHours = configHours(config.order_activity_time, 1);
    const configuredPinkHours = configHours(config.order_pink_time, 0);
    const pinkHours = configuredPinkHours > 0 ? configuredPinkHours : activityHours;
    const scheduledSeconds = Math.floor(message.scheduledAt / 1_000);
    const candidates = await this.container.db
      .select({
        id: storeOrder.id,
        type: storeOrder.type,
        addTime: storeOrder.addTime,
      })
      .from(storeOrder)
      .where(
        and(
          gt(storeOrder.id, message.cursor),
          eq(storeOrder.pid, 0),
          eq(storeOrder.paid, 0),
          eq(storeOrder.status, 0),
          eq(storeOrder.isDel, 0),
        ),
      )
      .orderBy(asc(storeOrder.id))
      .limit(SCHEDULED_ORDER_PAGE_SIZE);
    const work: OrderMessage[] = [];
    for (const order of candidates) {
      const hours = order.type === 0
        ? normalHours
        : order.type === 3
          ? pinkHours
          : activityHours;
      if (hours <= 0) continue;
      const threshold = scheduledSeconds - Math.ceil(hours * 3600);
      if (order.addTime <= threshold) {
        work.push({
          action: "processScheduledOrder",
          job: "unpaid_order_cancel",
          runId: message.runId,
          scheduledAt: message.scheduledAt,
          orderId: order.id,
          threshold,
        });
      }
    }
    const nextCursor = candidates.at(-1)?.id ?? message.cursor;
    const hasMore = candidates.length === SCHEDULED_ORDER_PAGE_SIZE;
    if (hasMore) work.push({ ...message, cursor: nextCursor, threshold: null });
    if (work.length) await sendOrderMessages(this.env, work);
    return {
      event: "scheduled_unpaid_order_scan",
      job: message.job,
      runId: message.runId,
      cursor: message.cursor,
      nextCursor,
      candidates: candidates.length,
      enqueued: work.length - (hasMore ? 1 : 0),
      hasMore,
    };
  }

  private async scanPinkTimeouts(
    message: ScheduledMaintenanceMessage,
  ): Promise<Record<string, unknown>> {
    const candidates = await this.container.db
      .select({ id: storePink.id })
      .from(storePink)
      .where(
        and(
          gt(storePink.id, message.cursor),
          eq(storePink.kId, 0),
          or(
            and(
              eq(storePink.status, 1),
              eq(storePink.isRefund, 0),
              or(
                lte(storePink.stopTime, new Date(message.scheduledAt)),
                sql`${storePink.stopTime} IS NULL`,
              ),
            ),
            and(
              inArray(storePink.status, [1, 2]),
              eq(storePink.isRefund, 0),
              sql`NOT EXISTS (
                SELECT 1
                FROM store_pink participant
                JOIN store_order backing
                  ON backing.uid = participant.uid
                 AND backing.type = 3
                 AND backing.activity_id = participant.combination_id
                 AND backing.paid = 1
                 AND (
                   (participant.order_id <> '' AND backing.order_id = participant.order_id)
                   OR (
                     participant.order_id_key <> ''
                     AND (
                       backing.unique = participant.order_id_key
                       OR backing.id::text = participant.order_id_key
                     )
                   )
                 )
                WHERE (participant.id = ${storePink.id} OR participant.k_id = ${storePink.id})
                  AND participant.is_virtual = 0
                  AND participant.is_refund = 0
              )`,
            ),
            and(
              eq(storePink.status, 3),
              sql`EXISTS (
                SELECT 1
                FROM store_pink participant
                JOIN store_order backing
                  ON backing.uid = participant.uid
                 AND backing.type = 3
                 AND backing.activity_id = participant.combination_id
                 AND backing.paid = 1
                 AND (
                   (participant.order_id <> '' AND backing.order_id = participant.order_id)
                   OR (
                     participant.order_id_key <> ''
                     AND (
                       backing.unique = participant.order_id_key
                       OR backing.id::text = participant.order_id_key
                     )
                   )
                 )
                WHERE (participant.id = ${storePink.id} OR participant.k_id = ${storePink.id})
                  AND participant.is_virtual = 0
                  AND backing.refund_status <> 2
              )`,
            ),
          ),
        ),
      )
      .orderBy(asc(storePink.id))
      .limit(SCHEDULED_PINK_PAGE_SIZE);
    const work: OrderMessage[] = candidates.map((candidate) => ({
      action: "processPinkTimeout" as const,
      job: "pink_timeout" as const,
      runId: message.runId,
      scheduledAt: message.scheduledAt,
      pinkId: candidate.id,
    }));
    const nextCursor = candidates.at(-1)?.id ?? message.cursor;
    const hasMore = candidates.length === SCHEDULED_PINK_PAGE_SIZE;
    if (hasMore) work.push({ ...message, cursor: nextCursor, threshold: null });
    if (work.length) await sendOrderMessages(this.env, work);
    return {
      event: "scheduled_pink_timeout_scan",
      job: message.job,
      runId: message.runId,
      cursor: message.cursor,
      nextCursor,
      candidates: candidates.length,
      hasMore,
    };
  }

  private async reconcileRefunds(
    message: ScheduledMaintenanceMessage,
  ): Promise<Record<string, unknown>> {
    const result = await new StoreOrderRefundService(
      this.container,
      this.env,
    ).reconcilePendingRefunds(SCHEDULED_REFUND_PAGE_SIZE, message.cursor);
    if (result.hasMore) {
      await this.sendContinuation(message, result.nextCursor);
    }
    return {
      event: "scheduled_refund_reconciliation",
      job: message.job,
      runId: message.runId,
      cursor: message.cursor,
      ...result,
    };
  }

  private async resolveThreshold(
    message: ScheduledMaintenanceMessage,
    job: FulfillmentOrderJob,
  ): Promise<number | null> {
    if (message.threshold !== null) return message.threshold;
    const configuredDays = parseConfigInteger(
      await new SystemConfigService(this.container, this.env).get(CONFIG_KEYS[job]),
      0,
    );
    if (configuredDays <= 0) return null;
    const scheduledSeconds = Math.floor(message.scheduledAt / 1_000);
    return Math.max(0, scheduledSeconds - configuredDays * 86_400);
  }

  private async findEligibleOrders(
    job: FulfillmentOrderJob,
    threshold: number,
    cursor: number,
    limit: number,
    orderId?: number,
  ): Promise<Array<{ id: number }>> {
    const statusTypes = STATUS_TYPES[job];
    const conditions: SQL[] = [
      orderId === undefined ? gt(storeOrder.id, cursor) : eq(storeOrder.id, orderId),
      eq(storeOrder.paid, 1),
      eq(storeOrder.status, job === "auto_receipt" ? 1 : 2),
      eq(storeOrder.isDel, 0),
      ne(storeOrder.pid, -1),
      ne(storeOrder.supplierAllocationStatus, 1),
      inArray(storeOrder.refundStatus, [0, 3]),
      sql`EXISTS (
        SELECT 1
        FROM ${storeOrderStatus}
        WHERE ${storeOrderStatus.oid} = ${storeOrder.id}
          AND ${storeOrderStatus.changeType} IN (${sql.join(
            statusTypes.map((type) => sql`${type}`),
            sql`, `,
          )})
          AND ${storeOrderStatus.changeTime} < ${threshold}
      )`,
    ];
    if (job === "auto_receipt") {
      conditions.push(ne(storeOrder.deliveryType, "send"));
    }
    return this.container.db
      .select({ id: storeOrder.id })
      .from(storeOrder)
      .where(and(...conditions))
      .orderBy(asc(storeOrder.id))
      .limit(Math.max(1, Math.min(Math.trunc(limit), SCHEDULED_ORDER_PAGE_SIZE)));
  }

  private async sendContinuation(
    message: ScheduledMaintenanceMessage,
    cursor: number,
  ): Promise<void> {
    await this.env.ORDER_QUEUE.send(
      { ...message, cursor },
      { contentType: "json" },
    );
  }
}

function configHours(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

async function sendOrderMessages(env: Env, messages: OrderMessage[]): Promise<void> {
  if (!messages.length) return;
  await env.ORDER_QUEUE.sendBatch(
    messages.map((body) => ({ body, contentType: "json" as const })),
  );
}
