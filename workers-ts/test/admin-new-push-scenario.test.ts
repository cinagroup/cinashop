import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import {
  storeOrder, storeProduct, storeProductReply, userExtract, systemRole, systemMenus, systemAdmin,
  user, userBrokerage, userMoney, userRecharge, systemConfig, capitalFlow, storeOrderOutbox,
} from "@/models/schema";
import { createContainerFromDb, type Container } from "@/lib/di";
import type { Env, AppVariables } from "@/env";
import { AdminNewPushService } from "@/services/admin/AdminNewPushService";
import { AdminPermissionService } from "@/services/admin/AdminPermissionService";
import { adminNewPush } from "@/controllers/api/v1/AdminController";
import { adminAuthMiddleware } from "@/middleware/admin-auth";
import { errorHandler } from "@/middleware/error";
import { createToken, md5 } from "@/utils/jwt";
import { UserWithdrawalService } from "@/services/user/UserWithdrawalService";
import { financePostgres } from "./helpers/financePostgres";

let fixture: Awaited<ReturnType<typeof financePostgres>>, container: Container, service: AdminNewPushService;
const root = { id: 1, account: "admin", level: 0, roles: "", realName: "管理员", divisionId: 0 };
const actor = (roles: string) => ({ ...root, level: 1, roles });
beforeAll(async () => {
  fixture = await financePostgres([storeOrder, storeProduct, storeProductReply, userExtract, systemRole, systemMenus, systemAdmin,
    user, userBrokerage, userMoney, userRecharge, systemConfig, capitalFlow, storeOrderOutbox]);
  await fixture.exec("CREATE UNIQUE INDEX cf_event_key_uq ON capital_flow(event_key); CREATE UNIQUE INDEX soob_event_key_uq ON store_order_outbox(event_key);");
  container = createContainerFromDb(fixture.db); service = new AdminNewPushService(container);
}, 30000);
afterAll(async () => { await fixture?.close(); });
beforeEach(async () => { await fixture.reset(); });

async function funding() {
  await fixture.db.insert(user).values({ uid: 7, nickname: "测试申请人", brokeragePrice: "100.00" });
  await fixture.db.insert(systemConfig).values(Object.entries({ user_extract_min_price: "1", user_extract_max_price: "1000", withdraw_fee: "2.5", brokerage_type: "0", user_extract_balance_status: "1" }).map(([menuName, value]) => ({ menuName, value })));
  return new UserWithdrawalService(container);
}
const application = () => ({ extractType: "alipay", extractPrice: "20.00", realName: "测试申请人", extractNumber: "preview@example.invalid", requestKey: `local-intent-${crypto.randomUUID()}` });

describe("permission-scoped admin pending work", () => {
  it("reports an exact zero snapshot, not a fabricated count, and rejects missing actors", async () => {
    const counts = await service.snapshot(root);
    expect(counts).toEqual({ ordernum: 0, inventory: 0, commentnum: 0, reflectnum: 0, msgcount: 0, sampled_at: expect.any(Number) });
    expect(Math.abs(counts.sampled_at - Math.floor(Date.now() / 1000))).toBeLessThan(5);
    await expect(service.snapshot(undefined)).rejects.toThrow("请登录");
    await expect(service.snapshot({ ...root, id: 0 })).rejects.toThrow("请登录");
  });
  it("includes paid partial shipment and excludes refunds, pickup, deleted and split parents", async () => {
    await fixture.db.insert(storeOrder).values([
      { id: 1, paid: 1 }, { id: 2, paid: 1, status: 4, refundStatus: 3 },
      { id: 3, paid: 0 }, { id: 4, paid: 1, status: 1 }, { id: 5, paid: 1, refundStatus: 1 },
      { id: 6, paid: 1, refundStatus: 2 }, { id: 7, paid: 1, shippingType: 2 },
      { id: 8, paid: 1, shippingType: 3 }, { id: 9, paid: 1, isDel: 1 },
      { id: 10, paid: 1, isSystemDel: 1 }, { id: 11, paid: 1, pid: -1 },
      { id: 12, paid: 1, pid: 11 },
    ]);
    expect(await service.snapshot(root)).toMatchObject({ ordernum: 3, msgcount: 3 });
  });
  it("uses the inventory warning contract, not PHP's invalid product-source type=5", async () => {
    const product = { isShow: 1, isDel: 0, isVerify: 1, isPolices: 1, stock: 2 };
    await fixture.db.insert(storeProduct).values([
      { ...product, type: 0 }, { ...product, type: 2 }, { ...product, stock: 0 },
      { ...product, isShow: 0 }, { ...product, isDel: 1 }, { ...product, isVerify: 0 },
      { ...product, isPolices: 0 }, { type: 5, isPolices: 0 },
    ]);
    expect(await service.snapshot(root)).toMatchObject({ inventory: 2, msgcount: 2 });
  });
  it("counts unreplied non-deleted reviews and pending withdrawals only", async () => {
    await fixture.db.insert(storeProductReply).values([{ isReply: 0 }, { isReply: 0, isDel: 1 }, { isReply: 1 }]);
    await fixture.db.insert(userExtract).values([{ status: 0 }, { status: 0 }, { status: 1 }, { status: -1 }]);
    expect(await service.snapshot(root)).toMatchObject({ commentnum: 1, reflectnum: 2, msgcount: 3 });
    await fixture.db.update(userExtract).set({ status: 1 }).where(eq(userExtract.id, 1));
    expect(await service.snapshot(root)).toMatchObject({ reflectnum: 1, msgcount: 2 });
    expect(await fixture.db.select().from(userExtract)).toHaveLength(4);
  });
  it("never leaks restricted counts or adds them back into the total", async () => {
    await fixture.db.insert(storeOrder).values({ paid: 1 });
    await fixture.db.insert(userExtract).values([{ status: 0 }, { status: 0 }]);
    await fixture.db.insert(systemRole).values([
      { id: 1, rules: "extract.manage", status: 1 }, { id: 2, rules: "order.view", status: 1 },
      { id: 3, rules: "extract.view", status: 0 }, { id: 4, rules: "dashboard.view", status: 1 },
    ]);
    expect(await service.snapshot(actor("1"))).toMatchObject({ ordernum: 0, reflectnum: 2, msgcount: 2 });
    expect(await service.snapshot(actor("2"))).toMatchObject({ ordernum: 1, reflectnum: 0, msgcount: 1 });
    for (const roles of ["3", "4", "", "999"]) expect(await service.snapshot(actor(roles))).toMatchObject({ msgcount: 0 });
    expect(await service.snapshot(actor("1,2"))).toMatchObject({ ordernum: 1, reflectnum: 2, msgcount: 3 });
    await fixture.db.update(systemRole).set({ status: 0 }).where(eq(systemRole.id, 1));
    expect(await service.snapshot(actor("1,2"))).toMatchObject({ reflectnum: 0, msgcount: 1 });
  });
  it("resolves legacy numeric menu rules without accepting client-selected capabilities", async () => {
    await fixture.db.insert(userExtract).values({ status: 0 });
    await fixture.db.insert(systemRole).values({ id: 5, rules: "51" });
    await fixture.db.insert(systemMenus).values({ id: 51, type: 1, authType: 2, access: 1, apiUrl: "/adminapi/extract/list", methods: "GET" });
    expect(await service.snapshot(actor("5"))).toMatchObject({ reflectnum: 1, msgcount: 1 });
    await fixture.db.update(systemMenus).set({ isDel: 1 }).where(eq(systemMenus.id, 51));
    expect(await service.snapshot(actor("5"))).toMatchObject({ reflectnum: 0, msgcount: 0 });
  });
  it("allows only the read-only common-header exception, not dashboard or writes", async () => {
    const permissions = new AdminPermissionService(container);
    for (const path of ["/adminapi/new_push", "/api/admin/new_push"]) {
      await expect(permissions.assertAuthorized(actor(""), "GET", path)).resolves.toBeUndefined();
      await expect(permissions.assertAuthorized(actor(""), "POST", path)).rejects.toThrow("权限");
    }
    await expect(permissions.assertAuthorized(actor(""), "GET", "/adminapi/home/header")).rejects.toThrow("权限");
  });
  it("both controller aliases preserve the PHP envelope, reject cache reuse and ignore role query input", async () => {
    await fixture.db.insert(userExtract).values({ status: 0 });
    await fixture.db.insert(systemRole).values({ id: 1, rules: "extract.view" });
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use("*", async (c, next) => { c.set("container", container); c.set("adminInfo", actor("1")); await next(); });
    app.get("/adminapi/new_push", adminNewPush); app.get("/api/admin/new_push", adminNewPush);
    for (const path of ["/adminapi/new_push", "/api/admin/new_push"]) {
      const response = await app.request(`${path}?roles=0&permissions=order.view&admin_id=99`);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
      expect(await response.json()).toMatchObject({ status: 200, data: { reflectnum: 1, ordernum: 0, msgcount: 1 } });
    }
  });
  it("keeps the common header behind real authentication and the platform-admin security domain", async () => {
    const signingKey = crypto.randomUUID();
    const bindings: Partial<Env> = { APP_KEY: signingKey, UPSTASH_REDIS_URL: "", UPSTASH_REDIS_TOKEN: "" };
    await fixture.db.insert(systemAdmin).values({ id: 1, account: "finance", pwd: "local-fixture-only", level: 1, roles: "1", adminType: 1 });
    await fixture.db.insert(systemRole).values({ id: 1, rules: "extract.view" });
    await fixture.db.insert(userExtract).values({ status: 0 });
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.onError(errorHandler);
    app.use("*", async (c, next) => { c.set("container", container); await next(); });
    app.get("/adminapi/new_push", adminAuthMiddleware(), adminNewPush);
    const headers = (token: string) => ({ "Authori-zation": `Bearer ${token}` });
    const adminToken = (await createToken(1, "admin", md5("local-fixture-only"), signingKey)).token;
    const userToken = (await createToken(1, "api", "", signingKey)).token;
    const get = (token = "") => app.request("/adminapi/new_push", { headers: token ? headers(token) : {} }, bindings as Env);
    expect(await (await get()).json()).toMatchObject({ status: 410000 });
    expect(await (await get(userToken)).json()).not.toMatchObject({ status: 200 });
    expect(await (await get(adminToken)).json()).toMatchObject({ status: 200, data: { reflectnum: 1, msgcount: 1 } });
    await fixture.db.update(systemAdmin).set({ adminType: 4 }).where(eq(systemAdmin.id, 1));
    expect(await (await get(adminToken)).json()).not.toMatchObject({ status: 200 });
    await fixture.db.update(systemAdmin).set({ adminType: 1, status: 0 }).where(eq(systemAdmin.id, 1));
    expect(await (await get(adminToken)).json()).not.toMatchObject({ status: 200 });
  });
  it("tracks real apply/replay/reject and automatic balance approval without writing extra funds", async () => {
    const withdrawals = await funding(), input = application();
    const request = await withdrawals.apply(7, input);
    expect((await service.snapshot(root)).reflectnum).toBe(1);
    expect(await withdrawals.apply(7, input)).toEqual(request);
    expect((await service.snapshot(root)).reflectnum).toBe(1);
    await withdrawals.review(request.id, 2, "本地测试拒绝");
    expect((await service.snapshot(root)).reflectnum).toBe(0);
    await withdrawals.review(request.id, 2, "本地测试拒绝");
    expect((await fixture.db.select().from(user))[0].brokeragePrice).toBe("100.00");
    await withdrawals.apply(7, { ...application(), extractType: "balance" });
    expect((await service.snapshot(root)).reflectnum).toBe(0);
    expect(await fixture.db.select().from(userExtract)).toHaveLength(2);
    expect(await fixture.db.select().from(capitalFlow)).toHaveLength(1);
    expect(await fixture.db.select().from(storeOrderOutbox)).toHaveLength(2);
  });
  it("does not expose a phantom pending request after a late ledger failure rolls back", async () => {
    const withdrawals = await funding();
    await fixture.exec("CREATE FUNCTION fail_todo_debit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected debit failure'; END $$; CREATE TRIGGER fail_todo_debit BEFORE INSERT ON user_brokerage FOR EACH ROW EXECUTE FUNCTION fail_todo_debit();");
    try {
      await expect(withdrawals.apply(7, application())).rejects.toThrow();
      expect((await service.snapshot(root)).reflectnum).toBe(0);
      expect(await fixture.db.select().from(userExtract)).toHaveLength(0);
      expect((await fixture.db.select().from(user))[0].brokeragePrice).toBe("100.00");
    } finally { await fixture.exec("DROP TRIGGER fail_todo_debit ON user_brokerage; DROP FUNCTION fail_todo_debit();"); }
  });
});
