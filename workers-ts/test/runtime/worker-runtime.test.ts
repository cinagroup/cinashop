import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  evictDurableObject,
  getQueueResult,
  reset,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import type { Env, OrderMessage } from "../../src/env";

const testEnv = env as unknown as Env;
const QUEUE_NAME = "cinashop-order-runtime-test";
const SNOWFLAKE_EPOCH = Date.UTC(2020, 5, 5);
const SNOWFLAKE_SEQUENCE_MASK = (1n << 12n) - 1n;
const SNOWFLAKE_TIMESTAMP_SHIFT = 22n;

afterEach(async () => {
  await reset();
});

describe("Worker runtime bindings", () => {
  it("keeps KV writes inside the isolated workerd binding", async () => {
    await testEnv.CONFIG_KV.put("runtime:key", "local-value");

    await expect(testEnv.CONFIG_KV.get("runtime:key")).resolves.toBe("local-value");
  });

  it("turns one Cron event into four replayable root Queue jobs without touching PostgreSQL", async () => {
    const scheduledTime = new Date("2026-08-09T12:00:00.000Z");
    const controller = createScheduledController({
      scheduledTime,
      cron: "*/5 * * * *",
    });
    const ctx = createExecutionContext();

    await worker.scheduled(controller, testEnv, ctx);
    await waitOnExecutionContext(ctx);

    const metrics = await testEnv.ORDER_QUEUE.metrics();
    expect(metrics.backlogCount).toBe(4);
    expect(metrics.backlogBytes).toBeGreaterThan(0);
  });
});

describe("Queue acknowledgement and retry semantics", () => {
  it("explicitly acknowledges a recognized legacy message", async () => {
    const ctx = createExecutionContext();
    const batch = createMessageBatch<OrderMessage>(QUEUE_NAME, [
      {
        id: "legacy-message",
        timestamp: new Date("2026-08-09T12:00:00.000Z"),
        attempts: 1,
        body: { action: "compute", orderId: "wx-runtime", uid: 1 },
      },
    ]);

    await worker.queue(batch, testEnv);
    const result = await getQueueResult(batch, ctx);

    expect(result.explicitAcks).toEqual(["legacy-message"]);
    expect(result.retryMessages).toEqual([]);
  });

  it("requests a bounded retry when an outbox message cannot reach local PostgreSQL", async () => {
    const ctx = createExecutionContext();
    const batch = createMessageBatch<OrderMessage>(QUEUE_NAME, [
      {
        id: "outbox-message",
        timestamp: new Date("2026-08-09T12:00:00.000Z"),
        attempts: 1,
        body: {
          action: "processOrderPaidOutbox",
          outboxId: 42,
          eventKey: "runtime-test:42",
        },
      },
    ]);

    await worker.queue(batch, testEnv);
    const result = await getQueueResult(batch, ctx);

    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages).toEqual([
      { msgId: "outbox-message", delaySeconds: 30 },
    ]);
  });
});

describe("SequenceDO durability", () => {
  it("restores the persisted snowflake sequence after isolate eviction", async () => {
    const stub = testEnv.SEQUENCE.getByName("runtime-sequence");
    await stub.nextId();
    const futureTimestamp = Date.now() - SNOWFLAKE_EPOCH + 60_000;

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE sequence_state SET last_ts = ?, seq = ? WHERE singleton = 1",
        futureTimestamp,
        10,
      );
    });
    await evictDurableObject(stub);

    const next = BigInt(await stub.nextId());
    expect(Number(next >> SNOWFLAKE_TIMESTAMP_SHIFT)).toBe(futureTimestamp);
    expect(Number(next & SNOWFLAKE_SEQUENCE_MASK)).toBe(11);
  });

  it("serializes concurrent RPC allocations without duplicate IDs", async () => {
    const stub = testEnv.SEQUENCE.getByName("runtime-concurrency");
    const ids = await Promise.all(
      Array.from({ length: 64 }, () => stub.nextId()),
    );

    expect(new Set(ids).size).toBe(ids.length);
  });
});
