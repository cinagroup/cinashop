import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppVariables, Env } from "../src/env";
import { createContainerFromDb } from "../src/lib/di";
import { storeOrder, storeSeckill, systemAdmin, systemRole } from "../src/models/schema";
import * as Statistics from "../src/controllers/api/v1/AdminSeckillStatisticsController";
import { adminAuthMiddleware } from "../src/middleware/admin-auth";
import { AdminPermissionService, requiredAdminPermission } from "../src/services/admin/AdminPermissionService";
import { ApiException } from "../src/utils/errors";
import { createToken, md5 } from "../src/utils/jwt";
import { financePostgres } from "./helpers/financePostgres";

type Reply = { status: number; msg: string; data: any };

describe("read-only Admin seckill statistics", () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>;
  let app: Hono<{ Bindings: Env; Variables: AppVariables }>;
  let bindings: Env;
  let statisticsToken: string;
  let activityToken: string;

  beforeEach(async () => {
    fixture = await financePostgres([storeSeckill, storeOrder, systemAdmin, systemRole]);
    await fixture.db.insert(storeSeckill).values([
      { id: 7, storeName: "七号秒杀", quota: 10, quotaShow: 20 },
      { id: 8, storeName: "八号秒杀", quota: 3, quotaShow: 9 },
    ]);
    await fixture.db.insert(storeOrder).values([
      { id: 1, unique: "s1", orderId: "SO-001", type: 1, activityId: 7, uid: 11, realName: "甲", userPhone: "13800000011", paid: 0, totalNum: 1, payPrice: "7.00", addTime: 100 },
      { id: 2, unique: "s2", orderId: "SO-002", type: 1, activityId: 7, uid: 11, realName: "甲", userPhone: "13800000011", paid: 1, totalNum: 2, payPrice: "10.00", addTime: 200 },
      { id: 3, unique: "s3", orderId: "SO-003", type: 1, activityId: 7, uid: 11, realName: "甲", userPhone: "13800000011", paid: 1, refundStatus: 2, refundType: 6, totalNum: 1, payPrice: "20.00", addTime: 300 },
      { id: 4, unique: "s4", orderId: "SO-004", type: 1, activityId: 7, uid: 22, realName: "百%分", userPhone: "13900000022", paid: 1, isDel: 1, totalNum: 3, payPrice: "30.00", addTime: 400 },
      { id: 5, unique: "s5", orderId: "SO-005", type: 1, activityId: 7, uid: 22, pid: 99, paid: 1, totalNum: 99, payPrice: "99.00", addTime: 500 },
      { id: 6, unique: "s6", orderId: "SO-006", type: 2, activityId: 7, uid: 33, paid: 1, totalNum: 99, payPrice: "99.00", addTime: 600 },
      { id: 7, unique: "s7", orderId: "SO-007", type: 1, activityId: 8, uid: 44, paid: 1, totalNum: 99, payPrice: "99.00", addTime: 700 },
      { id: 8, unique: "s8", orderId: "SO-008", type: 1, activityId: 7, uid: 22, realName: "乙", userPhone: "13900000022", paid: 1, status: 3, totalNum: 3, payPrice: "40.00", addTime: 800, payTime: 810 },
      { id: 9, unique: "s9", orderId: "SO-009", type: 1, activityId: 7, uid: 55, realName: "未付", paid: 0, totalNum: 1, payPrice: "5.00", addTime: 900 },
    ]);
    await fixture.db.insert(systemRole).values([
      { id: 1, roleName: "秒杀统计", rules: "seckill_statistics.view" },
      { id: 2, roleName: "活动目录", rules: "activity.view,activity.manage" },
    ]);
    await fixture.db.insert(systemAdmin).values([
      { id: 90, account: "stats-reader", pwd: "stats-fixture", level: 1, roles: "1", adminType: 1 },
      { id: 91, account: "activity-editor", pwd: "activity-fixture", level: 1, roles: "2", adminType: 1 },
    ]);
    bindings = { APP_KEY: "seckill-statistics-test-signing-key", UPSTASH_REDIS_URL: "", UPSTASH_REDIS_TOKEN: "" } as Env;
    statisticsToken = (await createToken(90, "admin", md5("stats-fixture"), bindings.APP_KEY)).token;
    activityToken = (await createToken(91, "admin", md5("activity-fixture"), bindings.APP_KEY)).token;
    app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use("*", async (c, next) => { c.set("container", createContainerFromDb(fixture.db)); await next(); });
    app.onError((error, c) => c.json({ status: error instanceof ApiException ? error.code : 500, msg: error.message, data: null }));
    const auth = adminAuthMiddleware();
    app.get("/adminapi/activity/seckill-statistics/:id/head", auth, Statistics.head);
    app.get("/adminapi/activity/seckill-statistics/:id/people", auth, Statistics.people);
    app.get("/adminapi/activity/seckill-statistics/:id/orders", auth, Statistics.orders);
  });
  afterEach(async () => { await fixture?.close(); });

  async function get(part: "head" | "people" | "orders", query = "", id = "7", token = statisticsToken) {
    const response = await app.request(`/adminapi/activity/seckill-statistics/${id}/${part}${query}`,
      { headers: token ? { "Authori-zation": `Bearer ${token}` } : {} }, bindings);
    return { response, body: await response.json<Reply>() };
  }

  it("isolates personal statistics from general activity.view and disables caching", async () => {
    for (const part of ["head", "people", "orders"] as const) {
      expect(requiredAdminPermission("GET", `/adminapi/activity/seckill-statistics/7/${part}`)).toBe("seckill_statistics.view");
      expect((await get(part)).body.status).toBe(200);
      expect((await get(part, "", "7", activityToken)).body.status).not.toBe(200);
      expect((await get(part, "", "7", "")).body.status).not.toBe(200);
      const { response } = await get(part);
      expect(response.headers.get("cache-control")).toContain("private");
      expect(response.headers.get("cache-control")).toContain("no-store");
    }
    expect(requiredAdminPermission("GET", "/adminapi/activity/seckill")).toBe("activity.view");
    const menus = new AdminPermissionService(createContainerFromDb(fixture.db))
      .buildMenus(new Set(["seckill_statistics.view"]));
    expect(menus.map((menu) => menu.path)).toEqual(["/activity/seckill-statistics"]);
  });

  it("reproduces distinct people and the legacy paid/refund/stock head meanings", async () => {
    const { body } = await get("head");
    expect(body.data).toEqual({ id: 7, store_name: "七号秒杀", order_count: 3,
      all_price: "80.00", pay_count: 2, pay_rate: "10/20" });
    expect((await get("head", "", "8")).body.data).toEqual({ id: 8, store_name: "八号秒杀",
      order_count: 1, all_price: "99.00", pay_count: 1, pay_rate: "3/9" });
  });

  it("groups paid main orders by participant and searches only order identity fields", async () => {
    const all = (await get("people", "?page=1&limit=1")).body.data;
    expect(all).toMatchObject({ count: 2, page: 1, limit: 1 });
    expect(all.list).toEqual([{ uid: 22, real_name: "乙", goods_num: 6, order_num: 2,
      total_price: "70.00", add_time: 800 }]);
    const next = (await get("people", "?page=2&limit=1")).body.data;
    expect(next.list).toEqual([{ uid: 11, real_name: "甲", goods_num: 3, order_num: 2,
      total_price: "30.00", add_time: 300 }]);
    expect((await get("people", "?real_name=13900000022")).body.data.count).toBe(1);
    expect((await get("people", "?real_name=SO-008")).body.data.count).toBe(0);
    expect((await get("people", "?real_name=%25")).body.data.list[0]).toMatchObject({ uid: 22, goods_num: 3 });
  });

  it("keeps order list and total on the same paid main-order predicate", async () => {
    const all = (await get("orders", "?page=1&limit=2")).body.data;
    expect(all).toMatchObject({ count: 4, page: 1, limit: 2 });
    expect(all.list.map((row: { id: number }) => row.id)).toEqual([8, 4]);
    expect(all.list[1].status).toBe("已删除");
    const second = (await get("orders", "?page=2&limit=2")).body.data;
    expect(second.list.map((row: { id: number }) => row.id)).toEqual([3, 2]);
    expect(second.list[0].status).toBe("已退款");
    expect((await get("orders", "?status=0")).body.data).toMatchObject({ count: 0, list: [] });
    expect((await get("orders", "?status=1")).body.data).toMatchObject({ count: 1 });
    expect((await get("orders", "?status=4")).body.data.list[0]).toMatchObject({ id: 8, status: "已完成" });
    expect((await get("orders", "?real_name=SO-008")).body.data.list[0]).toMatchObject({ id: 8 });
    expect((await get("orders", "?real_name=%25")).body.data.list[0]).toMatchObject({ id: 4 });
    expect((await get("orders", "?real_name=13900000022")).body.data.count).toBe(2);
  });

  it("retains the legacy pid=-1 main-order variant in paid totals and the status filter", async () => {
    await fixture.db.insert(storeOrder).values({ id: 10, unique: "s10", orderId: "SO-010", type: 1,
      activityId: 7, uid: 66, realName: "丙", pid: -1, paid: 1, status: 1,
      shippingType: 1, totalNum: 2, payPrice: "5.00", addTime: 1000 });
    expect((await get("head")).body.data).toMatchObject({ order_count: 4, pay_count: 3, all_price: "85.00" });
    expect((await get("people", "?real_name=丙")).body.data.list[0]).toMatchObject({ uid: 66, goods_num: 2 });
    expect((await get("orders", "?status=2")).body.data).toMatchObject({ count: 1,
      list: [{ id: 10, order_id: "SO-010" }] });
  });

  it("rejects missing products, invalid IDs and unbounded filters", async () => {
    expect((await get("head", "", "99")).body.status).toBe(404);
    for (const id of ["0", "-1", "x", "2147483648"]) expect((await get("head", "", id)).body.status).toBe(400);
    for (const query of ["?page=0", "?page=10001", "?limit=101", "?limit=1e2", "?status=5",
      "?page=2000&limit=100", `?real_name=${"x".repeat(101)}`]) {
      expect((await get("people", query)).body.status, query).toBe(400);
      expect((await get("orders", query)).body.status, query).toBe(400);
    }
  });
});
