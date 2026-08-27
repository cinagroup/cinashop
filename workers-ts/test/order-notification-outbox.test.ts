import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { isOrderNotificationOutboxMessage } from "../src/services/order/OrderOutboxService";
import {
  ORDER_DELIVERY_NOTICE_EVENT,
  ORDER_REFUND_REFUSED_NOTICE_EVENT,
  assertOrderNotificationPayload,
  orderDeliveryNoticeEventKey,
  orderRefundRefusedNoticeEventKey,
} from "../src/services/order/OrderNotificationOutboxService";
import { consumeOrderNotificationOutboxQueueMessage } from "../src/services/order/OrderPaidOutboxQueueConsumer";
import { prepareOrderQueueDeadLetter } from "../src/services/order/OrderQueueDeadLetterService";

function notificationMessage(attempts = 1) {
  return {
    body: {
      action: "processOrderNotificationOutbox" as const,
      outboxId: 9,
      eventKey: "order.delivery.notice:42",
    },
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

describe("order notification outbox", () => {
  it("uses stable event keys and a distinct Queue contract", () => {
    expect(orderDeliveryNoticeEventKey(42)).toBe(`${ORDER_DELIVERY_NOTICE_EVENT}:42`);
    expect(orderRefundRefusedNoticeEventKey(7)).toBe(`${ORDER_REFUND_REFUSED_NOTICE_EVENT}:7`);
    expect(isOrderNotificationOutboxMessage(notificationMessage().body)).toBe(true);
    expect(isOrderNotificationOutboxMessage({
      action: "processOrderNotificationOutbox",
      outboxId: 9,
      eventKey: "order.paid:42",
    })).toBe(false);
    expect(() => orderDeliveryNoticeEventKey(0)).toThrow("订单 ID 无效");
  });

  it("validates immutable delivery and refusal snapshots", () => {
    expect(() => assertOrderNotificationPayload({
      orderId: 42,
      orderNo: "ORDER42",
      userId: 3,
      deliveryType: "express",
      deliveryName: "SF",
      deliveryId: "TRACK42",
      userAddress: "Singapore",
    }, ORDER_DELIVERY_NOTICE_EVENT, 42)).not.toThrow();
    expect(() => assertOrderNotificationPayload({
      orderId: 42,
      orderNo: "ORDER42",
      refundId: 8,
      userId: 3,
      payPrice: "19.90",
    }, ORDER_REFUND_REFUSED_NOTICE_EVENT, 42)).not.toThrow();
    expect(() => assertOrderNotificationPayload({
      orderId: 43,
      orderNo: "ORDER42",
      userId: 3,
      deliveryType: "express",
      deliveryName: "SF",
      deliveryId: "TRACK42",
      userAddress: "Singapore",
    }, ORDER_DELIVERY_NOTICE_EVENT, 42)).toThrow("聚合 ID 不匹配");
  });

  it("acks successful notices, retries failures and allows idempotent DLQ replay", async () => {
    const success = notificationMessage();
    const processor = { processMessage: vi.fn().mockResolvedValue("completed") };
    await consumeOrderNotificationOutboxQueueMessage(success, processor);
    expect(success.ack).toHaveBeenCalledOnce();
    expect(success.retry).not.toHaveBeenCalled();

    const busy = notificationMessage(2);
    processor.processMessage.mockResolvedValueOnce("busy");
    await consumeOrderNotificationOutboxQueueMessage(busy, processor);
    expect(busy.ack).not.toHaveBeenCalled();
    expect(busy.retry).toHaveBeenCalledWith({ delaySeconds: 60 });

    const failure = notificationMessage(3);
    processor.processMessage.mockRejectedValueOnce(new Error("transient"));
    await consumeOrderNotificationOutboxQueueMessage(failure, processor);
    expect(failure.ack).not.toHaveBeenCalled();
    expect(failure.retry).toHaveBeenCalledWith({ delaySeconds: 120 });

    expect(prepareOrderQueueDeadLetter(success.body)).toMatchObject({
      messageType: "processOrderNotificationOutbox",
      replayPolicy: "ALLOW",
      replayMessage: success.body,
    });
  });

  it("keeps physical and embedded DDL identical and wires every current mutation path", () => {
    const migration = readFileSync("migrations/0084_order_notification_outbox.sql", "utf8").trim();
    const embedded = readFileSync("src/services/MigrationService.ts", "utf8")
      .match(/private migration_0091\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    expect(embedded).toBe(migration);
    expect(migration).toContain('"event_type" IN (');
    expect(migration).toContain('"smsg_event_key_uq"');

    for (const file of [
      "src/controllers/api/v1/AdminCrudController.ts",
      "src/services/supplier/SupplierFulfillmentService.ts",
      "src/services/order/VirtualProductDeliveryService.ts",
    ]) {
      expect(readFileSync(file, "utf8")).toContain("enqueueOrderDeliveryNoticeEvent");
    }
    for (const file of [
      "src/services/order/StoreOrderRefundService.ts",
      "src/services/out/OutApiService.ts",
    ]) {
      expect(readFileSync(file, "utf8")).toContain("enqueueOrderRefundRefusedNoticeEvent");
    }
  });
});
