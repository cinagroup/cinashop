import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppVariables, Env } from "../src/env";
import { createContainerFromDb } from "../src/lib/di";
import { user, userBill, systemAdmin, systemRole } from "../src/models/schema";
import * as PointStatistic from "../src/controllers/api/v1/AdminPointStatisticController";
import { adminAuthMiddleware } from "../src/middleware/admin-auth";
import { requiredAdminPermission } from "../src/services/admin/AdminPermissionService";
import { parsePointStatisticRange } from "../src/services/admin/AdminPointStatisticService";
import { ApiException } from "../src/utils/errors";
import { createToken, md5 } from "../src/utils/jwt";
import { financePostgres } from "./helpers/financePostgres";

type Reply = { status: number; data: any };
const at = (day: number, hour = 0) => Date.UTC(2026, 8, day, hour - 8) / 1000;
const time = "2026/09/21-2026/09/23";

describe("read-only legacy Admin point statistics", () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>;
  let app: Hono<{ Bindings: Env; Variables: AppVariables }>;
  let bindings: Env;
  let viewerToken: string;
  let ledgerToken: string;

  beforeEach(async () => {
    fixture = await financePostgres([user, userBill, systemAdmin, systemRole]);
    await fixture.db.insert(user).values([
      { uid: 11, account: "active", nickname: "Active", integral: 100, status: 1 },
      { uid: 22, account: "inactive", nickname: "Inactive", integral: 50, status: 0 },
      { uid: 33, account: "other", nickname: "Other", integral: 9, status: 1 },
    ]);
    await fixture.db.insert(userBill).values([
      { id: 1, uid: 11, category: "integral", type: "gain", pm: 1, number: "10.00", addTime: at(21, 1) },
      { id: 2, uid: 11, category: "integral", type: "gain", pm: 1, number: "5.00", addTime: at(22, 1) },
      { id: 3, uid: 11, category: "integral", type: "system_add", pm: 1, number: "2.00", addTime: at(22, 2) },
      { id: 4, uid: 11, category: "integral", type: "sign", pm: 1, number: "3.00", addTime: at(22, 3) },
      { id: 5, uid: 11, category: "integral", type: "lottery_add", pm: 1, number: "4.00", addTime: at(23, 1) },
      { id: 6, uid: 11, category: "integral", type: "deduction", pm: 0, number: "6.00", addTime: at(21, 2) },
      { id: 7, uid: 11, category: "integral", type: "lottery_use", pm: 0, number: "1.00", addTime: at(21, 3) },
      { id: 8, uid: 11, category: "integral", type: "system_sub", pm: 0, number: "2.00", addTime: at(22, 4) },
      { id: 9, uid: 11, category: "integral", type: "pay_product_integral_back", pm: 1, number: "7.00", addTime: at(22, 5) },
      { id: 10, uid: 11, category: "integral", type: "storeIntegral_use", pm: 0, number: "8.00", addTime: at(23, 2) },
      { id: 11, uid: 11, category: "now_money", type: "gain", pm: 1, number: "999.00", addTime: at(22, 6) },
      { id: 12, uid: 11, category: "integral", type: "gain", pm: 1, number: "20.00", addTime: at(20, 23) },
    ]);
    await fixture.db.insert(systemRole).values([
      { id: 1, roleName: "积分统计查看", rules: "point_statistic.view" },
      { id: 2, roleName: "仅积分日志", rules: "integral_log.view" },
    ]);
    await fixture.db.insert(systemAdmin).values([
      { id: 91, account: "point-reader", pwd: "point-fixture", level: 1, roles: "1", adminType: 1 },
      { id: 92, account: "ledger-reader", pwd: "ledger-fixture", level: 1, roles: "2", adminType: 1 },
    ]);
    bindings = { APP_KEY: "point-statistic-test-signing-key", UPSTASH_REDIS_URL: "", UPSTASH_REDIS_TOKEN: "" } as Env;
    viewerToken = (await createToken(91, "admin", md5("point-fixture"), bindings.APP_KEY)).token;
    ledgerToken = (await createToken(92, "admin", md5("ledger-fixture"), bindings.APP_KEY)).token;
    app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use("*", async (c, next) => { c.set("container", createContainerFromDb(fixture.db)); await next(); });
    app.onError((error, c) => c.json({ status: error instanceof ApiException ? error.code : 500, msg: error.message, data: null }));
    app.get("/adminapi/marketing/point/get_basic", adminAuthMiddleware(), PointStatistic.basic);
    app.get("/adminapi/marketing/point/get_trend", adminAuthMiddleware(), PointStatistic.trend);
    app.get("/adminapi/marketing/point/get_channel", adminAuthMiddleware(), PointStatistic.channel);
    app.get("/adminapi/marketing/point/get_type", adminAuthMiddleware(), PointStatistic.type);
  });
  afterEach(async () => { await fixture?.close(); });

  async function get(path: "get_basic" | "get_trend" | "get_channel" | "get_type", range = time, token = viewerToken) {
    const response = await app.request(`/adminapi/marketing/point/${path}?time=${encodeURIComponent(range)}`,
      { headers: token ? { "Authori-zation": `Bearer ${token}` } : {} }, bindings);
    return { response, body: await response.json<Reply>() };
  }

  it("keeps four GETs under a separate read-only permission and disables shared caches", async () => {
    for (const path of ["get_basic", "get_trend", "get_channel", "get_type"] as const) {
      expect(requiredAdminPermission("GET", `/adminapi/marketing/point/${path}`)).toBe("point_statistic.view");
      const allowed = await get(path);
      expect(allowed.body.status, `${path}: ${JSON.stringify(allowed.body)}`).toBe(200);
      expect(allowed.response.headers.get("cache-control")).toContain("private");
      expect(allowed.response.headers.get("cache-control")).toContain("no-store");
      expect((await get(path, time, ledgerToken)).body.status).not.toBe(200);
      expect((await get(path, time, "")).body.status).not.toBe(200);
    }
    expect(requiredAdminPermission("GET", "/adminapi/marketing/user-point/logs")).toBe("integral_log.view");
  });

  it("preserves active-user current balance, dated ledger totals and both trend series", async () => {
    expect((await get("get_basic")).body.data).toEqual({ now_point: "109", all_point: "31.00", pay_point: "17.00" });
    const trend = (await get("get_trend")).body.data;
    expect(trend.xAxis).toEqual(["2026-09-21", "2026-09-22", "2026-09-23"]);
    expect(trend.series.map((row: { name: string; data: number[] }) => row.name)).toEqual(["积分积累", "积分消耗"]);
    expect(trend.series[0].data).toEqual([10, 17, 4]);
    expect(trend.series[1].data).toEqual([7, 2, 8]);
    const empty = (await get("get_basic", "2026/01/01-2026/01/02")).body.data;
    expect(empty).toEqual({ now_point: "109", all_point: "0", pay_point: "0" });
    const long = (await get("get_trend", "2026/08/23-2026/09/23")).body.data;
    expect(long.xAxis.length).toBe(11);
    expect(long.series[0].data.reduce((sum: number, amount: number) => sum + amount, 0)).toBe(51);
  });

  it("keeps the duplicated gain source and includes positive refund rows in old spend types", async () => {
    const source = (await get("get_channel")).body.data;
    expect(source.bing_xdata).toEqual(["订单赠送", "商品赠送", "后台赠送", "签到获得", "九宫格抽奖"]);
    expect(source.bing_data.map((row: { value: number }) => row.value)).toEqual([15, 15, 2, 3, 4]);
    expect(source.list[0]).toEqual({ name: "订单赠送", value: 15, percent: 38.4 });
    expect(source.list[1]).toEqual({ name: "商品赠送", value: 15, percent: 38.4 });
    const spend = (await get("get_type")).body.data;
    expect(spend.bing_xdata).toEqual(["订单抵扣", "九宫格抽奖", "后台减少", "退款退回", "兑换商品"]);
    expect(spend.bing_data.map((row: { value: number }) => row.value)).toEqual([6, 1, 2, 7, 8]);
    expect(spend.list[1]).toEqual({ name: "退款退回", value: 7, percent: 29.1 });
  });

  it("rejects malformed and unbounded date input before reading business rows", async () => {
    expect(parsePointStatisticRange("", at(23, 8)).days).toBe(30);
    for (const range of ["2026/09/22-2026/09/21", "2026/02/30-2026/03/01",
      "2026/09/21-2026/09/23junk", "2026/09/21-2026/09/23;DROP", "2000/01/01-2026/09/23",
      "x".repeat(40)]) {
      expect((await get("get_basic", range)).body.status, range).toBe(400);
    }
  });
});
