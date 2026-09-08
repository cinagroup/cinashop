import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { financePostgres } from "./helpers/financePostgres";
import { withFinancePeers, waitForFinanceBlock, waitForFinanceClock, outcome } from "./helpers/financePeers";
import { createContainerFromDb, withTx } from "../src/lib/di";
import { reservePinkJoin } from "../src/services/activity/PinkLifecycleService";
import { ActivityJoinService } from "../src/services/activity/ActivityJoinService";
import { StoreOrderRefundService } from "../src/services/order/StoreOrderRefundService";
import { SystemConfigService } from "../src/services/system/SystemConfigService";
import { removePink } from "../src/controllers/api/v1/ActivityJoinController";
import { ApiException } from "../src/utils/errors";
import { storePink, storeOrder, storeOrderCartInfo, storeOrderRefund, storeOrderStatus, user } from "../src/models/schema";
import type { AppVariables, Env } from "../src/env";

// Real HTTP, SQL eligibility and refund application. Execution is deliberately
// intercepted: these tests do NOT claim balance/provider settlement coverage.
describe("pink cancellation authorization before privileged refund execution", () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  let svc: ActivityJoinService;
  let app: Hono<{ Bindings: Env; Variables: AppVariables }>;
  const env = {} as Env;
  let execute: MockInstance<StoreOrderRefundService["agreeRefund"]>;
  beforeEach(async () => {
    f = await financePostgres([user, storePink, storeOrder, storeOrderCartInfo, storeOrderRefund, storeOrderStatus]);
    const container = createContainerFromDb(f.db);
    svc = new ActivityJoinService(container, env);
    vi.spyOn(SystemConfigService.prototype, "get").mockResolvedValue("0");
    execute = vi.spyOn(StoreOrderRefundService.prototype, "agreeRefund").mockResolvedValue({ completed: false, status: "PROCESSING" });
    await f.db.insert(user).values({ uid: 11, nickname: "Isolated leader" });
    await f.db.insert(storePink).values({ id: 400, uid: 11, combinationId: 30, productId: 70, people: 4,
      orderIdKey: "500", orderId: "isolated-pink-order", stopTime: sql`NOW() + INTERVAL '1 day'` });
    await f.db.insert(storeOrder).values({ id: 500, uid: 11, orderId: "isolated-pink-order", type: 3,
      activityId: 30, pinkId: 400, paid: 1, payPrice: "6.25", totalNum: 1, payType: "yue" });
    await f.db.insert(storeOrderCartInfo).values({ id: 1, oid: 500, cartId: "1", cartNum: 1,
      productId: 70, cartInfo: JSON.stringify({ truePrice: "6.25" }) });
    app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use("*", async (c, next) => { c.set("container", container); c.set("uid", Number(c.req.header("x-fixture-user") ?? 11)); await next(); });
    app.onError((error, c) => c.json({ status: error instanceof ApiException ? error.code : 500, msg: error.message }));
    app.post("/api/combination/remove", removePink);
  }, 30_000);
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); });
  const cancel = () => svc.removePink(11, 400, 30);
  const request = async (body: string, uid = 11) => {
    const response = await app.request("/api/combination/remove", { method: "POST", headers: {
      "content-type": "application/json", "x-fixture-user": String(uid),
    }, body }, env);
    return { response, body: await response.json<{ status: number; msg: string; data?: unknown }>() };
  };
  const untouched = async () => {
    expect(execute).not.toHaveBeenCalled();
    expect(await f.db.select().from(storeOrderStatus)).toHaveLength(0);
    expect((await f.db.select().from(storeOrder))[0].refundStatus).toBe(0);
    expect((await f.db.select().from(storePink))[0].isRefund).toBe(0);
  };

  it.each([
    { type: 0 }, { activityId: 31 }, { pinkId: 401 }, { uid: 22 }, { paid: 0 },
    { isDel: 1 }, { isSystemDel: 1 }, { orderId: "different-order" },
    { status: 1 }, { refundStatus: 3 },
  ])("rejects unrelated or ineligible paid orders: %j", async (patch) => {
    await f.db.update(storeOrder).set(patch);
    await expect(cancel()).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
    expect(await f.db.select().from(storeOrderRefund)).toHaveLength(0);
  });
  it.each(["0500", "5e2", "500.0", " 500", "500 ", "0x1f4", "9007199254740993"])("rejects noncanonical order key %s", async (orderIdKey) => {
    await f.db.update(storePink).set({ orderIdKey });
    await expect(cancel()).rejects.toThrow();
    await untouched();
  });
  it("does not auto-approve an unrelated open partial refund", async () => {
    await f.db.insert(storeOrderRefund).values({ id: 80, storeOrderId: 500, uid: 11, orderId: "customer-existing-refund",
      refundPrice: "1.00", refundNum: 1, applyType: 1 });
    await expect(cancel()).rejects.toThrow("已有进行中的退款申请");
    expect((await f.db.select().from(storeOrderRefund))[0].refundType).toBe(0);
    await untouched();
  });
  it.each([{ stopTime: null }, { stopTime: new Date(0) }, { status: 2 }, { kId: 401 }, { isRefund: 1 }, { people: 1 }])("rejects a non-cancellable group: %j", async (patch) => {
    await f.db.update(storePink).set(patch);
    await expect(cancel()).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
  it("blocks a full persisted membership even when status is still 1", async () => {
    await f.db.update(storePink).set({ people: 2 });
    await f.db.insert(storePink).values({ id: 401, uid: 22, kId: 400, combinationId: 30 });
    await expect(cancel()).rejects.toThrow("拼团人数已满");
    await untouched();
  });
  it("requires a live account before creating a refund", async () => {
    await f.db.update(user).set({ status: 0 });
    await expect(cancel()).rejects.toThrow();
    await untouched();
  });
  it("blocks an unpaid join when the leader has no successor", async () => {
    await f.db.insert(storeOrder).values({ id: 501, uid: 22, type: 3, pinkId: 400, activityId: 30, paid: 0 });
    await expect(cancel()).rejects.toThrow("待支付参团订单");
    await untouched();
  });
  it("ignores system-deleted unpaid reservations", async () => {
    await f.db.insert(storeOrder).values({ id: 501, uid: 22, type: 3, pinkId: 400, paid: 0, isSystemDel: 1 });
    expect(await cancel()).toEqual({ completed: false, status: "PROCESSING" });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("returns processing, not a completed refund, through the real controller", async () => {
    const result = await request('{"id":400,"cid":30}');
    expect(result.body).toMatchObject({ status: 200, msg: "退款处理中", data: { completed: false, status: "PROCESSING" } });
    expect(result.response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("creates one dedicated full refund application and binds execution on repeat requests", async () => {
    expect(await cancel()).toEqual({ completed: false, status: "PROCESSING" });
    expect(await cancel()).toEqual({ completed: false, status: "PROCESSING" });
    const refunds = await f.db.select().from(storeOrderRefund);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ orderId: "pink_cancel_400_500", refundPrice: "6.25", refundNum: 1, refundType: 0 });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenLastCalledWith(refunds[0].id, expect.objectContaining({ expectedUid: 11,
      expectedStoreOrderId: 500, expectedRefundOrderId: "pink_cancel_400_500", expectedRefundAmountCents: 625,
      requirePaid: true, requireSystemVisible: true }));
    expect(await f.db.select().from(storeOrderStatus)).toHaveLength(1);
    expect((await f.db.select().from(storePink))[0].isRefund).toBe(0);
  });
  it.each(["expired", "full", "refunded", "order", "account", "pending-join"])("rechecks %s after preflight, before committing a new application", async change => {
    const apply = StoreOrderRefundService.prototype.applyRefund;
    vi.spyOn(StoreOrderRefundService.prototype, "applyRefund").mockImplementationOnce(async function (this: StoreOrderRefundService, ...args) {
      if (change === "expired") await f.db.update(storePink).set({ stopTime: new Date(0) });
      if (change === "full") await f.db.update(storePink).set({ people: 1 });
      if (change === "refunded") await f.db.update(storePink).set({ isRefund: 400 });
      if (change === "order") await f.db.update(storeOrder).set({ pinkId: 401 });
      if (change === "account") await f.db.update(user).set({ status: 0 });
      if (change === "pending-join") await f.db.insert(storeOrder).values({ id: 501, uid: 22, type: 3, pinkId: 400, paid: 0 });
      return apply.apply(this, args);
    });
    await expect(cancel()).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
    expect(await f.db.select().from(storeOrderRefund)).toHaveLength(0);
    expect(await f.db.select().from(storeOrderStatus)).toHaveLength(0);
  });
  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))("uses the actual deadline after waiting for the leader lock on PostgreSQL", async () => {
    await withFinancePeers(f.db, async ([blocker, first]) => {
      await blocker.exec('BEGIN; SELECT id FROM store_pink WHERE id=400 FOR UPDATE');
      // Preflight sees the old committed deadline. The new deadline elapses
      // while admission waits; transaction-start NOW() would wrongly accept it.
      const [deadline] = await blocker.db.update(storePink).set({ stopTime: sql`clock_timestamp() + INTERVAL '1 second'` })
        .returning({ time: storePink.stopTime });
      const pending = outcome(new ActivityJoinService(createContainerFromDb(first.db), env).removePink(11, 400, 30));
      await waitForFinanceBlock(f.db, first.pid, blocker.pid);
      await waitForFinanceClock(f.db, deadline.time!.getTime());
      await blocker.exec("COMMIT");
      const result = await pending;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("已到期");
    });
    expect(execute).not.toHaveBeenCalled();
    expect(await f.db.select().from(storeOrderRefund)).toHaveLength(0);
    expect(await f.db.select().from(storeOrderStatus)).toHaveLength(0);
  }, 15_000);
  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))("holds the leader until cancellation intent commits, then rejects a waiting reservation", async () => {
    await withFinancePeers(f.db, async ([first, second]) => {
      let release = () => {};
      let announce = () => {};
      const gate = new Promise<void>(resolve => { release = resolve; });
      const locked = new Promise<void>(resolve => { announce = resolve; });
      const apply = StoreOrderRefundService.prototype.applyRefund;
      vi.spyOn(StoreOrderRefundService.prototype, "applyRefund").mockImplementationOnce(function (this: StoreOrderRefundService, input) {
        return apply.call(this, { ...input, authorizeApplication: async (tx, order) => {
          await input.authorizeApplication!(tx, order);
          announce(); await gate;
        } });
      });
      const cancelling = outcome(new ActivityJoinService(createContainerFromDb(first.db), env).removePink(11, 400, 30));
      try {
        await Promise.race([locked, cancelling.then(() => { throw new Error("Cancellation finished before admission barrier"); })]);
        const joining = outcome(withTx(createContainerFromDb(second.db), tx => reservePinkJoin(tx, { uid: 22, leaderId: 400, combinationId: 30 })));
        await waitForFinanceBlock(f.db, second.pid, first.pid);
        expect(await f.db.select().from(storeOrderRefund)).toHaveLength(0);
        release();
        expect(await cancelling).toMatchObject({ ok: true, value: { completed: false, status: "PROCESSING" } });
        const result = await joining;
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.message).toContain("取消处理中");
        expect(await f.db.select().from(storeOrderRefund)).toHaveLength(1);
      } finally { release(); await cancelling; }
    });
  }, 15_000);
  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))("rejects cancellation when an earlier locked reservation commits an unpaid join", async () => {
    await withFinancePeers(f.db, async ([first, second]) => {
      let release = () => {};
      let announce = () => {};
      const gate = new Promise<void>(resolve => { release = resolve; });
      const locked = new Promise<void>(resolve => { announce = resolve; });
      const joining = outcome(withTx(createContainerFromDb(first.db), async tx => {
        await reservePinkJoin(tx, { uid: 22, leaderId: 400, combinationId: 30 });
        await tx.insert(storeOrder).values({ id: 501, uid: 22, type: 3, activityId: 30, pinkId: 400, paid: 0 });
        announce(); await gate;
      }));
      try {
        await Promise.race([locked, joining.then(() => { throw new Error("Reservation finished before barrier"); })]);
        const cancelling = outcome(new ActivityJoinService(createContainerFromDb(second.db), env).removePink(11, 400, 30));
        await waitForFinanceBlock(f.db, second.pid, first.pid);
        release();
        expect(await joining).toMatchObject({ ok: true });
        const result = await cancelling;
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.message).toContain("待支付参团订单");
      } finally { release(); await joining; }
    });
    expect(execute).not.toHaveBeenCalled();
    expect(await f.db.select().from(storeOrderRefund)).toHaveLength(0);
    expect(await f.db.select().from(storeOrderStatus)).toHaveLength(0);
  }, 15_000);
  it.each(["null", "[]", "{", '{}', '{"id":true,"cid":30}', '{"id":-1,"cid":30}', '{"id":400.5,"cid":30}', '{"id":"400","cid":30}'])("rejects malformed JSON IDs with a private business error: %s", async (body) => {
    const result = await request(body);
    expect(result.body.status).toBe(400);
    expect(result.response.headers.get("cache-control")).toBe("private, no-store");
    await untouched();
  });
  it("keeps anonymous cancellation private and refuses before execution", async () => {
    const result = await request('{"id":400,"cid":30}', 0);
    expect(result.body.status).toBe(400);
    expect(result.response.headers.get("cache-control")).toBe("private, no-store");
    await untouched();
  });
});
