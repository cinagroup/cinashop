import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppVariables, Env } from "../src/env";
import { createContainerFromDb } from "../src/lib/di";
import { user, userBill, systemAdmin, systemRole } from "../src/models/schema";
import { exportManifest } from "../src/controllers/api/v1/AdminIntegralLogController";
import { adminAuthMiddleware } from "../src/middleware/admin-auth";
import { requiredAdminPermission } from "../src/services/admin/AdminPermissionService";
import { ApiException } from "../src/utils/errors";
import { createToken, md5 } from "../src/utils/jwt";
import { financePostgres } from "./helpers/financePostgres";

type Reply = { status: number; msg: string; data: any };

describe("independent Admin integral export HTTP contract", () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>;
  let app: Hono<{ Bindings: Env; Variables: AppVariables }>;
  let bindings: Env;
  const tokens: Record<string, string> = {};

  beforeEach(async () => {
    fixture = await financePostgres([user, userBill, systemAdmin, systemRole]);
    await fixture.db.insert(user).values({ uid: 11, nickname: "会员" });
    await fixture.db.insert(userBill).values([
      { id: 1, uid: 11, category: "integral", title: "签到", number: "5.00", balance: "5.00", addTime: 1_700_000_000 },
      { id: 2, uid: 11, category: "integral", title: "兑换", number: "2.00", balance: "3.00", addTime: 1_700_000_010 },
      { id: 3, uid: 11, category: "now_money", title: "余额", number: "999.00", balance: "999.00" },
    ]);
    await fixture.db.insert(systemRole).values([
      { id: 1, roleName: "积分查看", rules: "integral_log.view" },
      { id: 2, roleName: "积分导出", rules: "integral_log.export" },
      { id: 3, roleName: "财务查看", rules: "bill.view" },
    ]);
    await fixture.db.insert(systemAdmin).values([
      { id: 91, account: "view", pwd: "view-fixture", level: 1, roles: "1", adminType: 1 },
      { id: 92, account: "export", pwd: "export-fixture", level: 1, roles: "2", adminType: 1 },
      { id: 93, account: "finance", pwd: "finance-fixture", level: 1, roles: "3", adminType: 1 },
    ]);
    bindings = { APP_KEY: "integral-export-http-signing-key", UPSTASH_REDIS_URL: "", UPSTASH_REDIS_TOKEN: "" } as Env;
    for (const [name, id, password] of [["view", 91, "view-fixture"], ["export", 92, "export-fixture"], ["finance", 93, "finance-fixture"]] as const) {
      tokens[name] = (await createToken(id, "admin", md5(password), bindings.APP_KEY)).token;
    }
    app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use("*", async (c, next) => { c.set("container", createContainerFromDb(fixture.db)); await next(); });
    app.onError((error, c) => c.json({ status: error instanceof ApiException ? error.code : 500, msg: error.message, data: null }));
    app.get("/adminapi/marketing/user-point/export", adminAuthMiddleware(), exportManifest);
    app.get("/api/admin/marketing/user-point/export", adminAuthMiddleware(), exportManifest);
  }, 30_000);
  afterEach(async () => { await fixture?.close(); }, 30_000);

  async function get(prefix: "/adminapi" | "/api/admin", query = "", role = "export") {
    const response = await app.request(`${prefix}/marketing/user-point/export${query}`,
      { headers: role ? { "Authori-zation": `Bearer ${tokens[role]}` } : {} }, bindings);
    return { response, body: await response.json<Reply>() };
  }

  it("keeps export separate from ledger and finance reads under both prefixes", async () => {
    for (const prefix of ["/adminapi", "/api/admin"] as const) {
      expect(requiredAdminPermission("GET", `${prefix}/marketing/user-point/export`)).toBe("integral_log.export");
      expect(requiredAdminPermission("HEAD", `${prefix}/marketing/user-point/export`)).toBe("integral_log.export");
      expect((await get(prefix, "", "view")).body.status).not.toBe(200);
      expect((await get(prefix, "", "finance")).body.status).not.toBe(200);
      expect((await get(prefix, "", "")).body.status).not.toBe(200);
      const allowed = await get(prefix, "?page=1&limit=1");
      expect(allowed.body).toMatchObject({ status: 200, data: { count: 2, page: 1, limit: 1, has_more: true } });
      expect(allowed.body.data.export[0]).toMatchObject({ id: "2", title: "兑换", balance: "3", number: "2" });
      expect(allowed.response.headers.get("cache-control")).toContain("no-store");
      const next = await get(prefix, `?page=2&limit=1&snapshot=${allowed.body.data.snapshot}`);
      expect(next.body.data.export[0].id).toBe("1");
    }
  });

  it("rejects malformed export query and never includes non-integral finance records", async () => {
    expect((await get("/adminapi", "?keyword=余额")).body.data.count).toBe(0);
    for (const query of ["?page=2&limit=1", "?limit=1001", "?keyword=%00", "?page=1&page=2"]) {
      expect((await get("/adminapi", query)).body.status, query).toBe(400);
    }
  });
});
