import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  orderQueueDeadLetterAdminListColumns,
  prepareOrderQueueDeadLetter,
} from "../src/services/order/OrderQueueDeadLetterService";
import {
  consumeOrderQueueDeadLetterMessage,
  deadLetterArchiveRetryDelaySeconds,
} from "../src/services/order/OrderQueueDeadLetterConsumer";
import { sameDeadLetterAuditPublicSnapshot } from "./integration/OrderQueueDeadLetterPostgresScenario";

describe("order Queue dead-letter operations", () => {
  it("compares production safety snapshots independent of JSONB object key order", () => {
    const left = {
      table_count: 227,
      outbox_count: 0,
      outbox_sequence: "1",
      dead_letter_table: "system_queue_dead_letter",
      safety: {
        tables: [{ table: "work_client", rows: "0", digest: "abc" }],
        sequences: [{ sequence: "work_client_id_seq", last_value: "1", is_called: false }],
      },
    };
    const right = JSON.parse(
      '{"safety":{"sequences":[{"is_called":false,"last_value":"1","sequence":"work_client_id_seq"}],"tables":[{"rows":"0","table":"work_client","digest":"abc"}]},"dead_letter_table":"system_queue_dead_letter","outbox_sequence":"1","outbox_count":0,"table_count":227}',
    );
    expect(sameDeadLetterAuditPublicSnapshot(left, right)).toBe(true);
  });

  it("only allows replay for messages accepted by a current idempotent consumer", () => {
    const payment = prepareOrderQueueDeadLetter({
      action: "processOrderPaidOutbox",
      outboxId: 7,
      eventKey: "order.paid:42",
    });
    expect(payment.replayPolicy).toBe("ALLOW");
    expect(payment.replayMessage).toEqual({
      action: "processOrderPaidOutbox",
      outboxId: 7,
      eventKey: "order.paid:42",
    });

    const workCallback = prepareOrderQueueDeadLetter({
      action: "processWorkCallbackOutbox",
      outboxId: 17,
      eventId: 19,
      eventKey: "a".repeat(64),
    });
    expect(workCallback).toMatchObject({
      messageType: "processWorkCallbackOutbox",
      replayPolicy: "ALLOW",
      body: {
        action: "processWorkCallbackOutbox",
        outboxId: 17,
        eventId: 19,
        eventKey: "a".repeat(64),
      },
      replayMessage: {
        action: "processWorkCallbackOutbox",
        outboxId: 17,
        eventId: 19,
        eventKey: "a".repeat(64),
      },
    });
    expect(prepareOrderQueueDeadLetter({
      action: "dispatchWorkCallbackOutbox",
      scheduledAt: 1_788_048_000_000,
    }).replayPolicy).toBe("ALLOW");

    const replayKey = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    expect(prepareOrderQueueDeadLetter({
      action: "processMerchantShipmentCallbackOutbox",
      outboxId: 23,
      eventId: 29,
      replayKey,
    })).toMatchObject({
      messageType: "processMerchantShipmentCallbackOutbox",
      replayPolicy: "ALLOW",
      replayMessage: { action: "processMerchantShipmentCallbackOutbox", replayKey },
    });
    expect(prepareOrderQueueDeadLetter({
      action: "processCityDeliveryCallbackOutbox",
      outboxId: 31,
      eventId: 37,
      replayKey,
    })).toMatchObject({
      messageType: "processCityDeliveryCallbackOutbox",
      replayPolicy: "ALLOW",
      replayMessage: { action: "processCityDeliveryCallbackOutbox", replayKey },
    });
    expect(prepareOrderQueueDeadLetter({
      action: "dispatchCityDeliveryCallbacks",
      scheduledAt: 1_788_048_000_000,
    }).replayPolicy).toBe("ALLOW");

    const legacy = prepareOrderQueueDeadLetter({
      action: "compute",
      orderId: "wx-42",
      uid: 3,
    });
    expect(legacy).toMatchObject({
      messageType: "compute",
      replayPolicy: "BLOCK_UNSUPPORTED",
    });
    expect(legacy.replayMessage).toBeUndefined();
  });

  it("redacts SMS credentials and unknown secrets before persistence", () => {
    const sms = prepareOrderQueueDeadLetter({
      action: "sendSmsVerification",
      recordId: 11,
      uid: 3,
      phone: "13800138000",
      code: "123456",
      expiresIn: 300,
      purpose: "supplier_application",
      templateCode: "SMS_123",
    });
    expect(sms.replayPolicy).toBe("BLOCK_SENSITIVE");
    expect(sms.replayMessage).toBeUndefined();
    expect(sms.body).toMatchObject({
      phone: "138****8000",
      code: "[REDACTED]",
      templateCode: "[REDACTED]",
    });

    const circular: Record<string, unknown> = {
      action: "futureMessage",
      authorization: "Bearer secret",
      nested: { apiKey: "key", mobile: "13900139000" },
    };
    circular.self = circular;
    expect(prepareOrderQueueDeadLetter(circular)).toMatchObject({
      messageType: "futureMessage",
      replayPolicy: "BLOCK_UNSUPPORTED",
      body: {
        authorization: "[REDACTED]",
        nested: { apiKey: "[REDACTED]", mobile: "139****9000" },
        self: "[CIRCULAR]",
      },
    });
  });

  it("never exposes the internal replay lease token in the admin list projection", () => {
    expect(Object.keys(orderQueueDeadLetterAdminListColumns)).toContain("replayLeaseUntil");
    expect(Object.keys(orderQueueDeadLetterAdminListColumns)).not.toContain("replayToken");
  });

  it("acks only after durable archive and retries archive failures with a bounded delay", async () => {
    const ack = vi.fn();
    const retry = vi.fn();
    const message = {
      id: "dead-letter-1",
      timestamp: new Date(1_700_000_000_000),
      body: { action: "processOrderPaidOutbox", outboxId: 7, eventKey: "order.paid:42" },
      attempts: 2,
      ack,
      retry,
    };
    const archive = vi.fn().mockResolvedValue({
      id: 9,
      duplicate: false,
      status: "OPEN",
      messageType: "processOrderPaidOutbox",
      replayPolicy: "ALLOW",
      occurrenceCount: 1,
    });
    await consumeOrderQueueDeadLetterMessage("cinashop-order-dlq", message, { archive });
    expect(archive).toHaveBeenCalledWith("cinashop-order-dlq", message);
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();

    ack.mockClear();
    archive.mockRejectedValueOnce(new Error("postgres unavailable"));
    await consumeOrderQueueDeadLetterMessage("cinashop-order-dlq", message, { archive });
    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(deadLetterArchiveRetryDelaySeconds(99)).toBe(900);
  });

  it("keeps the physical/embedded schema, queue bindings and admin controls wired", () => {
    const migration = readFileSync("migrations/0080_order_queue_dead_letter.sql", "utf8").trim();
    const embedded = readFileSync("src/services/MigrationService.ts", "utf8")
      .match(/private migration_0087\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    expect(embedded).toBe(migration);
    expect(migration).toContain('CONSTRAINT "sqdl_queue_message_uq" UNIQUE');
    expect(migration).toContain("'BLOCK_SENSITIVE'");

    const config = readFileSync("wrangler.toml", "utf8");
    expect(config).toContain('ORDER_DLQ_NAME = "cinashop-order-dlq"');
    expect(config).toContain('queue = "cinashop-order-dlq"');
    expect(config).toContain('dead_letter_queue = "cinashop-order-dlq-unarchived"');

    const entrypoint = readFileSync("src/index.ts", "utf8");
    expect(entrypoint).toContain("batch.queue === env.ORDER_DLQ_NAME");
    expect(entrypoint).toContain("consumeOrderQueueDeadLetterMessage");

    const routes = readFileSync("src/routes/adminapi.ts", "utf8");
    expect(routes).toContain('"/order/outbox/dead-letter"');
    expect(routes).toContain('"/order/outbox/dead-letter/:id/replay"');
    expect(routes).toContain('"/order/outbox/dead-letter/:id/resolve"');
    const v1Routes = readFileSync("src/routes/v1/index.ts", "utf8");
    expect(v1Routes).toContain('"/admin/order/outbox/dead-letter"');
    expect(v1Routes).toContain('"/admin/order/outbox/dead-letter/:id/replay"');
    expect(v1Routes).toContain('"/admin/order/outbox/dead-letter/:id/resolve"');

    const scenario = readFileSync(
      "test/integration/OrderQueueDeadLetterPostgresScenario.ts",
      "utf8",
    );
    const auditWorker = readFileSync(
      "test/integration/OrderQueueDeadLetterAuditWorker.ts",
      "utf8",
    );
    const workAuditConfig = readFileSync(
      "test/integration/enterprise-wechat-work-c2-queue-audit.wrangler.jsonc",
      "utf8",
    );
    expect(scenario).toContain("public_state_unchanged");
    expect(scenario).toContain("SMS code was persisted in clear text");
    expect(scenario).toContain("replay business processing was duplicated");
    expect(auditWorker).toContain("consumeOrderQueueDeadLetterMessage");
    expect(auditWorker).toContain("production Hyperdrive isolated controlled replay audit");
    expect(auditWorker).toContain("verifyWorkCallbackDeadLetterAudit");
    expect(auditWorker).toContain("consumeWorkCallbackQueueMessage");
    expect(auditWorker).toContain("EnterpriseWechatCallbackService");
    expect(scenario).toContain("body_sha256");
    expect(scenario).toContain("callback event did not reach ORDERED");
    expect(scenario).toContain('DROP SCHEMA IF EXISTS "${schemaName}" CASCADE');
    expect(auditWorker).toContain('path === "/send/work-failing"');
    expect(workAuditConfig).toContain('"id": "9748c294e21c49a99579c9cef70102e0"');
    expect(workAuditConfig).toContain('"max_retries": 1');
    expect(workAuditConfig).toContain('"dead_letter_queue": "cinashop-work-c2-audit-dlq"');
    expect(workAuditConfig).toContain('"dead_letter_queue": "cinashop-work-c2-audit-unarchived"');
  });
});
