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
import { consumeOrderPaidOutboxQueueMessage } from "../../src/services/order/OrderPaidOutboxQueueConsumer";

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

  it("turns one Cron event into thirteen replayable root Queue jobs without touching PostgreSQL", async () => {
    const scheduledTime = new Date("2026-08-09T12:00:00.000Z");
    const controller = createScheduledController({
      scheduledTime,
      cron: "*/5 * * * *",
    });
    const ctx = createExecutionContext();
    const messages: OrderMessage[] = [];
    const runtimeEnv = {
      ...testEnv,
      ORDER_QUEUE: {
        async send(body: OrderMessage) { messages.push(body); },
        async sendBatch(batch: MessageSendRequest<OrderMessage>[]) {
          messages.push(...batch.map((message) => message.body));
        },
      },
    } as unknown as Env;

    await worker.scheduled(controller, runtimeEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(messages).toHaveLength(13);
    expect(messages.filter((message) => message.action === "runScheduledMaintenance"))
      .toHaveLength(11);
    expect(messages.map((message) => message.action).sort()).toEqual([
      "dispatchWorkCallbackOutbox",
      "dispatchWorkContactActions",
      ...Array.from({ length: 11 }, () => "runScheduledMaintenance"),
    ].sort());
    expect(messages.every((message) => "scheduledAt" in message
      && message.scheduledAt === scheduledTime.getTime())).toBe(true);
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

  it("marks a failed outbox delivery for retry without acknowledging it", async () => {
    const ctx = createExecutionContext();
    const batch = createMessageBatch<OrderMessage>(QUEUE_NAME, [
      {
        id: "outbox-message",
        timestamp: new Date("2026-08-09T12:00:00.000Z"),
        attempts: 1,
        body: {
          action: "processOrderPaidOutbox",
          outboxId: 42,
          eventKey: "order.paid:42",
        },
      },
    ]);

    await consumeOrderPaidOutboxQueueMessage(batch.messages[0], {
      processMessage: async () => { throw new Error("runtime_postgres_unavailable"); },
    });
    const result = await getQueueResult(batch, ctx);

    expect(result.explicitAcks).toEqual([]);
    // The current Cloudflare test helper exposes the retry marker but not the
    // per-message delay. The exact bounded delay contract is covered by the
    // OrderPaidOutboxQueueConsumer unit tests.
    expect(result.retryMessages).toEqual([{ msgId: "outbox-message" }]);
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

describe("Scan-login Durable Object state", () => {
  it("lets only the scanning uid reject and invalidate a pending approval", async () => {
    const stub = testEnv.TOKEN_BUCKET.getByName("scan-login:runtime-rejection");
    const now = Math.floor(Date.now() / 1000);
    const pollTokenHash = "b".repeat(64);
    await expect(stub.createScanLoginChallenge({
      version: 1,
      audience: "pc_user",
      stage: "pending",
      pollTokenHash,
      issuedAt: now,
      expiresAt: now + 600,
      clientOrigin: "https://runtime-test.invalid",
      clientDevice: "Test · Browser",
      target: "CinaShop PC 商城",
    })).resolves.toBe(true);
    await expect(stub.markScanLoginChallengeScanned(17)).resolves.toMatchObject({
      stage: "scanned",
      scannedUid: 17,
    });
    await expect(stub.rejectScanLoginChallenge(18)).resolves.toBeNull();
    await expect(stub.rejectScanLoginChallenge(17)).resolves.toMatchObject({
      stage: "scanned",
      scannedUid: 17,
    });
    await expect(stub.getScanLoginChallenge()).resolves.toBeNull();
    await expect(stub.pollScanLoginChallenge(pollTokenHash, "pc_user")).resolves
      .toEqual({ status: 0 });
  });

  it("binds, approves, audience-checks, and redelivers one fixed token", async () => {
    const stub = testEnv.TOKEN_BUCKET.getByName("scan-login:runtime-contract");
    const now = Math.floor(Date.now() / 1000);
    const pollTokenHash = "a".repeat(64);
    await expect(stub.createScanLoginChallenge({
      version: 1,
      audience: "kefu_agent",
      stage: "pending",
      pollTokenHash,
      issuedAt: now,
      expiresAt: now + 600,
      clientOrigin: "https://runtime-test.invalid",
      clientDevice: "Test · Browser",
      target: "CinaShop 客服工作台",
    })).resolves.toBe(true);

    const pending = await stub.getScanLoginChallenge();
    expect(pending).toMatchObject({ audience: "kefu_agent", stage: "pending" });
    expect(pending).not.toHaveProperty("pollTokenHash");
    await expect(stub.markScanLoginChallengeScanned(17)).resolves.toMatchObject({
      stage: "scanned",
      scannedUid: 17,
    });
    await expect(stub.markScanLoginChallengeScanned(18)).resolves.toBeNull();
    await expect(stub.pollScanLoginChallenge(pollTokenHash, "kefu_agent")).resolves
      .toMatchObject({ status: 1, audience: "kefu_agent" });
    await expect(stub.approveScanLoginChallenge(18, 9)).resolves.toBeNull();
    await expect(stub.approveScanLoginChallenge(17, 9)).resolves.toMatchObject({
      stage: "approved",
    });
    await expect(stub.pollScanLoginChallenge(pollTokenHash, "pc_user")).resolves
      .toEqual({ status: 0 });
    const claim = await stub.pollScanLoginChallenge(pollTokenHash, "kefu_agent");
    expect(claim).toMatchObject({ status: 4, uid: 17, kefuId: 9 });
    if (claim.status !== 4) throw new Error("issuance claim missing");
    await expect(stub.pollScanLoginChallenge(pollTokenHash, "kefu_agent")).resolves
      .toMatchObject({ status: 1, audience: "kefu_agent" });
    const kefuInfo = {
      id: 9,
      uid: 17,
      account: "service-17",
      avatar: "",
      nickname: "客服 17",
      phone: "",
      online: 0,
    };
    await expect(stub.completeScanLoginChallenge(
      claim.lease,
      "fixed-runtime-token",
      now + 3600,
      kefuInfo,
    )).resolves.toEqual({
      status: 3,
      token: "fixed-runtime-token",
      exp_time: now + 3600,
      kefuInfo,
    });
    await expect(stub.pollScanLoginChallenge(pollTokenHash, "kefu_agent")).resolves
      .toEqual({
        status: 3,
        token: "fixed-runtime-token",
        exp_time: now + 3600,
        kefuInfo,
      });
  });
});
