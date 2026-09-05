import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { user, userBrokerage, userExtract, userMoney, userRecharge, systemConfig, capitalFlow,
  storeOrderOutbox, systemMessage, userMessage, systemNotification, storeService, orderNotificationDelivery, notificationTemplate } from "@/models/schema";
import { createContainerFromDb, type Container } from "@/lib/di";
import type { Env, AppVariables, OrderMessage, OrderNotificationOutboxMessage } from "@/env";
import { UserWithdrawalService } from "@/services/user/UserWithdrawalService";
import { OrderOutboxService, isOrderNotificationOutboxMessage } from "@/services/order/OrderOutboxService";
import { OrderNotificationAdminService } from "@/services/order/OrderNotificationAdminService";
import { WITHDRAWAL_APPLICATION_EVENT, WITHDRAWAL_APPLICATION_MARK } from "@/services/user/WithdrawalApplicationNoticeService";
import { KefuInboxService } from "@/services/kefu/KefuInboxService";
import { userUnreadMessageCount, visibleSystemMessageWhere } from "@/services/message/UserMessageVisibility";
import { kefuapiRoutes } from "@/routes/kefuapi";
import { messageList, messageDetail } from "@/controllers/api/v1/UserMessageController";
import { errorHandler } from "@/middleware/error";
import { createToken, md5 } from "@/utils/jwt";
import { WITHDRAWAL_APPLICATION_NOTICE_SQL } from "@/migrations/withdrawalApplicationNotice";
import { WITHDRAWAL_EFFECTS_SQL } from "@/migrations/withdrawalEffects";
import { STAFF_NOTIFICATION_REFRESH_SQL } from "@/migrations/staffNotificationRefresh";
import { USER_WITHDRAWAL_REPLAY_SQL } from "@/migrations/userWithdrawalReplay";
import { financePostgres } from "./helpers/financePostgres";

let fixture: Awaited<ReturnType<typeof financePostgres>>, container: Container;
let withdrawal: UserWithdrawalService, outbox: OrderOutboxService, inbox: KefuInboxService;
const sent: OrderMessage[] = [];
const sendBatch = vi.fn(async (messages: Iterable<MessageSendRequest<OrderMessage>>) => {
  sent.push(...Array.from(messages, (message) => message.body));
  return { metadata: { metrics: { backlogCount: sent.length, backlogBytes: 0 } } };
});
const envOverrides: Partial<Env> = { APP_KEY: crypto.randomUUID(), UPSTASH_REDIS_URL: "", UPSTASH_REDIS_TOKEN: "",
  ORDER_QUEUE: { sendBatch, send: async (body) => sendBatch([{ body }]), metrics: async () => ({ backlogCount: sent.length, backlogBytes: 0 }) } };
const env = envOverrides as Env; // Isolated non-production fixture, no provider or Redis credentials.
const principal = { id: 1, uid: 10 };
const input = (extractType = "alipay") => ({ extractType, extractPrice: "20.00", realName: "申请人", extractNumber: "test@example.invalid", requestKey: `intent-${crypto.randomUUID()}` });

beforeAll(async () => {
  fixture = await financePostgres([user, userBrokerage, userExtract, userMoney, userRecharge, systemConfig, capitalFlow,
    storeOrderOutbox, systemMessage, userMessage, systemNotification, storeService, orderNotificationDelivery, notificationTemplate]);
  await fixture.exec(USER_WITHDRAWAL_REPLAY_SQL); await fixture.exec(WITHDRAWAL_EFFECTS_SQL);
  await fixture.exec(WITHDRAWAL_APPLICATION_NOTICE_SQL); await fixture.exec(WITHDRAWAL_APPLICATION_NOTICE_SQL);
  await fixture.exec(STAFF_NOTIFICATION_REFRESH_SQL);
  await fixture.exec("CREATE UNIQUE INDEX soob_event_key_uq ON store_order_outbox(event_key); CREATE UNIQUE INDEX smsg_event_key_uq ON system_message(event_key);");
  container = createContainerFromDb(fixture.db); withdrawal = new UserWithdrawalService(container);
  outbox = new OrderOutboxService(container, env); inbox = new KefuInboxService(container);
}, 30000);
afterAll(async () => { await fixture?.close(); });
beforeEach(async () => {
  await fixture.reset(); sent.length = 0; sendBatch.mockClear();
  await fixture.db.insert(user).values([
    { uid: 7, nickname: "申请{money}<b>用户</b>", brokeragePrice: "100.00", nowMoney: "5.00" },
    { uid: 10, nickname: "客服绑定用户" }, { uid: 11 }, { uid: 12, status: 0 }, { uid: 13, isDel: 1 },
    { uid: 14, deleteTime: new Date() }, { uid: 15 },
  ]);
  await fixture.db.insert(storeService).values([
    { uid: 10, nickname: "平台客服甲", password: "fixture-password" },
    { uid: 11, nickname: "平台客服乙", customer: 1 },
  ]);
  await fixture.db.insert(systemConfig).values(Object.entries({ user_extract_min_price: "1", user_extract_max_price: "1000", withdraw_fee: "2.5", brokerage_type: "0", user_extract_balance_status: "1" }).map(([menuName, value]) => ({ menuName, value })));
  await fixture.db.insert(systemNotification).values({ mark: WITHDRAWAL_APPLICATION_MARK, isSystem: 1, systemTitle: "{admin_name}：提现申请", systemText: "{nickname}申请提现{money}元" });
});

async function applicationEvent() {
  const [event] = await fixture.db.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventType, WITHDRAWAL_APPLICATION_EVENT));
  if (!event) throw new Error("Missing application event");
  return event;
}
async function consume() {
  await outbox.dispatchPending();
  const message = sent.find((m): m is OrderNotificationOutboxMessage => isOrderNotificationOutboxMessage(m) && m.eventKey.startsWith(`${WITHDRAWAL_APPLICATION_EVENT}:`));
  if (!message) throw new Error("Application event was not dispatched");
  await outbox.processMessage(message); return message;
}
async function notice() { await withdrawal.apply(7, input()); return consume(); }

describe("withdrawal application events and isolated staff inbox", () => {
  it("registers rerunnable DDL, actual enum constraints and the inbox index", async () => {
    expect(readFileSync("migrations/0132_withdrawal_application_notice.sql", "utf8").trim()).toBe(WITHDRAWAL_APPLICATION_NOTICE_SQL.trim());
    expect(readFileSync("src/services/MigrationService.ts", "utf8")).toContain("this.migration_0136()");
    const base = { eventKey: "unknown:1", aggregateId: 1, payload: { orderId: 1, orderNo: "fixture" } };
    await expect(fixture.db.insert(storeOrderOutbox).values({ ...base, eventType: "withdrawal.unknown" })).rejects.toThrow();
    await withdrawal.apply(7, input());
    await fixture.exec(WITHDRAWAL_APPLICATION_NOTICE_SQL);
    await fixture.exec(STAFF_NOTIFICATION_REFRESH_SQL); await fixture.exec(STAFF_NOTIFICATION_REFRESH_SQL);
    const indexes = await fixture.db.execute<{ indexname: string }>(sqlIndex());
    expect(JSON.stringify(indexes)).toContain("smsg_staff_inbox");
  });

  it("persists exactly one application/debit/event for a successful intent replay", async () => {
    const params = input(), request = await withdrawal.apply(7, params);
    expect(await withdrawal.apply(7, params)).toEqual(request);
    expect(await fixture.db.select().from(userExtract)).toHaveLength(1);
    expect(await fixture.db.select().from(userBrokerage)).toHaveLength(1);
    expect(await fixture.db.select().from(storeOrderOutbox)).toHaveLength(1);
    const event = await applicationEvent();
    expect(event).toMatchObject({ aggregateType: "withdrawal", aggregateId: request.id,
      payload: { withdrawalId: request.id, userId: 7, grossAmount: "20.00", nickname: "申请{money}<b>用户</b>" } });
    expect(JSON.stringify(event.payload)).not.toContain("test@example.invalid");
    expect(await fixture.db.select().from(systemMessage)).toHaveLength(0);
  });

  it("fans out once per active platform UID, excluding disabled/unbound/deleted/tenant accounts", async () => {
    await fixture.db.insert(storeService).values([
      { uid: 10, nickname: "重复UID" }, { uid: 7, notify: 0 }, { uid: 0 }, { uid: 999 },
      { uid: 12 }, { uid: 13 }, { uid: 14 }, { uid: 15, merId: 3 },
      { uid: 7, status: 0 }, { uid: 7, accountStatus: 0 }, { uid: 7, isDel: 1 },
    ]);
    const message = await notice();
    expect(await outbox.processMessage(message)).toBe("already-completed");
    const rows = await fixture.db.select().from(systemMessage);
    expect(rows.map((row) => row.userId)).toEqual([10, 11]);
    expect(rows.every((row) => row.type === 2 && row.mark === WITHDRAWAL_APPLICATION_MARK)).toBe(true);
    expect(new Set(rows.map((row) => row.eventKey)).size).toBe(2);
    expect(rows[0].title).toBe("平台客服甲：提现申请");
    expect(rows[0].content).toBe("申请{money}<b>用户</b>申请提现20.00元");
    expect((await fixture.db.select().from(user).where(eq(user.uid, 7)))[0].brokeragePrice).toBe("80.00");
  });

  it("retains the application even if review/refusal completes before the consumer", async () => {
    const request = await withdrawal.apply(7, input());
    await withdrawal.review(request.id, -1, "资料需补充"); await consume();
    expect((await inbox.list(principal)).list[0].content).toContain("20.00元");
    expect((await fixture.db.select().from(user).where(eq(user.uid, 7)))[0].brokeragePrice).toBe("100.00");
    expect(await fixture.db.select().from(storeOrderOutbox)).toHaveLength(3);
  });

  it("rechecks recipients before fan-out and preserves offline delivery without requiring online status", async () => {
    await withdrawal.apply(7, input());
    await fixture.db.update(storeService).set({ notify: 0 }).where(eq(storeService.id, 1));
    await consume();
    const rows = await fixture.db.select().from(systemMessage);
    expect(rows).toHaveLength(1); expect(rows[0].userId).toBe(11);
    expect((await inbox.list({ id: 2, uid: 11 })).unread_count).toBe(1);
  });

  it("keeps an oversized recipient set recoverable instead of silently truncating financial reminders", async () => {
    await fixture.exec('INSERT INTO "user"(uid) SELECT generate_series(100,1100); INSERT INTO store_service(uid) SELECT generate_series(100,1100);');
    await withdrawal.apply(7, input()); await expect(consume()).rejects.toThrow("单批上限");
    expect((await applicationEvent()).status).toBe("FAILED");
    expect(await fixture.db.select().from(systemMessage)).toHaveLength(0);
    expect((await fixture.db.select().from(user).where(eq(user.uid, 7)))[0].brokeragePrice).toBe("80.00");
  });

  it("includes automatic balance approval with distinct business events, a refresh child and one credit", async () => {
    const params = input("balance"); await withdrawal.apply(7, params); await withdrawal.apply(7, params); await consume();
    expect(await fixture.db.select().from(storeOrderOutbox)).toHaveLength(3);
    expect(await fixture.db.select().from(capitalFlow)).toHaveLength(1);
    expect(await fixture.db.select().from(userMoney)).toHaveLength(1);
    expect((await fixture.db.select().from(user).where(eq(user.uid, 7)))[0]).toMatchObject({ brokeragePrice: "80.00", nowMoney: "25.00" });
    expect((await inbox.list(principal)).unread_count).toBe(1);
  });

  it("rolls back the complete financial operation when its application event insert fails", async () => {
    await fixture.exec("CREATE FUNCTION fail_application() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type = 'withdrawal.applied.notice' THEN RAISE EXCEPTION 'injected application failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_application BEFORE INSERT ON store_order_outbox FOR EACH ROW EXECUTE FUNCTION fail_application();");
    try {
      await expect(withdrawal.apply(7, input("balance"))).rejects.toThrow();
      for (const table of [userExtract, userBrokerage, userMoney, userRecharge, capitalFlow, storeOrderOutbox]) expect(await fixture.db.select().from(table)).toHaveLength(0);
      expect((await fixture.db.select().from(user).where(eq(user.uid, 7)))[0]).toMatchObject({ brokeragePrice: "100.00", nowMoney: "5.00" });
    } finally { await fixture.exec("DROP TRIGGER fail_application ON store_order_outbox; DROP FUNCTION fail_application();"); }
  });

  it("atomically rolls back partial fan-out and recovers without another debit", async () => {
    await withdrawal.apply(7, input());
    await fixture.exec("ALTER TABLE system_message ADD CONSTRAINT fail_recipient CHECK (user_id <> 11)");
    try { await expect(consume()).rejects.toThrow(); } finally { await fixture.exec("ALTER TABLE system_message DROP CONSTRAINT fail_recipient"); }
    expect((await applicationEvent()).status).toBe("FAILED");
    expect(await fixture.db.select().from(systemMessage)).toHaveLength(0);
    await outbox.replay((await applicationEvent()).id); await consume();
    expect(await fixture.db.select().from(systemMessage)).toHaveLength(2);
    expect(await fixture.db.select().from(userBrokerage)).toHaveLength(1);
  });

  it("recovers a lost Queue dispatch and does not replay completed reminders", async () => {
    await withdrawal.apply(7, input()); sendBatch.mockRejectedValueOnce(new Error("injected queue failure"));
    await expect(consume()).rejects.toThrow();
    expect((await applicationEvent()).status).toBe("FAILED");
    await outbox.replay((await applicationEvent()).id); const message = await consume();
    await expect(outbox.replay(message.outboxId)).rejects.toThrow("已完成");
    expect(await outbox.processMessage(message)).toBe("already-completed");
    expect(await fixture.db.select().from(systemMessage)).toHaveLength(2);
  });

  it("honors a disabled switch without inventing delivery", async () => {
    await fixture.db.update(systemNotification).set({ isSystem: 0 }); await notice();
    expect(await fixture.db.select().from(systemMessage)).toHaveLength(0);
    expect((await applicationEvent()).status).toBe("COMPLETED");
  });

  it("supports controlled Admin configuration without allowing unimplemented external channels", async () => {
    const admin = new OrderNotificationAdminService(container, env);
    await fixture.db.delete(systemNotification);
    expect((await admin.listOrderConfigs()).find((item) => item.mark === WITHDRAWAL_APPLICATION_MARK)).toMatchObject({ exists: false, officialAllowed: false, routineAllowed: false });
    await admin.saveOrderConfig(WITHDRAWAL_APPLICATION_MARK, { isSystem: true, systemTitle: "{admin_name}的提醒", systemText: "{nickname}申请{money}元" });
    for (const input of [{ isSms: true }, { isWechat: true }, { isRoutine: true }]) await expect(admin.saveOrderConfig(WITHDRAWAL_APPLICATION_MARK, input)).rejects.toThrow();
    await notice(); expect((await inbox.list(principal)).list[0].title).toBe("平台客服甲的提醒");
    expect(await fixture.db.select().from(orderNotificationDelivery)).toHaveLength(0);
  });

  it("retains duplicate configuration, oversized templates and forged snapshots as failed events", async () => {
    await withdrawal.apply(7, input());
    await fixture.db.insert(systemNotification).values({ mark: WITHDRAWAL_APPLICATION_MARK });
    await expect(consume()).rejects.toThrow("重复");
    await fixture.db.delete(systemNotification).where(eq(systemNotification.id, 2));
    await fixture.db.update(systemNotification).set({ systemTitle: "{nickname}".repeat(20) });
    await outbox.replay((await applicationEvent()).id);
    await expect(consume()).rejects.toThrow("超限");
    await fixture.db.update(systemNotification).set({ systemTitle: "提现申请" });
    const event = await applicationEvent();
    await fixture.db.update(storeOrderOutbox).set({ payload: { ...event.payload, userId: 999 } }).where(eq(storeOrderOutbox.id, event.id));
    await outbox.replay(event.id);
    await expect(consume()).rejects.toThrow("不匹配");
    expect(await fixture.db.select().from(systemMessage)).toHaveLength(0);
  });

  it("does not leak staff messages through ordinary-user list/detail or personal-home counts", async () => {
    await notice(); const staffRow = (await inbox.list(principal)).list[0];
    const ordinary = await fixture.db.insert(systemMessage).values([
      { userId: 0, type: 0, title: "广播" }, { userId: 10, type: 1, title: "用户本人" },
      { userId: 0, type: 2, title: "客服广播不能公开" }, { userId: 10, type: 3, title: "未知受众" },
      { userId: 11, type: 1, title: "其他用户" }, { userId: 10, type: 1, status: 0 }, { userId: 10, type: 1, isDel: 1 },
    ]).returning();
    expect(await fixture.db.select().from(systemMessage).where(visibleSystemMessageWhere(10))).toHaveLength(2);
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use("*", async (c, next) => { c.set("uid", 10); c.set("container", container); await next(); });
    app.get("/messages", messageList); app.get("/messages/:id", messageDetail);
    expect(await (await app.request(`/messages/${staffRow.id}`)).json()).toMatchObject({ data: null });
    expect(JSON.stringify(await (await app.request("/messages")).json())).not.toContain("提现");
    expect((await fixture.db.select({ total: userUnreadMessageCount(10) }).from(user).where(eq(user.uid, 10)))[0].total).toBe(2);
    await fixture.db.insert(userMessage).values({ uid: 10, messageId: ordinary[0].id, isRead: 1 });
    expect((await fixture.db.select({ total: userUnreadMessageCount(10) }).from(user).where(eq(user.uid, 10)))[0].total).toBe(1);
  });

  it("isolates pagination and explicit idempotent read acknowledgements by recipient", async () => {
    await notice();
    await fixture.db.insert(systemMessage).values([{ userId: 10, type: 2, title: "新提醒" }, { userId: 11, type: 2, title: "另一客服" }]);
    const first = await inbox.list(principal, { limit: "1" });
    expect(first).toMatchObject({ unread_count: 2, list: [{ title: "新提醒" }] });
    const next = await inbox.list(principal, { cursor: first.next_cursor!, limit: 1 });
    expect(next.list).toHaveLength(1); expect(next.next_cursor).toBeNull();
    expect((await inbox.detail(principal, first.list[0].id)).look).toBe(0);
    await inbox.markRead(principal, first.list[0].id); await inbox.markRead(principal, first.list[0].id);
    expect((await inbox.list(principal, { unread: "1" })).list).toHaveLength(1);
    const foreign = (await inbox.list({ id: 2, uid: 11 })).list[0];
    await expect(inbox.detail(principal, foreign.id)).rejects.toThrow("不存在");
    await expect(inbox.markRead(principal, foreign.id)).rejects.toThrow("不存在");
    expect((await inbox.detail({ id: 2, uid: 11 }, foreign.id)).look).toBe(0);
    const hidden = await fixture.db.insert(systemMessage).values([
      { userId: 0, type: 2 }, { userId: 10, type: 1 }, { userId: 10, type: 2, status: 0 }, { userId: 10, type: 2, isDel: 1 },
    ]).returning();
    for (const row of hidden) {
      await expect(inbox.detail(principal, row.id)).rejects.toThrow("不存在");
      await expect(inbox.markRead(principal, row.id)).rejects.toThrow("不存在");
    }
  });

  it("denies reads and acknowledgements immediately on next query after authority is revoked", async () => {
    await notice(); const id = (await inbox.list(principal)).list[0].id;
    for (const patch of [{ notify: 0 }, { status: 0 }, { accountStatus: 0 }, { isDel: 1 }, { merId: 1 }, { uid: 11 }]) {
      await fixture.db.update(storeService).set(patch).where(eq(storeService.id, 1));
      await expect(inbox.list(principal)).rejects.toThrow();
      await expect(inbox.detail(principal, id)).rejects.toThrow();
      await expect(inbox.markRead(principal, id)).rejects.toThrow();
      await fixture.db.update(storeService).set({ notify: 1, status: 1, accountStatus: 1, isDel: 0, merId: 0, uid: 10 }).where(eq(storeService.id, 1));
    }
    await fixture.db.update(user).set({ status: 0 }).where(eq(user.uid, 10));
    await expect(inbox.list(principal)).rejects.toThrow();
    expect((await fixture.db.select().from(systemMessage).where(eq(systemMessage.id, id)))[0].look).toBe(0);
  });

  it("validates bounded cursors, limits and principals instead of accepting forged query ownership", async () => {
    for (const limit of [0, -1, 51, "1e2", "1.5", "Infinity", [], {}]) await expect(inbox.list(principal, { limit })).rejects.toThrow();
    for (const cursor of [0, "-1", "NaN", "2147483648"]) await expect(inbox.list(principal, { cursor })).rejects.toThrow();
    await expect(inbox.list({ id: 0, uid: 10 })).rejects.toThrow();
    await expect(inbox.list(principal, { unread: "yes" })).rejects.toThrow();
    expect(() => visibleSystemMessageWhere(0)).toThrow();
  });

  it("uses real dedicated kefu auth, rejects user/admin tokens and ignores attacker-supplied UID", async () => {
    await notice();
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>(); app.onError(errorHandler);
    app.use("*", async (c, next) => { c.set("container", container); await next(); }); app.route("/kefuapi", kefuapiRoutes);
    const token = await createToken(1, "kefu", md5("fixture-password"), env.APP_KEY);
    const request = (value?: string) => app.request("/kefuapi/messages?uid=11&kefuId=2", { headers: value ? { Authorization: `Bearer ${value}` } : {} }, env);
    const response = await request(token.token), body = await response.json();
    expect(body).toMatchObject({ status: 200, data: { unread_count: 1, list: [{ title: "平台客服甲：提现申请" }] } });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const id = (await inbox.list(principal)).list[0].id;
    const acknowledged = await app.request(`/kefuapi/messages/${id}/read?uid=11`, { method: "POST", headers: { Authorization: `Bearer ${token.token}` } }, env);
    expect(await acknowledged.json()).toMatchObject({ status: 200, data: { id, look: 1 } });
    expect(acknowledged.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await (await request()).json()).not.toMatchObject({ status: 200 });
    for (const type of ["api", "admin"] as const) {
      const other = await createToken(1, type, "", env.APP_KEY);
      expect(await (await request(other.token)).json()).not.toMatchObject({ status: 200 });
    }
    await fixture.db.update(storeService).set({ notify: 0 }).where(eq(storeService.id, 1));
    expect(await (await request(token.token)).json()).not.toMatchObject({ status: 200 });
  });

  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))("PostgreSQL 16: concurrent apply and consumers produce one event and one notice per UID", async () => {
    const params = input(); const requests = await Promise.all(Array.from({ length: 4 }, () => withdrawal.apply(7, params)));
    expect(new Set(requests.map((r) => r.id)).size).toBe(1);
    await outbox.dispatchPending(); const message = sent.find(isOrderNotificationOutboxMessage)!;
    await Promise.all(Array.from({ length: 4 }, () => outbox.processMessage(message)));
    expect(await outbox.processMessage(message)).toBe("already-completed");
    expect(await fixture.db.select().from(storeOrderOutbox)).toHaveLength(2);
    expect(await fixture.db.select().from(systemMessage)).toHaveLength(2);
    expect(await fixture.db.select().from(userBrokerage)).toHaveLength(1);
  });
});

function sqlIndex() { return sql`SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'system_message'`; }
