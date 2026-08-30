import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  normalizeMobileDeliveryPage,
  parseLegacyDeliveryTimeRange,
} from "../src/services/store/StoreMobileDeliveryService";

const epoch = (value: string) => Math.floor(Date.parse(value) / 1_000);

describe("API-008 mobile-store delivery compatibility", () => {
  it("interprets legacy time tokens at Asia/Shanghai boundaries", () => {
    const now = epoch("2026-08-30T10:30:00+08:00");
    expect(parseLegacyDeliveryTimeRange("today", now)).toEqual({
      start: epoch("2026-08-30T00:00:00+08:00"),
      endExclusive: epoch("2026-08-31T00:00:00+08:00"),
    });
    expect(parseLegacyDeliveryTimeRange("yesterday", now)).toEqual({
      start: epoch("2026-08-29T00:00:00+08:00"),
      endExclusive: epoch("2026-08-30T00:00:00+08:00"),
    });
    expect(parseLegacyDeliveryTimeRange("week", now)).toEqual({
      start: epoch("2026-08-24T00:00:00+08:00"),
      endExclusive: epoch("2026-08-31T00:00:00+08:00"),
    });
    expect(parseLegacyDeliveryTimeRange("month", now)).toEqual({
      start: epoch("2026-08-01T00:00:00+08:00"),
      endExclusive: epoch("2026-09-01T00:00:00+08:00"),
    });
    expect(parseLegacyDeliveryTimeRange("2026/08/01 - 2026/08/03", now)).toEqual({
      start: epoch("2026-08-01T00:00:00+08:00"),
      endExclusive: epoch("2026-08-04T00:00:00+08:00"),
    });
  });

  it("rejects malformed or unbounded time and paging inputs", () => {
    expect(() => parseLegacyDeliveryTimeRange("2026/08/03 - 2026/08/01"))
      .toThrow("统计结束日期不能早于开始日期");
    expect(() => parseLegacyDeliveryTimeRange("2024/01/01 - 2026/01/01"))
      .toThrow("统计跨度不能超过366天");
    expect(() => parseLegacyDeliveryTimeRange("everything"))
      .toThrow("统计时间范围错误");
    expect(normalizeMobileDeliveryPage(undefined, undefined)).toEqual({ page: 1, limit: 15, offset: 0 });
    expect(() => normalizeMobileDeliveryPage("0", "15")).toThrow("页码错误");
    expect(() => normalizeMobileDeliveryPage("1", "101")).toThrow("每页数量必须在1到100之间");
    expect(() => normalizeMobileDeliveryPage("1000", "100")).toThrow("分页范围过大");
  });

  it("registers the six exact PHP contracts with the intended auth boundary", () => {
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    expect(routes).toContain(
      'v1Routes.get("/store/list", stationOpenMiddleware(), StoreOrderWriteoff.publicPickupStores)',
    );
    expect(routes).toContain('v1Routes.get("/store/category", stationOpenMiddleware(), ProductController.category)');
    for (const [path, handler] of [
      ["/store/delivery/info", "StoreMobileDelivery.info"],
      ["/store/delivery/statistics", "StoreMobileDelivery.statistics"],
      ["/store/delivery/data", "StoreMobileDelivery.data"],
      ["/store/delivery/order", "StoreMobileDelivery.orderList"],
      ["/store/delivery/list", "StoreMobileDelivery.deliveryList"],
    ]) {
      const start = routes.indexOf(`"${path}"`);
      expect(start).toBeGreaterThan(-1);
      const registration = routes.slice(start, start + 180);
      expect(registration).toContain("stationOpenMiddleware()");
      expect(registration).toContain("authMiddleware({ force: true })");
      expect(registration).toContain(handler);
    }
  });

  it("fails closed on actor scope and returns only bounded projections", () => {
    const service = readFileSync("src/services/store/StoreMobileDeliveryService.ts", "utf8");
    const controller = readFileSync("src/controllers/api/v1/StoreMobileDeliveryController.ts", "utf8");
    expect(service).toContain("eq(storeOrder.deliveryUid, uid)");
    expect(service).toContain("eq(deliveryService.relationId, staff[0].storeId)");
    expect(service).toContain("配送员门店身份存在重复");
    expect(service).toContain("店员身份存在重复");
    expect(service).toContain("MAX_SNAPSHOT_BYTES");
    expect(service).not.toContain("fetch(");
    expect(controller.match(/private, no-store/g)).toHaveLength(1);
    expect(controller).toContain('c.header("Pragma", "no-cache")');
  });
});
