import type { OrderMessage } from "@/env";
import {
  isOrderNotificationOutboxMessage,
  isOrderPaidOutboxMessage,
  type OrderOutboxService,
} from "@/services/order/OrderOutboxService";
import { emitOperationalEvent, operationalErrorCode } from "@/utils/observability";

type OrderPaidOutboxProcessor = Pick<OrderOutboxService, "processMessage">;
type OrderPaidOutboxQueueMessage = Pick<
  Message<OrderMessage>,
  "body" | "attempts" | "ack" | "retry"
>;

export function paymentOutboxQueueRetryDelaySeconds(attempts: number): number {
  return Math.min(30 * 2 ** Math.max(Math.trunc(attempts) - 1, 0), 900);
}

/** Consume one payment outbox delivery with the same retry contract in every Worker entrypoint. */
export async function consumeOrderPaidOutboxQueueMessage(
  message: OrderPaidOutboxQueueMessage,
  processor: OrderPaidOutboxProcessor,
): Promise<void> {
  if (!isOrderPaidOutboxMessage(message.body)) {
    throw new Error("Queue message is not a payment outbox event");
  }
  const startedAt = Date.now();
  try {
    const result = await processor.processMessage(message.body);
    if (result === "busy") {
      const delaySeconds = paymentOutboxQueueRetryDelaySeconds(message.attempts);
      emitOperationalEvent("warn", {
        event: "payment_outbox_busy",
        component: "payment",
        operation: "outbox_consume",
        outcome: "retry",
        durationMs: Date.now() - startedAt,
        queueAttempt: message.attempts,
        retryDelaySeconds: delaySeconds,
      });
      message.retry({ delaySeconds });
      return;
    }
    emitOperationalEvent("info", {
      event: "payment_outbox_consumed",
      component: "payment",
      operation: "outbox_consume",
      outcome: "success",
      result,
      durationMs: Date.now() - startedAt,
      queueAttempt: message.attempts,
    });
    message.ack();
  } catch (error) {
    const delaySeconds = paymentOutboxQueueRetryDelaySeconds(message.attempts);
    emitOperationalEvent("error", {
      event: "payment_outbox_consume_failed",
      component: "payment",
      operation: "outbox_consume",
      outcome: "retry",
      durationMs: Date.now() - startedAt,
      queueAttempt: message.attempts,
      retryDelaySeconds: delaySeconds,
      errorCode: operationalErrorCode(error),
    });
    message.retry({ delaySeconds });
  }
}

/** Consume a delivery/refund notification event with the same bounded retry policy. */
export async function consumeOrderNotificationOutboxQueueMessage(
  message: OrderPaidOutboxQueueMessage,
  processor: OrderPaidOutboxProcessor,
): Promise<void> {
  if (!isOrderNotificationOutboxMessage(message.body)) {
    throw new Error("Queue message is not an order notification outbox event");
  }
  const startedAt = Date.now();
  try {
    const result = await processor.processMessage(message.body);
    if (result === "busy") {
      const delaySeconds = paymentOutboxQueueRetryDelaySeconds(message.attempts);
      emitOperationalEvent("warn", {
        event: "order_notification_outbox_busy",
        component: "queue",
        operation: "notification_outbox",
        outcome: "retry",
        durationMs: Date.now() - startedAt,
        queueAttempt: message.attempts,
        retryDelaySeconds: delaySeconds,
      });
      message.retry({ delaySeconds });
      return;
    }
    emitOperationalEvent("info", {
      event: "order_notification_outbox_consumed",
      component: "queue",
      operation: "notification_outbox",
      outcome: "success",
      result,
      durationMs: Date.now() - startedAt,
      queueAttempt: message.attempts,
    });
    message.ack();
  } catch (error) {
    const delaySeconds = paymentOutboxQueueRetryDelaySeconds(message.attempts);
    emitOperationalEvent("error", {
      event: "order_notification_outbox_consume_failed",
      component: "queue",
      operation: "notification_outbox",
      outcome: "retry",
      durationMs: Date.now() - startedAt,
      queueAttempt: message.attempts,
      retryDelaySeconds: delaySeconds,
      errorCode: operationalErrorCode(error),
    });
    message.retry({ delaySeconds });
  }
}
