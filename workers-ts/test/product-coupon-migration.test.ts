import { readFileSync } from "node:fs";
import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { MIGRATION_TABLES } from "../scripts/data-migration/manifest";
import { storeProductCoupon } from "../src/models/schema";
import { requiredAdminPermission } from "../src/services/admin/AdminPermissionService";
import {
  calculateCouponDiscountCents,
  calculateCouponEligibleSubtotalCents,
  parseCouponScopeIds,
  type CouponScopeItem,
} from "../src/services/activity/ProductCouponService";

const items: CouponScopeItem[] = [
  {
    productId: 11,
    parentProductId: 10,
    categoryIds: [101],
    categoryAncestorIds: [100],
    brandId: 5,
    brandAncestorIds: [4],
    subtotalCents: 1_001,
  },
  {
    productId: 22,
    parentProductId: 22,
    categoryIds: [202],
    categoryAncestorIds: [200],
    brandId: 8,
    brandAncestorIds: [],
    subtotalCents: 2_000,
  },
];

describe("product coupon migration", () => {
  it("preserves the exact five-column source contract and stable key", () => {
    expect(getTableName(storeProductCoupon)).toBe("store_product_coupon");
    expect(Object.keys(getTableColumns(storeProductCoupon))).toEqual([
      "id",
      "productId",
      "issueCouponId",
      "addTime",
      "title",
    ]);
    const spec = MIGRATION_TABLES.find((entry) => entry.table === "store_product_coupon");
    expect(spec?.key).toEqual(["id"]);
    expect(spec?.note).toContain("duplicate links");
    const migration = readFileSync("migrations/0052_product_coupon_grants.sql", "utf8");
    expect(migration).not.toContain("CREATE UNIQUE INDEX");
    expect(migration).toContain('ON "store_product_coupon" ("product_id", "id")');
  });

  it("matches general, product-parent, category-ancestor, and brand-ancestor scopes", () => {
    const subtotal = (scopeType: number, productIds: number[], categoryIds: number[], brandIds: number[]) =>
      calculateCouponEligibleSubtotalCents({ scopeType, productIds, categoryIds, brandIds, items });
    expect(subtotal(0, [], [], [])).toBe(3_001);
    expect(subtotal(2, [10], [], [])).toBe(1_001);
    expect(subtotal(1, [], [100], [])).toBe(1_001);
    expect(subtotal(3, [], [], [4])).toBe(1_001);
    expect(subtotal(2, [999], [], [])).toBe(0);
    expect(parseCouponScopeIds("[3, 4]", "4,5", 6, 0)).toEqual([3, 4, 5, 6]);
  });

  it("calculates full-reduction and discount coupons with exact integer cents", () => {
    expect(calculateCouponDiscountCents({
      discountType: 1,
      couponPrice: "12.34",
      eligibleSubtotalCents: 2_000,
    })).toBe(1_234);
    expect(calculateCouponDiscountCents({
      discountType: 2,
      couponPrice: "8.50",
      eligibleSubtotalCents: 1_001,
    })).toBe(150);
    expect(calculateCouponDiscountCents({
      discountType: 2,
      couponPrice: "10.00",
      eligibleSubtotalCents: 1_001,
    })).toBe(0);
    expect(() => calculateCouponDiscountCents({
      discountType: 2,
      couponPrice: "10.01",
      eligibleSubtotalCents: 1_001,
    })).toThrow("不超过10折");
  });

  it("enforces coupon scope at order creation and grants links inside paid outbox", () => {
    const createOrder = readFileSync("src/services/order/StoreOrderCreateService.ts", "utf8");
    const outbox = readFileSync("src/services/order/OrderOutboxService.ts", "utf8");
    const grants = readFileSync("src/services/activity/ProductCouponService.ts", "utf8");
    const receive = readFileSync("src/services/activity/ActivityService.ts", "utf8");
    const admin = readFileSync("src/controllers/api/v1/AdminCrudController.ts", "utf8");
    expect(createOrder).toContain("leftJoin(storeCouponIssue");
    expect(createOrder).toContain("calculateCouponEligibleSubtotalCents");
    expect(createOrder).toContain("eligibleSubtotalCents < useMinPriceCents");
    expect(createOrder).not.toContain("totalCents / 100 < Number(cu[0].useMinPrice)");
    expect(outbox).toContain("grantPaidOrderProductCoupons(tx, order.id, order.uid, now)");
    expect(grants).toContain('.for("update")');
    expect(grants).toContain("storeCouponIssue.remainCount} > 0");
    expect(grants).toContain('receiveSource: "order"');
    expect(receive).toContain('.for("update")');
    expect(receive).toContain("received >= issue.receiveLimit");
    expect(receive).not.toContain("storeCouponUserDao.countReceived");
    expect(admin).toContain("couponType: scopeType");
    expect(admin).toContain("totalCount - claimedCount");
    expect(admin).not.toContain("couponType: 1,");
  });

  it("restores dual product-coupon admin routes under the product ACL", () => {
    const adminRoutes = readFileSync("src/routes/adminapi.ts", "utf8");
    const v1Routes = readFileSync("src/routes/v1/index.ts", "utf8");
    for (const routes of [adminRoutes, v1Routes]) {
      expect(routes).toContain('/product/coupons/:id"');
      expect(routes).toContain("adminProductCouponsReplace");
    }
    expect(requiredAdminPermission("GET", "/adminapi/product/coupons/1"))
      .toBe("product.view");
    expect(requiredAdminPermission("PUT", "/api/admin/product/coupons/1"))
      .toBe("product.manage");
  });
});
