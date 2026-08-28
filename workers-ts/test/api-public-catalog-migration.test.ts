import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  normalizeCatalogPage,
  parseLegacyGroupValue,
} from "@/services/product/PublicCatalogService";

describe("API-001 public homepage and product discovery migration", () => {
  it("normalizes pagination without allowing unbounded catalogue reads", () => {
    expect(normalizeCatalogPage(undefined, undefined)).toEqual({ page: 1, limit: 10 });
    expect(normalizeCatalogPage("-4", "500")).toEqual({ page: 1, limit: 100 });
    expect(normalizeCatalogPage("2.9", "8.9")).toEqual({ page: 2, limit: 8 });
    expect(normalizeCatalogPage("bad", "bad", 12)).toEqual({ page: 1, limit: 12 });
  });

  it("flattens legacy system-group fields and rejects malformed or oversized JSON", () => {
    expect(parseLegacyGroupValue(JSON.stringify({
      name: { type: "input", value: "精品" },
      url: { type: "input", value: "/pages/goods/list" },
      count: 3,
    }))).toEqual({ name: "精品", url: "/pages/goods/list", count: 3 });
    expect(parseLegacyGroupValue("not-json")).toBeNull();
    expect(parseLegacyGroupValue(JSON.stringify(["not", "an", "object"]))).toBeNull();
    expect(parseLegacyGroupValue(`{"value":"${"x".repeat(500_001)}"}`)).toBeNull();
    const polluted = parseLegacyGroupValue('{"safe":{"value":"ok"},"__proto__":{"value":"bad"}}');
    expect(polluted).toEqual({ safe: "ok" });
    expect(Object.getPrototypeOf(polluted)).toBe(Object.prototype);
  });

  it("registers every audited PHP read route with optional authentication", () => {
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    for (const route of [
      '"/navigation/:template_name"',
      '"/index"',
      '"/menu/user"',
      '"/menu/date"',
      '"/presale/list"',
      '"/search/recommend/:type"',
      '"/search/filter"',
      '"/brand"',
      '"/product/rank/category"',
      '"/product/rank/:type"',
      '"/product/detail/recommend/:id"',
      '"/product/detail/activity/:id"',
      '"/product/detail/:id/:type"',
      '"/product/detail_content/:id"',
      '"/groom/list/:type"',
      '"/product/hot"',
      '"/reply/comment/:id"',
    ]) {
      expect(routes, `missing route ${route}`).toContain(route);
    }
    expect(routes).toContain("authMiddleware({ force: false })");
  });

  it("uses one shared visible-product path and restores exact count and PHP reply keys", () => {
    const productService = readFileSync("src/services/product/StoreProductService.ts", "utf8");
    const productDao = readFileSync("src/dao/product/StoreProductDao.ts", "utf8");
    const replyDao = readFileSync("src/dao/product/ReplyDaos.ts", "utf8");
    expect(productService).toContain("getRecommendProducts(");
    expect(productService).toContain("countSearch(where)");
    expect(productDao).toContain("COUNT(*)::int");
    for (const key of ["sum_count", "good_count", "in_count", "poor_count", "reply_chance", "reply_star"]) {
      expect(replyDao).toContain(key);
    }
  });

  it("keeps production reads bounded and batches group/config/label enrichment", () => {
    const service = readFileSync("src/services/product/PublicCatalogService.ts", "utf8");
    const config = readFileSync("src/services/system/SystemConfigService.ts", "utf8");
    expect(service).toContain("const MAX_LIMIT = 100");
    expect(service).toContain("groupDataMany");
    expect(service).toContain("decorateProducts");
    expect(service).not.toContain("SELECT *");
    expect(config).toContain("Promise.all(");
  });
});
