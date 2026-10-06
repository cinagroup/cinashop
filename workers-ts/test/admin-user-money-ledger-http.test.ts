import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppVariables, Env } from "../src/env";
import { createContainerFromDb } from "../src/lib/di";
import { user, userMoney, userBill, systemAdmin, systemRole } from "../src/models/schema";
import * as Ledger from "../src/controllers/api/v1/AdminUserMoneyLedgerController";
import { adminAuthMiddleware } from "../src/middleware/admin-auth";
import { requiredAdminPermission } from "../src/services/admin/AdminPermissionService";
import { ApiException } from "../src/utils/errors";
import { createToken, md5 } from "../src/utils/jwt";
import { financePostgres } from "./helpers/financePostgres";

type Reply = { status: number; msg: string; data: any };

describe("dedicated Admin cash-ledger HTTP contract", () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>;
  let app: Hono<{ Bindings: Env; Variables: AppVariables }>;
  let bindings: Env;
  const tokens: Record<string, string> = {};

  beforeEach(async () => {
    fixture = await financePostgres([user, userMoney, userBill, systemAdmin, systemRole]);
    await fixture.db.insert(user).values({ uid: 11, nickname: "现金会员", account: "cash-11" });
    await fixture.db.insert(userMoney).values([
      { id: 1, uid: 11, type: "recharge", title: "充值", number: "25.50", pm: 1, addTime: 1_700_000_000 },
      { id: 2, uid: 11, type: "pay_product", title: "消费", number: "10.00", pm: 0, addTime: 1_700_000_001 },
      { id: 3, uid: 11, type: "sign", title: "旧排除型", number: "100.00", pm: 1 },
    ]);
    await fixture.db.insert(userBill).values({ id: 99, uid: 11, category: "integral", title: "积分", number: "999.00" });
    await fixture.db.insert(systemRole).values([
      { id: 1, roleName: "现金查看", rules: "bill.view" },
      { id: 2, roleName: "现金导出", rules: "bill.export" },
      { id: 3, roleName: "积分查看", rules: "integral_log.view" },
    ]);
    await fixture.db.insert(systemAdmin).values([
      { id: 91, account: "cash-view", pwd: "cash-view-fixture", level: 1, roles: "1", adminType: 1 },
      { id: 92, account: "cash-export", pwd: "cash-export-fixture", level: 1, roles: "2", adminType: 1 },
      { id: 93, account: "point-view", pwd: "point-view-fixture", level: 1, roles: "3", adminType: 1 },
    ]);
    bindings = { APP_KEY: "cash-ledger-http-signing-key", UPSTASH_REDIS_URL: "", UPSTASH_REDIS_TOKEN: "" } as Env;
    for (const [name, id, password] of [["view", 91, "cash-view-fixture"], ["export", 92, "cash-export-fixture"],
      ["point", 93, "point-view-fixture"]] as const) {
      tokens[name] = (await createToken(id, "admin", md5(password), bindings.APP_KEY)).token;
    }
    app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use("*", async (c, next) => { c.set("container", createContainerFromDb(fixture.db)); await next(); });
    app.onError((error, c) => c.json({ status: error instanceof ApiException ? error.code : 500, msg: error.message, data: null }));
    for (const base of ["/adminapi", "/api/admin"]) {
      app.get(`${base}/finance/user-money-ledger/types`, adminAuthMiddleware(), Ledger.types);
      app.get(`${base}/finance/user-money-ledger/export`, adminAuthMiddleware(), Ledger.exportManifest);
      app.get(`${base}/finance/user-money-ledger`, adminAuthMiddleware(), Ledger.list);
    }
  }, 30_000);
  afterEach(async () => { await fixture?.close(); }, 30_000);

  async function get(base: "/adminapi" | "/api/admin", suffix = "", role = "view") {
    const response = await app.request(`${base}/finance/user-money-ledger${suffix}`,
      { headers: role ? { "Authori-zation": `Bearer ${tokens[role]}` } : {} }, bindings);
    return { response, body: await response.json<Reply>() };
  }

  it.each(["/adminapi", "/api/admin"] as const)("keeps read/export grants and cash/points separate on %s", async base => {
    expect(requiredAdminPermission("GET", `${base}/finance/user-money-ledger`)).toBe("bill.view");
    expect(requiredAdminPermission("GET", `${base}/finance/user-money-ledger/types`)).toBe("bill.view");
    expect(requiredAdminPermission("GET", `${base}/finance/user-money-ledger/export`)).toBe("bill.export");
    expect((await get(base, "", "point")).body.status).not.toBe(200);
    expect((await get(base, "", "export")).body.status).not.toBe(200);
    expect((await get(base, "/export", "view")).body.status).not.toBe(200);
    expect((await get(base, "", "")).body.status).not.toBe(200);
    const list = await get(base);
    expect(list.body).toMatchObject({ status: 200, data: { count: 2, page: 1, limit: 20 } });
    expect(list.body.data.list.map((row: { id: number }) => row.id)).toEqual([2, 1]);
    expect(list.body.data.list[0]).toMatchObject({ uid: 11, number: "10.00", pm: 0 });
    expect(list.response.headers.get("cache-control")).toContain("no-store");
    const types = await get(base, "/types");
    expect(types.body.data.list.map((row: { type: string }) => row.type)).toEqual(["pay_product", "recharge", "sign"]);
    const exported = await get(base, "/export?limit=1", "export");
    expect(exported.body).toMatchObject({ status: 200, data: { count: 2, page: 1, has_more: true } });
    expect(exported.body.data.export[0]).toMatchObject({ uid: "11", pm: "-10.00", title: "消费" });
    const next = await get(base, `/export?page=2&limit=1&snapshot=${exported.body.data.snapshot}`, "export");
    expect(next.body.data.export[0]).toMatchObject({ uid: "11", pm: "25.50", title: "充值" });
  });

  it("rejects malformed or duplicate query parameters before any ledger result", async () => {
    for (const suffix of ["?page=0", "?limit=15", "?keyword=%00", "?page=1&page=2", "?start=1700000000", "?type=sign%00"]) {
      expect((await get("/adminapi", suffix)).body.status, suffix).toBe(400);
    }
    expect((await get("/adminapi", "/types?keyword=现金会员")).body.status).toBe(400);
    expect((await get("/adminapi", "/export?page=2&limit=1", "export")).body.status).toBe(400);
  });
});
