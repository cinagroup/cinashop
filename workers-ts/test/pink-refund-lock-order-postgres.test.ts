import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createPcCheckoutQuoteFixture } from "./helpers/pcCheckoutQuoteFixture";
import { withFinancePeers, waitForFinanceBlock, outcome, type FinancePeer } from "./helpers/financePeers";
import { createContainerFromDb, type Container } from "../src/lib/di";
import { StoreOrderCreateService, cancelStoreOrder } from "../src/services/order/StoreOrderCreateService";
import { applyStoreOrderBalancePayment, applyStoreOrderPayment } from "../src/services/order/StoreOrderPayService";
import { finalizeStoreOrderRefund } from "../src/services/order/StoreOrderRefundService";
import { PinkTimeoutService } from "../src/services/activity/PinkTimeoutService";
import { storeCombination, storePink, storeCart, storeOrder, storeOrderCartInfo, storeOrderRefund,
  storeOrderRefundPayment, storeOrderInvoice, storeOrderOutbox, storeOrderStatus, storeProductAttrValue,
  userBrokerage, printDocument, systemStore, user } from "../src/models/schema";

// The fixture really creates/reserves and balance-pays orders. No provider,
// mocked transaction, host credentials or production data enters these tests.
describe("pink inventory, order and member lock ordering", () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  let leaderOrder: typeof storeOrder.$inferSelect;
  let memberOrder: typeof storeOrder.$inferSelect;
  let pendingOrder: typeof storeOrder.$inferSelect;
  let successorId: number;
  const pg = it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL));
  const create = async (container: Container, uid: number, cartId: number, pinkId = 0) => {
    await StoreOrderCreateService.createWithRuntime(container,
      { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => `isolated-pink-${cartId}` },
      { uid, key: `pink-key-${cartId}`, cartIds: [cartId], type: 3, combinationId: 30, pinkId,
        shippingType: 2, storeId: 1, realName: "隔离拼团", userPhone: "00000000000", userIp: "127.0.0.1" });
    return (await container.db.select().from(storeOrder).where(eq(storeOrder.orderId, `isolated-pink-${cartId}`)))[0];
  };
  beforeEach(async () => {
    f = await createPcCheckoutQuoteFixture([storeCombination, storePink, storeOrderCartInfo, storeOrderRefund,
      storeOrderRefundPayment, storeOrderInvoice, storeOrderOutbox, storeOrderStatus, userBrokerage, printDocument]);
    await f.exec('CREATE UNIQUE INDEX fixture_pink_outbox_event ON store_order_outbox (event_key)');
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
    await f.db.update(systemStore).set({ isStore: 1 });
    await f.db.update(user).set({ nowMoney: "100.00" });
    await f.db.insert(user).values([22, 33, 44].map(uid => ({ uid, nowMoney: "100.00" })));
    await f.db.update(storeCart).set({ type: 3, activityId: 30 });
    await f.db.insert(storeCart).values([2, 3, 4].map(id => ({ id, uid: id * 11, productId: 70,
      productAttrUnique: "qared001", cartNum: 1, type: 3, activityId: 30, isNew: 1, status: 1 })));
    await f.db.insert(storeCombination).values({ id: 30, productId: 70, people: 6, effectiveTime: 24,
      stock: 20, quota: 20, onceNum: 3, num: 20, price: "6.25" });
    await f.db.insert(storeProductAttrValue).values({ id: 2, productId: 30, type: 3, unique: "pink-red",
      suk: "红色,大号", stock: 20, quota: 20, price: "6.25" });
    const first = await create(f.container, 11, 1);
    await applyStoreOrderBalancePayment(f.container, { uid: 11, orderId: first.orderId });
    leaderOrder = (await f.db.select().from(storeOrder).where(eq(storeOrder.id, first.id)))[0];
    memberOrder = await create(f.container, 22, 2, leaderOrder.pinkId);
    await applyStoreOrderBalancePayment(f.container, { uid: 22, orderId: memberOrder.orderId });
    successorId = (await f.db.select().from(storePink).where(eq(storePink.uid, 22)))[0].id;
    pendingOrder = await create(f.container, 33, 3, leaderOrder.pinkId);
    await f.db.insert(storeOrderRefund).values({ id: 1, storeOrderId: leaderOrder.id, uid: 11,
      orderId: "isolated-leader-refund", refundPrice: "12.50", refundNum: 2, applyType: 1 });
  }, 30_000);
  afterEach(async () => { await f?.close(); });
  const refund = (peer?: FinancePeer, id = 1) => finalizeStoreOrderRefund(peer ? createContainerFromDb(peer.db) : f.container, id);
  const cancel = (peer?: FinancePeer) => cancelStoreOrder(peer ? createContainerFromDb(peer.db) : f.container,
    { uid: 33, orderId: pendingOrder.orderId });
  const promoted = async () => {
    expect((await f.db.select().from(storeOrder).where(eq(storeOrder.id, leaderOrder.id)))[0].refundStatus).toBe(2);
    expect((await f.db.select().from(storePink).where(eq(storePink.id, successorId)))[0]).toMatchObject({ kId: 0, status: 1 });
    expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0].nowMoney).toBe("100.00");
    expect((await f.snapshot()).bills.filter(row => row.type === "pay_product_refund")).toHaveLength(1);
  };
  it("promotes the member and preserves the pending order after real create/payment/refund", async () => {
    expect(await refund()).toBe("completed");
    await promoted();
    expect((await f.db.select().from(storeOrder).where(eq(storeOrder.id, pendingOrder.id)))[0]).toMatchObject({ paid: 0, pinkId: successorId });
    expect((await f.snapshot()).products[0].stock).toBe(6);
    expect(await refund()).toBe("already-completed");
    await promoted();
  });
  it.each(["before", "after"])("restores an unpaid reservation %s leader refund without double stock", async phase => {
    if (phase === "before") await cancel();
    await refund();
    if (phase === "after") await cancel();
    await promoted();
    expect((await f.db.select().from(storeOrder).where(eq(storeOrder.id, pendingOrder.id)))[0]).toMatchObject({ paid: 0, status: -2, isDel: 1 });
    expect((await f.snapshot()).products[0].stock).toBe(7);
    expect((await f.db.select().from(storeCombination))[0]).toMatchObject({ stock: 19, quota: 19, sales: 1 });
  });
  it("refunds a member before timeout and then settles the failed group without another member credit", async () => {
    await f.db.insert(storeOrderRefund).values({ id: 2, storeOrderId: memberOrder.id, uid: 22,
      orderId: "isolated-member-refund", refundPrice: "6.25", refundNum: 1, applyType: 1 });
    expect(await refund(undefined, 2)).toBe("completed");
    expect((await f.db.select().from(storePink).where(eq(storePink.id, leaderOrder.pinkId)))[0]).toMatchObject({ memberCount: 1, status: 1 });
    await f.db.update(storePink).set({ stopTime: new Date(0) }).where(eq(storePink.id, leaderOrder.pinkId));
    expect(await new PinkTimeoutService(f.container, f.env).expireGroup(leaderOrder.pinkId))
      .toMatchObject({ expired: true, completedRefunds: 2, pendingRefunds: 0 });
    expect((await f.snapshot()).bills.filter(row => row.type === "pay_product_refund")).toHaveLength(2);
    expect((await f.db.select().from(user).where(eq(user.uid, 22)))[0].nowMoney).toBe("100.00");
    expect((await f.snapshot()).products[0].stock).toBe(7);
  });
  pg.each(["balance", "provider"])("lets an earlier %s payment finish while refund waits for its order, not its group", async mode => {
    await withFinancePeers(f.db, async ([blocker, payer, refunder]) => {
      await blocker.exec('BEGIN; SELECT uid FROM "user" WHERE uid=33 FOR UPDATE');
      const container = createContainerFromDb(payer.db);
      const paying = outcome(mode === "balance"
        ? applyStoreOrderBalancePayment(container, { uid: 33, orderId: pendingOrder.orderId })
        : applyStoreOrderPayment(container, { orderId: pendingOrder.id, payType: "weixin", tradeNo: "isolated-trade",
            authorizeBeforePayment: async tx => { await tx.select({ uid: user.uid }).from(user).where(eq(user.uid, 33)).for("update"); } }));
      await waitForFinanceBlock(f.db, payer.pid, blocker.pid);
      const refunding = outcome(refund(refunder));
      await waitForFinanceBlock(f.db, refunder.pid, payer.pid);
      await blocker.exec("COMMIT");
      expect(await paying).toMatchObject({ ok: true, value: { outcome: "paid" } });
      expect(await refunding).toEqual({ ok: true, value: "completed" });
    });
    await promoted();
    expect((await f.db.select().from(storeOrder).where(eq(storeOrder.id, pendingOrder.id)))[0]).toMatchObject({ paid: 1, pinkId: successorId });
    expect(await f.db.select().from(storeOrderOutbox)).toHaveLength(3);
  }, 20_000);
  pg("makes a later charged callback wait for promotion and pay into the successor group", async () => {
    await withFinancePeers(f.db, async ([blocker, refunder, payer]) => {
      await blocker.exec('BEGIN; SELECT uid FROM "user" WHERE uid=11 FOR UPDATE');
      const refunding = outcome(refund(refunder));
      await waitForFinanceBlock(f.db, refunder.pid, blocker.pid);
      const paying = outcome(applyStoreOrderPayment(createContainerFromDb(payer.db),
        { orderId: pendingOrder.id, payType: "weixin", tradeNo: "isolated-late-trade" }));
      await waitForFinanceBlock(f.db, payer.pid, refunder.pid);
      await blocker.exec("COMMIT");
      expect(await refunding).toEqual({ ok: true, value: "completed" });
      expect(await paying).toMatchObject({ ok: true, value: { outcome: "paid" } });
    });
    await promoted();
    expect((await f.db.select().from(storeOrder).where(eq(storeOrder.id, pendingOrder.id)))[0]).toMatchObject({ paid: 1, pinkId: successorId, tradeNo: "isolated-late-trade" });
    expect(await f.db.select().from(storeOrderOutbox)).toHaveLength(3);
  }, 20_000);
  pg("serializes an earlier actual create before refund, including its newly reserved order", async () => {
    await withFinancePeers(f.db, async ([blocker, creator, refunder]) => {
      await blocker.exec("BEGIN; SELECT id FROM store_cart WHERE id=4 FOR UPDATE");
      const creating = outcome(create(createContainerFromDb(creator.db), 44, 4, leaderOrder.pinkId));
      await waitForFinanceBlock(f.db, creator.pid, blocker.pid);
      const refunding = outcome(refund(refunder));
      await waitForFinanceBlock(f.db, refunder.pid, creator.pid);
      await blocker.exec("COMMIT");
      expect(await creating).toMatchObject({ ok: true });
      expect(await refunding).toEqual({ ok: true, value: "completed" });
    });
    await promoted();
    expect((await f.db.select().from(storeOrder).where(eq(storeOrder.uid, 44)))[0]).toMatchObject({ paid: 0, pinkId: successorId });
    expect((await f.snapshot()).products[0].stock).toBe(5);
  }, 20_000);
  pg("rejects a later create into the refunded leader and rolls back its cart and stock", async () => {
    await withFinancePeers(f.db, async ([blocker, refunder, creator]) => {
      await blocker.exec('BEGIN; SELECT uid FROM "user" WHERE uid=11 FOR UPDATE');
      const refunding = outcome(refund(refunder));
      await waitForFinanceBlock(f.db, refunder.pid, blocker.pid);
      const creating = outcome(create(createContainerFromDb(creator.db), 44, 4, leaderOrder.pinkId));
      await waitForFinanceBlock(f.db, creator.pid, refunder.pid);
      await blocker.exec("COMMIT");
      expect(await refunding).toEqual({ ok: true, value: "completed" });
      const result = await creating; expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("该团已结束");
    });
    await promoted();
    expect(await f.db.select().from(storeOrder).where(eq(storeOrder.uid, 44))).toHaveLength(0);
    expect((await f.db.select().from(storeCart).where(eq(storeCart.id, 4)))[0].isPay).toBe(0);
    expect((await f.snapshot()).products[0].stock).toBe(6);
  }, 20_000);
  pg.each(["cancel-first", "refund-first"])("does not invert inventory and pending-order locks: %s", async direction => {
    await withFinancePeers(f.db, async ([blocker, first, second]) => {
      await blocker.exec(direction === "cancel-first"
        ? "BEGIN; SELECT id FROM store_cart WHERE id=3 FOR UPDATE"
        : 'BEGIN; SELECT uid FROM "user" WHERE uid=11 FOR UPDATE');
      const a = outcome(direction === "cancel-first" ? cancel(first) : refund(first).then(() => {}));
      await waitForFinanceBlock(f.db, first.pid, blocker.pid);
      const b = outcome(direction === "cancel-first" ? refund(second).then(() => {}) : cancel(second));
      await waitForFinanceBlock(f.db, second.pid, first.pid);
      await blocker.exec("COMMIT");
      expect(await a).toMatchObject({ ok: true }); expect(await b).toMatchObject({ ok: true });
    });
    await promoted();
    expect((await f.snapshot()).products[0].stock).toBe(7);
    expect((await f.db.select().from(storeOrder).where(eq(storeOrder.id, pendingOrder.id)))[0]).toMatchObject({ status: -2, isDel: 1 });
  }, 20_000);
  pg("waits for the leader before holding a refunded member, compatible with timeout maintenance", async () => {
    await f.db.update(storePink).set({ stopTime: new Date(0) }).where(eq(storePink.id, leaderOrder.pinkId));
    await f.db.insert(storeOrderRefund).values({ id: 2, storeOrderId: memberOrder.id, uid: 22,
      orderId: "isolated-member-refund", refundPrice: "6.25", refundNum: 1, applyType: 1 });
    await withFinancePeers(f.db, async ([blocker, refunder, maintainer]) => {
      await blocker.exec(`BEGIN; SELECT id FROM store_pink WHERE id=${leaderOrder.pinkId} FOR UPDATE`);
      const refunding = outcome(refund(refunder, 2));
      await waitForFinanceBlock(f.db, refunder.pid, blocker.pid);
      // NOWAIT proves the refund has not locked the member before its leader.
      await maintainer.exec(`BEGIN; SELECT id FROM store_pink WHERE id=${successorId} FOR UPDATE NOWAIT; ROLLBACK`);
      const expiring = outcome(new PinkTimeoutService(createContainerFromDb(maintainer.db), f.env).expireGroup(leaderOrder.pinkId));
      await waitForFinanceBlock(f.db, maintainer.pid, refunder.pid);
      await blocker.exec("COMMIT");
      expect(await refunding).toEqual({ ok: true, value: "completed" });
      expect(await expiring).toMatchObject({ ok: true, value: { expired: true, completedRefunds: 2, pendingRefunds: 0 } });
    });
    expect((await f.snapshot()).products[0].stock).toBe(7);
    expect((await f.db.select().from(storeOrderRefund)).every(row => row.refundType === 6)).toBe(true);
    expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0].nowMoney).toBe("100.00");
    expect((await f.db.select().from(user).where(eq(user.uid, 22)))[0].nowMoney).toBe("100.00");
  }, 20_000);
});
