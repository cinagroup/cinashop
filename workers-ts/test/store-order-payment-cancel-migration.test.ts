import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("订单支付与取消 PostgreSQL 迁移", () => {
  it("取消订单锁定订单行并将资源补偿与状态证据放在同一事务", () => {
    const source = readFileSync("src/services/order/StoreOrderCreateService.ts", "utf8");
    expect(source).toContain("export async function cancelStoreOrder(");
    expect(source).toContain('.for("update")');
    expect(source).toContain('changeType: "cancel"');
    expect(source).toContain("await cancelStoreOrder(this.container, { uid, orderId });");
    expect(source).not.toContain('storeOrderStatusDao.log(order.id, "cancel"');
  });

  it("支付状态与不可变 outbox 事件共用一个可验证事务入口", () => {
    const payment = readFileSync("src/services/order/StoreOrderPayService.ts", "utf8");
    const outbox = readFileSync("src/services/order/OrderOutboxService.ts", "utf8");
    expect(payment).toContain("export async function applyStoreOrderPayment(");
    expect(payment).toContain("const outbox = await enqueueOrderPaidEvent(tx, paidOrder, now);");
    expect(payment).toContain("const paymentResult = await applyStoreOrderPayment(this.container");
    expect(outbox).toContain("export async function enqueueOrderPaidEvent(");
    expect(outbox).toContain("return enqueueOrderPaidEvent(db, order, now);");
  });

  it("余额支付先锁订单并把资金、账单、付款状态和 outbox 原子提交", () => {
    const payment = readFileSync("src/services/order/StoreOrderPayService.ts", "utf8");
    expect(payment).toContain("export async function applyStoreOrderBalancePayment(");
    expect(payment).toContain('.where(eq(storeOrder.orderId, params.orderId))');
    expect(payment).toContain('.for("update")');
    expect(payment).toContain("await assertPinkOrderPayable(tx, order);");
    expect(payment).toContain("const payCents = decimalToCents(order.payPrice);");
    expect(payment).toContain("await debitRequiredOrderIntegral(tx, order, now);");
    expect(payment).toContain('eventKey: "order_pay_integral"');
    expect(payment).toContain("const result = await applyStoreOrderBalancePayment(this.container, { uid, orderId });");
    expect(payment).not.toContain("余额不足 (并发冲突)");
  });

  it("保留生产 PostgreSQL 临时 Schema 的并发、回滚和公共状态不变场景", () => {
    const scenario = readFileSync(
      "test/integration/StoreOrderPaymentCancelPostgresScenario.ts",
      "utf8",
    );
    expect(scenario).toContain("codex_pay_cancel_it_");
    expect(scenario).toContain("SET LOCAL lock_timeout = '3s'");
    expect(scenario).toContain("integration cancel status failure");
    expect(scenario).toContain("integration paid outbox failure");
    expect(scenario).toContain("Promise.allSettled([run(firstDb), run(secondDb)])");
    expect(scenario).toContain("payment/cancel race must have exactly one winner");
    expect(scenario).toContain("duplicate callbacks must have one paid transition");
    expect(scenario).toContain("duplicate balance payments must debit exactly once");
    expect(scenario).toContain("balance outbox failure did not roll back every write");
    expect(scenario).toContain("balance/cancel race must have exactly one winner");
    expect(scenario).toContain("zero-value balance payment wrote inconsistent evidence");
    expect(scenario).toContain("duplicate integral balance payments must debit money and points exactly once");
    expect(scenario).toContain("insufficient required integral was not rejected by a business guard");
    expect(scenario).toContain("DROP SCHEMA ${schemaIdentifier} CASCADE");
    expect(scenario).toContain("public business rows or sequences changed");
  });
});
