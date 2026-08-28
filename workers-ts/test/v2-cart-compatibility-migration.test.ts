import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseLegacyProductAttrValues } from "../src/services/product/StoreProductService";

describe("API v2 cart compatibility migration", () => {
  it("mounts all four PHP routes behind the original authenticated boundary", () => {
    const routes = readFileSync("src/routes/v2/index.ts", "utf8");
    for (const route of [
      'v2Routes.post("/reset_cart", authMiddleware({ force: true })',
      'v2Routes.get("/cart_list", authMiddleware({ force: true })',
      'v2Routes.get("/get_attr/:id/:type", authMiddleware({ force: true })',
      'v2Routes.post("/set_cart_num", authMiddleware({ force: true })',
    ]) expect(routes).toContain(route);
  });

  it("accepts both historical attribute encodings used by production rows", () => {
    expect(parseLegacyProductAttrValues('["陶瓷黑","影青灰"]')).toEqual(["陶瓷黑", "影青灰"]);
    expect(parseLegacyProductAttrValues("8GB+128GB, 12GB+256GB")).toEqual([
      "8GB+128GB",
      "12GB+256GB",
    ]);
    expect(parseLegacyProductAttrValues("  ")).toEqual([]);
  });

  it("keys legacy productValue by suk and exposes snake_case SKU fields", () => {
    const source = readFileSync("src/services/product/StoreProductService.ts", "utf8");
    expect(source).toContain("Object.fromEntries(skus.map((sku) => [sku.suk");
    expect(source).toContain("product_id: sku.productId");
    expect(source).toContain("product_stock: sku.stock");
    expect(source).toContain("cart_num: cartQuantity.get(sku.unique) ?? 0");
  });

  it("serializes writes per user and keeps every mutation owner-scoped", () => {
    const service = readFileSync("src/services/order/StoreCartService.ts", "utf8");
    expect(service).toContain("pg_advisory_xact_lock");
    expect(service).toContain("eq(storeCart.uid, params.uid)");
    expect(service).toContain("eq(storeCart.isNew, 0)");
    expect(service).toContain("eq(storeCart.activityId, 0)");
    expect(service).toContain("setNormalNumByProductLegacy");
    expect(service).not.toContain("tx.delete(storeCart)");
  });

  it("restores the v1 type=2 product-id quantity contract", () => {
    const controller = readFileSync("src/controllers/api/v1/OrderController.ts", "utf8");
    expect(controller).toContain("Number(body.type ?? 1) === 2");
    expect(controller).toContain("svc.setNormalNumByProductLegacy(uid, id, quantity)");
    expect(controller).toContain("body.cartNum ?? body.number ?? 1");
  });
});
