import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  formatLegacyCouponDate,
  legacyCouponProjection,
  legacyShanghaiDayRange,
  parseLegacyCouponQuery,
} from "@/services/activity/V2CouponCompatibilityService";
import { storeCouponIssue, storeCouponUser } from "@/models/schema";

type Issue = typeof storeCouponIssue.$inferSelect;
type Used = typeof storeCouponUser.$inferSelect;

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 7,
    cid: 9,
    category: 1,
    couponType: 2,
    couponTitle: "迁移券",
    type: 1,
    couponPrice: "12.50",
    useMinPrice: "88.00",
    productId: "41,42",
    category_id: "0",
    brandId: "0",
    legacyProductIds: "41,42",
    legacyCategoryId: 0,
    legacyBrandId: 0,
    totalCount: 100,
    remainCount: 20,
    receiveLimit: 1,
    receiveType: 1,
    startTime: new Date("2026-08-27T16:00:00.000Z"),
    endTime: new Date("2026-08-31T15:59:59.000Z"),
    day: 0,
    isPermanent: 0,
    isGiveSubscribe: 0,
    isFullGive: 0,
    fullReduction: "0.00",
    isDel: 0,
    title: "测试",
    integral: 0,
    useStartTime: new Date("2026-08-28T00:00:00.000Z"),
    useEndTime: new Date("2026-09-30T15:59:59.000Z"),
    rule: "规则",
    status: 1,
    appType: 0,
    sort: 10,
    addTime: 1_777_000_000,
    ...overrides,
  };
}

function used(overrides: Partial<Used> = {}): Used {
  return {
    id: 70,
    uid: 3,
    issueCouponId: 7,
    couponTitle: "迁移券",
    couponPrice: "12.50",
    useMinPrice: "88.00",
    status: 0,
    startTime: new Date("2026-08-27T16:00:00.000Z"),
    endTime: new Date("2026-09-03T15:59:59.000Z"),
    useTime: null,
    type: 1,
    receiveTime: 1_777_000_000,
    receiveSource: "get",
    isFail: 0,
    ...overrides,
  };
}

describe("API v2 coupon compatibility migration", () => {
  it("mounts the three PHP routes with the exact original auth boundaries", () => {
    const routes = readFileSync("src/routes/v2/index.ts", "utf8");
    expect(routes).toContain(
      'v2Routes.get("/new_coupon", authMiddleware({ force: true }), UserActivityController.couponNewV2)',
    );
    expect(routes).toContain(
      'v2Routes.get("/get_today_coupon", authMiddleware({ force: false }), UserActivityController.couponTodayV2)',
    );
    expect(routes).toContain(
      'v2Routes.get("/coupons", authMiddleware({ force: false }), UserActivityController.couponListV2)',
    );
  });

  it("restores the source type/coupon_type meanings and snake_case fields", () => {
    const projected = legacyCouponProjection(issue(), {
      variant: "list",
      relatedProductIds: [42, 41],
      products: [{ id: 41, image: "/p.jpg", store_name: "商品", price: 99, sales: 8 }],
    });
    expect(projected).toEqual(expect.objectContaining({
      type: 2,
      coupon_type: 1,
      coupon_price: 12.5,
      use_min_price: 88,
      product_id: "41,42",
      start_time: "2026/08/28",
      end_time: "2026/09/30",
      is_use: false,
      products: [{ id: 41, image: "/p.jpg", store_name: "商品", price: 99, sales: 8 }],
    }));
    expect(projected).not.toHaveProperty("couponType");
    expect(projected).not.toHaveProperty("legacyProductIds");
  });

  it("uses a user's rolling validity dates only for coupon_time coupons", () => {
    const projected = legacyCouponProjection(issue({ day: 7 }), {
      variant: "list",
      used: used(),
      relatedProductIds: [41, 42],
    });
    expect(projected).toEqual(expect.objectContaining({
      is_use: true,
      start_time: "2026/08/28",
      end_time: "2026/09/03",
      used: expect.objectContaining({ cid: 7, uid: 3, is_fail: 0 }),
    }));
  });

  it("preserves an empty source product_id and untouched decimal fields", () => {
    const projected = legacyCouponProjection(issue({
      couponType: 0,
      legacyProductIds: "",
      productId: "0",
      fullReduction: "120.50",
    }), { variant: "new" });
    expect(projected.product_id).toBe("");
    expect(projected.full_reduction).toBe("120.50");
  });

  it("formats claim dates and today's range in Asia/Shanghai", () => {
    expect(formatLegacyCouponDate(new Date("2026-08-27T16:00:00.000Z"))).toBe("2026-08-28");
    expect(legacyShanghaiDayRange(new Date("2026-08-28T12:00:00.000Z"))).toEqual({
      start: new Date("2026-08-27T16:00:00.000Z"),
      end: new Date("2026-08-28T16:00:00.000Z"),
    });
  });

  it("keeps PHP integer coercion while bounding page sizes", () => {
    expect(parseLegacyCouponQuery({
      type: "2foo",
      product_id: "41bar",
      page: "0",
      limit: "9999",
      priceOrder: "desc",
    })).toEqual(expect.objectContaining({
      type: 2,
      productId: 41,
      page: 1,
      limit: 100,
      priceOrder: "desc",
    }));
  });

  it("batches used rows, scope relations, counts and sample products", () => {
    const source = readFileSync("src/services/activity/V2CouponCompatibilityService.ts", "utf8");
    expect(source).toContain("Promise.all([");
    expect(source).toContain("INNER JOIN LATERAL");
    expect(source).toContain("COUNT(*) FILTER");
    expect(source).toContain("MAX_PAGE_SIZE = 100");
    expect(source).not.toContain("sql.raw(");
  });
});
