import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseKefuOrderPage,
  parseKefuOrderStatus,
} from "../src/services/kefu/KefuOrderService";
import { normalizeKefuDeliveryInput } from "../src/services/kefu/KefuFulfillmentService";
import {
  parseKefuOrderEditInput,
  parseKefuRefundDecisionInput,
} from "../src/services/kefu/KefuOrderManagementService";

describe("customer-service order/refund context migration", () => {
  it("keeps PHP status values while bounding page inputs", () => {
    expect(parseKefuOrderPage(undefined)).toBe(1);
    expect(parseKefuOrderPage("30")).toBe(30);
    expect(() => parseKefuOrderPage("0")).toThrow("页码错误");
    expect(() => parseKefuOrderPage("1000001")).toThrow("页码错误");
    expect(parseKefuOrderStatus("")).toBeNull();
    expect(parseKefuOrderStatus("-1")).toBe(-1);
    expect(parseKefuOrderStatus("9")).toBe(9);
    expect(() => parseKefuOrderStatus("10")).toThrow("订单状态错误");
  });

  it("keeps the external and Worker-embedded partial indexes byte-equivalent", () => {
    const migration = readFileSync("migrations/0096_kefu_order_context_indexes.sql", "utf8").trim();
    const embedded = readFileSync("src/services/MigrationService.ts", "utf8")
      .match(/private migration_0103\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    expect(embedded).toBe(migration);
    expect(migration).toContain('"so_kefu_customer_orders"');
    expect(migration).toContain('"sor_kefu_customer_refunds"');
    expect(migration).toContain('WHERE "is_system_del" = 0');
    expect(migration).toContain('WHERE "is_cancel" = 0 AND "is_del" = 0');
  });

  it("closes PHP order/refund ownership gaps without exposing secret fields", () => {
    const service = readFileSync("src/services/kefu/KefuOrderService.ts", "utf8");
    expect(service).toContain("await assertKefuConversation(this.container, kefuUid, uid, 0)");
    expect(service).toContain("this.ownedOrderConversation(kefuUid)");
    expect(service).toContain("this.ownedRefundConversation(kefuUid)");
    expect(service).toContain("inArray(storeOrderRefund.uid, assigned)");
    expect(service).toContain("eq(storeServiceRecord.userId, kefuUid)");
    expect(service).toContain("eq(storeServiceRecord.isTourist, 0)");
    expect(service).not.toContain("verify_code:");
    expect(service).not.toContain("user_ip:");
    expect(service).not.toContain("pwd:");
  });

  it("batch-loads carts/refunds and retains the PHP type=-1 after-sale branch", () => {
    const service = readFileSync("src/services/kefu/KefuOrderService.ts", "utf8");
    expect(service).toContain("if (status === -1) return this.customerRefunds");
    expect(service).toContain("this.cartsByOrder(orderIds)");
    expect(service).toContain("this.refundsByOrder(orderIds)");
    expect(service).toContain("inArray(storeOrder.refundType, [...CUSTOMER_ORDER_REFUND_TYPES])");
    expect(service).toContain("inArray(storeOrderRefund.refundType, [...ACTIVE_REFUND_TYPES])");
  });

  it("parses exact order-edit amounts while keeping disabled PHP fields read-only", () => {
    expect(parseKefuOrderEditInput({
      order_id: "wx123456",
      total_price: "18.60",
      total_postage: 2,
      pay_postage: "2.00",
      pay_price: "16.35",
      gain_integral: "12",
    })).toEqual({
      orderId: "wx123456",
      payPriceCents: 1635,
      gainIntegral: 12,
      readonlyValues: {
        totalPriceCents: 1860,
        totalPostageCents: 200,
        payPostageCents: 200,
      },
    });
    expect(() => parseKefuOrderEditInput({ order_id: "wx123", pay_price: "1.001", gain_integral: 1 }))
      .toThrow("实际支付金额格式错误");
    expect(() => parseKefuOrderEditInput({ order_id: "wx123", pay_price: "1.00", gain_integral: "1.5" }))
      .toThrow("赠送积分必须是非负整数");
    expect(() => parseKefuOrderEditInput({ order_id: "wx-123", pay_price: "1.00", gain_integral: 1 }))
      .toThrow("订单编号格式错误");
    expect(() => parseKefuOrderEditInput({ order_id: "wx123", pay_price: "10000000000.00", gain_integral: 1 }))
      .toThrow("实际支付金额超出允许范围");
  });

  it("binds customer-service money refunds to one exact authoritative amount", () => {
    expect(parseKefuRefundDecisionInput({ refund_price: "44.91" })).toEqual({
      type: 1,
      refundPriceCents: 4491,
    });
    expect(parseKefuRefundDecisionInput({ type: "1", refund_price: 0 })).toEqual({
      type: 1,
      refundPriceCents: 0,
    });
    expect(() => parseKefuRefundDecisionInput({ type: 2, refund_price: "44.91" }))
      .toThrow("仅接受同意操作");
    expect(() => parseKefuRefundDecisionInput({ refund_price: "44.911" }))
      .toThrow("退款金额格式错误");
    expect(() => parseKefuRefundDecisionInput({})).toThrow("请输入退款金额");
  });

  it("registers management and refund decisions behind kefu auth", () => {
    const routes = readFileSync("src/routes/kefuapi.ts", "utf8");
    const service = readFileSync("src/services/kefu/KefuOrderManagementService.ts", "utf8");
    for (const route of [
      'get("/order/edit/:id"',
      'put("/order/update/:id"',
      'post("/order/remark"',
      'get("/order/refund_form/:id"',
      'post("/refund/remark/:id"',
      'get("/refund/refund/:id"',
      'put("/refund/agree/:id"',
      'put("/refund/refund/:id"',
    ]) expect(routes).toContain(route);
    expect(routes.indexOf('use("*", kefuAuthMiddleware)')).toBeLessThan(routes.indexOf('get("/order/edit/:id"'));
    expect(service).toContain("pg_advisory_xact_lock");
    expect(service).toContain("for(\"update\")");
    expect(service).toContain('changeType: "order_edit"');
    expect(service).toContain('changeType: "kefu_order_remark"');
    expect(service).toContain('changeType: "kefu_refund_remark"');
    expect(service).toContain('changeType: "kefu_refund_return"');
    expect(service).toContain("expectedRefundedAmountCents: completedReplay ? authorizedCents : 0");
    expect(service).toContain("authorizeBeforeRefundLock");
    expect(service).toContain("await lockKefuConversationOwnership(tx, kefuUid, current.uid)");
    expect(service).toContain("退款金额与售后单权威金额不一致");
    expect(service).toContain("历史部分退款");
    expect(service).not.toContain("set({ totalPrice");
  });

  it("records evidence-backed retirements without hiding them from raw coverage", () => {
    const decisions = JSON.parse(readFileSync("audit/legacy-route-decisions.json", "utf8"));
    const audit = readFileSync("scripts/route-parity-audit.ts", "utf8");
    expect(decisions.decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "POST", path: "/kefuapi/order/refund", status: "retired" }),
      expect.objectContaining({ method: "GET", path: "/kefuapi/refund/agree/:order_id", status: "retired" }),
    ]));
    expect(decisions.decisions.every((item: { evidence?: string[] }) => item.evidence?.length)).toBe(true);
    expect(audit).toContain("actionableMissingRoutes");
    expect(audit).toContain("effectiveExecutableCoveragePercent");
    expect(audit).toContain("Retired routes remain in the raw PHP denominator");
  });

  it("normalizes manual express, registered delivery, and virtual fulfillment inputs", () => {
    expect(normalizeKefuDeliveryInput({
      type: 1,
      express_record_type: 1,
      delivery_name: " 顺丰速运 ",
      delivery_code: "SF",
      delivery_id: "SF123",
    })).toEqual({
      deliveryType: "express",
      deliveryName: "顺丰速运",
      deliveryCode: "SF",
      deliveryId: "SF123",
      fictitiousContent: "",
      deliveryUid: 0,
      expressRecordType: 1,
    });
    expect(normalizeKefuDeliveryInput({ type: 2, sh_delivery_uid: "31" })).toMatchObject({
      deliveryType: "send",
      deliveryUid: 31,
    });
    expect(normalizeKefuDeliveryInput({ type: 3, fictitious_content: "卡密已通过私信发送" }))
      .toMatchObject({ deliveryType: "fictitious", fictitiousContent: "卡密已通过私信发送" });
    expect(() => normalizeKefuDeliveryInput({
      type: 1,
      express_record_type: 2,
      delivery_name: "顺丰速运",
      delivery_id: "SF123",
    })).toThrow("可重试面单任务");
    expect(() => normalizeKefuDeliveryInput({ type: 2, delivery_type: 2, sh_delivery_uid: 31 }))
      .toThrow("第三方同城配送");
  });

  it("registers fulfillment/writeoff contracts with transfer-safe authorization and audit", () => {
    const routes = readFileSync("src/routes/kefuapi.ts", "utf8");
    const fulfillment = readFileSync("src/services/kefu/KefuFulfillmentService.ts", "utf8");
    const ownership = readFileSync("src/services/kefu/KefuOwnership.ts", "utf8");
    const supplier = readFileSync("src/services/supplier/SupplierFulfillmentService.ts", "utf8");
    const writeoff = readFileSync("src/services/order/StoreOrderWriteoffService.ts", "utf8");
    for (const route of [
      'post("/order/delivery/:id"',
      'get("/order/export"',
      'get("/order/delivery_all"',
      'get("/order/delivery_info"',
      'get("/order/verific/:id"',
      'get("/order/writeOff/cartInfo"',
      'put("/order/write_update/:order_id"',
      'get("/order/split_cart_info/:id"',
      'put("/order/split_delivery/:id"',
    ]) expect(routes).toContain(route);
    expect(routes.indexOf('use("*", kefuAuthMiddleware)')).toBeLessThan(
      routes.indexOf('post("/order/delivery/:id"'),
    );
    expect(fulfillment).toContain("authorize: this.fulfillmentAuthorization(kefuUid, input)");
    expect(fulfillment).toContain('changeType: "kefu_order_delivery"');
    expect(fulfillment).toContain('changeType: "kefu_order_split_delivery"');
    const lockBody = ownership.slice(ownership.indexOf("export async function lockKefuConversationOwnership"));
    expect(lockBody.indexOf("${KEFU_TRANSFER_LOCK_NAMESPACE}")).toBeLessThan(
      lockBody.indexOf("${KEFU_CHAT_LOCK_NAMESPACE}"),
    );
    expect(supplier.indexOf("await authorize?.(tx")).toBeLessThan(
      supplier.indexOf("await lockOrderSettlement(tx, rootId)"),
    );
    expect(supplier).toContain("await generatePickupVerifyCode(tx, order.id)");
    expect(writeoff).toContain('| { kind: "kefu"; kefuId: number; kefuUid: number }');
    expect(writeoff.indexOf("await lockKefuConversationOwnership(tx")).toBeLessThan(
      writeoff.indexOf("await lockOrderSettlement(tx, candidates[0].id)"),
    );
    expect(writeoff).toContain('changeType: "kefu_order_writeoff"');
  });
});
