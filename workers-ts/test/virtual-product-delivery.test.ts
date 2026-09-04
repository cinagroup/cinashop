import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseVirtualDeliveryInfo } from "../src/services/order/VirtualProductDeliveryService";

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

  it("把原子领取接入既有可重放支付 outbox，而不是请求内浮动执行", () => {
    const outbox = readFileSync("src/services/order/OrderOutboxService.ts", "utf8");
    const delivery = readFileSync("src/services/order/VirtualProductDeliveryService.ts", "utf8");
    expect(outbox).toContain("await deliverPaidVirtualOrders(tx, allocation.fulfillmentOrders, now)");
    expect(delivery).toContain('.for("update", { skipLocked: true })');
    expect(delivery).toContain("eq(storeProductVirtual.uid, 0)");
    expect(delivery).toContain('deliveryType: "fictitious"');
    expect(delivery).toContain('changeType: "delivery_fictitious"');
    expect(delivery).not.toContain("Math.random");
  });

  it("在下单时拒绝陈旧商品类型、混单和自提，并免除虚拟商品运费", () => {
    const create = readFileSync("src/services/order/StoreOrderCreateService.ts", "utf8");
    expect(create).toContain("cart.productType !== product.productType");
    expect(create).toContain('productTypes.has(1) && productTypes.size > 1');
    expect(create).toContain('if (productTypes.size > 1)');
    expect(create).toContain('throw new ValidateException("不同履约类型商品不能同单购买")');
    expect(create).toContain('throw new ValidateException("卡密商品无需到店自提")');
    expect(create).toContain("![1, 2, 3].includes(orderProductType)");
    expect(create).toContain("[1, 2, 3].includes(product.productType)");
  });

  it("列表隐藏卡密，只有通过用户归属校验的详情才解码交付内容", () => {
    const create = readFileSync("src/services/order/StoreOrderCreateService.ts", "utf8");
    expect(create).toContain("virtualInfo: null");
    expect(create).toContain("parseVirtualDeliveryInfo(order.virtualInfo)");
    expect(create).toContain("parseVirtualDeliveryInfo(child.virtualInfo)");
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
});
