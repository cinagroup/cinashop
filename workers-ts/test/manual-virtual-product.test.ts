import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertManualOrderDeliveryType,
  assertProductCheckoutShippingType,
} from "@/services/order/ManualVirtualDeliveryPolicy";
import { customerVisibleManualVirtualContent } from "@/services/order/StoreOrderCreateService";

describe("E5E3 manual virtual product migration", () => {
  it("binds each immutable product type to its permitted manual delivery channel", () => {
    expect(() => assertManualOrderDeliveryType(3, "fictitious")).not.toThrow();
    expect(() => assertManualOrderDeliveryType(3, "express"))
      .toThrow("手工虚拟商品只能使用虚拟交付");
    expect(() => assertManualOrderDeliveryType(0, "fictitious"))
      .toThrow("实物商品不能使用虚拟交付");
    expect(() => assertManualOrderDeliveryType(0, "express")).not.toThrow();
    expect(() => assertManualOrderDeliveryType(0, "send")).not.toThrow();
    expect(() => assertManualOrderDeliveryType(1, "express"))
      .toThrow("卡密商品由支付任务自动交付");
    expect(() => assertManualOrderDeliveryType(4, "express"))
      .toThrow("次卡商品必须使用到店核销");
    expect(() => assertManualOrderDeliveryType(2, "express"))
      .toThrow("当前商品履约类型不支持手工发货");
  });

  it("rejects pickup checkout for every legacy non-logistics product type", () => {
    for (const productType of [1, 2, 3]) {
      expect(() => assertProductCheckoutShippingType(productType, 2))
        .toThrow("虚拟商品无需到店自提");
      expect(() => assertProductCheckoutShippingType(productType, 1)).not.toThrow();
    }
    expect(() => assertProductCheckoutShippingType(0, 2)).not.toThrow();
    expect(() => assertProductCheckoutShippingType(4, 2)).not.toThrow();
  });

  it("reveals manual content only after a paid type-three order is virtually delivered", () => {
    const delivered = {
      paid: 1,
      status: 1,
      productType: 3,
      deliveryType: "fictitious",
      fictitiousContent: "下载地址：https://example.test/file\n提取码：CINA",
    };
    expect(customerVisibleManualVirtualContent(delivered)).toBe(delivered.fictitiousContent);
    for (const override of [
      { paid: 0 },
      { status: 0 },
      { productType: 0 },
      { productType: 1 },
      { deliveryType: "express" },
    ]) {
      expect(customerVisibleManualVirtualContent({ ...delivered, ...override })).toBe("");
    }
  });

  it("keeps type-three checkout non-logistics and refund behavior snapshot-driven", () => {
    const checkout = readFileSync("src/services/order/StoreOrderCreateService.ts", "utf8");
    const refund = readFileSync("src/services/order/StoreOrderRefundService.ts", "utf8");
    expect(checkout).toContain("assertProductCheckoutShippingType(orderProductType, shippingType)");
    expect(checkout).toContain("[1, 2, 3].includes(product.productType)");
    expect(checkout).toContain("isSupportRefund:");
    expect(checkout).toContain("product.isSupportRefund");
    expect(checkout.match(/productType === 1 && .*deliveryType === \"fictitious\"/g)).toHaveLength(2);
    expect(refund).toContain("cart.isSupportRefund !== 1");
    expect(refund).toContain("所选商品不支持退款");
  });

  it("enforces the same policy in Admin and Supplier fulfillment and emits the legacy event type", () => {
    const admin = readFileSync("src/controllers/api/v1/AdminCrudController.ts", "utf8");
    const supplier = readFileSync("src/services/supplier/SupplierFulfillmentService.ts", "utf8");
    expect(admin).toContain("assertManualOrderDeliveryType(order.productType, deliveryType");
    expect(admin).toContain("请输入虚拟交付内容");
    expect(admin).toContain('"delivery_fictitious"');
    expect(supplier).toContain("assertManualOrderDeliveryType(order.productType, input.deliveryType)");
    expect(supplier).toContain("手工虚拟商品不支持拆分发货");
    expect(supplier).toContain("enqueueOrderDeliveryNoticeEvent");
  });

  it("wires type-three authoring, fulfillment, and type-aware customer presentation", () => {
    const adminForm = readFileSync("../view/admin-ts/src/pages/product/ProductForm.vue", "utf8");
    const adminOrders = readFileSync("../view/admin-ts/src/pages/order/OrderList.vue", "utf8");
    const supplierForm = readFileSync("../view/supplier-ts/src/pages/ProductForm.vue", "utf8");
    const supplierOrders = readFileSync("../view/supplier-ts/src/pages/Orders.vue", "utf8");
    const pc = readFileSync("../view/pc-ts/src/pages/order/OrderDetail.vue", "utf8");
    const uniapp = readFileSync("../view/uniapp-ts/src/pages/order/detail.vue", "utf8");
    for (const form of [adminForm, supplierForm]) {
      expect(form).toContain("手工虚拟");
      expect(form).toContain("is_support_refund");
    }
    expect(adminOrders).toContain("row.productType === 3");
    expect(supplierOrders).toContain("isManualVirtualOrder");
    for (const customer of [pc, uniapp]) {
      expect(customer).toContain("fictitious_content");
      expect(customer).toContain("product_type === 1 && Array.isArray");
      expect(customer).toContain("已人工交付");
      expect(customer).toContain("虚拟商品已交付");
    }
  });

  it("keeps production verification isolated, authenticated, and self-cleaning", () => {
    const productScenario = readFileSync(
      "test/integration/SupplierProductSkuLifecyclePostgresScenario.ts",
      "utf8",
    );
    const orderScenario = readFileSync(
      "test/integration/ManualVirtualProductPostgresScenario.ts",
      "utf8",
    );
    const worker = readFileSync(
      "test/integration/ManualVirtualProductAuditWorker.ts",
      "utf8",
    );
    const config = readFileSync(
      "test/integration/manual-virtual-product-audit.wrangler.jsonc",
      "utf8",
    );
    const runner = readFileSync(
      "scripts/run-manual-virtual-product-production-audit.ps1",
      "utf8",
    );
    for (const assertion of [
      "supplier_manual_virtual_created",
      "supplier_manual_virtual_forced_no_logistics",
      "supplier_manual_virtual_stock_verified",
      "supplier_manual_virtual_refund_policy",
      "supplier_manual_virtual_retirement_verified",
      "supplier_manual_virtual_restore_verified",
    ]) expect(productScenario).toContain(assertion);
    for (const assertion of [
      "persisted_manual_delivery",
      "customer_content_visible_after_delivery",
      "immutable_outbox_verified",
      "manual_express_rejected",
      "physical_virtual_rejected",
      "card_manual_rejected",
      "second_card_manual_rejected",
      "refundable_application_verified",
      "refund_application_idempotent",
      "non_refundable_application_rejected",
      "public_state_unchanged",
    ]) expect(orderScenario).toContain(assertion);
    expect(orderScenario).toContain("searchPath: schema");
    expect(orderScenario).toContain("DROP SCHEMA IF EXISTS");
    expect(worker).toContain("crypto.subtle.timingSafeEqual");
    expect(worker).toContain("runManualVirtualProductPostgresScenario");
    expect(config).toContain('"id": "9748c294e21c49a99579c9cef70102e0"');
    expect(config).toContain('"global_fetch_strictly_public"');
    expect(runner.match(/Invoke-RestMethod -Method Post/g)).toHaveLength(1);
    expect(runner).toContain("} finally {");
    expect(runner).toContain("wrangler delete");
    expect(runner).toContain("url_returns_404");
  });
});
