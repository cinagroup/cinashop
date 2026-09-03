import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  consumeSecondCardReminderQueueMessage,
  isSecondCardReminderMessage,
  SECOND_CARD_REMINDER_PAGE_SIZE,
  secondCardReminderRetryDelaySeconds,
  secondCardReminderWindowHours,
} from "@/services/order/SecondCardReminderService";
import {
  assertOrderNotificationPayload,
  ORDER_SECOND_CARD_ADVENT_NOTICE_EVENT,
  ORDER_SECOND_CARD_EXPIRED_NOTICE_EVENT,
  orderSecondCardNoticeEventKey,
} from "@/services/order/OrderNotificationOutboxService";

const scheduledAt = Date.parse("2026-09-03T05:00:00.000Z");
const message = {
  action: "processSecondCardReminder" as const,
  job: "reminder_unverified_remind" as const,
  runId: `scheduled:${scheduledAt}`,
  scheduledAt,
  cartInfoId: 31,
  orderId: 17,
  writeEnd: 1_788_400_000,
  kind: "advent" as const,
};

describe("second-card reminder migration", () => {
  it("strictly validates opaque per-card queue messages", () => {
    expect(isSecondCardReminderMessage(message)).toBe(true);
    expect(isSecondCardReminderMessage({ ...message, cartInfoId: 0 })).toBe(false);
    expect(isSecondCardReminderMessage({ ...message, writeEnd: -1 })).toBe(false);
    expect(isSecondCardReminderMessage({ ...message, kind: "other" })).toBe(false);
    expect(isSecondCardReminderMessage({ ...message, runId: "scheduled:other" })).toBe(false);
    expect(secondCardReminderWindowHours('"24"')).toBe(24);
    expect(secondCardReminderWindowHours("-1")).toBe(1);
    expect(secondCardReminderWindowHours("8761")).toBe(1);
  });

  it("uses immutable event identities and rejects kind mismatches", () => {
    const payload = {
      orderId: 17,
      orderNo: "ORDER17",
      cartInfoId: 31,
      userId: 9,
      kind: "advent" as const,
      writeEnd: 1_788_400_000,
      payTime: 1_788_000_000,
      storeName: "十次体验卡",
    };
    expect(orderSecondCardNoticeEventKey("advent", 31, payload.writeEnd)).toBe(
      `order.second_card.advent.notice:31:${payload.writeEnd}`,
    );
    expect(() => assertOrderNotificationPayload(
      payload,
      ORDER_SECOND_CARD_ADVENT_NOTICE_EVENT,
      17,
    )).not.toThrow();
    expect(() => assertOrderNotificationPayload(
      payload,
      ORDER_SECOND_CARD_EXPIRED_NOTICE_EVENT,
      17,
    )).toThrow("类型与事件不匹配");
  });

  it("acks terminal processing and retries failures with bounded backoff", async () => {
    const ack = vi.fn();
    const retry = vi.fn();
    const processMessage = vi.fn().mockResolvedValue("staged");
    await consumeSecondCardReminderQueueMessage(
      { body: message, attempts: 1, ack, retry } as never,
      { processMessage },
    );
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();

    const failedAck = vi.fn();
    const failedRetry = vi.fn();
    await consumeSecondCardReminderQueueMessage(
      { body: message, attempts: 99, ack: failedAck, retry: failedRetry } as never,
      { processMessage: vi.fn().mockRejectedValue(new Error("temporary")) },
    );
    expect(failedAck).not.toHaveBeenCalled();
    expect(failedRetry).toHaveBeenCalledWith({ delaySeconds: 900 });
    expect(secondCardReminderRetryDelaySeconds(1)).toBe(30);
    expect(secondCardReminderRetryDelaySeconds(99)).toBe(900);
  });

  it("keeps Cron bounded and stages flags with the outbox in one transaction", () => {
    const source = readFileSync("src/services/order/SecondCardReminderService.ts", "utf8");
    const outbox = readFileSync("src/services/order/OrderNotificationOutboxService.ts", "utf8");
    const migration = readFileSync("migrations/0129_second_card_reminder_indexes.sql", "utf8");
    const embedded = readFileSync("src/migrations/secondCardReminderIndexes.ts", "utf8");
    const schema = readFileSync("src/models/schema/order_outbox.ts", "utf8");
    expect(SECOND_CARD_REMINDER_PAGE_SIZE).toBeLessThanOrEqual(99);
    expect(source).toContain("gt(storeOrderCartInfo.id, message.cursor)");
    expect(source).toContain("inArray(storeOrder.refundStatus, [0, 3])");
    expect(source).toContain("pg_advisory_xact_lock");
    expect(source).toContain("enqueueSecondCardNoticeEvent(tx");
    expect(source.indexOf("enqueueSecondCardNoticeEvent(tx")).toBeLessThan(
      source.indexOf("isAdventSms: 1"),
    );
    expect(outbox).toContain('return "reminder_brink_death"');
    expect(outbox).toContain('return "expiration_reminder"');
    expect(outbox).toContain("if (isSecondCard) return");
    expect(outbox).toContain('secondCard.kind === "advent"');
    for (const contract of [migration, embedded, schema]) {
      expect(contract).toContain("soob_event_type_ck");
      expect(contract).toContain("order.second_card.advent.notice");
      expect(contract).toContain("order.second_card.expired.notice");
    }
    expect(migration).toContain('"soci_second_card_advent_due"');
    expect(migration).toContain('"soci_second_card_expired_due"');
  });

  it("returns scoped return contacts and renders them only for return states", () => {
    const resolver = readFileSync("src/services/order/RefundReturnContactService.ts", "utf8");
    const service = readFileSync("src/services/order/StoreOrderRefundService.ts", "utf8");
    const admin = readFileSync("../view/admin-ts/src/pages/refund/RefundList.vue", "utf8");
    const uniapp = readFileSync("../view/uniapp-ts/src/pages/order/refundDetail.vue", "utf8");
    expect(resolver).toContain('"refund_name"');
    expect(resolver).toContain("systemSupplier.supplierName");
    expect(resolver).toContain("systemStore.name");
    expect(service).toContain("resolveRefundReturnContact(this.container, refund)");
    expect(admin).toContain("退货收货人");
    expect(admin).toContain("退货电话");
    expect(admin).toContain("退货地址");
    expect(uniapp).toContain("status === 4 || status === 5");
    expect(uniapp).toContain("退货收件信息");
  });

  it("keeps production verification token-gated, bounded, and disposable", () => {
    const worker = readFileSync("test/integration/SecondCardReminderAuditWorker.ts", "utf8");
    const config = readFileSync("test/integration/second-card-reminder-audit.wrangler.jsonc", "utf8");
    const runner = readFileSync("scripts/run-second-card-production-audit.ps1", "utf8");
    expect(config).toContain('"id": "9748c294e21c49a99579c9cef70102e0"');
    expect(worker).toContain("AUDIT_READ_TOKEN_SHA256");
    expect(worker).toContain("AUDIT_WRITE_TOKEN_SHA256");
    expect(worker).toContain("SET TRANSACTION READ ONLY");
    expect(worker).toContain("size.cart_rows > 100_000");
    expect(worker).toContain("businessRowsUnchanged");
    expect(runner).toContain("wrangler delete $taskAuditName");
    expect(runner).not.toContain("Write-Output $taskReadCredential");
    expect(runner).not.toContain("Write-Output $taskWriteCredential");
  });
});
