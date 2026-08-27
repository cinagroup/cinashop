import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseAdminStatisticRange,
  parseCategoryIds,
  parseProductRankingSort,
  statisticComparison,
} from "@/services/admin/AdminStatisticService";

const epoch = (value: string) => Math.floor(Date.parse(value) / 1000);

describe("admin statistic migration", () => {
  it("parses inclusive calendar dates at Asia/Shanghai midnight", () => {
    const range = parseAdminStatisticRange("2026/08/27-2026/08/27");
    expect(range.start).toBe(epoch("2026-08-26T16:00:00.000Z"));
    expect(range.endExclusive).toBe(epoch("2026-08-27T16:00:00.000Z"));
    expect(range.days).toBe(1);
    expect(range.granularity).toBe("hour");
    expect(range.bucketKeys).toHaveLength(24);
  });

  it("uses complete day, three-day, and month buckets without dropping dates", () => {
    const daily = parseAdminStatisticRange("2026/08/01-2026/08/30");
    expect(daily.granularity).toBe("day");
    expect(daily.bucketKeys).toHaveLength(30);

    const threeDay = parseAdminStatisticRange("2026/07/01-2026/08/01");
    expect(threeDay.days).toBe(32);
    expect(threeDay.granularity).toBe("three_day");
    expect(threeDay.bucketKeys).toHaveLength(11);
    expect(threeDay.bucketKeys.at(-1)).toBe("2026-07-31");

    const monthly = parseAdminStatisticRange("2026/01/15-2026/05/01");
    expect(monthly.granularity).toBe("month");
    expect(monthly.bucketKeys).toEqual(["2026-01", "2026-02", "2026-03", "2026-04", "2026-05"]);
  });

  it("defaults to 30 business days and fails closed on invalid input", () => {
    const range = parseAdminStatisticRange(undefined, epoch("2026-08-27T04:00:00.000Z"));
    expect(range.days).toBe(30);
    expect(range.bucketKeys[0]).toBe("2026-07-29");
    expect(range.bucketKeys.at(-1)).toBe("2026-08-27");
    expect(() => parseAdminStatisticRange("2026/08/30-2026/08/01")).toThrow("不能早于");
    expect(() => parseAdminStatisticRange("2026/02/30-2026/03/01")).toThrow("日期无效");
    expect(() => parseAdminStatisticRange("today")).toThrow("必须包含起止日期");
  });

  it("whitelists ranking fields/categories and preserves PHP comparison direction", () => {
    expect(parseProductRankingSort()).toBe("visit");
    expect(parseProductRankingSort("changes")).toBe("changes");
    expect(() => parseProductRankingSort("visit desc")).toThrow("排序字段无效");
    expect(parseCategoryIds(["1,2", "2", "3"])).toEqual([1, 2, 3]);
    expect(() => parseCategoryIds(["0"])).toThrow("分类参数无效");
    expect(statisticComparison(15, 10)).toEqual({ num: 15, percent: 50 });
    expect(statisticComparison(5, 10)).toEqual({ num: 5, percent: -50 });
    expect(statisticComparison(5, 0)).toEqual({ num: 5, percent: 500 });
  });

  it("registers the seven PHP runtime contracts on both admin route surfaces", () => {
    const adminRoutes = readFileSync("src/routes/adminapi.ts", "utf8");
    const v1Routes = readFileSync("src/routes/v1/index.ts", "utf8");
    const paths = [
      "statistic/order/get_basic",
      "statistic/order/get_trend",
      "statistic/order/get_channel",
      "statistic/order/get_type",
      "statistic/product/get_basic",
      "statistic/product/get_trend",
      "statistic/product/get_product_ranking",
    ];
    for (const path of paths) {
      expect(adminRoutes).toContain(`/${path}`);
      expect(v1Routes).toContain(`/admin/${path}`);
    }
    expect(adminRoutes).not.toContain("AdminCrud.adminStatisticTrend");
    expect(adminRoutes).not.toContain("AdminCrud.adminStatisticRank");
  });

  it("uses PostgreSQL Shanghai grouping, root orders, and deletion filters", () => {
    const service = readFileSync("src/services/admin/AdminStatisticService.ts", "utf8");
    const oldController = readFileSync("src/controllers/api/v1/AdminCrudController.ts", "utf8");
    expect(service).toContain("AT TIME ZONE 'Asia/Shanghai'");
    expect(service).toContain("pid = 0");
    expect(service).toContain("is_del = 0 AND is_system_del = 0");
    expect(service).toContain("refund_price");
    expect(service).toContain("MATERIALIZED");
    expect(service).not.toContain("AT TIME ZONE 'UTC'");
    expect(oldController).not.toContain("export async function adminStatisticTrend");
    expect(oldController).not.toContain("export async function adminStatisticRank");
  });
});
