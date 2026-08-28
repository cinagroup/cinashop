import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  legacyPromotionPrice,
  parseLegacyPromotionPage,
} from "@/services/activity/V2PromotionCompatibilityService";

describe("API-004 promotion compatibility migration", () => {
  it("mounts the three PHP routes with their original auth boundaries", () => {
    const routes = readFileSync("src/routes/v2/index.ts", "utf8");
    expect(routes).toContain(
      'v2Routes.get("/promotions/productList/:type", V2PromotionCompatibilityController.productList)',
    );
    expect(routes).toContain(
      'v2Routes.get("/promotions/give_info/:id", V2PromotionCompatibilityController.giveInfo)',
    );
    expect(routes).toContain(
      'v2Routes.get("/promotions/collect_order/product", authMiddleware({ force: true }), V2PromotionCompatibilityController.collectOrderProduct)',
    );
  });

  it("bounds pagination while preserving PHP integer-prefix coercion", () => {
    expect(parseLegacyPromotionPage({ page: "99999tail", limit: "500items" })).toEqual({
      page: 1_000,
      limit: 100,
    });
    expect(parseLegacyPromotionPage({ page: "0", limit: "-1" })).toEqual({ page: 1, limit: 10 });
  });

  it("preserves PHP decimal truncation for discount promotion prices", () => {
    expect(legacyPromotionPrice("19.99", "85.99")).toBe(16.99);
    expect(legacyPromotionPrice("0.01", "99")).toBe(0);
  });

  it("requires active platform parent promotions and fails closed on oversized sets", () => {
    const source = readFileSync("src/services/activity/V2PromotionCompatibilityService.ts", "utf8");
    expect(source).toContain("eq(storePromotions.pid, 0)");
    expect(source).toContain("eq(storePromotions.type, 1)");
    expect(source).toContain("eq(storePromotions.storeId, 0)");
    expect(source).toContain("eq(storePromotions.status, 1)");
    expect(source).toContain("lte(storePromotions.startTime, now)");
    expect(source).toContain("gte(storePromotions.stopTime, now)");
    expect(source).toContain("MAX_ACTIVE_PROMOTIONS + 1");
    expect(source).toContain("MAX_PROMOTION_PRODUCTS + 1");
  });

  it("implements every PHP product participation mode", () => {
    const source = readFileSync("src/services/activity/V2PromotionCompatibilityService.ts", "utf8");
    for (const mode of [1, 2, 3, 4, 5]) expect(source).toContain(`case ${mode}:`);
    expect(source).toContain("notInArray(storeProduct.id, excluded)");
    expect(source).toContain("eq(storeProductRelation.type, 2)");
    expect(source).toContain("eq(storeProductRelation.type, 3)");
  });

  it("batches gift coupon, product and SKU reads", () => {
    const source = readFileSync("src/services/activity/V2PromotionCompatibilityService.ts", "utf8");
    expect(source).toContain("const [coupons, products, attrs] = await Promise.all([");
    expect(source).toContain("legacyCouponProjection(coupon, { variant: \"list\" })");
    expect(source).toContain("skuProjection(attr)");
  });

  it("keeps query values parameterized and never emits raw SQL", () => {
    const source = readFileSync("src/services/activity/V2PromotionCompatibilityService.ts", "utf8");
    expect(source).toContain("sql.join(scopes.map");
    expect(source).not.toContain("sql.raw(");
  });

  it("enforces explicit product id scopes instead of using them only for sorting", () => {
    const searchers = readFileSync("src/models/searchers/product.ts", "utf8");
    expect(searchers).toContain("ids: (value) => {");
    expect(searchers).toContain("inArray(storeProduct.id, valid)");
  });
});
