import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { storeOrderOutbox, storeService, systemAdmin, systemRole, systemMenus, systemMessage, user, userExtract } from "@/models/schema";
import { createContainerFromDb, type Container } from "@/lib/di";
import type { AppVariables, Env, OrderMessage } from "@/env";
import { AdminPermissionService } from "@/services/admin/AdminPermissionService";
import { StaffNotificationAuthService } from "@/services/notification/StaffNotificationAuthService";
import { parseStaffEventKey, parseStaffSession, STAFF_REFRESH_EVENT, staffPrincipalName, type StaffSocketSession } from "@/services/notification/StaffNotificationProtocol";
import { deliverStaffRefresh, type StaffPublisher } from "@/services/notification/StaffNotificationDeliveryService";
import { upgradeStaffNotification } from "@/services/notification/StaffNotificationGateway";
import { OrderOutboxService } from "@/services/order/OrderOutboxService";
import { adminAuthMiddleware } from "@/middleware/admin-auth";
import { kefuAuthMiddleware } from "@/middleware/kefu-auth";
import { errorHandler } from "@/middleware/error";
import * as cache from "@/utils/cache";
import { createToken, md5 } from "@/utils/jwt";
import { STAFF_NOTIFICATION_REFRESH_SQL } from "@/migrations/staffNotificationRefresh";
import { financePostgres } from "./helpers/financePostgres";

let fixture: Awaited<ReturnType<typeof financePostgres>>, container: Container;
const env = { APP_KEY: crypto.randomUUID(), UPSTASH_REDIS_URL: "", UPSTASH_REDIS_TOKEN: "",
  AUTH_ALLOWED_ORIGINS: "https://admin.example.invalid", KEFU_AUTH_ALLOWED_ORIGINS: "https://kefu.example.invalid" } as Env;
const session = (audience: "admin" | "kefu" = "admin", id = 1): StaffSocketSession => ({ audience, id, authId: audience === "kefu" ? 1 : id,
  expiresAt: Math.floor(Date.now() / 1000) + 600, authVersion: md5("fixture-password"), tokenKey: md5("not-a-bearer-token") });
beforeAll(async () => {
  fixture = await financePostgres([storeOrderOutbox, storeService, systemAdmin, systemRole, systemMenus, systemMessage, user, userExtract]);
  await fixture.exec(STAFF_NOTIFICATION_REFRESH_SQL); await fixture.exec("CREATE UNIQUE INDEX soob_event_key_uq ON store_order_outbox(event_key)");
  container = createContainerFromDb(fixture.db);
}, 30000);
afterAll(async () => { await fixture?.close(); });
afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  await fixture.reset();
  await fixture.db.insert(systemRole).values([{ id: 1, rules: "extract.manage" }, { id: 2, rules: "dashboard.view" }, { id: 3, status: 0, rules: "extract.view" }, { id: 4, rules: "41" }]);
  await fixture.db.insert(systemMenus).values({ id: 41, type: 1, authType: 2, access: 1, isDel: 0, uniqueAuth: "extract.view" });
  await fixture.db.insert(systemAdmin).values([
    { id: 1, pwd: "fixture-password", level: 1, roles: "1" }, { id: 2, pwd: "fixture-password", level: 1, roles: "2" },
    { id: 3, pwd: "fixture-password", level: 0 }, { id: 4, pwd: "fixture-password", level: 1, roles: "3,999" },
    { id: 5, pwd: "fixture-password", level: 0, status: 0 }, { id: 6, pwd: "fixture-password", level: 0, adminType: 2 },
    { id: 7, pwd: "fixture-password", level: 1, roles: "4" }, { id: 8, pwd: "fixture-password", level: 0, isDel: 1 },
  ]);
  await fixture.db.insert(user).values({ uid: 10 });
  await fixture.db.insert(storeService).values({ id: 1, uid: 10, password: "fixture-password" });
});
async function seededEvent() {
  await fixture.db.insert(userExtract).values({ id: 19, uid: 10 });
  await fixture.db.insert(storeOrderOutbox).values({ eventKey: "withdrawal.applied.notice:19", eventType: "withdrawal.applied.notice",
    aggregateType: "withdrawal", aggregateId: 19, payload: { withdrawalId: 19 }, status: "COMPLETED" });
  const [event] = await fixture.db.insert(storeOrderOutbox).values({ eventKey: "withdrawal.staff.refresh:19", eventType: STAFF_REFRESH_EVENT,
    aggregateType: "withdrawal", aggregateId: 19, payload: { withdrawalId: 19 } }).returning();
  await fixture.db.insert(systemMessage).values({ userId: 10, type: 2, eventKey: "withdrawal.applied.notice:19:kefu:10" });
  return event;
}

describe("staff realtime authority and durable dispatch", () => {
  it("keeps bounded strict protocols and a separate admin/kefu namespace", () => {
    expect(staffPrincipalName(session())).toBe("staff-notice:admin:1");
    expect(staffPrincipalName(session("kefu", 10))).toBe("staff-notice:kefu:10");
    for (const input of [{ ...session(), audience: "user" }, { ...session(), id: 2 }, { ...session(), authVersion: "raw" }, { ...session(), tokenKey: "JWT" }, null]) expect(() => parseStaffSession(input)).toThrow();
    for (const value of ["withdrawal.staff.refresh:0", "withdrawal.staff.refresh:2147483648", "order.paid:1", "withdrawal.staff.refresh:1:x"]) expect(() => parseStaffEventKey(value)).toThrow();
    expect(readFileSync("migrations/0133_staff_notification_refresh.sql", "utf8").trim()).toBe(STAFF_NOTIFICATION_REFRESH_SQL.trim());
  });
  it("uses the same semantic and legacy menu roles for batched fanout as individual requests", async () => {
    const admins = await fixture.db.select().from(systemAdmin), service = new AdminPermissionService(container);
    const many = await service.resolveManyAdminPermissionKeys(admins);
    for (const [index, admin] of admins.entries()) expect(many[index]).toEqual(await service.resolveAdminPermissionKeys(admin));
    expect(many[0].has("extract.view")).toBe(true); expect(many[1].has("extract.view")).toBe(false);
  });
  it("rechecks role revocation, account deletion, type, password, token expiration and kefu binding flags", async () => {
    const auth = new StaffNotificationAuthService(container, env);
    for (const id of [1, 3, 7]) await auth.assertSession(session("admin", id));
    for (const id of [2, 4, 5, 6, 8, 999]) await expect(auth.assertSession(session("admin", id))).rejects.toThrow();
    await expect(auth.assertSession({ ...session(), expiresAt: 1 })).rejects.toThrow();
    await expect(auth.assertSession({ ...session(), authVersion: md5("changed") })).rejects.toThrow();
    await fixture.db.update(systemRole).set({ status: 0 }).where(eq(systemRole.id, 1));
    await expect(auth.assertSession(session())).rejects.toThrow();
    const kefu = session("kefu", 10); await auth.assertSession(kefu);
    for (const change of [{ uid: 11 }, { notify: 0 }, { merId: 2 }, { status: 0 }, { accountStatus: 0 }, { isDel: 1 }]) {
      await fixture.db.update(storeService).set(change).where(eq(storeService.id, 1));
      await expect(auth.assertSession(kefu)).rejects.toThrow();
      await fixture.db.update(storeService).set({ uid: 10, notify: 1, merId: 0, status: 1, accountStatus: 1, isDel: 0 });
    }
    await fixture.db.update(user).set({ deleteTime: new Date() }); await expect(auth.assertSession(kefu)).rejects.toThrow();
  });
  it("requires the matching live Redis token bucket and fails closed on unavailable state", async () => {
    const lookup = vi.spyOn(cache, "getTokenBucket"); const s = session(), auth = new StaffNotificationAuthService(container, { UPSTASH_REDIS_URL: "https://redis.invalid", UPSTASH_REDIS_TOKEN: "fixture" });
    lookup.mockResolvedValue({ uid: 1, type: "admin", token: "not-a-bearer-token", exp: 600 }); await auth.assertSession(s);
    for (const bucket of [null, { uid: 2, type: "admin", token: "not-a-bearer-token", exp: 600 }, { uid: 1, type: "kefu", token: "not-a-bearer-token", exp: 600 }, { uid: 1, type: "admin", token: "different", exp: 600 }]) {
      lookup.mockResolvedValue(bucket); await expect(auth.assertSession(s)).rejects.toThrow();
    }
    lookup.mockRejectedValue(new Error("state unavailable")); await expect(auth.assertSession(s)).rejects.toThrow();
  });
  it("persists retry after partial live fanout and never changes the application or inbox on replay", async () => {
    const event = await seededEvent(), delivered: string[] = [];
    let fail = true;
    const publisher: StaffPublisher = { getByName: (name) => ({ publish: async (principal, key) => {
      expect(key).toBe(event.eventKey); expect(staffPrincipalName(principal)).toBe(name);
      if (name === "staff-notice:kefu:10" && fail) throw new Error("DO unavailable");
      delivered.push(name); return { revision: 1, connected: 0 };
    } }) };
    const messages: OrderMessage[] = [];
    const queue: Queue<OrderMessage> = { send: async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }),
      sendBatch: async (batch) => { messages.push(...Array.from(batch, (item) => item.body)); return { metadata: { metrics: { backlogCount: messages.length, backlogBytes: 0 } } }; }, metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }) };
    const outbox = new OrderOutboxService(container, { ORDER_QUEUE: queue, STAFF_NOTICE: publisher });
    await outbox.dispatchEventKey(event.eventKey);
    const message = messages[0]; if (!message || message.action !== "processOrderNotificationOutbox") throw new Error("Missing queued refresh");
    await expect(outbox.processMessage(message)).rejects.toThrow("等待重试");
    expect((await fixture.db.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id, event.id)))[0].status).toBe("FAILED");
    expect(delivered.sort()).toEqual(["staff-notice:admin:1", "staff-notice:admin:3", "staff-notice:admin:7"]);
    await fixture.db.update(systemRole).set({ status: 0 }).where(eq(systemRole.id, 1));
    fail = false; delivered.length = 0; await outbox.replay(event.id); await outbox.dispatchEventKey(event.eventKey);
    expect(await outbox.processMessage(message)).toBe("completed");
    expect(delivered.sort()).toEqual(["staff-notice:admin:3", "staff-notice:admin:7", "staff-notice:kefu:10"]);
    expect(await outbox.processMessage(message)).toBe("already-completed");
    expect(await fixture.db.select().from(userExtract)).toHaveLength(1); expect(await fixture.db.select().from(systemMessage)).toHaveLength(1);
    await fixture.exec(STAFF_NOTIFICATION_REFRESH_SQL);
  });
  it("rejects a mismatched business reference and never publishes without its completed parent", async () => {
    const event = await seededEvent(), publish = vi.fn(async () => ({ revision: 1, connected: 0 }));
    const publisher: StaffPublisher = { getByName: () => ({ publish }) };
    await expect(deliverStaffRefresh(container, publisher, { ...event, aggregateId: 20 })).rejects.toThrow();
    await fixture.db.update(storeOrderOutbox).set({ status: "FAILED" }).where(eq(storeOrderOutbox.eventKey, "withdrawal.applied.notice:19"));
    await expect(deliverStaffRefresh(container, publisher, event)).rejects.toThrow("已完成申请事件"); expect(publish).not.toHaveBeenCalled();
  });
  it("upgrades only origin-approved genuine admin/kefu tokens and strips all client-injected identity and bearer headers", async () => {
    const forwarded: Request[] = [], names: string[] = [];
    // A partial namespace is sufficient: this HTTP boundary test exercises fetch only, not RPC/runtime.
    const bindings = { ...env, STAFF_NOTICE: { getByName: (name: string) => { names.push(name); return { fetch: async (request: Request) => { forwarded.push(request); return new Response("upgraded by fixture"); } }; } } } as Env;
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>(); app.onError(errorHandler);
    app.use("*", async (c, next) => { c.set("container", container); await next(); });
    app.get("/extract/notifications/socket", adminAuthMiddleware(), (c) => upgradeStaffNotification(c, "admin"));
    app.get("/messages/socket", kefuAuthMiddleware, (c) => upgradeStaffNotification(c, "kefu"));
    for (const audience of ["admin", "kefu"] as const) {
      const token = await createToken(1, audience, md5("fixture-password"), env.APP_KEY);
      const path = audience === "admin" ? "/extract/notifications/socket" : "/messages/socket";
      const headers = { Upgrade: "websocket", Origin: `https://${audience}.example.invalid`, "Sec-WebSocket-Protocol": `cinashop,cinashop-auth.${token.token}`, "X-Staff-Session": JSON.stringify({ audience: "admin", id: 3 }), Cookie: "ignored=true" };
      expect(await (await app.request(`${path}?uid=3`, { headers }, bindings)).text()).toBe("upgraded by fixture");
      expect(names.at(-1)).toBe(`staff-notice:${audience}:${audience === "kefu" ? 10 : 1}`);
      const request = forwarded.at(-1)!;
      expect(request.url).toBe("https://staff-notice.internal/connect"); expect(request.headers.get("Cookie")).toBeNull();
      expect(request.headers.get("Sec-WebSocket-Protocol")).toBe("cinashop"); expect(JSON.stringify([...request.headers])).not.toContain(token.token);
      const count = forwarded.length;
      for (const origin of ["null", "https://evil.invalid", ""]) await app.request(path, { headers: { ...headers, Origin: origin } }, bindings);
      const userToken = await createToken(1, "api", md5("fixture-password"), env.APP_KEY);
      await app.request(path, { headers: { ...headers, "Sec-WebSocket-Protocol": `cinashop,cinashop-auth.${userToken.token}` } }, bindings);
      expect(forwarded).toHaveLength(count);
    }
  });
});
