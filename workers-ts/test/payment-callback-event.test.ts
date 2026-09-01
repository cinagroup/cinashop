import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { MigrationService } from "@/services/MigrationService";
import {
  consumePaymentCallbackMessage,
  isPaymentCallbackDispatchMessage,
  isPaymentCallbackMessage,
} from "@/services/payment/PaymentCallbackEventService";
import { prepareOrderQueueDeadLetter } from "@/services/order/OrderQueueDeadLetterService";

const replayKey = "018f47a2-763b-4b73-8d6a-615f80b79595";
const body = {
  action: "processPaymentCallback" as const,
  eventId: 41,
  replayKey,
};

describe("CORE-001-B durable payment callback pipeline", () => {
  it("keeps Queue payloads opaque and rejects expanded or malformed contracts", () => {
    expect(isPaymentCallbackMessage(body)).toBe(true);
    expect(isPaymentCallbackMessage({ ...body, orderNo: "wx-secret-order" })).toBe(false);
    expect(isPaymentCallbackMessage({ ...body, replayKey: "not-a-replay-key" })).toBe(false);
    expect(isPaymentCallbackDispatchMessage({
      action: "dispatchPaymentCallbackOutbox",
      scheduledAt: 1_800_000_000_000,
    })).toBe(true);
    expect(isPaymentCallbackDispatchMessage({
      action: "dispatchPaymentCallbackOutbox",
      scheduledAt: 1,
      cursor: 1,
    })).toBe(false);
  });

  it("allows durable payment messages to be replayed from the sanitized DLQ", () => {
    expect(prepareOrderQueueDeadLetter(body)).toEqual({
      messageType: "processPaymentCallback",
      replayPolicy: "ALLOW",
      body,
      replayMessage: body,
    });
    const dispatch = {
      action: "dispatchPaymentCallbackOutbox" as const,
      scheduledAt: 1_800_000_000_000,
    };
    expect(prepareOrderQueueDeadLetter(dispatch)).toEqual({
      messageType: "dispatchPaymentCallbackOutbox",
      replayPolicy: "ALLOW",
      body: dispatch,
      replayMessage: dispatch,
    });
  });

  it.each(["completed", "ignored", "unknown", "already-completed", "dead"] as const)(
    "acknowledges the durable %s result",
    async (result) => {
      const ack = vi.fn();
      const retry = vi.fn();
      await consumePaymentCallbackMessage(
        { body, attempts: 1, ack, retry },
        { processMessage: vi.fn().mockResolvedValue(result) },
      );
      expect(ack).toHaveBeenCalledOnce();
      expect(retry).not.toHaveBeenCalled();
    },
  );

  it("retries active leases, durable deferrals and storage failures", async () => {
    const retryBusy = vi.fn();
    await consumePaymentCallbackMessage(
      { body, attempts: 2, ack: vi.fn(), retry: retryBusy },
      { processMessage: vi.fn().mockResolvedValue("busy") },
    );
    expect(retryBusy).toHaveBeenCalledWith({ delaySeconds: 30 });

    const retryDeferred = vi.fn();
    await consumePaymentCallbackMessage(
      { body, attempts: 2, ack: vi.fn(), retry: retryDeferred },
      { processMessage: vi.fn().mockResolvedValue({ kind: "deferred", delaySeconds: 77 }) },
    );
    expect(retryDeferred).toHaveBeenCalledWith({ delaySeconds: 77 });

    const retryFailure = vi.fn();
    await consumePaymentCallbackMessage(
      { body, attempts: 3, ack: vi.fn(), retry: retryFailure },
      { processMessage: vi.fn().mockRejectedValue(new Error("postgres_unavailable")) },
    );
    expect(retryFailure).toHaveBeenCalledWith({ delaySeconds: 120 });
  });

  it("keeps external and embedded DDL byte-for-byte identical", () => {
    const external = readFileSync("migrations/0120_payment_callback_pipeline.sql", "utf8");
    expect(new MigrationService({} as never)
      .paymentCallbackPipelineMigrationSqlForVerification())
      .toBe(external);
    expect((external.match(/^CREATE TABLE IF NOT EXISTS/gm) ?? [])).toHaveLength(2);
    expect(external).toContain('UNIQUE INDEX IF NOT EXISTS "pce_provider_event_uq"');
    expect(external).toContain('FOREIGN KEY ("event_id")');
    expect(external).toContain("ON DELETE RESTRICT");
    expect(external).toContain('WHERE "status" IN (\'PENDING\', \'FAILED\')');
    expect(external).not.toMatch(/^\s*(?:DROP|TRUNCATE|DELETE|UPDATE|INSERT)\b/im);
  });

  it("moves settlement out of HTTP and leaves cron recovery wired", () => {
    const pay = readFileSync("src/controllers/api/v1/PayController.ts", "utf8");
    const wechat = readFileSync("src/controllers/api/v1/WechatController.ts", "utf8");
    const entry = readFileSync("src/index.ts", "utf8");
    const service = readFileSync(
      "src/services/payment/PaymentCallbackEventService.ts",
      "utf8",
    );
    for (const controller of [pay, wechat]) {
      expect(controller).toContain("PaymentCallbackEventService");
      expect(controller).toContain("callbackService.receive(");
      expect(controller).toContain("executionCtx.waitUntil(");
    }
    expect(service).toContain("pg_advisory_xact_lock");
    expect(service).toContain('.for("update", { skipLocked: true })');
    expect(service).toContain("applyStoreOrderPayment");
    expect(service).toContain("applyRechargePayment");
    expect(service).toContain("applyMembershipPayment");
    expect(entry).toContain('action: "dispatchPaymentCallbackOutbox"');
    expect(entry).toContain("consumePaymentCallbackMessage");
  });

  it("keeps the production-engine audit isolated, gated and bound to the exact Hyperdrive", () => {
    const worker = readFileSync(
      "test/integration/PaymentCallbackPipelineAuditWorker.ts",
      "utf8",
    );
    const config = readFileSync(
      "test/integration/payment-callback-pipeline-audit.wrangler.jsonc",
      "utf8",
    );
    expect(config).toContain('"id": "9748c294e21c49a99579c9cef70102e0"');
    expect(worker).toContain("AUDIT_ISOLATED_TOKEN_SHA256");
    expect(worker).toContain("DROP SCHEMA IF EXISTS");
    expect(worker).toContain("temporary_schema_removed");
    expect(worker).toContain("duplicate_receive_is_atomic");
    expect(worker).toContain("transaction_conflict_is_terminal");
    expect(worker).toContain("ingress_transaction_rolls_back_on_outbox_failure");
    expect(worker).toContain("crash_after_settlement_replays_idempotently");
    expect(worker).toContain("dlq_replay_resumes_same_durable_event");
  });
});
