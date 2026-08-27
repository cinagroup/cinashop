import type { OrderQueueDeadLetterService } from "@/services/order/OrderQueueDeadLetterService";

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
  try {
    const archived = await archiver.archive(queueName, message);
    console.error(JSON.stringify({
      event: "order_queue_dead_letter_archived",
      queue: queueName,
      messageId: message.id,
      queueAttempt: message.attempts,
      ...archived,
    }));
    message.ack();
  } catch (error) {
    const delaySeconds = deadLetterArchiveRetryDelaySeconds(message.attempts);
    console.error(JSON.stringify({
      event: "order_queue_dead_letter_archive_failed",
      queue: queueName,
      messageId: message.id,
      queueAttempt: message.attempts,
      retryDelaySeconds: delaySeconds,
      error: error instanceof Error ? error.message : String(error),
    }));
    message.retry({ delaySeconds });
  }
}
