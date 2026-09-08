import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createPcCheckoutQuoteFixture } from "./helpers/pcCheckoutQuoteFixture";
import { withFinancePeers, waitForFinanceBlock, outcome } from "./helpers/financePeers";
import { createContainerFromDb } from "../src/lib/di";
import { ActivityJoinService } from "../src/services/activity/ActivityJoinService";
import { StoreOrderRefundService } from "../src/services/order/StoreOrderRefundService";
import { WechatPayService } from "../src/services/wechat/WechatPayService";
import { removePink } from "../src/controllers/api/v1/ActivityJoinController";
import { storeCombination, storePink, storeOrder, storeOrderCartInfo, storeOrderStatus,
  storeOrderRefund, storeOrderRefundPayment, storeOrderInvoice, userBrokerage, storeProductAttrValue, user } from "../src/models/schema";

// The balance path below uses the actual application, execution, compensation,
// and group lifecycle SQL. WeChat transport alone is replaced by explicit
// provider results; no host binding or real external payment is used.
describe("pink cancellation refund recovery through real SQL execution", () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  let svc: ActivityJoinService;
  beforeEach(async () => {
    f = await createPcCheckoutQuoteFixture([storeCombination, storePink, storeOrderCartInfo, storeOrderStatus,
      storeOrderRefund, storeOrderRefundPayment, storeOrderInvoice, userBrokerage]);
    for (const key of Object.keys(f.config)) f.config[key] = "0";
    svc = new ActivityJoinService(f.container, f.env);
    f.app.post("/api/combination/remove", removePink);
    await f.db.insert(storeCombination).values({ id: 30, productId: 70, storeName: "Isolated cancellation",
      people: 4, price: "6.25", stock: 7, quota: 7, sales: 1 });
    await f.db.insert(storeProductAttrValue).values({ id: 2, productId: 30, type: 3, unique: "actred30",
      suk: "红色,大号", stock: 7, quota: 7, sales: 1, price: "6.25" });
    await f.db.insert(storePink).values({ id: 400, uid: 11, orderId: "isolated-paid-leader", orderIdKey: "500",
      combinationId: 30, productId: 70, people: 4, memberCount: 1, stopTime: sql`NOW() + INTERVAL '1 day'` });
    await f.db.insert(storeOrder).values({ id: 500, uid: 11, orderId: "isolated-paid-leader", type: 3, activityId: 30,
      pinkId: 400, paid: 1, payType: "yue", totalNum: 1, payPrice: "6.25" });
    await f.db.insert(storeOrderCartInfo).values({ id: 1, uid: 11, oid: 500, cartId: "1", productId: 70,
      skuUnique: "qared001", cartNum: 1, cartInfo: JSON.stringify({ truePrice: "6.25", sku: { id: 1 }, activitySku: { id: 2 } }) });
  }, 30_000);
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); });
  const cancel = () => svc.removePink(11, 400, 30);
  const request = async () => {
    const response = await f.app.request("/api/combination/remove", { method: "POST", headers: {
      "content-type": "application/json", "x-fixture-user": "11",
    }, body: '{"id":400,"cid":30}' }, f.env);
    return { response, body: await response.json<{ status: number; data: { completed: boolean; status: string } }>() };
  };
  const ordered = <T extends { id?: number; uid?: number }>(rows: T[]) =>
    [...rows].sort((a, b) => (a.id ?? a.uid ?? 0) - (b.id ?? b.uid ?? 0));
  const snapshot = async () => {
    const base = await f.snapshot();
    return { carts: ordered(base.carts), products: ordered(base.products), skus: ordered(base.skus),
      users: ordered(base.users), orders: ordered(base.orders), bills: ordered(base.bills),
      pinks: await f.db.select().from(storePink).orderBy(storePink.id),
      refunds: await f.db.select().from(storeOrderRefund).orderBy(storeOrderRefund.id),
      details: await f.db.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.id),
      combinations: await f.db.select().from(storeCombination).orderBy(storeCombination.id),
      statuses: await f.db.select().from(storeOrderStatus).orderBy(storeOrderStatus.id),
    };
  };

  it("refunds balance once and returns the confirmed result on completed HTTP replays", async () => {
    expect((await request()).body).toMatchObject({ status: 200, data: { completed: true, status: "BALANCE_SUCCESS" } });
    const first = await snapshot();
    expect(first.users[0].nowMoney).toBe("6.25");
    expect(first.orders[0]).toMatchObject({ refundStatus: 2, refundPrice: "6.25" });
    expect(first.pinks[0]).toMatchObject({ status: 3, isRefund: 400 });
    expect(first.details[0].refundNum).toBe(1);
    expect(first.products[0].stock).toBe(9);
    expect(first.skus.find(row => row.id === 1)?.stock).toBe(9);
    expect(first.skus.find(row => row.id === 2)).toMatchObject({ stock: 8, quota: 8 });
    expect(first.combinations[0]).toMatchObject({ stock: 8, quota: 8 });
    expect(first.bills.filter(row => row.type === "pay_product_refund")).toHaveLength(1);
    for (let attempt = 0; attempt < 2; attempt++) {
      const replay = await request();
      expect(replay.body).toMatchObject({ status: 200, data: { completed: true, status: "SUCCESS" } });
      expect(replay.response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(await snapshot()).toEqual(first);
  });

  it("promotes the surviving member and replays via the original leader identity without touching that member's order", async () => {
    await f.db.insert(user).values({ uid: 22, nickname: "Survivor" });
    await f.db.insert(storePink).values({ id: 401, uid: 22, kId: 400, combinationId: 30, productId: 70,
      orderId: "isolated-survivor", orderIdKey: "501", people: 4 });
    await f.db.insert(storeOrder).values({ id: 501, uid: 22, orderId: "isolated-survivor", type: 3, activityId: 30,
      pinkId: 400, paid: 1, payType: "yue", totalNum: 1, payPrice: "6.25" });
    expect(await cancel()).toMatchObject({ completed: true });
    const first = await snapshot();
    expect(first.pinks.find(row => row.id === 401)).toMatchObject({ kId: 0, status: 1, isRefund: 0, memberCount: 1 });
    expect(first.orders.find(row => row.id === 501)).toMatchObject({ pinkId: 401, refundStatus: 0 });
    expect(await cancel()).toEqual({ completed: true, status: "SUCCESS" });
    expect(await snapshot()).toEqual(first);
  });

  it("resumes a processing provider refund after group expiry with the original refund number, never a second request", async () => {
    await f.db.update(storeOrder).set({ payType: "weixin", tradeNo: "isolated-provider-trade" });
    const send = vi.spyOn(WechatPayService.prototype, "requestRefund").mockResolvedValue({ status: "PROCESSING", providerRefundId: "isolated-refund" });
    const query = vi.spyOn(WechatPayService.prototype, "queryRefund").mockResolvedValue({ status: "SUCCESS", providerRefundId: "isolated-refund" });
    expect(await cancel()).toEqual({ completed: false, status: "PROCESSING" });
    expect((await snapshot()).orders[0].refundStatus).toBe(0);
    await f.db.update(storePink).set({ stopTime: new Date(0), status: 3 });
    expect(await cancel()).toEqual({ completed: true, status: "SUCCESS" });
    expect(send).toHaveBeenCalledTimes(1); expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toEqual(send.mock.calls[0][0]);
    const first = await snapshot();
    expect(first.refunds).toHaveLength(1); expect(first.refunds[0]).toMatchObject({ refundType: 6, refundedPrice: "6.25" });
    expect(first.users[0].nowMoney).toBe("0.00"); // Original channel, not balance.
    expect(await cancel()).toEqual({ completed: true, status: "SUCCESS" });
    expect(send).toHaveBeenCalledTimes(1); expect(query).toHaveBeenCalledTimes(1);
    expect(await snapshot()).toEqual(first);
  });

  it("keeps an uncertain provider result recoverable and queries before resending", async () => {
    await f.db.update(storeOrder).set({ payType: "weixin", tradeNo: "isolated-provider-trade" });
    const send = vi.spyOn(WechatPayService.prototype, "requestRefund").mockRejectedValue(new Error("isolated transport timeout"));
    const query = vi.spyOn(WechatPayService.prototype, "queryRefund").mockResolvedValue({ status: "SUCCESS", providerRefundId: "isolated-refund" });
    await expect(cancel()).rejects.toThrow("结果未知");
    expect((await f.db.select().from(storeOrderRefundPayment))[0].providerStatus).toBe("UNKNOWN");
    await f.db.update(storePink).set({ stopTime: new Date(0) });
    expect(await cancel()).toEqual({ completed: true, status: "SUCCESS" });
    expect(send).toHaveBeenCalledTimes(1); expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toEqual(send.mock.calls[0][0]);
  });

  it("rolls back balance, stock and group changes on failed finalization and recovers the same application", async () => {
    await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify({ truePrice: "6.25", sku: { id: 999 }, activitySku: { id: 2 } }) });
    const before = await snapshot();
    await expect(cancel()).rejects.toThrow("退款商品规格库存无法回退");
    const failed = await snapshot();
    expect(failed.users).toEqual(before.users); expect(failed.pinks).toEqual(before.pinks);
    expect(failed.orders).toEqual(before.orders); expect(failed.skus).toEqual(before.skus);
    expect(failed.bills).toEqual(before.bills); expect(failed.details).toEqual(before.details);
    expect(failed.refunds).toHaveLength(1); expect(failed.refunds[0].refundType).toBe(0);
    await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify({ truePrice: "6.25", sku: { id: 1 }, activitySku: { id: 2 } }) });
    await f.db.update(storePink).set({ stopTime: new Date(0) });
    expect(await cancel()).toMatchObject({ completed: true });
    expect((await f.db.select().from(storeOrderRefund)).map(row => row.id)).toEqual([failed.refunds[0].id]);
  });

  it("does not resurrect an explicitly withdrawn cancellation application", async () => {
    const refund = await new StoreOrderRefundService(f.container, f.env).applyRefund({ uid: 11, orderId: "isolated-paid-leader",
      refundReason: "用户手动取消拼团", refundExplain: "用户手动取消未成团的拼团订单", applyType: 1,
      expectedRefundAmountCents: 625, applicationOrderId: "pink_cancel_400_500" });
    await new StoreOrderRefundService(f.container, f.env).cancelApply(11, refund.refundId);
    const before = await snapshot();
    await expect(cancel()).rejects.toThrow("已撤销、删除或拒绝");
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    { refundPrice: "1.00" }, { refundedPrice: "1.00" }, { uid: 22 }, { refundNum: 2 },
    { applyType: 2 }, { refundReason: "different application" }, { isDel: 1 },
  ])("rejects an inconsistent completed receipt without repeating compensation: %j", async patch => {
    await cancel();
    await f.db.update(storeOrderRefund).set(patch);
    const before = await snapshot();
    await expect(cancel()).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

  it.each(["order", "pink"])("rejects a completed receipt whose %s completion evidence is inconsistent", async target => {
    await cancel();
    if (target === "order") await f.db.update(storeOrder).set({ refundStatus: 0 });
    else await f.db.update(storePink).set({ isRefund: 999 });
    const before = await snapshot();
    await expect(cancel()).rejects.toThrow("完成记录不一致");
    expect(await snapshot()).toEqual(before);
  });

  // Only independent PG16 backends can prove this lock wait. The local PGlite
  // run reports this one case as skipped; both CI shards require zero skips.
  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))("serializes overlapping recovery after expiry on independent PostgreSQL backends", async () => {
    await withFinancePeers(f.db, async ([blocker, first, second]) => {
      await blocker.exec('BEGIN; SELECT uid FROM "user" WHERE uid=11 FOR UPDATE');
      const a = outcome(new ActivityJoinService(createContainerFromDb(first.db), f.env).removePink(11, 400, 30));
      await waitForFinanceBlock(f.db, first.pid, blocker.pid);
      // The first application has committed, but its real balance transaction
      // has not. Recovery must find that application after the deadline passes.
      await f.db.update(storePink).set({ stopTime: new Date(0) }).where(eq(storePink.id, 400));
      const b = outcome(new ActivityJoinService(createContainerFromDb(second.db), f.env).removePink(11, 400, 30));
      await waitForFinanceBlock(f.db, second.pid, first.pid);
      await blocker.exec("COMMIT");
      expect(await a).toMatchObject({ ok: true, value: { completed: true } });
      expect(await b).toEqual({ ok: true, value: { completed: true, status: "SUCCESS" } });
    });
    const state = await snapshot();
    expect(state.users[0].nowMoney).toBe("6.25");
    expect(state.refunds).toHaveLength(1);
    expect(state.bills.filter(row => row.type === "pay_product_refund")).toHaveLength(1);
    expect(state.details[0].refundNum).toBe(1);
    expect(state.skus.find(row => row.id === 2)).toMatchObject({ stock: 8, quota: 8 });
  }, 15_000);
});
