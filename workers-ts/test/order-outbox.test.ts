import { describe, expect, it } from "vitest";
import {
  ORDER_PAID_EVENT,
  OUTBOX_MAX_ATTEMPTS,
  isOrderPaidOutboxMessage,
  orderPaidEventKey,
  outboxFailureDisposition,
  outboxRetryDelaySeconds,
} from "../src/services/order/OrderOutboxService";

describe("订单支付 outbox", () => {
  it("为同一订单生成稳定事件键", () => {
    expect(orderPaidEventKey(42)).toBe(`${ORDER_PAID_EVENT}:42`);
    expect(orderPaidEventKey(42)).toBe(orderPaidEventKey(42));
    expect(() => orderPaidEventKey(0)).toThrow("订单 ID 无效");
  });

  it("只接受可序列化且边界有效的支付 outbox 消息", () => {
    expect(
      isOrderPaidOutboxMessage({
        action: "processOrderPaidOutbox",
        outboxId: 7,
        eventKey: "order.paid:42",
      }),
    ).toBe(true);
    expect(isOrderPaidOutboxMessage({ action: "processOrderPaidOutbox", outboxId: 0, eventKey: "order.paid:42" })).toBe(false);
    expect(isOrderPaidOutboxMessage({ action: "processOrderPaidOutbox", outboxId: 7.5, eventKey: "order.paid:42" })).toBe(false);
    expect(isOrderPaidOutboxMessage({ action: "processOrderPaidOutbox", outboxId: 7, eventKey: "order.paid:0" })).toBe(false);
    expect(isOrderPaidOutboxMessage({ action: "compute", orderId: "wx1", uid: 1 })).toBe(false);
  });

  it("指数退避有上限", () => {
    expect(outboxRetryDelaySeconds(1)).toBe(30);
    expect(outboxRetryDelaySeconds(2)).toBe(60);
    expect(outboxRetryDelaySeconds(7)).toBe(1920);
    expect(outboxRetryDelaySeconds(8)).toBe(3600);
    expect(outboxRetryDelaySeconds(999)).toBe(3600);
  });

  it("达到最大次数后进入 DEAD，等待管理员显式重放", () => {
    expect(outboxFailureDisposition(OUTBOX_MAX_ATTEMPTS - 1, 1_000)).toEqual({
      status: "FAILED",
      availableTime: 2_920,
    });
    expect(outboxFailureDisposition(OUTBOX_MAX_ATTEMPTS, 1_000)).toEqual({
      status: "DEAD",
      availableTime: 0,
    });
  });

});
