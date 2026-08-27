import { describe, expect, it, vi } from "vitest";
import type { OrderPaidOutboxMessage } from "../src/env";
import {
  consumeOrderPaidOutboxQueueMessage,
  paymentOutboxQueueRetryDelaySeconds,
} from "../src/services/order/OrderPaidOutboxQueueConsumer";

function makeMessage(attempts: number) {
  const body: OrderPaidOutboxMessage = {
    action: "processOrderPaidOutbox",
    outboxId: 7,
    eventKey: "order.paid:42",
  };
  return {
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

describe("payment outbox queue consumer", () => {
  it("acknowledges a successfully processed event", async () => {
    const message = makeMessage(1);
    const processor = {
      processMessage: vi.fn().mockResolvedValue("completed"),
    };

    await consumeOrderPaidOutboxQueueMessage(message, processor);

    expect(processor.processMessage).toHaveBeenCalledWith(message.body);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("retries a duplicate delivery while another consumer owns the processing lease", async () => {
    const message = makeMessage(2);
    const processor = {
      processMessage: vi.fn().mockResolvedValue("busy"),
    };

    await consumeOrderPaidOutboxQueueMessage(message, processor);

    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
  });

  it("retries a failed event with bounded exponential delay", async () => {
    const message = makeMessage(3);
    const processor = {
      processMessage: vi.fn().mockRejectedValue(new Error("transient")),
    };

    await consumeOrderPaidOutboxQueueMessage(message, processor);

    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
  });

  it("caps retry delay at fifteen minutes", () => {
    expect(paymentOutboxQueueRetryDelaySeconds(1)).toBe(30);
    expect(paymentOutboxQueueRetryDelaySeconds(4)).toBe(240);
    expect(paymentOutboxQueueRetryDelaySeconds(99)).toBe(900);
  });
});
