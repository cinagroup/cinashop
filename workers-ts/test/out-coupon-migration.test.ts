import { readFileSync } from "node:fs";
import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { outCouponWriteReplay } from "@/models/schema";
import {
  normalizeOutCouponInput,
  normalizeOutCouponRequestKey,
} from "@/services/out/OutCouponService";

function fixedCoupon(overrides: Record<string, unknown> = {}) {
  return {
    coupon_title: "Out 满减券",
    coupon_price: "10.00",
    use_min_price: "50.00",
    coupon_time: 0,
    start_use_time: "2030-01-01 00:00:00",
    end_use_time: "2030-12-31 23:59:59",
    start_time: "2029-12-01 00:00:00",
    end_time: "2029-12-31 23:59:59",
    receive_type: 1,
    is_permanent: 0,
    total_count: 100,
    product_id: "20,10,20",
    category_id: [],
    type: 2,
    sort: 5,
    status: 0,
    coupon_type: 1,
    ...overrides,
  };
}

describe("Out API coupon write migration", () => {
  it("normalizes PHP field meanings without re-swapping scope and discount type", () => {
    const normalized = normalizeOutCouponInput(fixedCoupon());
    expect(normalized).toMatchObject({
      couponTitle: "Out 满减券",
      couponPrice: "10.00",
      useMinPrice: "50.00",
      scopeType: 2,
      discountType: 1,
      productIds: [10, 20],
      totalCount: 100,
      isPermanent: 0,
      status: 0,
    });
    expect(normalized.startTime?.toISOString()).toBe("2029-11-30T16:00:00.000Z");
  });

  it("uses PHP's 0-100 discount percentage and strict time/inventory contracts", () => {
    expect(normalizeOutCouponInput(fixedCoupon({
      coupon_price: "85",
      coupon_type: 2,
    })).couponPrice).toBe("85.00");
    expect(() => normalizeOutCouponInput(fixedCoupon({
      coupon_price: "100.01",
      coupon_type: 2,
    }))).toThrow("不超过100");
    expect(() => normalizeOutCouponInput(fixedCoupon({ end_use_time: 0 })))
      .toThrow("必须填写使用开始和结束时间");
    expect(() => normalizeOutCouponInput(fixedCoupon({ end_use_time: "2030-02-31 00:00:00" })))
      .toThrow("使用结束时间格式错误");
    expect(() => normalizeOutCouponInput(fixedCoupon({ total_count: 0 })))
      .toThrow("发行量必须大于0");
    expect(() => normalizeOutCouponInput(fixedCoupon({ brand_id: 9 })))
      .toThrow("不能静默丢弃");
  });

  it("forces newcomer/gift coupons unlimited and validates UUID-v4 replay keys", () => {
    expect(normalizeOutCouponInput(fixedCoupon({
      receive_type: 3,
      is_permanent: 0,
      total_count: 999,
    }))).toMatchObject({ receiveType: 3, isPermanent: 1, totalCount: 0 });
    expect(normalizeOutCouponRequestKey("8C237C34-9995-4E47-8E02-C6D3E67524DB"))
      .toBe("8c237c34-9995-4e47-8e02-c6d3e67524db");
    expect(() => normalizeOutCouponRequestKey("coupon-retry-1")).toThrow("UUID v4");
  });

  it("keeps the external and embedded replay DDL exact and content-free", () => {
    expect(getTableName(outCouponWriteReplay)).toBe("out_coupon_write_replay");
    expect(Object.keys(getTableColumns(outCouponWriteReplay))).toEqual([
      "id",
      "outAccountId",
      "operation",
      "requestKey",
      "requestHash",
      "couponId",
      "resultStatus",
      "addTime",
    ]);
    const migration = readFileSync("migrations/0098_out_coupon_write_replay.sql", "utf8").trim();
    const service = readFileSync("src/services/MigrationService.ts", "utf8");
    const embedded = service
      .match(/private migration_0105\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    expect(embedded).toBe(migration);
    expect(migration).not.toMatch(/coupon_title|coupon_price|product_id|request_body|response_body/i);
  });

  it("publishes all three PHP write routes and preserves issued-coupon scope on delete", () => {
    const service = readFileSync("src/services/out/OutCouponService.ts", "utf8");
    const outApi = readFileSync("src/services/out/OutApiService.ts", "utf8");
    const routes = readFileSync("src/routes/outapi.ts", "utf8");
    expect(routes).toContain('"/coupon/status/:id/:status"');
    expect(routes).toContain('"/coupon/:id"');
    expect(outApi).toContain('"post /coupon"');
    expect(outApi).toContain('"put /coupon/status/{id}/{status}"');
    expect(outApi).toContain('"delete /coupon/{id}"');
    expect(service).toContain("Keep store_coupon_product");
    expect(service).not.toMatch(/delete\(storeCouponProduct\)/);
    expect(service).toContain("商品支付后赠券");
    expect(service).toContain("抽奖活动");
    expect(service).toContain("促销活动");
    expect(service).toContain("新人礼包");
    const scenario = readFileSync("test/integration/OutApiCouponPostgresScenario.ts", "utf8");
    const runScenario = scenario.slice(scenario.indexOf("async function runScenario"));
    expect(runScenario).not.toContain("container.db");
    expect(runScenario).toContain("const scopedDb");
  });

  it("restores PHP list filters and response field names after target-column swaps", () => {
    const source = readFileSync("src/services/out/OutApiService.ts", "utf8");
    const couponList = source.slice(source.indexOf("async couponList"), source.indexOf("async userLevelList"));
    expect(couponList).toContain("eq(storeCouponIssue.type, couponType)");
    expect(couponList).toContain('receive === "send"');
    expect(couponList).toContain("type: row.couponType");
    expect(couponList).toContain("coupon_type: row.type");
    expect(couponList).toContain("start_use_time: row.useStartTime");
    expect(couponList).toContain("delete item.legacy_product_ids");
  });
});
