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
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import type { Env, OrderMessage } from "../../src/env";
import {
  type ChatSocketSession,
  KefuRealtimeService,
} from "../../src/services/kefu/KefuRealtimeService";
import { consumeOrderQueueDeadLetterMessage } from "../../src/services/order/OrderQueueDeadLetterConsumer";
import { consumeOrderPaidOutboxQueueMessage } from "../../src/services/order/OrderPaidOutboxQueueConsumer";
import { putConcatenatedR2Objects } from "../../src/services/system/AttachmentService";

const testEnv = env as unknown as Env;
const QUEUE_NAME = "cinashop-order-runtime-test";
const SNOWFLAKE_EPOCH = Date.UTC(2020, 5, 5);
const SNOWFLAKE_SEQUENCE_MASK = (1n << 12n) - 1n;
const SNOWFLAKE_TIMESTAMP_SHIFT = 22n;

afterEach(async () => {
  await reset();
  vi.restoreAllMocks();
});

describe("Worker runtime bindings", () => {
  it("keeps KV writes inside the isolated workerd binding", async () => {
    await testEnv.CONFIG_KV.put("runtime:key", "local-value");

    await expect(testEnv.CONFIG_KV.get("runtime:key")).resolves.toBe("local-value");
  });

  it("round-trips object data and metadata inside the isolated R2 binding", async () => {
    const key = "runtime/assets/object.txt";
    await testEnv.ASSETS_BUCKET.put(key, "runtime-r2-value", {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
      customMetadata: { scope: "runtime-test" },
    });

    const object = await testEnv.ASSETS_BUCKET.get(key);
    expect(object).not.toBeNull();
    await expect(object?.text()).resolves.toBe("runtime-r2-value");
    expect(object?.httpMetadata?.contentType).toBe("text/plain; charset=utf-8");
    expect(object?.customMetadata).toEqual({ scope: "runtime-test" });

    const listed = await testEnv.ASSETS_BUCKET.list({ prefix: "runtime/assets/" });
    expect(listed.objects.map((item) => item.key)).toContain(key);

    await testEnv.ASSETS_BUCKET.delete(key);
    await expect(testEnv.ASSETS_BUCKET.get(key)).resolves.toBeNull();
  });

  it("streams ordered temporary video chunks into one fixed-length R2 object", async () => {
    const first = "runtime/video/session/1.part";
    const second = "runtime/video/session/2.part";
    const destination = "runtime/video/final.mp4";
    await testEnv.ASSETS_BUCKET.put(first, "hello ");
    await testEnv.ASSETS_BUCKET.put(second, "world");

    const stored = await putConcatenatedR2Objects(
      testEnv.ASSETS_BUCKET,
      [first, second],
      destination,
      11,
      { httpMetadata: { contentType: "video/mp4" } },
    );

    expect(stored.size).toBe(11);
    const object = await testEnv.ASSETS_BUCKET.get(destination);
    await expect(object?.text()).resolves.toBe("hello world");
    expect(object?.httpMetadata?.contentType).toBe("video/mp4");
    const ranged = await testEnv.ASSETS_BUCKET.get(destination, { range: { offset: 6, length: 5 } });
    await expect(ranged?.text()).resolves.toBe("world");
    expect(ranged?.size).toBe(11);
    expect(ranged?.range).toEqual({ offset: 6, length: 5 });
    await testEnv.ASSETS_BUCKET.delete([first, second, destination]);
  });

  it("transforms private R2 image bytes through the isolated Images binding", async () => {
    const key = "runtime/assets/source.png";
    const encoded = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    await testEnv.ASSETS_BUCKET.put(key, bytes, { httpMetadata: { contentType: "image/png" } });
    const object = await testEnv.ASSETS_BUCKET.get(key);
    expect(object).not.toBeNull();
    const result = await testEnv.IMAGES.input(object!.body)
      .transform({ width: 1, height: 1 })
      .output({ format: "image/png" });
    const response = result.response();
    expect(response.headers.get("content-type")).toBe("image/png");
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
    await testEnv.ASSETS_BUCKET.delete(key);
  });

  it("turns a non-reminder Cron event into nineteen replayable root Queue jobs without touching PostgreSQL", async () => {
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

    expect(messages).toHaveLength(19);
    expect(messages.filter((message) => message.action === "runScheduledMaintenance"))
      .toHaveLength(12);
    expect(messages.map((message) => message.action).sort()).toEqual([
      "dispatchPaymentCallbackOutbox",
      "dispatchPaymentReconciliation",
      "dispatchMerchantShipmentCallbackOutbox",
      "dispatchCityDeliveryCallbacks",
      "dispatchWechatCallbackOutbox",
      "dispatchWorkCallbackOutbox",
      "dispatchWorkContactActions",
      ...Array.from({ length: 12 }, () => "runScheduledMaintenance"),
    ].sort());
    expect(messages.every((message) => "scheduledAt" in message
      && message.scheduledAt === scheduledTime.getTime())).toBe(true);
  });

  it("adds one sign-reminder root only at 10:25 Asia/Shanghai", async () => {
    const scheduledTime = new Date("2026-08-09T02:25:00.000Z");
    const controller = createScheduledController({ scheduledTime, cron: "*/5 * * * *" });
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

    expect(messages).toHaveLength(20);
    expect(messages.filter((message) =>
      message.action === "runScheduledMaintenance" && message.job === "sign_remind_time"
    )).toHaveLength(1);
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

  it("acknowledges a DLQ message only after archival and retries archival failure", async () => {
    const ctx = createExecutionContext();
    const batch = createMessageBatch<OrderMessage>("cinashop-order-runtime-test-dlq", [
      {
        id: "dead-letter-message",
        timestamp: new Date("2026-08-09T12:00:00.000Z"),
        attempts: 2,
        body: {
          action: "processOrderPaidOutbox",
          outboxId: 42,
          eventKey: "order.paid:42",
        },
      },
    ]);
    const archive = vi.fn().mockResolvedValue({
      id: 1,
      duplicate: false,
      status: "OPEN",
      messageType: "processOrderPaidOutbox",
      replayPolicy: "ALLOW",
      occurrenceCount: 1,
    });

    await consumeOrderQueueDeadLetterMessage(batch.queue, batch.messages[0], { archive });
    let result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(["dead-letter-message"]);
    expect(result.retryMessages).toEqual([]);

    const retryBatch = createMessageBatch<OrderMessage>("cinashop-order-runtime-test-dlq", [
      {
        id: "dead-letter-retry",
        timestamp: new Date("2026-08-09T12:00:00.000Z"),
        attempts: 2,
        body: {
          action: "processOrderPaidOutbox",
          outboxId: 43,
          eventKey: "order.paid:43",
        },
      },
    ]);
    archive.mockRejectedValueOnce(new Error("runtime_postgres_unavailable"));

    await consumeOrderQueueDeadLetterMessage(retryBatch.queue, retryBatch.messages[0], { archive });
    result = await getQueueResult(retryBatch, ctx);
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages).toEqual([{ msgId: "dead-letter-retry" }]);
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

describe("Kefu ChatRoomDO WebSocket hibernation", () => {
  it("rejects non-upgrades and malformed sessions before PostgreSQL access", async () => {
    const stub = testEnv.CHAT_ROOM.getByName("kefu:runtime-rejection");

    const notUpgrade = await stub.fetch("https://chat.internal/connect");
    expect(notUpgrade.status).toBe(426);
    await expect(notUpgrade.text()).resolves.toBe("Expected WebSocket");

    const malformed = await stub.fetch(new Request("https://chat.internal/connect", {
      headers: { Upgrade: "websocket" },
    }));
    expect(malformed.status).toBe(401);
    await expect(malformed.text()).resolves.toBe("Unauthorized WebSocket");
  });

  it("restores a tagged session attachment and revokes its token after eviction", async () => {
    const stub = testEnv.CHAT_ROOM.getByName("kefu:runtime-hibernation");
    const tokenKey = "a".repeat(32);
    const expiresAt = Math.floor(Date.now() / 1_000) + 3_600;
    const setOnline = vi.spyOn(KefuRealtimeService.prototype, "setOnline")
      .mockResolvedValue(undefined);
    vi.spyOn(KefuRealtimeService.prototype, "setDisconnected")
      .mockResolvedValue(undefined);

    const upgrade = await stub.fetch(new Request("https://chat.internal/connect", {
      headers: {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": "cinashop",
        "X-Chat-Principal-Uid": "71",
        "X-Chat-Role": "2",
        "X-Chat-To-Uid": "29",
        "X-Chat-Is-Tourist": "0",
        "X-Chat-Auth-Id": "11",
        "X-Chat-Token-Key": tokenKey,
        "X-Chat-Token-Exp": String(expiresAt),
        "X-Chat-Auth-Version": "runtime-v1",
      },
    }));
    expect(upgrade.status).toBe(101);
    expect(upgrade.headers.get("Sec-WebSocket-Protocol")).toBe("cinashop");
    const client = upgrade.webSocket;
    if (!client) throw new Error("runtime WebSocket upgrade missing client");
    const closed = new Promise<CloseEvent>((resolve) => {
      client.addEventListener("close", resolve, { once: true });
    });
    client.accept();
    expect(setOnline).toHaveBeenCalledWith(expect.objectContaining({
      principalUid: 71,
      role: 2,
      toUid: 29,
      tokenKey,
    }), true);

    const attached = await runInDurableObject(stub, (_instance, state) => {
      const sockets = state.getWebSockets("role:2");
      expect(sockets).toHaveLength(1);
      return sockets[0]?.deserializeAttachment() as ChatSocketSession;
    });

    await evictDurableObject(stub);

    await runInDurableObject(stub, (_instance, state) => {
      const restored = state.getWebSockets("role:2");
      expect(restored).toHaveLength(1);
      expect(restored[0]?.deserializeAttachment()).toEqual(attached);
    });
    await expect(stub.disconnectToken("b".repeat(32))).resolves.toBe(0);
    await expect(stub.disconnectToken(tokenKey)).resolves.toBe(1);
    await expect(closed).resolves.toMatchObject({ code: 4001, reason: "Session revoked" });
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
