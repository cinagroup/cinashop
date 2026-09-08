import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { financePostgres } from "./helpers/financePostgres";
import { withFinancePeers, waitForFinanceBlock, outcome } from "./helpers/financePeers";
import { createContainerFromDb, withTx } from "../src/lib/di";
import { reservePinkJoin, assertPinkOrderPayable } from "../src/services/activity/PinkLifecycleService";
import { applyStoreOrderPayment, applyStoreOrderBalancePayment } from "../src/services/order/StoreOrderPayService";
import { storeCombination, storePink, storeOrder, storeOrderCartInfo, storeOrderRefund,
  storeOrderInvoice, storeOrderOutbox, storeProductAttrValue, user, userBill } from "../src/models/schema";

// Real payment/ledger/outbox SQL; no payment provider call or production binding.
describe("durable pink cancellation intent gates payment admission", () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  beforeEach(async () => {
    f = await financePostgres([storeCombination, storePink, storeOrder, storeOrderCartInfo, storeOrderRefund,
      storeOrderInvoice, storeOrderOutbox, storeProductAttrValue, user, userBill]);
    await f.exec('CREATE UNIQUE INDEX fixture_outbox_event ON store_order_outbox (event_key)');
    await f.db.insert(user).values([{ uid: 11 }, { uid: 22, nowMoney: "20.00" }]);
    await f.db.insert(storeCombination).values({ id: 30, productId: 70, people: 4, effectiveTime: 24, price: "6.25" });
    await f.db.insert(storeProductAttrValue).values({ id: 2, productId: 30, type: 3 });
    await f.db.insert(storePink).values({ id: 400, uid: 11, combinationId: 30, people: 4, memberCount: 1,
      orderIdKey: "500", orderId: "leader-order", stopTime: sql`NOW() + INTERVAL '1 day'` });
    await f.db.insert(storeOrder).values({ id: 501, uid: 22, type: 3, activityId: 30, pinkId: 400,
      orderId: "joining-order", totalNum: 1, payPrice: "6.25" });
    await f.db.insert(storeOrderCartInfo).values({ oid: 501, cartInfo: JSON.stringify({ activitySku: { id: 2 } }) });
  }, 30_000);
  afterEach(async () => { await f?.close(); });
  const intent = () => f.db.insert(storeOrderRefund).values({ storeOrderId: 500, uid: 11,
    orderId: "pink_cancel_400_500", refundPrice: "6.25", refundNum: 1 });
  const reserve = () => withTx(createContainerFromDb(f.db), tx => reservePinkJoin(tx, { uid: 33, leaderId: 400, combinationId: 30 }));
  const balance = () => applyStoreOrderBalancePayment(createContainerFromDb(f.db), { uid: 22, orderId: "joining-order" });
  const assertUnpaid = async () => {
    expect((await f.db.select().from(storeOrder))[0]).toMatchObject({ paid: 0, pinkId: 400 });
    expect((await f.db.select().from(user).where(eq(user.uid, 22)))[0].nowMoney).toBe("20.00");
    expect(await f.db.select().from(userBill)).toHaveLength(0);
    expect(await f.db.select().from(storeOrderOutbox)).toHaveLength(0);
    expect(await f.db.select().from(storePink)).toHaveLength(1);
  };
  it.each([0, 1, 2, 4, 5])("blocks reservation and payment for active refund state %s", async refundType => {
    await intent(); await f.db.update(storeOrderRefund).set({ refundType });
    await expect(reserve()).rejects.toThrow("取消处理中");
    const [order] = await f.db.select().from(storeOrder);
    await expect(assertPinkOrderPayable(f.db, order)).rejects.toThrow("取消处理中");
    await expect(balance()).rejects.toThrow("取消处理中");
    await assertUnpaid();
  });
  it.each([{ isCancel: 1 }, { isDel: 1 }, { refundType: 3 }, { orderId: "unrelated-refund" }])("does not treat inactive or unrelated receipts as cancellation: %j", async patch => {
    await intent(); await f.db.update(storeOrderRefund).set(patch);
    expect(await reserve()).toMatchObject({ leaderId: 400 });
    expect(await balance()).toMatchObject({ outcome: "paid" });
    expect((await f.db.select().from(user).where(eq(user.uid, 22)))[0].nowMoney).toBe("13.75");
    expect(await f.db.select().from(userBill)).toHaveLength(1);
    expect(await f.db.select().from(storeOrderOutbox)).toHaveLength(1);
  });
  it("retains an already charged callback in a new group, with one paid event on replay", async () => {
    await intent();
    const input = { orderId: 501, payType: "weixin", tradeNo: "isolated-charged-trade" };
    expect(await applyStoreOrderPayment(createContainerFromDb(f.db), input)).toMatchObject({ outcome: "paid" });
    const [order] = await f.db.select().from(storeOrder);
    expect(order).toMatchObject({ paid: 1, tradeNo: input.tradeNo });
    expect(order.pinkId).not.toBe(400);
    expect((await f.db.select().from(storePink).where(eq(storePink.id, 400)))[0]).toMatchObject({ status: 1, memberCount: 1 });
    expect((await f.db.select().from(storePink).where(eq(storePink.id, order.pinkId)))[0]).toMatchObject({ uid: 22, kId: 0, orderIdKey: "501" });
    expect(await applyStoreOrderPayment(createContainerFromDb(f.db), input)).toMatchObject({ outcome: "already-paid" });
    expect(await f.db.select().from(storePink)).toHaveLength(2);
    expect(await f.db.select().from(storeOrderOutbox)).toHaveLength(1);
    expect(await f.db.select().from(userBill)).toHaveLength(0);
  });
  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))("rolls back balance, ledger and paid state if cancellation commits after preflight", async () => {
    await withFinancePeers(f.db, async ([blocker, first]) => {
      await blocker.exec('BEGIN; SELECT uid FROM "user" WHERE uid=22 FOR UPDATE');
      const paying = outcome(applyStoreOrderBalancePayment(createContainerFromDb(first.db), { uid: 22, orderId: "joining-order" }));
      await waitForFinanceBlock(f.db, first.pid, blocker.pid);
      // Balance reached its debit after a successful eligibility read. The
      // durable intent wins before the later locked group activation.
      await intent();
      await blocker.exec("COMMIT");
      const result = await paying;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("取消处理中");
    });
    await assertUnpaid();
  }, 15_000);
});
