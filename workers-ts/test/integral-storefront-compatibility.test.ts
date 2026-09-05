import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ActivityService,
  parseIntegralRange,
} from "../src/services/activity/ActivityService";

function queryResult<T>(rows: T[]) {
  const result = Promise.resolve(rows);
  const query: Record<string, unknown> = {};
  for (const method of ["from", "innerJoin", "leftJoin", "where", "orderBy", "groupBy", "offset"]) {
    query[method] = vi.fn(() => query);
  }
  query.limit = vi.fn(() => result);
  query.then = result.then.bind(result);
  return query;
}

describe("legacy integral storefront compatibility", () => {
  it("parses bounded integral ranges and preserves reverse ranges as empty queries", () => {
    expect(parseIntegralRange("100 - 500")).toEqual({ minimum: 100, maximum: 500 });
    expect(parseIntegralRange("500-100")).toEqual({ minimum: 500, maximum: 100 });
    expect(parseIntegralRange("全部")).toBeUndefined();
    expect(parseIntegralRange("-1-100")).toBeUndefined();
    expect(parseIntegralRange(`0-${2_147_483_648}`)).toBeUndefined();
  });

  it("forwards the PHP list filters, returns brand names, and signs canonical assets", async () => {
    const list = vi.fn().mockResolvedValue([{
      id: 14,
      productId: 104,
      storeName: "积分商品",
      image: "/api/assets/7",
      integral: 300,
      price: "1.50",
      sales: 4,
      stock: 7,
      brandName: "示例品牌",
    }]);
    const service = new ActivityService(
      { storeIntegralDao: { list } } as never,
      { APP_KEY: "test-integral-app-key" } as never,
    );

    const result = await service.integralList(0, 999, {
      storeName: "  商品\u0000名称  ",
      priceOrder: "DESC",
      salesOrder: "asc",
      range: "100-500",
    });

    expect(list).toHaveBeenCalledWith(1, 50, {
      storeName: "商品名称",
      priceOrder: "desc",
      salesOrder: "asc",
      range: { minimum: 100, maximum: 500 },
      isHost: false,
    });
    expect(result).toEqual([expect.objectContaining({
      id: 14,
      product_id: 104,
      title: "积分商品",
      integral: 300,
      price: 1.5,
      brand_name: "示例品牌",
      image: expect.stringMatching(/^\/api\/assets\/7\?expires=\d+&signature=/),
    })]);
  });

  it("returns the PHP home envelope with recommended products and optional user points", async () => {
    const list = vi.fn().mockResolvedValue([{
      id: 8,
      productId: 18,
      storeName: "推荐商品",
      image: "/recommended.png",
      integral: 88,
      price: "0.00",
      sales: 9,
      stock: 2,
      brandName: "",
    }]);
    const select = vi.fn((selection: Record<string, unknown>) => {
      if (Object.hasOwn(selection, "configName")) {
        return queryResult([{
          configName: "integral_shop_banner",
          id: 3,
          gid: 4,
          value: JSON.stringify({
            img: { value: "/api/assets/9" },
            comment: { value: "积分活动" },
            link: { value: "javascript:alert(1)" },
          }),
          addTime: 1,
          sort: 10,
          status: 1,
        }]);
      }
      return queryResult([{ integral: 321 }]);
    });
    const service = new ActivityService(
      { db: { select }, storeIntegralDao: { list } } as never,
      { APP_KEY: "test-integral-app-key" } as never,
    );

    const result = await service.integralHome(12, 2, 5);

    expect(list).toHaveBeenCalledWith(2, 5, expect.objectContaining({ isHost: true }));
    expect(result.integral).toBe(321);
    expect(result.list).toEqual([expect.objectContaining({ title: "推荐商品" })]);
    expect(result.banner).toEqual([expect.objectContaining({
      comment: "积分活动",
      link: "",
      img: expect.stringMatching(/^\/api\/assets\/9\?expires=\d+&signature=/),
    })]);
  });

  it("maps visible group-5 categories to the legacy label/value contract", async () => {
    const select = vi.fn(() => queryResult([
      { name: "低积分", integralMin: 0, integralMax: 100 },
      { name: "高积分", integralMin: 101, integralMax: 500 },
    ]));
    const service = new ActivityService({ db: { select } } as never);

    await expect(service.integralCategories()).resolves.toEqual([
      { label: "低积分", value: "0-100" },
      { label: "高积分", value: "101-500" },
    ]);
  });

  it("registers all four browse routes behind StationOpen and optional auth", () => {
    const routes = readFileSync(
      resolve(import.meta.dirname, "../src/routes/v1/index.ts"),
      "utf8",
    );
    for (const path of [
      "/store_integral/index",
      "/store_integral/category",
      "/store_integral/list",
      "/store_integral/detail/:id",
    ]) {
      const start = routes.indexOf(`\"${path}\"`);
      expect(start).toBeGreaterThan(-1);
      const block = routes.slice(start, start + 260);
      expect(block).toContain("stationOpenMiddleware()");
      expect(block).toContain("authMiddleware({ force: false })");
    }
  });
});
