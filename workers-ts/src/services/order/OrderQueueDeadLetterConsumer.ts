import type { OrderQueueDeadLetterService } from "@/services/order/OrderQueueDeadLetterService";
import { emitOperationalEvent, operationalErrorCode } from "@/utils/observability";

type DeadLetterArchiver = Pick<OrderQueueDeadLetterService, "archive">;
type DeadLetterMessage = Pick<Message<unknown>, "id" | "timestamp" | "body" | "attempts" | "ack" | "retry">;

export function deadLetterArchiveRetryDelaySeconds(attempts: number): number {
  return Math.min(30 * 2 ** Math.max(Math.trunc(attempts) - 1, 0), 900);
}

/** Persist one DLQ message before acknowledging it; database failure always requests redelivery. */
export async function consumeOrderQueueDeadLetterMessage(
  queueName: string,
  message: DeadLetterMessage,
  archiver: DeadLetterArchiver,
): Promise<void> {
  const startedAt = Date.now();
  try {
    const archived = await archiver.archive(queueName, message);
    emitOperationalEvent("error", {
      event: "order_queue_dead_letter_archived",
      component: "dlq",
      operation: "archive",
      outcome: "failure",
      result: archived.status.toLowerCase(),
      duplicate: archived.duplicate,
      messageType: archived.messageType,
      durationMs: Date.now() - startedAt,
      queueAttempt: message.attempts,
    });
    message.ack();
  } catch (error) {
    const delaySeconds = deadLetterArchiveRetryDelaySeconds(message.attempts);
    emitOperationalEvent("error", {
      event: "order_queue_dead_letter_archive_failed",
      component: "dlq",
      operation: "archive",
      outcome: "retry",
      durationMs: Date.now() - startedAt,
      queueAttempt: message.attempts,
      retryDelaySeconds: delaySeconds,
      errorCode: operationalErrorCode(error),
    });
    message.retry({ delaySeconds });
  }
}
