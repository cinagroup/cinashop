import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adminMobileOrderData,
  adminMobileOrderStaging,
  adminMobileOrderStatistics,
  adminMobileOrderTime,
  adminMobileOrderTimeChart,
} from "@/controllers/api/v1/AdminController";
import {
  AdminStatisticService,
  parseMobileOrderDataQuery,
  parseMobileOrderPeriod,
} from "@/services/admin/AdminStatisticService";
import { requiredAdminPermission } from "@/services/admin/AdminPermissionService";

const epoch = (value: string) => Math.floor(Date.parse(value) / 1000);

afterEach(() => vi.restoreAllMocks());

function context(query: Record<string, string> = {}) {
  const header = vi.fn();
  return {
    header,
    value: {
      req: {
        query: (name?: string) => name === undefined ? query : query[name],
      },
      get: (key: string) => key === "container" ? {} : undefined,
      header,
      json: (body: unknown) => Response.json(body),
    } as never,
  };
}

describe("embedded admin mobile order statistics migration", () => {
  it("parses bounded daily and comparison queries in Asia/Shanghai", () => {
    const now = epoch("2026-08-31T04:34:56.000Z");
    expect(parseMobileOrderDataQuery({}, now)).toEqual({
      start: epoch("2026-07-31T16:00:00.000Z"),
      endExclusive: now + 1,
      page: 1,
      limit: 15,
      offset: 0,
    });
    expect(parseMobileOrderDataQuery({ start: "100", stop: "199", page: "2", limit: "100" }, now))
      .toEqual({ start: 100, endExclusive: 200, page: 2, limit: 100, offset: 100 });
    expect(() => parseMobileOrderDataQuery({ start: "200", stop: "100" }, now)).toThrow("不能早于");
    expect(() => parseMobileOrderDataQuery({ limit: "101" }, now)).toThrow("每页数量参数错误");
    expect(() => parseMobileOrderDataQuery({ page: "1e2" }, now)).toThrow("页码参数错误");

    const today = parseMobileOrderPeriod(undefined, now);
    expect(today).toEqual({
      type: 1,
      currentStart: epoch("2026-08-30T16:00:00.000Z"),
      currentEndExclusive: now + 1,
      previousStart: epoch("2026-08-30T03:25:03.000Z"),
      chartStart: epoch("2026-08-29T16:00:00.000Z"),
    });
    expect(parseMobileOrderPeriod("7", now).currentStart).toBe(epoch("2026-08-24T16:00:00.000Z"));
    expect(parseMobileOrderPeriod("30", now).currentStart).toBe(epoch("2026-08-01T16:00:00.000Z"));
    expect(() => parseMobileOrderPeriod("0", now)).toThrow("仅支持");
    expect(() => parseMobileOrderPeriod("01", now)).toThrow("仅支持");
  });

  it("maps PHP statistic fields while counting all root orders", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([{
        order_count: 10,
        sum_price: "88.50",
        unpaid_count: 1,
        unshipped_count: 2,
        received_count: 3,
        evaluated_count: 4,
        unwritoff_count: 5,
        complete_count: 6,
        today_price: "20.50",
        today_count: 2,
        previous_price: "12.25",
        previous_count: 1,
        month_price: "70.75",
        month_count: 8,
      }])
      .mockResolvedValueOnce([{ refunding_count: 3, refunded_count: 2 }]);
    const getValues = vi.fn().mockResolvedValue({
      balance_func_status: "1",
      yue_pay_status: "1",
      pay_weixin_open: "0",
      ali_pay_status: "1",
    });
    const service = new AdminStatisticService({
      db: { execute },
      systemConfigDao: { getValues },
    } as never);

    await expect(service.mobileOrderStatistics(epoch("2026-08-31T04:34:56.000Z"))).resolves.toEqual({
      order_count: "10",
      sum_price: "88.50",
      unpaid_count: "1",
      unshipped_count: "2",
      received_count: "3",
      evaluated_count: "4",
      unwritoff_count: "5",
      complete_count: "6",
      refunding_count: "3",
      refunded_count: "2",
      refund_count: "5",
      yue_pay_status: 1,
      pay_weixin_open: 0,
      ali_pay_status: true,
      todayPrice: 20.5,
      todayCount: 2,
      proPrice: 12.25,
      proCount: 1,
      monthPrice: 70.75,
      monthCount: 8,
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(getValues).toHaveBeenCalledWith([
      "balance_func_status", "yue_pay_status", "pay_weixin_open", "ali_pay_status",
    ]);
  });

  it("preserves staging strings and computes exact time comparison fields", async () => {
    const stagingExecute = vi.fn().mockResolvedValue([{
      unshipped_count: 4,
      refunding_count: 2,
      refunded_count: 1,
      outofstock: 5,
      policeforce: 6,
    }]);
    const staging = new AdminStatisticService({ db: { execute: stagingExecute } } as never);
    await expect(staging.mobileOrderStaging()).resolves.toEqual({
      unshipped_count: "4",
      refunding_count: "2",
      refunded_count: "1",
      refund_count: "3",
      outofstock: 5,
      policeforce: 6,
    });

    const timeExecute = vi.fn().mockResolvedValue([{
      after_price: "75.50",
      front_price: "100.00",
      after_number: 8,
      after_pay_number: 6,
      today_visits: 30,
    }]);
    const time = new AdminStatisticService({ db: { execute: timeExecute } } as never);
    await expect(time.mobileOrderTime(parseMobileOrderPeriod("1"))).resolves.toEqual({
      after_price: 75.5,
      growth_rate: 24,
      increase_time: 24.5,
      increase_time_status: 2,
      after_number: 8,
      after_pay_number: 6,
      today_visits: 30,
    });
  });

  it("returns private PHP envelopes from all five handlers", async () => {
    vi.spyOn(AdminStatisticService.prototype, "mobileOrderStatistics").mockResolvedValue({} as never);
    vi.spyOn(AdminStatisticService.prototype, "mobileOrderStaging").mockResolvedValue({} as never);
    vi.spyOn(AdminStatisticService.prototype, "mobileOrderData").mockResolvedValue([]);
    vi.spyOn(AdminStatisticService.prototype, "mobileOrderTime").mockResolvedValue({} as never);
    vi.spyOn(AdminStatisticService.prototype, "mobileOrderTimeChart").mockResolvedValue([]);
    const calls = [
      [adminMobileOrderStatistics, context()],
      [adminMobileOrderStaging, context()],
      [adminMobileOrderData, context()],
      [adminMobileOrderTime, context({ type: "7" })],
      [adminMobileOrderTimeChart, context({ type: "30" })],
    ] as const;
    for (const [handler, testContext] of calls) {
      const response = await handler(testContext.value);
      expect((await response.json()) as { status: number }).toMatchObject({ status: 200 });
      expect(testContext.header).toHaveBeenCalledWith("Cache-Control", "private, no-store, max-age=0");
    }
  });

  it("mounts the five exact PHP routes behind order.view", () => {
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    const paths = ["statistics", "staging", "data", "time", "time/chart"];
    for (const path of paths) {
      expect(routes).toContain(`get("/admin/order/${path}", adminAuth, AdminController.`);
      expect(requiredAdminPermission("GET", `/api/admin/order/${path}`)).toBe("order.view");
    }
  });

  it("uses one timezone, root orders, deletion filters, and read-only SQL", () => {
    const service = readFileSync("src/services/admin/AdminStatisticService.ts", "utf8");
    expect(service).toContain("async mobileOrderStatistics");
    expect(service).toContain("async mobileOrderTimeChart");
    expect(service).toContain("AT TIME ZONE 'Asia/Shanghai'");
    expect(service).toContain("WHERE pid = 0 AND is_del = 0 AND is_system_del = 0");
    expect(service).toContain("product_log.delete_time IS NULL");
    expect(service).toContain("GROUP BY 1\n      ORDER BY 1 ASC");
    expect(service).not.toMatch(/mobileOrder(?:Statistics|Staging|Data|Time|TimeChart)[\s\S]{0,500}\.(?:insert|update|delete)\(/);
  });
});
