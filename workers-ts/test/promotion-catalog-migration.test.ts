import { readFileSync } from "node:fs";
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { MIGRATION_TABLES } from "../scripts/data-migration/manifest";
import { storePromotions, storePromotionsAuxiliary } from "../src/models/schema";

describe("promotion catalog migration", () => {
  it("preserves promotion rules without collapsing nullable legacy lists", () => {
    const promotions = getTableColumns(storePromotions);
    const auxiliary = getTableColumns(storePromotionsAuxiliary);

    expect(Object.keys(promotions)).toEqual(
      expect.arrayContaining([
        "pid",
        "promotionsType",
        "promotionsCate",
        "thresholdType",
        "threshold",
        "discountType",
        "nPieceNDiscount",
        "giveCouponId",
        "giveProductId",
        "giveProductUnique",
        "productPartakeType",
        "productId",
        "startTime",
        "stopTime",
      ]),
    );
    expect(promotions.threshold.getSQLType()).toBe("numeric(12, 2)");
    expect(promotions.discount.getSQLType()).toBe("numeric(12, 2)");
    expect(promotions.giveCouponId.notNull).toBe(false);
    expect(promotions.productId.notNull).toBe(false);

    expect(Object.keys(auxiliary)).toEqual([
      "id",
      "type",
      "promotionsId",
      "productPartakeType",
      "productId",
      "couponId",
      "brandId",
      "storeLabelId",
      "limitNum",
      "surplusNum",
      "isAll",
      "unique",
    ]);
    expect(auxiliary.unique.notNull).toBe(false);
  });

  it("copies promotion definitions before order evidence in the commerce phase", () => {
    const names = MIGRATION_TABLES.map((entry) => entry.table);
    for (const table of ["store_promotions", "store_promotions_auxiliary"]) {
      expect(MIGRATION_TABLES.find((entry) => entry.table === table)).toMatchObject({
        key: ["id"],
        phase: "commerce",
      });
    }
    expect(names.indexOf("store_promotions")).toBeLessThan(names.indexOf("store_order_promotions"));
    expect(names.indexOf("store_promotions_auxiliary")).toBeLessThan(
      names.indexOf("store_order_promotions"),
    );
  });

  it("enriches historical order promotion allocations with their rule snapshot source", () => {
    const source = readFileSync("src/services/order/StoreOrderCreateService.ts", "utf8");
    expect(source).toContain("select({ allocation: storeOrderPromotions, promotion: storePromotions })");
    expect(source).toContain(
      ".leftJoin(storePromotions, eq(storePromotions.id, storeOrderPromotions.promotionsId))",
    );
    expect(source).toContain("promotionsDetail: promotionsDetail.map(({ allocation, promotion })");
  });
});
