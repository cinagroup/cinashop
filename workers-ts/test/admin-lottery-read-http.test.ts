import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppVariables, Env } from "@/env";
import { createContainerFromDb } from "@/lib/di";
import { luckLottery, luckLotteryRecord, luckPrize, systemAdmin, systemRole, user } from "@/models/schema";
import * as Lottery from "@/controllers/api/v1/AdminLotteryController";
import { adminAuthMiddleware } from "@/middleware/admin-auth";
import { requiredAdminPermission } from "@/services/admin/AdminPermissionService";
import { ApiException } from "@/utils/errors";
import { createToken, md5 } from "@/utils/jwt";
import { financePostgres } from "./helpers/financePostgres";

type Reply = { status: number; data: unknown };

describe("Admin lottery list and independent record permissions over HTTP", () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>;
  let app: Hono<{ Bindings: Env; Variables: AppVariables }>;
  let bindings: Env;
  let tokens: Record<string, string>;

  beforeEach(async () => {
    fixture = await financePostgres([luckLottery, luckPrize, luckLotteryRecord, user, systemAdmin, systemRole]);
    await fixture.db.insert(systemRole).values([
      { id: 1, roleName: "抽奖活动查看", rules: "lottery.view" },
      { id: 2, roleName: "中奖记录查看", rules: "lottery_record.view" },
      { id: 3, roleName: "中奖记录管理", rules: "lottery_record.manage" },
    ]);
    await fixture.db.insert(systemAdmin).values([
      { id: 101, account: "lottery-view", pwd: "lottery-view-password", level: 1, roles: "1", adminType: 1 },
      { id: 102, account: "record-view", pwd: "record-view-password", level: 1, roles: "2", adminType: 1 },
      { id: 103, account: "record-manage", pwd: "record-manage-password", level: 1, roles: "3", adminType: 1 },
    ]);
    await fixture.db.insert(luckLottery).values({ id: 7, name: "历史抽奖", factor: 1, status: 1, startTime: 1, endTime: 2_100_000_000 });
    await fixture.db.insert(user).values({ uid: 11, nickname: "可见昵称", realName: "隐私真名", phone: "13900000011" });
    await fixture.db.insert(luckLotteryRecord).values({ id: 71, lotteryId: 7, uid: 11, type: 6, addTime: 1_800_000_000,
      receiveInfo: JSON.stringify({ name: "隐私收货人", phone: "13800000000", address: "隐私收货地址" }),
      deliverInfo: JSON.stringify({ mark: "待复核", deliver_name: "顺丰", deliver_number: "SF123456" }) });
    bindings = { APP_KEY: "lottery-read-http-test-key", UPSTASH_REDIS_URL: "", UPSTASH_REDIS_TOKEN: "" } as Env;
    tokens = {};
    for (const [name, id, password] of [
      ["activity", 101, "lottery-view-password"],
      ["record", 102, "record-view-password"],
      ["manager", 103, "record-manage-password"],
    ] as const) tokens[name] = (await createToken(id, "admin", md5(password), bindings.APP_KEY)).token;
    app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use("*", async (c, next) => { c.set("container", createContainerFromDb(fixture.db)); await next(); });
    app.onError((error, c) => c.json({ status: error instanceof ApiException ? error.code : 500, msg: error.message, data: null }));
    for (const prefix of ["/adminapi", "/api/admin"] as const) {
      app.get(`${prefix}/lottery/list`, adminAuthMiddleware(), Lottery.list);
      app.get(`${prefix}/lottery/record/list`, adminAuthMiddleware(), Lottery.records);
      app.get(`${prefix}/lottery/record/list/:id`, adminAuthMiddleware(), Lottery.activityRecords);
      app.get(`${prefix}/lottery/record/detail/:id`, adminAuthMiddleware(), Lottery.recordDetail);
    }
  }, 30_000);

  afterEach(async () => { await fixture?.close(); }, 30_000);

  async function get(path: string, token?: string, prefix: "/adminapi" | "/api/admin" = "/adminapi") {
    const response = await app.request(`${prefix}${path}`, {
      headers: token ? { "Authori-zation": `Bearer ${token}` } : {},
    }, bindings);
    return { response, body: await response.json<Reply>() };
  }

  it("separates activity view, record view and record manage without disclosing private address or phone", async () => {
    expect(requiredAdminPermission("GET", "/adminapi/lottery/list")).toBe("lottery.view");
    expect(requiredAdminPermission("GET", "/api/admin/lottery/record/list")).toBe("lottery_record.view");
    expect(requiredAdminPermission("GET", "/adminapi/lottery/record/detail/:id")).toBe("lottery_record.manage");
    for (const prefix of ["/adminapi", "/api/admin"] as const) {
      expect((await get("/lottery/list", tokens.activity, prefix)).body.status).toBe(200);
      expect((await get("/lottery/record/list", tokens.activity, prefix)).body.status).not.toBe(200);
      expect((await get("/lottery/list", tokens.record, prefix)).body.status).not.toBe(200);
      const records = await get("/lottery/record/list", tokens.record, prefix);
      expect(records.body.status).toBe(200);
      expect(records.response.headers.get("cache-control")).toContain("no-store");
      const viewed = JSON.stringify(records.body.data);
      expect(viewed).toContain("可见昵称");
      for (const privateText of ["隐私真名", "13900000011", "13800000000", "隐私收货地址", "SF123456"]) {
        expect(viewed).not.toContain(privateText);
      }
      expect((await get("/lottery/record/detail/71", tokens.record, prefix)).body.status).not.toBe(200);
      // The platform intentionally expands every .manage grant into its .view grant.
      expect((await get("/lottery/record/list", tokens.manager, prefix)).body.status).toBe(200);
      const detail = await get("/lottery/record/detail/71", tokens.manager, prefix);
      expect(detail.body.status).toBe(200);
      expect(JSON.stringify(detail.body.data)).toContain("SF123456");
      expect(JSON.stringify(detail.body.data)).not.toContain("隐私收货地址");
      expect((await get("/lottery/record/list", undefined, prefix)).body.status).not.toBe(200);
    }
  });

  it("returns validation errors for path/query conflicts and does not broaden record reads", async () => {
    const conflict = await get("/lottery/record/list/7?lottery_id=8", tokens.record);
    expect(conflict.body.status).not.toBe(200);
    const filtered = await get("/lottery/record/list/7?lottery_id=7&type=6&start_time=1800000000", tokens.record);
    expect(filtered.body).toMatchObject({ status: 200, data: { count: 1, page: 1, limit: 15 } });
    expect((await get("/lottery/record/list?keyword=13900000011", tokens.record)).body).toMatchObject({
      status: 200, data: { count: 1 },
    });
  });
});
