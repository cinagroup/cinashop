import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  mergeLegacyProductCategory,
  mergeLegacyProductDetail,
  normalizeLegacyAddress,
  parseLegacyDiyJson,
} from "@/services/content/V2PublicCompatibilityService";

describe("API v2 public DIY compatibility migration", () => {
  it("mounts the six PHP routes without an authentication middleware", () => {
    const routes = readFileSync("src/routes/v2/index.ts", "utf8");
    for (const route of [
      'v2Routes.get("/diy/get_diy/:name?", PublicController.getDiyV2)',
      'v2Routes.get("/bind_status", PublicController.bindPhoneStatusV2)',
      'v2Routes.get("/diy/get_store_status", PublicController.storeStatusV2)',
      'v2Routes.get("/diy/color_change/:name", PublicController.colorChangeV2)',
      'v2Routes.get("/diy/product_detail", PublicController.productDetailDiyV2)',
      'v2Routes.get("/cityList", PublicController.cityListV2)',
    ]) expect(routes).toContain(route);
  });

  it("reproduces PHP's distinct product-detail and category merge semantics", () => {
    expect(mergeLegacyProductDetail(JSON.stringify({
      showCart: 0,
      replyNum: 8,
      futureFlag: "must be dropped",
    }))).toEqual(expect.objectContaining({ showCart: 0, replyNum: 8, openShare: 1 }));
    expect(mergeLegacyProductDetail(JSON.stringify({ futureFlag: true }))).not.toHaveProperty("futureFlag");
    expect(mergeLegacyProductCategory(JSON.stringify({ level: 3, futureFlag: true }))).toEqual({
      level: 3,
      index: 1,
      futureFlag: true,
    });
    expect(mergeLegacyProductDetail("not-json")).toEqual(expect.objectContaining({
      navList: [0, 1, 2, 3, 4],
      recommendNum: 12,
    }));
  });

  it("bounds legacy JSON and normalizes municipality address imports", () => {
    expect(parseLegacyDiyJson('{"name":"pageFoot"}')).toEqual({ name: "pageFoot" });
    expect(parseLegacyDiyJson("bad")).toBeNull();
    expect(parseLegacyDiyJson(`"${"x".repeat(2_000_001)}"`)).toBeNull();
    expect(normalizeLegacyAddress("/北京市/北京市/朝阳区/")).toEqual(["北京市", "朝阳区"]);
    expect(normalizeLegacyAddress("广东省/深圳市/南山区")).toEqual(["广东省", "深圳市", "南山区"]);
    expect(normalizeLegacyAddress("A/".repeat(9))).toEqual([]);
  });

  it("keeps city lookup exact-name, bounded and free of user-controlled LIKE patterns", () => {
    const source = readFileSync("src/services/content/V2PublicCompatibilityService.ts", "utf8");
    expect(source).toContain("const MAX_ADDRESS_SEGMENTS = 8");
    expect(source).toContain("eq(cityArea.name, segment)");
    expect(source).toContain('like(cityArea.path, `/${pathIds.join("/")}/%`)');
    expect(source).toContain("inArray(cityArea.parentId, ancestorIds)");
  });
});
