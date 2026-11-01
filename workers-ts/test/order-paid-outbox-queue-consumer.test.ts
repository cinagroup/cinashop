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
    let committed=false;
    const processor = {
      processMessage: vi.fn(async()=>{committed=true;return 'completed' as const;}),
    };
    const notifications={dispatchPending:vi.fn(async(limit:number,key?:string)=>{
      expect(committed).toBe(true);expect(limit).toBe(10);expect(key).toBe(message.body.eventKey);
      return{claimed:1,enqueued:1,unknown:0};
    })};

    await consumeOrderPaidOutboxQueueMessage(message, processor,notifications);

    expect(processor.processMessage).toHaveBeenCalledWith(message.body);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(notifications.dispatchPending).toHaveBeenCalledOnce();
  });

  it("retries a duplicate delivery while another consumer owns the processing lease", async () => {
    const message = makeMessage(2);
    const processor = {
      processMessage: vi.fn().mockResolvedValue("busy"),
    };
    const notifications={dispatchPending:vi.fn()};

    await consumeOrderPaidOutboxQueueMessage(message, processor,notifications);

    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(notifications.dispatchPending).not.toHaveBeenCalled();
  });

  it("retries a failed event with bounded exponential delay", async () => {
    const message = makeMessage(3);
    const processor = {
      processMessage: vi.fn().mockRejectedValue(new Error("transient")),
    };
    const notifications={dispatchPending:vi.fn()};

    await consumeOrderPaidOutboxQueueMessage(message, processor,notifications);

    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
    expect(notifications.dispatchPending).not.toHaveBeenCalled();
  });

  it.each(['completed','already-completed'])('keeps %s acknowledged when only post-commit notification dispatch fails',async result=>{
    const message=makeMessage(1),processor={processMessage:vi.fn().mockResolvedValue(result)},
      notifications={dispatchPending:vi.fn().mockRejectedValue(Error('Owned Queue unavailable'))};
    await consumeOrderPaidOutboxQueueMessage(message,processor,notifications);
    expect(notifications.dispatchPending).toHaveBeenCalledWith(10,message.body.eventKey);
    expect(processor.processMessage).toHaveBeenCalledOnce();expect(message.ack).toHaveBeenCalledOnce();expect(message.retry).not.toHaveBeenCalled();
  });

  it.each(['dead','deferred'])('does not accelerate an uncommitted or terminal %s source',async result=>{
    const message=makeMessage(1),processor={processMessage:vi.fn().mockResolvedValue(result)},notifications={dispatchPending:vi.fn()};
    await consumeOrderPaidOutboxQueueMessage(message,processor,notifications);
    expect(notifications.dispatchPending).not.toHaveBeenCalled();expect(message.ack).toHaveBeenCalledOnce();expect(message.retry).not.toHaveBeenCalled();
  });

  it("caps retry delay at fifteen minutes", () => {
    expect(paymentOutboxQueueRetryDelaySeconds(1)).toBe(30);
    expect(paymentOutboxQueueRetryDelaySeconds(4)).toBe(240);
    expect(paymentOutboxQueueRetryDelaySeconds(99)).toBe(900);
  });
});
