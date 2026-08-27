import type { OrderMessage } from "@/env";
import {
  isOrderNotificationOutboxMessage,
  isOrderPaidOutboxMessage,
  type OrderOutboxService,
} from "@/services/order/OrderOutboxService";

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
  try {
    const result = await processor.processMessage(message.body);
    if (result === "busy") {
      const delaySeconds = paymentOutboxQueueRetryDelaySeconds(message.attempts);
      console.log(JSON.stringify({
        event: "payment_outbox_busy",
        outboxId: message.body.outboxId,
        queueAttempt: message.attempts,
        retryDelaySeconds: delaySeconds,
      }));
      message.retry({ delaySeconds });
      return;
    }
    console.log(JSON.stringify({
      event: "payment_outbox_consumed",
      outboxId: message.body.outboxId,
      result,
      queueAttempt: message.attempts,
    }));
    message.ack();
  } catch (error) {
    const delaySeconds = paymentOutboxQueueRetryDelaySeconds(message.attempts);
    console.error(JSON.stringify({
      event: "payment_outbox_consume_failed",
      outboxId: message.body.outboxId,
      queueAttempt: message.attempts,
      retryDelaySeconds: delaySeconds,
      error: error instanceof Error ? error.message : String(error),
    }));
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
  try {
    const result = await processor.processMessage(message.body);
    if (result === "busy") {
      const delaySeconds = paymentOutboxQueueRetryDelaySeconds(message.attempts);
      console.log(JSON.stringify({
        event: "order_notification_outbox_busy",
        outboxId: message.body.outboxId,
        queueAttempt: message.attempts,
        retryDelaySeconds: delaySeconds,
      }));
      message.retry({ delaySeconds });
      return;
    }
    console.log(JSON.stringify({
      event: "order_notification_outbox_consumed",
      outboxId: message.body.outboxId,
      result,
      queueAttempt: message.attempts,
    }));
    message.ack();
  } catch (error) {
    const delaySeconds = paymentOutboxQueueRetryDelaySeconds(message.attempts);
    console.error(JSON.stringify({
      event: "order_notification_outbox_consume_failed",
      outboxId: message.body.outboxId,
      queueAttempt: message.attempts,
      retryDelaySeconds: delaySeconds,
      error: error instanceof Error ? error.message : String(error),
    }));
    message.retry({ delaySeconds });
  }
}
