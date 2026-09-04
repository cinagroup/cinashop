import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseVirtualDeliveryInfo,
  parseVirtualDeliverySnapshot,
} from "../src/services/order/VirtualProductDeliveryService";
import {
  customerRefundEligibility,
  type VirtualRefundCartSnapshot,
  type VirtualRefundOrderSnapshot,
} from "../src/services/order/VirtualProductRefundPolicy";

const refundableCardCart: VirtualRefundCartSnapshot = {
  id: 1,
  productId: 101,
  productType: 1,
  skuUnique: "VIRT0001",
  isSupportRefund: 1,
  writeTimes: 1,
  writeSurplusTimes: 1,
  cartInfo: JSON.stringify({ sku: { disk_info: "" } }),
};

const undeliveredOrder: VirtualRefundOrderSnapshot = {
  orderId: "virt-refund-1",
  status: 0,
  deliveryType: "",
  virtualInfo: null,
};

describe("虚拟卡密商品支付后自动交付", () => {
  it("只解析 PHP 兼容的卡密数组或密钥字符串", () => {
    expect(parseVirtualDeliveryInfo(JSON.stringify([
      { card_no: "CARD-001", card_pwd: "PWD-001" },
      {
        disk_info: "https://download.example/key",
        product_id: 8,
        sku_unique: "SKU00008",
        quantity: 1,
      },
    ]))).toEqual([
      { card_no: "CARD-001", card_pwd: "PWD-001" },
      {
        disk_info: "https://download.example/key",
        product_id: 8,
        sku_unique: "SKU00008",
        quantity: 1,
      },
    ]);
    expect(parseVirtualDeliveryInfo(JSON.stringify("密钥自动发放：ABC-123")))
      .toBe("密钥自动发放：ABC-123");
    expect(parseVirtualDeliveryInfo('{"card_no":"CARD-001"}')).toBeNull();
    expect(parseVirtualDeliveryInfo("not-json")).toBeNull();
    expect(parseVirtualDeliveryInfo("x".repeat(1024 * 1024 + 1))).toBeNull();
  });

  it("兼容新旧订单快照，并把空内容明确解释为卡库交付", () => {
    expect(parseVirtualDeliverySnapshot(JSON.stringify({
      sku: { disk_info: " checkout-secret " },
    }))).toEqual({ diskInfo: "checkout-secret" });
    expect(parseVirtualDeliverySnapshot(JSON.stringify({
      sku: { disk_info: "" },
    }))).toEqual({ diskInfo: "" });
    expect(parseVirtualDeliverySnapshot(JSON.stringify({
      productInfo: { attrInfo: { disk_info: "php-secret" } },
    }))).toEqual({ diskInfo: "php-secret" });
    expect(parseVirtualDeliverySnapshot(JSON.stringify({ sku: {} }))).toBeNull();
    expect(parseVirtualDeliverySnapshot(JSON.stringify({ sku: { disk_info: 1 } }))).toBeNull();
    expect(parseVirtualDeliverySnapshot("not-json")).toBeNull();
  });

  it("把原子领取接入既有可重放支付 outbox，而不是请求内浮动执行", () => {
    const outbox = readFileSync("src/services/order/OrderOutboxService.ts", "utf8");
    const delivery = readFileSync("src/services/order/VirtualProductDeliveryService.ts", "utf8");
    expect(outbox).toContain("await deliverPaidVirtualOrders(tx, allocation.fulfillmentOrders, now)");
    expect(delivery).toContain('.for("update", { skipLocked: true })');
    expect(delivery).toContain("eq(storeProductVirtual.uid, 0)");
    expect(delivery).toContain('deliveryType: "fictitious"');
    expect(delivery).toContain('changeType: "delivery_fictitious"');
    expect(delivery).toContain("parseVirtualDeliverySnapshot(cart.cartInfo)");
    expect(delivery).not.toContain("storeProductAttrValue.diskInfo");
    expect(delivery).not.toContain("Math.random");
  });

  it("在下单时拒绝陈旧商品类型、混单和自提，并免除虚拟商品运费", () => {
    const create = readFileSync("src/services/order/StoreOrderCreateService.ts", "utf8");
    expect(create).toContain("cart.productType !== product.productType");
    expect(create).toContain('productTypes.has(1) && productTypes.size > 1');
    expect(create).toContain('if (productTypes.size > 1)');
    expect(create).toContain('throw new ValidateException("不同履约类型商品不能同单购买")');
    expect(create).toContain("assertProductCheckoutShippingType(orderProductType, shippingType)");
    expect(create).toContain("![1, 2, 3].includes(orderProductType)");
    expect(create).toContain("[1, 2, 3].includes(product.productType)");
    expect(create).toContain('disk_info: sku.diskInfo ?? ""');
  });

  it("列表隐藏卡密，只有通过用户归属校验的详情才解码交付内容", () => {
    const create = readFileSync("src/services/order/StoreOrderCreateService.ts", "utf8");
    expect(create).toContain("virtualInfo: null");
    expect(create).toContain("parseVirtualDeliveryInfo(order.virtualInfo)");
    expect(create).toContain("parseVirtualDeliveryInfo(child.virtualInfo)");
  });

  it("只允许未发放卡密或可退款的固定内容走用户退款入口", () => {
    expect(customerRefundEligibility(undeliveredOrder, [refundableCardCart])).toEqual({
      allowed: true,
      reason: "",
    });
    expect(customerRefundEligibility(
      { ...undeliveredOrder, status: 1, deliveryType: "fictitious", virtualInfo: '[{"card_no":"CARD-1","card_pwd":"PWD-1"}]' },
      [refundableCardCart],
    )).toMatchObject({ allowed: false });
    expect(customerRefundEligibility(
      { ...undeliveredOrder, status: 1, deliveryType: "fictitious", virtualInfo: '[{"disk_info":"LICENSE","product_id":101,"sku_unique":"VIRT0001","quantity":1}]' },
      [{ ...refundableCardCart, cartInfo: JSON.stringify({ sku: { disk_info: "LICENSE" } }) }],
    )).toEqual({ allowed: true, reason: "" });
    expect(customerRefundEligibility(undeliveredOrder, [
      { ...refundableCardCart, isSupportRefund: 0 },
    ])).toMatchObject({ allowed: false });
    expect(customerRefundEligibility(undeliveredOrder, [
      { ...refundableCardCart, cartInfo: JSON.stringify({ sku: {} }) },
    ])).toMatchObject({ allowed: false });
  });

  it("把退款与发货竞争收敛到同一订单锁，并按已完成退款后的剩余数量发货", () => {
    const delivery = readFileSync("src/services/order/VirtualProductDeliveryService.ts", "utf8");
    const refund = readFileSync("src/services/order/StoreOrderRefundService.ts", "utf8");
    expect(delivery).toContain("storeOrderRefund.refundType, [0, 1, 2, 4, 5]");
    expect(delivery).toContain("const deliveryQuantity = cart.cartNum - cart.refundNum");
    expect(delivery).toContain('存在进行中的退款申请，暂不自动发货');
    expect(delivery.indexOf("const currentRows")).toBeLessThan(delivery.indexOf("const carts"));
    expect(refund).toContain("assertVirtualProductRefundPolicy");
    expect(refund).toContain('allowIrreversibleSecretRefund: params.privilegedActor === "admin"');
  });

  it("保留生产 Hyperdrive 并发、回滚、重试与共享密钥场景", () => {
    const scenario = readFileSync(
      "test/integration/VirtualProductDeliveryPostgresScenario.ts",
      "utf8",
    );
    expect(scenario).toContain("Promise.allSettled");
    expect(scenario).toContain("concurrent_single_winner");
    expect(scenario).toContain("partial_claim_rolled_back");
    expect(scenario).toContain("disk_info_delivered_without_card");
    expect(scenario).toContain("public_unchanged: true");
  });

  it("生产退款审计只写随机 schema，并强制验证授权、清理与 public 不变", () => {
    const scenario = readFileSync(
      "test/integration/VirtualCardRefundPostgresScenario.ts",
      "utf8",
    );
    const worker = readFileSync(
      "test/integration/VirtualCardRefundAuditWorker.ts",
      "utf8",
    );
    const runner = readFileSync(
      "scripts/run-virtual-card-refund-production-audit.ps1",
      "utf8",
    );
    expect(scenario).toContain("CREATE SCHEMA");
    expect(scenario).toContain("DROP SCHEMA");
    expect(scenario).toContain("public_state_unchanged");
    expect(scenario).toContain("assigned_card_never_recycled");
    expect(worker).toContain("AUDIT_TOKEN_SHA256");
    expect(worker).toContain('request.method !== "POST"');
    expect(runner).toContain("wrangler delete");
    expect(runner).toContain("url_returns_404");
  });
});
