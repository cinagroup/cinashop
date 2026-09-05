import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildLegacySystemCityTree,
  formatNearbyRange,
  formatPickupRange,
  parseLegacyCoordinates,
  parseLegacyStorePage,
  toLegacyPublicStore,
  type PublicStoreRow,
} from "@/services/system/PublicLocationStoreService";
import { ValidateException } from "@/utils/errors";

function storeRow(overrides: Partial<PublicStoreRow> = {}): PublicStoreRow {
  return {
    id: 7,
    name: " 测试门店 ",
    introduction: "介绍",
    phone: "400-100-2000",
    address: "广东省深圳市",
    province: 44,
    city: 4403,
    area: 440305,
    street: null,
    detailedAddress: "科技园 1 号",
    image: "/api/assets/11",
    oblongImage: "https://cdn.example.com/store.webp",
    latitude: "22.5431",
    longitude: "114.0579",
    validTime: "09:00-22:00",
    validRange: 5_000,
    dayTime: "周一-周日",
    dayStart: "09:00",
    dayEnd: "22:00",
    isShow: 1,
    isStore: 1,
    distance: 1_299.8,
    ...overrides,
  };
}

describe("legacy public city/store compatibility", () => {
  it("validates legacy coordinates and only enables distance with a complete pair", () => {
    expect(parseLegacyCoordinates("22.5431", "114.0579")).toEqual({
      latitude: 22.5431,
      longitude: 114.0579,
    });
    expect(parseLegacyCoordinates("22.5431", "")).toBeNull();
    expect(() => parseLegacyCoordinates("91", "114")).toThrow(ValidateException);
    expect(() => parseLegacyCoordinates("22", "181")).toThrow(ValidateException);
    expect(() => parseLegacyCoordinates("22e1", "114")).toThrow(ValidateException);
  });

  it("bounds public pagination and rejects excessive offsets", () => {
    expect(parseLegacyStorePage({})).toEqual({ page: 1, limit: 10, offset: 0 });
    expect(parseLegacyStorePage({ page: "2", limit: "999" })).toEqual({
      page: 2,
      limit: 100,
      offset: 100,
    });
    expect(() => parseLegacyStorePage({ page: "102", limit: "100" })).toThrow(ValidateException);
  });

  it("builds the complete v/n city hierarchy in stable source order", () => {
    expect(buildLegacySystemCityTree([
      { id: 1, cityId: 10, parentId: 0, name: "甲省" },
      { id: 2, cityId: 20, parentId: 0, name: "乙省" },
      { id: 3, cityId: 11, parentId: 10, name: "甲市" },
      { id: 4, cityId: 12, parentId: 11, name: "甲区" },
    ])).toEqual([
      {
        v: 10,
        n: "甲省",
        parent_id: 0,
        children: [{
          v: 11,
          n: "甲市",
          parent_id: 10,
          children: [{ v: 12, n: "甲区", parent_id: 11, children: [] }],
        }],
      },
      { v: 20, n: "乙省", parent_id: 0, children: [] },
    ]);
  });

  it("preserves distance display modes while omitting every finance credential", () => {
    expect(formatPickupRange(999)).toBe("999m");
    expect(formatPickupRange(1_299)).toBe("1.2km");
    expect(formatNearbyRange(1_299)).toBe("1.2");

    const unsafeSourceRow = {
      ...storeRow(),
      bankCode: "must-not-leak",
      bankAddress: "must-not-leak",
      alipayAccount: "must-not-leak",
      alipayQrcodeUrl: "must-not-leak",
      wechat: "must-not-leak",
      wechatQrcodeUrl: "must-not-leak",
    };
    const result = toLegacyPublicStore(
      unsafeSourceRow,
      "pickup",
      "/api/assets/11?expires=1&signature=signed",
      "https://cdn.example.com/store.webp",
    );
    expect(result).toMatchObject({
      id: 7,
      name: "测试门店",
      detailed_address: "科技园 1 号",
      distance: 1_300,
      range: "1.3km",
      status_name: "营业中",
    });
    expect(result.image).toContain("signature=signed");
    expect(result).not.toHaveProperty("bank_code");
    expect(result).not.toHaveProperty("bank_address");
    expect(result).not.toHaveProperty("alipay_account");
    expect(result).not.toHaveProperty("alipay_qrcode_url");
    expect(result).not.toHaveProperty("wechat");
    expect(result).not.toHaveProperty("wechat_qrcode_url");
    const withoutCoordinates = toLegacyPublicStore(storeRow({ distance: null }), "pickup");
    expect(withoutCoordinates).not.toHaveProperty("distance");
    expect(withoutCoordinates.range).toBe("0");

    const source = readFileSync("src/services/system/PublicLocationStoreService.ts", "utf8");
    for (const column of [
      "systemStore.bankCode",
      "systemStore.bankAddress",
      "systemStore.alipayAccount",
      "systemStore.alipayQrcodeUrl",
      "systemStore.wechat",
      "systemStore.wechatQrcodeUrl",
    ]) {
      expect(source).not.toContain(column);
    }
  });

  it("registers the lazy city route and three optional-auth routes with StationOpen", () => {
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    const city = routes.slice(routes.indexOf('"/city"'), routes.indexOf('"/city"') + 130);
    expect(city).toContain("stationOpenMiddleware()");
    expect(city).not.toContain("authMiddleware({ force: false })");

    for (const path of ["/store_list", "/city_list", "/nearby_store"]) {
      const start = routes.indexOf(`"${path}"`);
      expect(start).toBeGreaterThan(-1);
      const registration = routes.slice(start, start + 250);
      expect(registration).toContain("stationOpenMiddleware()");
      expect(registration).toContain("authMiddleware({ force: false })");
    }
  });
});
