import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  user, userBrokerage, userExtract, userMoney, userRecharge, systemConfig, capitalFlow,
  storeOrderOutbox, systemMessage, systemNotification, notificationTemplate, wechatUser,
  orderNotificationDelivery, orderNotificationDeliveryAction,
} from "@/models/schema";
import { createContainerFromDb, withTx, type Container } from "@/lib/di";
import type { Env, OrderMessage, OrderNotificationOutboxMessage, OrderNotificationDeliveryMessage } from "@/env";
import { UserWithdrawalService } from "@/services/user/UserWithdrawalService";
import { OrderOutboxService, isOrderNotificationOutboxMessage } from "@/services/order/OrderOutboxService";
import { OrderNotificationDeliveryService, isOrderNotificationDeliveryMessage } from "@/services/order/OrderNotificationDeliveryService";
import { OrderNotificationAdminService } from "@/services/order/OrderNotificationAdminService";
import { processWithdrawalNoticeEvent } from "@/services/user/WithdrawalEffectsService";
import * as sms from "@/services/message/SmsVerificationService";
import { USER_WITHDRAWAL_REPLAY_SQL } from "@/migrations/userWithdrawalReplay";
import { WITHDRAWAL_EFFECTS_SQL } from "@/migrations/withdrawalEffects";
import { WITHDRAWAL_APPLICATION_NOTICE_SQL } from "@/migrations/withdrawalApplicationNotice";
import { financePostgres } from "./helpers/financePostgres";

let fixture: Awaited<ReturnType<typeof financePostgres>>, container: Container;
let withdrawal: UserWithdrawalService, outbox: OrderOutboxService, deliveries: OrderNotificationDeliveryService;
let admin: OrderNotificationAdminService;
const queue: OrderMessage[] = [];
const sendBatch = vi.fn(async (messages: Iterable<MessageSendRequest<OrderMessage>>) => {
  queue.push(...Array.from(messages, (m) => m.body));
  return { metadata: { metrics: { backlogCount: queue.length, backlogBytes: 0 } } };
});
const input = (extractType = "bank") => ({ extractType, extractPrice: "20.00", realName: "用户", extractNumber: "6222021234567890123", bankName: "测试银行", requestKey: `intent-${crypto.randomUUID()}` });

beforeAll(async () => {
  fixture = await financePostgres([user, userBrokerage, userExtract, userMoney, userRecharge, systemConfig, capitalFlow,
    storeOrderOutbox, systemMessage, systemNotification, notificationTemplate, wechatUser, orderNotificationDelivery, orderNotificationDeliveryAction]);
  await fixture.exec(USER_WITHDRAWAL_REPLAY_SQL);
  await fixture.exec(WITHDRAWAL_EFFECTS_SQL);
  await fixture.exec(WITHDRAWAL_EFFECTS_SQL);
  await fixture.exec(WITHDRAWAL_APPLICATION_NOTICE_SQL);
  await fixture.exec(`CREATE UNIQUE INDEX soob_event_key_uq ON store_order_outbox(event_key);
    CREATE UNIQUE INDEX sm_event_key_uq ON system_message(event_key);
    CREATE UNIQUE INDEX ond_event_channel_uq ON order_notification_delivery(event_key,channel);
    CREATE UNIQUE INDEX onda_request_key_uq ON order_notification_delivery_action(request_key);`);
  container = createContainerFromDb(fixture.db);
  const queueBinding: Queue<OrderMessage> = {
    sendBatch,
    send: async (body) => sendBatch([{ body }]),
    metrics: async () => ({ backlogCount: queue.length, backlogBytes: 0 }),
  };
  // This isolated fixture supplies exactly the bindings exercised by these services.
  const testBindings: Partial<Env> = { ORDER_QUEUE: queueBinding, ALIYUN_SMS_ACCESS_KEY_ID: "fixture", ALIYUN_SMS_ACCESS_KEY_SECRET: "fixture", ALIYUN_SMS_SIGN_NAME: "fixture" };
  const env = testBindings as Env;
  withdrawal = new UserWithdrawalService(container);
  outbox = new OrderOutboxService(container, env);
  deliveries = new OrderNotificationDeliveryService(container, env);
  admin = new OrderNotificationAdminService(container, env);
}, 30000);
afterAll(async () => { await fixture?.close(); });
beforeEach(async () => {
  vi.restoreAllMocks(); sendBatch.mockClear(); queue.length = 0;
  await fixture.reset();
  await fixture.db.insert(user).values({ uid: 7, nickname: "申请用户", phone: "13800000000", brokeragePrice: "100.00", nowMoney: "5.00" });
  await fixture.db.insert(systemConfig).values(Object.entries({ user_extract_min_price: "1", user_extract_max_price: "1000", withdraw_fee: "2.5", brokerage_type: "0", user_extract_balance_status: "1" }).map(([menuName, value]) => ({ menuName, value })));
});

async function configure(mark = "user_extract", all = false) {
  await admin.saveOrderConfig(mark, { isSystem: true, systemTitle: "提现结果", systemText: "{nickname}|{extract_number}|{date}|{message}", isSms: true, smsId: "SMS_fixture", isWechat: all && mark === "user_extract", isRoutine: all });
  if (all) {
    if (mark === "user_extract") await admin.saveTemplate({ title: "提现成功", type: "wechat", mark, tempid: "official-fixture" });
    await admin.saveTemplate({ title: "提现结果", type: "routine", mark, tempid: "routine-fixture" });
    await fixture.db.insert(wechatUser).values([{ uid: 7, userType: "wechat", openid: "official-user" }, { uid: 7, userType: "routine", openid: "routine-user" }]);
  }
}
async function approved() {
  const request = await withdrawal.apply(7, input());
  await withdrawal.review(request.id, 1);
  return request;
}
async function processRoot() {
  await outbox.dispatchPending();
  const message = queue.find((m): m is OrderNotificationOutboxMessage => isOrderNotificationOutboxMessage(m) && !m.eventKey.startsWith("withdrawal.applied."))!;
  expect(message).toBeDefined();
  await outbox.processMessage(message);
  return message;
}
async function moneyState() {
  return {
    account: await fixture.db.select().from(user), requests: await fixture.db.select().from(userExtract),
    ledger: await fixture.db.select().from(userBrokerage), flows: await fixture.db.select().from(capitalFlow),
    // This suite audits review effects; the application fan-out has its own whole-event assertions.
    events: await fixture.db.select().from(storeOrderOutbox).where(inArray(storeOrderOutbox.eventType, ["withdrawal.approved.notice", "withdrawal.refused.notice"])),
  };
}

describe("API-014F withdrawal effects on actual SQL", () => {
  it("mirrors rerunnable DDL and enforces real order/withdrawal separation", async () => {
    expect(readFileSync("migrations/0131_withdrawal_effects.sql", "utf8").trim()).toBe(WITHDRAWAL_EFFECTS_SQL.trim());
    const base = { outboxId: 1, eventKey: "fixture", userId: 7, noticeMark: "user_extract", channel: "sms" as const, payload: { kind: "sms" as const, params: {} } };
    await expect(fixture.db.insert(orderNotificationDelivery).values(base)).rejects.toThrow();
    await expect(fixture.db.insert(orderNotificationDelivery).values({ ...base, orderId: 1, withdrawalId: 1 })).rejects.toThrow();
    await fixture.db.insert(orderNotificationDelivery).values({ ...base, withdrawalId: 1 });
  });

  it("writes one negative NET flow only on approval, without storing bank details as order IDs", async () => {
    const request = await withdrawal.apply(7, input());
    expect((await moneyState()).flows).toHaveLength(0);
    expect((await moneyState()).events).toHaveLength(0);
    await withdrawal.review(request.id, 1);
    await withdrawal.review(request.id, 1);
    const state = await moneyState();
    expect(state.flows).toHaveLength(1);
    expect(state.flows[0]).toMatchObject({ price: "-19.50", tradingType: 6, payType: "bank", uid: 7, orderId: `withdrawal:${request.id}` });
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({ aggregateType: "withdrawal", aggregateId: request.id, payload: { netAmount: "19.50", grossAmount: "20.00" } });
    expect(state.account[0].brokeragePrice).toBe("80.00");
  });

  it("includes automatic balance approval and key replay in the same atomic flow", async () => {
    const params = input("balance");
    const request = await withdrawal.apply(7, params);
    expect(await withdrawal.apply(7, params)).toEqual(request);
    const state = await moneyState();
    expect(state.flows).toHaveLength(1);
    expect(state.flows[0]).toMatchObject({ price: "-20.00", payType: "balance" });
    expect(state.events).toHaveLength(1);
    expect(state.account[0]).toMatchObject({ brokeragePrice: "80.00", nowMoney: "25.00" });
  });

  it("rejects once with GROSS compensation/notice and no capital flow", async () => {
    await configure("user_balance_change", true);
    const request = await withdrawal.apply(7, input());
    await withdrawal.review(request.id, -1, "收款信息有误");
    await withdrawal.review(request.id, 2, "changed retry reason");
    await processRoot();
    const state = await moneyState();
    expect(state.flows).toHaveLength(0);
    expect(state.account[0].brokeragePrice).toBe("100.00");
    expect(state.events).toHaveLength(1);
    const notices = await fixture.db.select().from(systemMessage);
    expect(notices[0].content).toContain("20.00");
    expect(notices[0].content).toContain("收款信息有误");
    const rows = await fixture.db.select().from(orderNotificationDelivery);
    expect(rows.map((r) => r.channel).sort()).toEqual(["sms", "wechat_routine"]);
    expect(rows.every((r) => r.orderId === null && r.withdrawalId === request.id)).toBe(true);
  });

  it("stages PHP template fields and only owned targets, then replays without extra messages", async () => {
    await configure("user_extract", true);
    const request = await approved();
    const message = await processRoot();
    expect(await outbox.processMessage(message)).toBe("already-completed");
    const rows = await fixture.db.select().from(orderNotificationDelivery);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.channel === "sms")?.payload).toEqual({ kind: "sms", params: { extract_number: "19.50" } });
    expect(rows.find((r) => r.channel === "wechat_official")?.payload).toMatchObject({ data: { amount3: "19.50" } });
    expect(rows.find((r) => r.channel === "wechat_routine")?.payload).toMatchObject({ url: "pages/user/finance", data: { thing1: "提现成功", amount2: "19.50元", thing3: "申请用户" } });
    expect(rows.every((r) => r.withdrawalId === request.id && r.orderId === null)).toBe(true);
    expect(await fixture.db.select().from(systemMessage)).toHaveLength(1);
    const listing = await admin.listDeliveries({ eventKey: message.eventKey });
    expect(listing.list[0]).toMatchObject({ withdrawalId: request.id, orderId: null });
    expect(JSON.stringify(listing)).not.toContain("13800000000");
  });

  it("rolls back all balances and events if a late success-flow write fails", async () => {
    await fixture.exec("CREATE FUNCTION reject_flow() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected flow failure'; END; $$; CREATE TRIGGER reject_flow BEFORE INSERT ON capital_flow FOR EACH ROW EXECUTE FUNCTION reject_flow()");
    try {
      await expect(withdrawal.apply(7, input("balance"))).rejects.toThrow();
      const state = await moneyState();
      expect(state.requests).toHaveLength(0); expect(state.ledger).toHaveLength(0); expect(state.events).toHaveLength(0);
      expect(state.account[0]).toMatchObject({ brokeragePrice: "100.00", nowMoney: "5.00" });
      expect(await fixture.db.select().from(userRecharge)).toHaveLength(0);
      expect(await fixture.db.select().from(userMoney)).toHaveLength(0);
      const request = await withdrawal.apply(7, input());
      await expect(withdrawal.review(request.id, 1)).rejects.toThrow();
      expect((await moneyState()).requests[0].status).toBe(0);
    } finally { await fixture.exec("DROP TRIGGER reject_flow ON capital_flow; DROP FUNCTION reject_flow()"); }
  });

  it("leaves failed notification staging recoverable without reversing committed funds", async () => {
    await configure("user_extract", true);
    await fixture.db.insert(notificationTemplate).values({ mark: "51729", legacyType: 1, status: 1, tempid: "conflicting-legacy" });
    await approved();
    await outbox.dispatchPending();
    const message = queue.find((m): m is OrderNotificationOutboxMessage => isOrderNotificationOutboxMessage(m) && m.eventKey.startsWith("withdrawal.approved."))!;
    await expect(outbox.processMessage(message)).rejects.toThrow("重复");
    expect((await moneyState()).events[0].status).toBe("FAILED");
    expect(await fixture.db.select().from(systemMessage)).toHaveLength(0);
    expect(await fixture.db.select().from(orderNotificationDelivery)).toHaveLength(0);
    await fixture.db.delete(notificationTemplate).where(eq(notificationTemplate.mark, "51729"));
    await outbox.replay(message.outboxId);
    await outbox.dispatchById(message.outboxId);
    await outbox.processMessage(message);
    expect((await moneyState()).flows).toHaveLength(1);
    expect((await moneyState()).account[0].brokeragePrice).toBe("80.00");
  });

  it("never sends forged owner/aggregate snapshots", async () => {
    await configure(); await approved();
    const [event] = (await moneyState()).events;
    await expect(withTx(container, (tx) => processWithdrawalNoticeEvent(tx, { ...event, aggregateType: "order" }, 1))).rejects.toThrow("聚合");
    await expect(withTx(container, (tx) => processWithdrawalNoticeEvent(tx, { ...event, payload: { ...event.payload, userId: 8 } }, 1))).rejects.toThrow("终态");
    expect(await fixture.db.select().from(systemMessage)).toHaveLength(0);
  });

  it("rolls back rejection compensation if the notification event cannot be persisted", async () => {
    const request = await withdrawal.apply(7, input());
    await fixture.exec("CREATE FUNCTION reject_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected event failure'; END; $$; CREATE TRIGGER reject_event BEFORE INSERT ON store_order_outbox FOR EACH ROW EXECUTE FUNCTION reject_event()");
    try {
      await expect(withdrawal.review(request.id, -1, "拒绝")).rejects.toThrow();
      const state = await moneyState();
      expect(state.requests[0].status).toBe(0);
      expect(state.account[0].brokeragePrice).toBe("80.00");
      expect(state.ledger).toHaveLength(1); expect(state.events).toHaveLength(0);
    } finally { await fixture.exec("DROP TRIGGER reject_event ON store_order_outbox; DROP FUNCTION reject_event()"); }
  });

  it("accepts PHP numeric template aliases and dispatches a successful provider result just once", async () => {
    await configure("user_extract", true);
    await fixture.db.update(notificationTemplate).set({ mark: "51729" }).where(eq(notificationTemplate.legacyType, 1));
    await fixture.db.update(notificationTemplate).set({ mark: "1470" }).where(eq(notificationTemplate.legacyType, 0));
    await approved(); await processRoot(); await deliveries.dispatchPending();
    const message = queue.find((m): m is OrderNotificationDeliveryMessage => isOrderNotificationDeliveryMessage(m) && m.channel === "sms")!;
    const provider = vi.spyOn(sms, "sendAliyunTemplateSms").mockResolvedValue({ bizId: "provider-fixture", requestId: "request-fixture" });
    expect(await deliveries.processMessage(message)).toBe("sent");
    expect(await deliveries.processMessage(message)).toBe("already-sent");
    expect(provider).toHaveBeenCalledTimes(1);
    expect((await fixture.db.select().from(orderNotificationDelivery)).filter((r) => r.status === "SENT")).toHaveLength(1);
  });

  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))("serializes simultaneous approvals into one flow and one notice on PostgreSQL 16", async () => {
    const request = await withdrawal.apply(7, input());
    const results = await Promise.all(Array.from({ length: 4 }, () => withdrawal.review(request.id, 1)));
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    const state = await moneyState();
    expect(state.flows).toHaveLength(1); expect(state.events).toHaveLength(1);
    expect(state.account[0].brokeragePrice).toBe("80.00");
  });

  it("survives queue failure, consumes the provider once, and keeps unknown outcomes for explicit recovery", async () => {
    await configure(); await approved();
    sendBatch.mockRejectedValueOnce(new Error("injected queue failure"));
    await expect(outbox.dispatchPending()).rejects.toThrow();
    const [event] = (await moneyState()).events;
    await outbox.replay(event.id); await processRoot();
    await deliveries.dispatchPending();
    const message = queue.find(isOrderNotificationDeliveryMessage)!;
    expect(message).toBeDefined();
    const provider = vi.spyOn(sms, "sendAliyunTemplateSms").mockRejectedValue(new Error("injected unknown result"));
    expect(await deliveries.processMessage(message)).toBe("unknown");
    expect(await deliveries.processMessage(message)).toBe("unknown");
    expect(await deliveries.dispatchPending()).toMatchObject({ claimed: 0 });
    expect(provider).toHaveBeenCalledTimes(1);
    const confirmation = { requestKey: crypto.randomUUID(), reason: "已核查提供商确认本条通知发送成功", providerReference: "receipt-fixture" };
    await admin.confirmSent(message.deliveryId, 1, confirmation);
    expect(await admin.confirmSent(message.deliveryId, 1, confirmation)).toMatchObject({ duplicate: true });
    expect(await deliveries.processMessage(message)).toBe("already-sent");
    expect((await moneyState()).flows).toHaveLength(1);
    expect((await moneyState()).account[0].brokeragePrice).toBe("80.00");
  });

  it("respects disabled channels and records missing targets as skipped, never sent", async () => {
    await configure(); await fixture.db.update(user).set({ phone: "" }).where(eq(user.uid, 7));
    await approved(); await processRoot();
    const rows = await fixture.db.select().from(orderNotificationDelivery);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "SKIPPED", lastError: "target_not_configured" });
    expect(await deliveries.dispatchPending()).toMatchObject({ claimed: 0 });
    await expect(admin.saveOrderConfig("user_balance_change", { isWechat: true })).rejects.toThrow("不支持公众号");
  });

  it("recognizes both withdrawal events and existing second-card delivery messages", () => {
    for (const eventKey of ["withdrawal.approved.notice:1", "withdrawal.refused.notice:2", "order.second_card.advent.notice:1:123"]) {
      const root: OrderNotificationOutboxMessage = { action: "processOrderNotificationOutbox", outboxId: 1, eventKey };
      const delivery: OrderNotificationDeliveryMessage = { action: "processOrderNotificationDelivery", deliveryId: 1, eventKey, channel: "sms" };
      expect(isOrderNotificationOutboxMessage(root)).toBe(true);
      expect(isOrderNotificationDeliveryMessage(delivery)).toBe(true);
    }
    expect(isOrderNotificationDeliveryMessage({ action: "processOrderNotificationDelivery", deliveryId: 1, eventKey: "withdrawal.approved.notice:0", channel: "sms" })).toBe(false);
  });
});
