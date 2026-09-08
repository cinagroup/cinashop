import { env } from "cloudflare:workers";
import { createExecutionContext, createMessageBatch, getQueueResult, reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import type { Env, OrderMessage, ScheduledMaintenanceMessage } from "../../src/env";
import { PinkCancellationRecoveryService } from "../../src/services/activity/PinkCancellationRecoveryService";

afterEach(async () => { await reset(); vi.restoreAllMocks(); });

describe("recovery scan failures through actual workerd Queue handler", () => {
  it("continues an empty recent window and retries the original cursor if continuation delivery fails", async () => {
    const recovery = vi.spyOn(PinkCancellationRecoveryService.prototype, "recoverPage")
      .mockResolvedValue({ checked: 0, completed: 0, pending: 0, attention: 0, errors: 0,
        nextCursor: 1020, hasMore: true, highWater: 5000, examined: 1000 });
    const bindings: Env = env as Env;
    const send = vi.spyOn(bindings.ORDER_QUEUE, "send").mockRejectedValueOnce(new Error("isolated queue delivery failure"));
    const body: ScheduledMaintenanceMessage = { action: "runScheduledMaintenance", job: "pink_cancellation_recovery",
      runId: "scheduled:1786276800000", scheduledAt: 1786276800000, cursor: 20, threshold: 5000 };
    const ctx = createExecutionContext();
    for (const attempts of [1, 2]) {
      const id = `window-${attempts}`;
      const batch = createMessageBatch<OrderMessage>("cinashop-order-runtime-test", [{
        id, timestamp: new Date(body.scheduledAt), attempts, body,
      }]);
      await worker.queue(batch, bindings);
      const result = await getQueueResult(batch, ctx);
      expect(result.explicitAcks).toEqual(attempts === 1 ? [] : [id]);
      expect(result.retryMessages).toEqual(attempts === 1 ? [{ msgId: id }] : []);
      expect(recovery).toHaveBeenNthCalledWith(attempts, 20, body.scheduledAt, 5000);
      expect(send).toHaveBeenNthCalledWith(attempts, { ...body, cursor: 1020 }, { contentType: "json" });
    }
  });

  it.each(["55P03", "57014"])("retries SQL error %s without ack or continuation, then acknowledges successful replay", async code => {
    // SQL cancellation itself is exercised against PG16. This boundary test
    // supplies that error to the real maintenance + Worker Queue dispatch path.
    const recovery = vi.spyOn(PinkCancellationRecoveryService.prototype, "recoverPage")
      .mockRejectedValueOnce(new Error("isolated scan failure", { cause: Object.assign(new Error("database deadline"), { code }) }))
      .mockResolvedValueOnce({ checked: 0, completed: 0, pending: 0, attention: 0, errors: 0,
        nextCursor: 20, hasMore: false, highWater: 100, examined: 0 });
    const bindings: Env = env as Env;
    const send = vi.spyOn(bindings.ORDER_QUEUE, "send");
    const body: ScheduledMaintenanceMessage = { action: "runScheduledMaintenance", job: "pink_cancellation_recovery",
      runId: "scheduled:1786276800000", scheduledAt: 1786276800000, cursor: 20, threshold: 100 };
    const ctx = createExecutionContext();
    const batch = createMessageBatch<OrderMessage>("cinashop-order-runtime-test", [{
      id: "scan-failure", timestamp: new Date(body.scheduledAt), attempts: 1, body,
    }]);
    await worker.queue(batch, bindings);
    const failed = await getQueueResult(batch, ctx);
    expect(failed.explicitAcks).toEqual([]);
    expect(failed.retryMessages).toEqual([{ msgId: "scan-failure" }]);
    expect(send).not.toHaveBeenCalled();
    expect(recovery).toHaveBeenNthCalledWith(1, 20, body.scheduledAt, 100);

    const replay = createMessageBatch<OrderMessage>("cinashop-order-runtime-test", [{
      id: "scan-replay", timestamp: new Date(body.scheduledAt), attempts: 2, body,
    }]);
    await worker.queue(replay, bindings);
    const succeeded = await getQueueResult(replay, ctx);
    expect(succeeded.explicitAcks).toEqual(["scan-replay"]);
    expect(succeeded.retryMessages).toEqual([]);
    expect(recovery).toHaveBeenNthCalledWith(2, 20, body.scheduledAt, 100);
    expect(send).not.toHaveBeenCalled();
  });
});
