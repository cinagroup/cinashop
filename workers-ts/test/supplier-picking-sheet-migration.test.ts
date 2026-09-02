import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { requiredSupplierPermissions } from "@/services/supplier/SupplierPermissionService";
import {
  normalizeSupplierPickingSheetIds,
  projectPickingSheetCartItem,
} from "@/services/supplier/SupplierService";

describe("supplier picking-sheet migration", () => {
  it("accepts one to ten distinct positive order ids and rejects ambiguous ranges", () => {
    expect(normalizeSupplierPickingSheetIds("7, 9,11")).toEqual([7, 9, 11]);
    expect(() => normalizeSupplierPickingSheetIds(undefined)).toThrow("请选择");
    expect(() => normalizeSupplierPickingSheetIds("1,1")).toThrow("不能重复");
    expect(() => normalizeSupplierPickingSheetIds("1,nope")).toThrow("格式错误");
    expect(() => normalizeSupplierPickingSheetIds(Array.from({ length: 11 }, (_, index) => index + 1).join(",")))
      .toThrow("最多预览10个订单");
  });

  it("projects both legacy and current bounded cart snapshots without trusting markup", () => {
    expect(projectPickingSheetCartItem({
      cartNum: 2,
      skuUnique: "fallback",
      settlePrice: "8.00",
      cartInfo: JSON.stringify({
        sum_price: "12.34",
        truePrice: "12.34",
        productInfo: { store_name: "保温杯\u0000", attrInfo: { suk: "黑色" } },
      }),
    }, 1)).toEqual({
      index: 1,
      product_name: "保温杯",
      sku: "黑色",
      unit_price: "12.34",
      quantity: 2,
      subtotal: "24.68",
    });
    expect(projectPickingSheetCartItem({
      cartNum: 3,
      skuUnique: "fallback",
      settlePrice: "8.00",
      cartInfo: JSON.stringify({ product: { storeName: "耳机" }, sku: { suk: "白色", price: "9.50" } }),
    }, 2)).toMatchObject({ product_name: "耳机", sku: "白色", subtotal: "28.50" });
  });

  it("registers the exact legacy read contract behind order-view permission", () => {
    const routes = readFileSync("src/routes/supplierapi.ts", "utf8");
    expect(routes).toContain('get("/order/distribution_info", SupplierController.pickingSheets)');
    expect(requiredSupplierPermissions("GET", "/supplierapi/order/distribution_info"))
      .toEqual(["supplier.order.view"]);
  });

  it("fails the entire batch closed unless every order belongs to the authenticated Supplier", () => {
    const service = readFileSync("src/services/supplier/SupplierService.ts", "utf8");
    expect(service).toContain("inArray(storeOrder.id, ids)");
    expect(service).toContain("eq(storeOrder.supplierId, supplierId)");
    expect(service).toContain("eq(storeOrder.isSystemDel, 0)");
    expect(service).toContain("if (orders.length !== ids.length)");
    expect(service).toContain("MAX_PICKING_SNAPSHOT_BYTES = 256 * 1024");
    expect(service).toContain("octet_length(${storeOrderCartInfo.cartInfo})");
    expect(service).toContain("vip_true_price: projectedCarts");
  });

  it("connects single and selected-order entries to a standalone printable page", () => {
    const api = readFileSync("../view/supplier-ts/src/api/supplier.ts", "utf8");
    const orders = readFileSync("../view/supplier-ts/src/pages/Orders.vue", "utf8");
    const router = readFileSync("../view/supplier-ts/src/router.ts", "utf8");
    const page = readFileSync("../view/supplier-ts/src/pages/PickingSheets.vue", "utf8");
    expect(api).toContain('url: "/order/distribution_info"');
    expect(orders).toContain("openPickingSheets(selectedOrders)");
    expect(orders).toContain("openPickingSheets([scope.row])");
    expect(orders).toContain('window.open(target.href, "_blank", "noopener,noreferrer")');
    expect(router).toContain('path: "/orders/picking-sheet"');
    expect(router).toContain('permission: "supplier.order.view"');
    expect(page).toContain("window.print()");
    expect(page).toContain("每页最多6条商品");
    expect(page).toContain("@page { size: A4 portrait");
    expect(page).not.toContain("qrcodejs2");
  });
});
