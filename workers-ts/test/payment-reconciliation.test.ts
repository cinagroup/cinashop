import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { MigrationService } from "@/services/MigrationService";
import { prepareOrderQueueDeadLetter } from "@/services/order/OrderQueueDeadLetterService";
import {
  consumePaymentReconciliationMessage,
  isPaymentReconciliationDispatchMessage,
  isPaymentReconciliationMessage,
  paymentReconciliationBackoff,
} from "@/services/payment/PaymentReconciliationService";

const replayKey = "00000000-0000-4000-8000-000000000002";
const body = {
  action: "processPaymentReconciliation" as const,
  caseId: 52,
  replayKey,
};

describe("CORE-001-C active payment reconciliation", () => {
  it("keeps Queue payloads opaque and rejects expanded or malformed contracts", () => {
    expect(isPaymentReconciliationMessage(body)).toBe(true);
    expect(isPaymentReconciliationMessage({ ...body, orderNo: "private-order" })).toBe(false);
    expect(isPaymentReconciliationMessage({ ...body, replayKey: "invalid" })).toBe(false);
    expect(isPaymentReconciliationDispatchMessage({
      action: "dispatchPaymentReconciliation",
      scheduledAt: 1_800_000_000_000,
      cursor: 0,
    })).toBe(true);
    expect(isPaymentReconciliationDispatchMessage({
      action: "dispatchPaymentReconciliation",
      scheduledAt: 1_800_000_000_000,
      cursor: 0,
      provider: "wechat",
    })).toBe(false);
  });

  it("allows only validated opaque reconciliation jobs to be replayed from the DLQ", () => {
    expect(prepareOrderQueueDeadLetter(body)).toEqual({
      messageType: "processPaymentReconciliation",
      replayPolicy: "ALLOW",
      body,
      replayMessage: body,
    });
    const dispatch = {
      action: "dispatchPaymentReconciliation" as const,
      scheduledAt: 1_800_000_000_000,
      cursor: 0,
    };
    expect(prepareOrderQueueDeadLetter(dispatch)).toEqual({
      messageType: "dispatchPaymentReconciliation",
      replayPolicy: "ALLOW",
      body: dispatch,
      replayMessage: dispatch,
    });
  });

  it("uses bounded exponential provider-query backoff", () => {
    expect(paymentReconciliationBackoff(1)).toBe(60);
    expect(paymentReconciliationBackoff(2)).toBe(120);
    expect(paymentReconciliationBackoff(12)).toBe(21_600);
    expect(paymentReconciliationBackoff(100)).toBe(21_600);
  });

  it.each([
    "settled",
    "confirmed",
    "waiting",
    "no-payment",
    "unknown",
    "conflict",
    "dead",
    "already-terminal",
  ] as const)("acknowledges durable %s outcomes", async (result) => {
    const ack = vi.fn();
    const retry = vi.fn();
    await consumePaymentReconciliationMessage(
      { body, attempts: 1, ack, retry },
      { processMessage: vi.fn().mockResolvedValue(result) },
    );
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  it("retries active leases, scheduled deferrals and storage failures", async () => {
    const retryBusy = vi.fn();
    await consumePaymentReconciliationMessage(
      { body, attempts: 1, ack: vi.fn(), retry: retryBusy },
      { processMessage: vi.fn().mockResolvedValue("busy") },
    );
    expect(retryBusy).toHaveBeenCalledWith({ delaySeconds: 30 });

    const retryDeferred = vi.fn();
    await consumePaymentReconciliationMessage(
      { body, attempts: 1, ack: vi.fn(), retry: retryDeferred },
      { processMessage: vi.fn().mockResolvedValue({ kind: "deferred", delaySeconds: 73 }) },
    );
    expect(retryDeferred).toHaveBeenCalledWith({ delaySeconds: 73 });

    const retryFailure = vi.fn();
    await consumePaymentReconciliationMessage(
      { body, attempts: 3, ack: vi.fn(), retry: retryFailure },
      { processMessage: vi.fn().mockRejectedValue(new Error("postgres unavailable")) },
    );
    expect(retryFailure).toHaveBeenCalledWith({ delaySeconds: 120 });
  });

  it("keeps external and embedded DDL byte-for-byte identical and fail-closed", () => {
    const external = readFileSync("migrations/0121_payment_reconciliation.sql", "utf8");
    expect(new MigrationService({} as never).paymentReconciliationMigrationSqlForVerification())
      .toBe(external);
    expect((external.match(/^CREATE TABLE IF NOT EXISTS/gm) ?? [])).toHaveLength(2);
    expect(external).toContain("0127 payment reconciliation relation shape verification failed");
    expect(external).toContain("0127 payment reconciliation constraint set verification failed");
    expect(external).toContain("0127 payment reconciliation index set verification failed");
    expect(external).toContain("ON DELETE RESTRICT");
    expect(external).not.toMatch(/^\s*(?:DROP|TRUNCATE|DELETE|UPDATE|INSERT)\b/im);
  });

  it("registers recovery intent before provider I/O across all external payment domains", () => {
    const store = readFileSync("src/services/order/StoreOrderPayService.ts", "utf8");
    const recharge = readFileSync("src/services/payment/RechargePaymentService.ts", "utf8");
    const membership = readFileSync("src/services/user/PaidMembershipService.ts", "utf8");
    for (const source of [store, recharge, membership]) {
      expect(source).toContain("registerPaymentReconciliationIntent");
    }
    expect(store.indexOf("registerPaymentReconciliationIntent", store.indexOf("async wechatPay")))
      .toBeLessThan(
      store.indexOf(".createOrder({", store.indexOf("async wechatPay")),
    );
    expect(recharge.indexOf("registerPaymentReconciliationIntent", recharge.indexOf("async startWechatPayment")))
      .toBeLessThan(
      recharge.indexOf(".createOrder({", recharge.indexOf("async startWechatPayment")),
    );
    expect(membership.indexOf("registerPaymentReconciliationIntent", membership.indexOf("async payOrder")))
      .toBeLessThan(membership.indexOf(".createOrder({", membership.indexOf("async payOrder")));
  });

  it("wires callback evidence, provider queries, cron recovery and guarded admin decisions", () => {
    const callback = readFileSync("src/services/payment/PaymentCallbackEventService.ts", "utf8");
    const reconciliation = readFileSync(
      "src/services/payment/PaymentReconciliationService.ts",
      "utf8",
    );
    const wechat = readFileSync("src/services/wechat/WechatPayService.ts", "utf8");
    const alipay = readFileSync("src/services/payment/AlipayTradeQueryService.ts", "utf8");
    const entry = readFileSync("src/index.ts", "utf8");
    const adminRoutes = readFileSync("src/routes/adminapi.ts", "utf8");
    expect(callback).toContain("registerPaymentReconciliationTx");
    expect(callback).toContain("resolvePaymentReconciliationFromCallbackTx");
    expect(reconciliation).toContain("Provider I/O is deliberately outside every PostgreSQL transaction");
    expect(reconciliation).toContain('.for("update", {\n        skipLocked: true,');
    expect(wechat).toContain("/v3/pay/transactions/out-trade-no/");
    expect(alipay).toContain('method: "alipay.trade.query"');
    expect(entry).toContain('action: "dispatchPaymentReconciliation"');
    expect(entry).toContain("consumePaymentReconciliationMessage");
    expect(adminRoutes).toContain('"/order/payment-reconciliation"');
    expect(adminRoutes).toContain('"/order/payment-reconciliation/:id/decision"');
  });

  it("keeps the production-engine audit isolated, gated and bound to the exact Hyperdrive", () => {
    const worker = readFileSync(
      "test/integration/PaymentReconciliationAuditWorker.ts",
      "utf8",
    );
    const config = readFileSync(
      "test/integration/payment-reconciliation-audit.wrangler.jsonc",
      "utf8",
    );
    expect(config).toContain('"id": "9748c294e21c49a99579c9cef70102e0"');
    expect(worker).toContain("AUDIT_READ_TOKEN_SHA256");
    expect(worker).toContain("AUDIT_MIGRATE_TOKEN_SHA256");
    expect(worker).toContain("AUDIT_ISOLATED_TOKEN_SHA256");
    expect(worker).toContain("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    expect(worker).toContain("DROP SCHEMA IF EXISTS");
    expect(worker).toContain("temporary_schema_removed");
    expect(worker).toContain("provider_success_settles_once");
    expect(worker).toContain("repeated_aged_not_found_is_no_payment");
    expect(worker).toContain("manual_actions_are_immutable_and_idempotent");
    expect(worker).toContain("callback_resolves_same_case");
  });
});
