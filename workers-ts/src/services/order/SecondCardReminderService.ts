import {
  and,
  asc,
  eq,
  gt,
  inArray,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type {
  Env,
  OrderMessage,
  ScheduledMaintenanceMessage,
  SecondCardReminderMessage,
} from "@/env";
import { withTx, type Container } from "@/lib/di";
import {
  storeOrder,
  storeOrderCartInfo,
  storeOrderOutbox,
} from "@/models/schema";
import { parseConfigInteger } from "@/utils/config";
import { emitOperationalEvent, operationalErrorCode } from "@/utils/observability";
import { SystemConfigService } from "@/services/system/SystemConfigService";
import {
  enqueueSecondCardNoticeEvent,
  orderSecondCardNoticeEventKey,
} from "@/services/order/OrderNotificationOutboxService";
import { OrderOutboxService } from "@/services/order/OrderOutboxService";

export const SECOND_CARD_REMINDER_JOB = "reminder_unverified_remind";
export const SECOND_CARD_REMINDER_PAGE_SIZE = 80;
export const SECOND_CARD_REMINDER_LOCK_NAMESPACE = 1_954_231_107;
const MAX_REMINDER_WINDOW_HOURS = 8_760;
const MAX_CART_SNAPSHOT_BYTES = 1_048_576;

export type SecondCardReminderResult =
  | "staged"
  | "already-staged"
  | "no-longer-eligible"
  | "order-ineligible";

interface SecondCardReminderProcessor {
  processMessage(message: SecondCardReminderMessage): Promise<SecondCardReminderResult>;
}

type SecondCardQueueMessage = Pick<
  Message<OrderMessage>,
  "body" | "attempts" | "ack" | "retry"
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function secondCardReminderWindowHours(value: string | undefined): number {
  const parsed = parseConfigInteger(value, 1);
  return parsed >= 0 && parsed <= MAX_REMINDER_WINDOW_HOURS ? parsed : 1;
}

export function isSecondCardReminderMessage(
  value: unknown,
): value is SecondCardReminderMessage {
  if (!isRecord(value)) return false;
  return value.action === "processSecondCardReminder"
    && value.job === SECOND_CARD_REMINDER_JOB
    && isPositiveSafeInteger(value.scheduledAt)
    && isPositiveSafeInteger(value.cartInfoId)
    && isPositiveSafeInteger(value.orderId)
    && isPositiveSafeInteger(value.writeEnd)
    && (value.kind === "advent" || value.kind === "expired")
    && typeof value.runId === "string"
    && value.runId === `scheduled:${value.scheduledAt}`;
}

export function secondCardReminderRetryDelaySeconds(attempts: number): number {
  const normalized = Math.max(1, Math.trunc(attempts));
  return Math.min(30 * 2 ** Math.min(normalized - 1, 5), 900);
}

export async function consumeSecondCardReminderQueueMessage(
  message: SecondCardQueueMessage,
  processor: SecondCardReminderProcessor,
): Promise<void> {
  if (!isSecondCardReminderMessage(message.body)) {
    throw new Error("Queue message is not a second-card reminder");
  }
  const startedAt = Date.now();
  try {
    const result = await processor.processMessage(message.body);
    emitOperationalEvent("info", {
      event: "second_card_reminder_consumed",
      component: "queue",
      operation: "second_card_reminder",
      outcome: "success",
      result,
      reminderKind: message.body.kind,
      durationMs: Date.now() - startedAt,
      queueAttempt: message.attempts,
    });
    message.ack();
  } catch (error) {
    const delaySeconds = secondCardReminderRetryDelaySeconds(message.attempts);
    emitOperationalEvent("error", {
      event: "second_card_reminder_failed",
      component: "queue",
      operation: "second_card_reminder",
      outcome: "retry",
      reminderKind: message.body.kind,
      durationMs: Date.now() - startedAt,
      queueAttempt: message.attempts,
      retryDelaySeconds: delaySeconds,
      errorCode: operationalErrorCode(error, "second_card_reminder_failed"),
    });
    message.retry({ delaySeconds });
  }
}

function productNameFromSnapshot(value: string | null): string {
  if (!value || value.length > MAX_CART_SNAPSHOT_BYTES) return "次卡商品";
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const candidates = [parsed.productInfo, parsed.product, parsed];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const record = candidate as Record<string, unknown>;
      const raw = typeof record.store_name === "string"
        ? record.store_name
        : typeof record.storeName === "string" ? record.storeName : "";
      const name = [...raw.trim()].slice(0, 10).join("");
      if (name) return name;
    }
  } catch {
    // Historical malformed snapshots still receive a generic, bounded notice.
  }
  return "次卡商品";
}

export class SecondCardReminderService implements SecondCardReminderProcessor {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  async scan(message: ScheduledMaintenanceMessage): Promise<Record<string, unknown>> {
    if (message.job !== SECOND_CARD_REMINDER_JOB) {
      throw new Error("unsupported_second_card_reminder_job");
    }
    const hours = secondCardReminderWindowHours(
      await new SystemConfigService(this.container, this.env)
        .get("reminder_deadline_second_card_time"),
    );
    const scheduledSeconds = Math.floor(message.scheduledAt / 1_000);
    const due: SQL[] = [
      and(
        eq(storeOrderCartInfo.isExpireSms, 0),
        lt(storeOrderCartInfo.writeEnd, scheduledSeconds),
      )!,
    ];
    if (hours > 0) {
      due.push(and(
        eq(storeOrderCartInfo.isAdventSms, 0),
        gt(storeOrderCartInfo.writeEnd, scheduledSeconds),
        sql`${storeOrderCartInfo.writeEnd} <= ${scheduledSeconds + hours * 3_600}`,
      )!);
    }
    const candidates = await this.container.db
      .select({
        cartInfoId: storeOrderCartInfo.id,
        orderId: storeOrder.id,
        writeEnd: storeOrderCartInfo.writeEnd,
        isExpireSms: storeOrderCartInfo.isExpireSms,
      })
      .from(storeOrderCartInfo)
      .innerJoin(storeOrder, and(
        eq(storeOrder.id, storeOrderCartInfo.oid),
        eq(storeOrder.uid, storeOrderCartInfo.uid),
      ))
      .where(and(
        gt(storeOrderCartInfo.id, message.cursor),
        eq(storeOrderCartInfo.productType, 4),
        eq(storeOrderCartInfo.isWriteoff, 0),
        gt(storeOrderCartInfo.writeStart, 0),
        gt(storeOrderCartInfo.writeEnd, 0),
        eq(storeOrder.paid, 1),
        eq(storeOrder.isDel, 0),
        eq(storeOrder.isSystemDel, 0),
        inArray(storeOrder.refundStatus, [0, 3]),
        or(...due),
      ))
      .orderBy(asc(storeOrderCartInfo.id))
      .limit(SECOND_CARD_REMINDER_PAGE_SIZE);
    const nextCursor = candidates.at(-1)?.cartInfoId ?? message.cursor;
    const hasMore = candidates.length === SECOND_CARD_REMINDER_PAGE_SIZE;
    const work: OrderMessage[] = candidates.map((candidate) => ({
      action: "processSecondCardReminder",
      job: SECOND_CARD_REMINDER_JOB,
      runId: message.runId,
      scheduledAt: message.scheduledAt,
      cartInfoId: candidate.cartInfoId,
      orderId: candidate.orderId,
      writeEnd: candidate.writeEnd,
      kind: candidate.writeEnd < scheduledSeconds && candidate.isExpireSms === 0
        ? "expired"
        : "advent",
    }));
    if (hasMore) work.push({ ...message, cursor: nextCursor });
    if (work.length) {
      await this.env.ORDER_QUEUE.sendBatch(
        work.map((body) => ({ body, contentType: "json" as const })),
      );
    }
    return {
      event: "scheduled_second_card_reminder_scan",
      job: message.job,
      runId: message.runId,
      cursor: message.cursor,
      nextCursor,
      candidates: candidates.length,
      hasMore,
      reminderWindowHours: hours,
    };
  }

  async processMessage(message: SecondCardReminderMessage): Promise<SecondCardReminderResult> {
    if (!isSecondCardReminderMessage(message)) {
      throw new Error("invalid_second_card_reminder_message");
    }
    const now = Math.floor(this.nowMs() / 1_000);
    const hours = secondCardReminderWindowHours(
      await new SystemConfigService(this.container, this.env)
        .get("reminder_deadline_second_card_time"),
    );
    const staged = await withTx(this.container, async (tx) => {
      await tx.execute(sql.raw("SET LOCAL lock_timeout = '2s'"));
      await tx.execute(sql.raw("SET LOCAL statement_timeout = '5s'"));
      await tx.execute(sql`SELECT pg_advisory_xact_lock(
        ${SECOND_CARD_REMINDER_LOCK_NAMESPACE}, ${message.cartInfoId}
      )`);
      const carts = await tx
        .select()
        .from(storeOrderCartInfo)
        .where(eq(storeOrderCartInfo.id, message.cartInfoId))
        .limit(1)
        .for("update");
      const cart = carts[0];
      if (
        !cart
        || cart.oid !== message.orderId
        || cart.writeEnd !== message.writeEnd
        || cart.productType !== 4
        || cart.isWriteoff !== 0
        || cart.writeStart <= 0
      ) {
        return { result: "no-longer-eligible" as const };
      }

      const flagAlreadySet = message.kind === "advent"
        ? cart.isAdventSms !== 0
        : cart.isExpireSms !== 0;
      if (flagAlreadySet) {
        const eventKey = orderSecondCardNoticeEventKey(
          message.kind,
          message.cartInfoId,
          message.writeEnd,
        );
        const events = await tx
          .select({ id: storeOrderOutbox.id, eventKey: storeOrderOutbox.eventKey })
          .from(storeOrderOutbox)
          .where(eq(storeOrderOutbox.eventKey, eventKey))
          .limit(1);
        return {
          result: "already-staged" as const,
          event: events[0],
        };
      }

      const temporallyEligible = message.kind === "expired"
        ? cart.writeEnd < now
        : hours > 0 && cart.writeEnd > now && cart.writeEnd <= now + hours * 3_600;
      if (!temporallyEligible) return { result: "no-longer-eligible" as const };

      const orders = await tx
        .select({
          id: storeOrder.id,
          uid: storeOrder.uid,
          orderId: storeOrder.orderId,
          payTime: storeOrder.payTime,
          paid: storeOrder.paid,
          isDel: storeOrder.isDel,
          isSystemDel: storeOrder.isSystemDel,
          refundStatus: storeOrder.refundStatus,
        })
        .from(storeOrder)
        .where(eq(storeOrder.id, message.orderId))
        .limit(1)
        .for("update");
      const order = orders[0];
      if (
        !order
        || order.uid !== cart.uid
        || order.paid !== 1
        || order.isDel !== 0
        || order.isSystemDel !== 0
        || ![0, 3].includes(order.refundStatus)
      ) {
        return { result: "order-ineligible" as const };
      }

      const event = await enqueueSecondCardNoticeEvent(tx, {
        orderId: order.id,
        orderNo: order.orderId,
        cartInfoId: cart.id,
        userId: order.uid,
        kind: message.kind,
        writeEnd: cart.writeEnd,
        payTime: order.payTime,
        storeName: productNameFromSnapshot(cart.cartInfo),
      }, now);
      const expectedFlag = message.kind === "advent"
        ? eq(storeOrderCartInfo.isAdventSms, 0)
        : eq(storeOrderCartInfo.isExpireSms, 0);
      const updated = await tx
        .update(storeOrderCartInfo)
        .set(message.kind === "advent" ? { isAdventSms: 1 } : { isExpireSms: 1 })
        .where(and(
          eq(storeOrderCartInfo.id, cart.id),
          eq(storeOrderCartInfo.oid, order.id),
          eq(storeOrderCartInfo.writeEnd, cart.writeEnd),
          eq(storeOrderCartInfo.isWriteoff, 0),
          expectedFlag,
        ))
        .returning({ id: storeOrderCartInfo.id });
      if (!updated[0]) throw new Error("次卡提醒状态发生并发变化");
      return { result: "staged" as const, event };
    });

    if (staged.event) {
      await new OrderOutboxService(this.container, this.env).dispatchById(staged.event.id);
    }
    return staged.result;
  }
}
