import { readFileSync } from "node:fs";
import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { MIGRATION_TABLES } from "../scripts/data-migration/manifest";
import { storeCouponIssueUser, storeCouponProduct } from "../src/models/schema";
import { reconcileCouponProductScopeIds } from "../src/services/activity/ProductCouponService";

describe("coupon relationship evidence migration", () => {
  it("preserves both source tables without inventing primary or unique keys", () => {
    expect(getTableName(storeCouponIssueUser)).toBe("store_coupon_issue_user");
    expect(getTableName(storeCouponProduct)).toBe("store_coupon_product");
    expect(Object.keys(getTableColumns(storeCouponIssueUser))).toEqual([
      "uid",
      "issueCouponId",
      "addTime",
    ]);
    expect(Object.keys(getTableColumns(storeCouponProduct))).toEqual([
      "couponId",
      "productId",
    ]);

    const migration = readFileSync("migrations/0062_coupon_relationship_evidence.sql", "utf8");
    const executableSql = migration.replace(/^--.*$/gm, "");
    expect(executableSql).not.toMatch(/PRIMARY KEY|UNIQUE/i);
    expect(MIGRATION_TABLES.find((entry) => entry.table === "store_coupon_issue_user")?.key)
      .toEqual([]);
    expect(MIGRATION_TABLES.find((entry) => entry.table === "store_coupon_product")?.key)
      .toEqual([]);
    expect(MIGRATION_TABLES.find((entry) => entry.table === "store_coupon_issue_user")?.copyStrategy)
      .toBe("append_multiset");
    expect(MIGRATION_TABLES.find((entry) => entry.table === "store_coupon_product")?.copyStrategy)
      .toBe("append_multiset");
  });

  it("uses relation rows when present and rejects drift from the encoded template scope", () => {
    expect(reconcileCouponProductScopeIds(["2,1"], [1, 2])).toEqual([1, 2]);
    expect(reconcileCouponProductScopeIds(["2,1"], [])).toEqual([1, 2]);
    expect(reconcileCouponProductScopeIds(["0"], [3, 4])).toEqual([3, 4]);
    expect(() => reconcileCouponProductScopeIds(["1,2"], [1, 3])).toThrow(
      "优惠券商品范围数据不一致",
    );
  });

  it("maintains product scope and claim evidence inside existing write transactions", () => {
    const admin = readFileSync("src/controllers/api/v1/AdminCrudController.ts", "utf8");
    const activity = readFileSync("src/services/activity/ActivityService.ts", "utf8");
    const grants = readFileSync("src/services/activity/ProductCouponService.ts", "utf8");
    const orders = readFileSync("src/services/order/StoreOrderCreateService.ts", "utf8");

    expect(admin).toContain('.for("update")');
    expect(admin).toContain("tx.delete(storeCouponProduct)");
    expect(admin).toContain("rawProductIds.map");
    expect(admin).toContain("legacyProductIds: productId");
    expect(admin).toContain("legacyCategoryId: Number(categoryId)");
    expect(admin).toContain("legacyBrandId: Number(brandId)");
    expect(activity).toContain("tx.insert(storeCouponIssueUser)");
    expect(grants).toContain("tx.insert(storeCouponIssueUser)");
    expect(orders).toContain(".from(storeCouponProduct)");
    expect(orders).toContain("reconcileCouponProductScopeIds");
  });
});
