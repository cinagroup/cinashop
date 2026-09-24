import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppVariables, Env } from "../src/env";
import { createContainerFromDb } from "../src/lib/di";
import { user, userBill, systemAdmin, systemRole } from "../src/models/schema";
import { list, statistics } from "../src/controllers/api/v1/AdminIntegralLogController";
import { adminAuthMiddleware } from "../src/middleware/admin-auth";
import { requiredAdminPermission } from "../src/services/admin/AdminPermissionService";
import { ApiException } from "../src/utils/errors";
import { createToken, md5 } from "../src/utils/jwt";
import { financePostgres } from "./helpers/financePostgres";

type Reply = { status: number; msg: string; data: any };

describe("read-only Admin integral ledger", () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>;
  let app: Hono<{ Bindings: Env; Variables: AppVariables }>;
  let bindings: Env;
  let viewerToken: string;
  let financeToken: string;

  beforeEach(async () => {
    fixture = await financePostgres([user, userBill, systemAdmin, systemRole]);
    await fixture.db.insert(user).values([
      { uid: 11, account: "alice-account", nickname: "Alice", phone: "13800138000" },
      { uid: 22, account: "literal-account", nickname: "百分%_\\", phone: "13900139000" },
    ]);
    await fixture.db.insert(userBill).values([
      { id: 1, uid: 11, category: "integral", type: "sign", pm: 1, title: "每日签到", number: "10.00", balance: "10.00", mark: "签到", addTime: 100 },
      { id: 2, uid: 11, category: "integral", type: "sign", pm: 1, title: "第二次签到", number: "5.80", balance: "15.80", addTime: 200 },
      { id: 3, uid: 11, category: "integral", type: "order_integral_refund", pm: 1, title: "订单积分退还", number: "3.00", balance: "18.80", addTime: 300 },
      { id: 4, uid: 11, category: "integral", type: "buy", pm: 0, title: "兑换商品", number: "4.20", balance: "14.60", addTime: 400 },
      { id: 5, uid: 11, category: "integral", type: "reward", pm: 1, title: "活动奖励", number: "7.00", balance: "21.60", addTime: 500, status: 0 },
      { id: 6, uid: 22, category: "integral", type: "sign", pm: 1, title: "签到奖励", number: "2.00", balance: "2.00", addTime: 600 },
      { id: 7, uid: 22, category: "now_money", type: "sign", pm: 1, title: "余额充值", number: "999.00", balance: "999.00", addTime: 700 },
    ]);
    await fixture.db.insert(systemRole).values([
      { id: 1, roleName: "积分查看", rules: "integral_log.view" },
      { id: 2, roleName: "财务查看", rules: "bill.view" },
    ]);
    await fixture.db.insert(systemAdmin).values([
      { id: 91, account: "integral-reader", pwd: "integral-fixture", level: 1, roles: "1", adminType: 1 },
      { id: 92, account: "bill-reader", pwd: "bill-fixture", level: 1, roles: "2", adminType: 1 },
    ]);
    bindings = { APP_KEY: "integral-log-test-signing-key", UPSTASH_REDIS_URL: "", UPSTASH_REDIS_TOKEN: "" } as Env;
    viewerToken = (await createToken(91, "admin", md5("integral-fixture"), bindings.APP_KEY)).token;
    financeToken = (await createToken(92, "admin", md5("bill-fixture"), bindings.APP_KEY)).token;
    app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use("*", async (c, next) => { c.set("container", createContainerFromDb(fixture.db)); await next(); });
    app.onError((error, c) => c.json({ status: error instanceof ApiException ? error.code : 500, msg: error.message, data: null }));
    app.get("/adminapi/marketing/user-point/logs", adminAuthMiddleware(), list);
    app.get("/adminapi/marketing/user-point/statistics", adminAuthMiddleware(), statistics);
  });
  afterEach(async () => { await fixture?.close(); });

  async function get(path: "logs" | "statistics", query = "", token = viewerToken) {
    const response = await app.request(`/adminapi/marketing/user-point/${path}${query}`,
      { headers: token ? { "Authori-zation": `Bearer ${token}` } : {} }, bindings);
    return { response, body: await response.json<Reply>() };
  }

  it("requires the dedicated integral view rule for both HTTP endpoints", async () => {
    for (const path of ["logs", "statistics"] as const) {
      expect(requiredAdminPermission("GET", `/adminapi/marketing/user-point/${path}`)).toBe("integral_log.view");
      expect((await get(path)).body.status).toBe(200);
      expect((await get(path, "", financeToken)).body.status).not.toBe(200);
      expect((await get(path, "", "")).body.status).not.toBe(200);
    }
    expect(requiredAdminPermission("GET", "/adminapi/bill/list")).toBe("bill.view");
  });

  it("scopes every list filter to category integral, orders by id and bounds pages", async () => {
    const all = await get("logs");
    expect(all.body).toMatchObject({ status: 200, data: { count: 6, page: 1, limit: 15 } });
    expect(all.body.data.list.map((row: { id: number }) => row.id)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(all.body.data.list[0]).toMatchObject({ uid: 22, nickname: "百分%_\\", number: "2", balance: "2" });
    expect(all.response.headers.get("cache-control")).toContain("private");
    expect(all.response.headers.get("cache-control")).toContain("no-store");
    expect((await get("logs", "?page=2&limit=2")).body.data.list.map((row: { id: number }) => row.id)).toEqual([4, 3]);
    expect((await get("logs", "?type=sign&start=200&stop=600")).body.data.list.map((row: { id: number }) => row.id)).toEqual([6, 2]);
    expect((await get("logs", "?keyword=13900139000")).body.data.list.map((row: { id: number }) => row.id)).toEqual([6]);
    expect((await get("logs", "?keyword=alice-account")).body.data.count).toBe(5);
    expect((await get("logs", "?keyword=积分退还")).body.data.list[0].id).toBe(3);
    expect((await get("logs", "?keyword=7")).body.data.count).toBe(0);
    for (const keyword of ["%", "_", "\\"]) {
      expect((await get("logs", `?keyword=${encodeURIComponent(keyword)}`)).body.data.list.map((row: { id: number }) => row.id)).toEqual([6]);
    }
  });

  it("aggregates the four legacy badges on the same integral filter without dropping pending records", async () => {
    const all = await get("statistics");
    expect(all.body).toMatchObject({ status: 200, data: {
      total_integral: "24", sign_count: "3", sign_integral: "17", used_integral: "4",
    } });
    expect(all.response.headers.get("cache-control")).toContain("no-store");
    expect((await get("statistics", "?keyword=Alice&start=200&stop=500")).body.data).toEqual({
      total_integral: "12", sign_count: "1", sign_integral: "5", used_integral: "4",
    });
    expect((await get("statistics", "?type=sign&keyword=不存在")).body.data).toEqual({
      total_integral: "0", sign_count: "0", sign_integral: "0", used_integral: "0",
    });
  });

  it("rejects malformed or unbounded filters before reading data", async () => {
    for (const query of ["?page=0", "?page=10001", "?limit=101", "?limit=1e2", "?type=sign%20or%201%3D1",
      "?start=-1", "?start=2147483648", "?start=600&stop=100", `?keyword=${"x".repeat(101)}`]) {
      expect((await get("logs", query)).body.status, query).toBe(400);
      expect((await get("statistics", query)).body.status, query).toBe(400);
    }
  });
});
