import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createBargainSelectionFixture } from "./helpers/bargainSelectionFixture";
import { outcome, waitForFinanceBlock, waitForFinanceClock, withFinancePeers, type FinancePeer } from "./helpers/financePeers";
import { createContainerFromDb } from "../src/lib/di";
import { StoreOrderCreateService, cancelStoreOrder, type CreateOrderParams } from "../src/services/order/StoreOrderCreateService";
import { finalizeStoreOrderRefund } from "../src/services/order/StoreOrderRefundService";
import { ActivityJoinService } from "../src/services/activity/ActivityJoinService";
import { storeCart, storeBargain, storeBargainUser, systemStore, storeOrderCartInfo, storeOrderStatus, printDocument,
  storeOrder, storeOrderRefund, storeOrderRefundPayment, storeOrderInvoice, userBrokerage } from "../src/models/schema";

// Only independent PG16 backends can prove these row-wait/conditional-update races.
// Never replace with PGlite concurrency or inherit production credentials.
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))("bargain order identity across independent PG16 backends", () => {
  let f: Awaited<ReturnType<typeof createBargainSelectionFixture>>;
  const params: CreateOrderParams = { uid: 11, key: "bargain_race", cartIds: [10], type: 2, bargainUserId: 80,
    shippingType: 2, storeId: 1, realName: "隔离砍价并发", userPhone: "00000000000", userIp: "127.0.0.1" };
  beforeEach(async () => {
    f = await createBargainSelectionFixture([storeOrderCartInfo, storeOrderStatus, printDocument,
      storeOrderRefund, storeOrderRefundPayment, storeOrderInvoice, userBrokerage]);
    await f.db.update(systemStore).set({ isStore: 1 }).where(eq(systemStore.id, 1));
    await f.db.insert(storeCart).values([10, 11].map(id => ({ id, uid: 11, productId: 70,
      productAttrUnique: "qared001", cartNum: 1, type: 2, activityId: 40, isNew: 1, status: 1 })));
  }, 30_000);
  afterEach(async () => { await f?.close(); });
  const create = (peer?: FinancePeer, input = params) => StoreOrderCreateService.createWithRuntime(
    peer ? createContainerFromDb(peer.db) : f.container,
    { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => `isolated_${input.key}` }, input);
  const cancel = (peer: FinancePeer, key = params.key) => cancelStoreOrder(createContainerFromDb(peer.db), { uid: 11, orderId: `isolated_${key}` });
  const snapshot = async () => {
    const value = await f.snapshot();
    return { ...value, sequences: undefined, carts: value.carts.sort((a, b) => a.id - b.id),
      skus: value.skus.sort((a, b) => a.id - b.id), users: value.users.sort((a, b) => a.uid - b.uid),
      orders: value.orders.sort((a, b) => a.id - b.id),
      details: await f.db.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.id),
      refunds: await f.db.select().from(storeOrderRefund).orderBy(storeOrderRefund.id),
      statuses: await f.db.select().from(storeOrderStatus).orderBy(storeOrderStatus.id),
      prints: await f.db.select().from(printDocument) };
  };
  const nextParams = { ...params, key: "next_bargain", cartIds: [11], bargainUserId: 90 };
  const prepareSecond = async (paid: boolean) => {
    await create();
    if (paid) {
      const [order] = await f.db.update(storeOrder).set({ paid: 1, payType: "yue" }).returning();
      await f.db.insert(storeOrderRefund).values({ id: 1, storeOrderId: order.id, uid: 11, orderId: "isolated_bargain_refund",
        applyType: 1, refundType: 0, refundPrice: "2.00", refundNum: 1,
        cartInfo: JSON.stringify({ cartIds: [{ cartId: 10, cartNum: 1 }] }) });
    }
    await f.db.insert(storeBargainUser).values({ id: 90, bargainId: 40, uid: 11,
      bargainPrice: "10.00", bargainPriceMin: "2.00", price: "8.00", status: 3 });
  };

  const cartEdits: Array<{ label: string; values: Partial<typeof storeCart.$inferInsert> }> = [
    { label: "quantity", values: { cartNum: 2 } },
    { label: "zero quantity", values: { cartNum: 0 } },
    { label: "negative quantity", values: { cartNum: -1 } },
    { label: "SKU", values: { productAttrUnique: "qablue01" } },
    { label: "product", values: { productId: 71 } },
    { label: "product type", values: { productType: 1 } },
    { label: "activity", values: { activityId: 41 } },
    { label: "cart type", values: { type: 0 } },
    { label: "cart mode", values: { isNew: 0 } },
  ];
  it.each(cartEdits)("re-evaluates $label after an observed cart row wait and refuses the stale quote", async ({ values }) => {
    const before = await snapshot();
    await withFinancePeers(f.db, async ([editor, buyer]) => {
      await editor.exec("BEGIN");
      await editor.db.update(storeCart).set(values).where(eq(storeCart.id, 10));
      // The buyer quotes the committed old version, then waits in UPDATE is_pay.
      const pending = outcome(create(buyer)); await waitForFinanceBlock(f.db, buyer.pid, editor.pid);
      await editor.exec("COMMIT");
      expect(await pending).toMatchObject({ ok: false, error: { message: expect.stringContaining("砍价购物车已变化或被占用") } });
    });
    expect(await snapshot()).toEqual({ ...before, carts: before.carts.map(row => row.id === 10 ? { ...row, ...values } : row) });
  }, 15_000);

  it.each(["rollback", "metadata"])("allows an unchanged quote after a verified %s cart edit wait", async mode => {
    await withFinancePeers(f.db, async ([editor, buyer]) => {
      await editor.exec("BEGIN");
      await editor.db.update(storeCart).set(mode === "rollback" ? { cartNum: 2 } : { addTime: 123 }).where(eq(storeCart.id, 10));
      const pending = outcome(create(buyer)); await waitForFinanceBlock(f.db, buyer.pid, editor.pid);
      await editor.exec(mode === "rollback" ? "ROLLBACK" : "COMMIT");
      expect(await pending).toMatchObject({ ok: true });
    });
    const state = await snapshot();
    expect(state.orders).toHaveLength(1);
    expect(state.orders[0]).toMatchObject({ totalNum: 1, payPrice: "2.00", activityId: 40 });
    expect(state.carts[0]).toMatchObject({ cartNum: 1, isPay: 1 });
    if (mode === "metadata") expect(state.carts[0].addTime).toBe(123);
    expect(state.participations.find(row => row.id === 80)?.status).toBe(4);
    expect(state.skus.find(row => row.id === 3)).toMatchObject({ stock: 6, quota: 5, sales: 1 });
  }, 15_000);

  it("two carts cannot consume one exact participation twice after an observed row wait", async () => {
    await withFinancePeers(f.db, async ([blocker, first, second]) => {
      await blocker.exec("BEGIN; SELECT id FROM store_bargain_user WHERE id=80 FOR UPDATE");
      const a = outcome(create(first)); await waitForFinanceBlock(f.db, first.pid, blocker.pid);
      const b = outcome(create(second, { ...params, key: "bargain_other", cartIds: [11] }));
      await waitForFinanceBlock(f.db, second.pid, first.pid);
      await blocker.exec("COMMIT");
      expect(await a).toMatchObject({ ok: true }); expect(await b).toMatchObject({ ok: false });
    });
    const state = await snapshot(); expect(state.orders).toHaveLength(1); expect(state.details).toHaveLength(1);
    expect(JSON.parse(state.details[0].cartInfo!).bargainParticipation).toEqual({ version: 1, participantId: 80, activityId: 40, uid: 11 });
    expect(state.bargains[0]).toMatchObject({ stock: 7, quota: 7, sales: 1 });
    expect(state.carts.map(row => row.isPay)).toEqual([1, 0]);
    expect(state.participations.find(row => row.id === 80)?.status).toBe(4);
  }, 15_000);

  it("duplicate cancellation waits on the same order and restores the snapshot participation once", async () => {
    await create();
    await withFinancePeers(f.db, async ([blocker, first, second]) => {
      await blocker.exec("BEGIN; SELECT id FROM store_bargain_user WHERE id=80 FOR UPDATE");
      const a = outcome(cancel(first)); await waitForFinanceBlock(f.db, first.pid, blocker.pid);
      const b = outcome(cancel(second)); await waitForFinanceBlock(f.db, second.pid, first.pid);
      await blocker.exec("COMMIT");
      expect(await a).toMatchObject({ ok: true }); expect(await b).toMatchObject({ ok: false });
    });
    const state = await snapshot(); expect(state.bargains[0]).toMatchObject({ stock: 8, quota: 8, sales: 0 });
    expect(state.participations.find(row => row.id === 80)?.status).toBe(3);
    expect(state.participations.find(row => row.id === 83)?.status).toBe(4);
    expect(state.statuses.filter(row => row.changeType === "cancel")).toHaveLength(1);
  }, 15_000);

  it("participant ownership changed during cancellation wait causes a full compensation rollback", async () => {
    await create(); const before = await snapshot();
    await withFinancePeers(f.db, async ([blocker, canceller]) => {
      await blocker.exec("BEGIN; UPDATE store_bargain_user SET uid=22 WHERE id=80");
      const pending = outcome(cancel(canceller)); await waitForFinanceBlock(f.db, canceller.pid, blocker.pid);
      await blocker.exec("COMMIT");
      expect(await pending).toMatchObject({ ok: false, error: { message: expect.stringContaining("状态无法恢复") } });
    });
    const after = await snapshot();
    expect(after).toEqual({ ...before, participations: before.participations.map(row => row.id === 80 ? { ...row, uid: 22 } : row) });
    expect((await f.db.select().from(storeBargainUser).where(eq(storeBargainUser.id, 80)))[0].status).toBe(4);
  }, 15_000);

  it.each(["cancel", "refund"])("%s waits before SKU writes while same-activity creation holds a cart barrier", async operation => {
    await prepareSecond(operation === "refund");
    await withFinancePeers(f.db, async ([blocker, buyer, restorer]) => {
      await blocker.exec("BEGIN; SELECT id FROM store_cart WHERE id=11 FOR UPDATE");
      const pending = outcome(create(buyer, nextParams)); await waitForFinanceBlock(f.db, buyer.pid, blocker.pid);
      const restoration = operation === "cancel" ? outcome(cancel(restorer))
        : outcome(finalizeStoreOrderRefund(createContainerFromDb(restorer.db), 1));
      await waitForFinanceBlock(f.db, restorer.pid, buyer.pid);
      await blocker.exec("COMMIT");
      expect(await pending).toMatchObject({ ok: true }); expect(await restoration).toMatchObject({ ok: true });
    });
    const state = await snapshot(); expect(state.orders).toHaveLength(2);
    expect(state.bargains[0]).toMatchObject({ stock: 7, quota: 7, sales: 1 });
    expect(state.products[0]).toMatchObject({ stock: 7, sales: 1 });
    expect(state.skus.find(row => row.id === 3)).toMatchObject({ stock: 6, quota: 5, sales: 1 });
    expect(state.participations.find(row => row.id === 80)?.status).toBe(operation === "cancel" ? 3 : 4);
    expect(state.participations.find(row => row.id === 90)?.status).toBe(4);
  }, 15_000);

  it("refund does not lock settlement users while waiting behind a cancellation's activity lock", async () => {
    await prepareSecond(true); await create(undefined, nextParams);
    await withFinancePeers(f.db, async ([blocker, canceller, refunder]) => {
      await blocker.exec("BEGIN; SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE");
      const pending = outcome(cancel(canceller, nextParams.key)); await waitForFinanceBlock(f.db, canceller.pid, blocker.pid);
      const restoration = outcome(finalizeStoreOrderRefund(createContainerFromDb(refunder.db), 1));
      await waitForFinanceBlock(f.db, refunder.pid, canceller.pid);
      await f.exec('SELECT uid FROM "user" WHERE uid=11 FOR UPDATE NOWAIT');
      await blocker.exec("COMMIT");
      expect(await pending).toMatchObject({ ok: true }); expect(await restoration).toEqual({ ok: true, value: "completed" });
    });
    const state = await snapshot();
    expect(state.bargains[0]).toMatchObject({ stock: 8, quota: 8, sales: 0 });
    expect(state.products[0]).toMatchObject({ stock: 8, sales: 0 });
    expect(state.skus.find(row => row.id === 3)).toMatchObject({ stock: 7, quota: 6, sales: 0 });
    expect(state.users.find(row => row.uid === 11)?.nowMoney).toBe("2.00");
  }, 15_000);

  it.each(["participant", "activity SKU", "base SKU"])("expiry during %s lock wait rolls back the entire actual create transaction", async target => {
    const deadline = Date.now() + 2_000;
    await f.db.update(storeBargain).set({ stopTime: new Date(deadline) }).where(eq(storeBargain.id, 40));
    const before = await snapshot();
    await withFinancePeers(f.db, async ([blocker, buyer]) => {
      await blocker.exec(target === "participant" ? "BEGIN; SELECT id FROM store_bargain_user WHERE id=80 FOR UPDATE"
        : target === "activity SKU" ? "BEGIN; SELECT id FROM store_product_attr_value WHERE id=3 FOR UPDATE"
        : "BEGIN; SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE");
      const pending = outcome(create(buyer)); await waitForFinanceBlock(f.db, buyer.pid, blocker.pid);
      await waitForFinanceClock(f.db, deadline); await blocker.exec("COMMIT");
      expect(await pending).toMatchObject({ ok: false, error: { message: expect.stringContaining("砍价活动已结束") } });
    });
    expect(await snapshot()).toEqual(before);
  }, 15_000);

  it("actual help can acquire KEY SHARE while checkout owns NO KEY UPDATE", async () => {
    await withFinancePeers(f.db, async ([blocker, buyer, helper]) => {
      await blocker.exec("BEGIN; SELECT id FROM store_cart WHERE id=10 FOR UPDATE");
      const pending = outcome(create(buyer)); await waitForFinanceBlock(f.db, buyer.pid, blocker.pid);
      // A FOR UPDATE activity lock would block this real help transaction until
      // the buyer released its cart barrier. KEY SHARE compatibility must work.
      const helped = await new ActivityJoinService(createContainerFromDb(helper.db)).helpBargain(22, 81);
      expect(Number(helped.price)).toBeGreaterThan(0);
      await blocker.exec("COMMIT"); expect(await pending).toMatchObject({ ok: true });
    });
    expect((await snapshot()).helps).toHaveLength(1);
  }, 15_000);

  it("start waits for consumed participation and then permits the next legitimate participation", async () => {
    await withFinancePeers(f.db, async ([blocker, buyer, starter]) => {
      await blocker.exec("BEGIN; SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE");
      const pending = outcome(create(buyer)); await waitForFinanceBlock(f.db, buyer.pid, blocker.pid);
      const started = outcome(new ActivityJoinService(createContainerFromDb(starter.db)).startBargain(11, 40));
      await waitForFinanceBlock(f.db, starter.pid, buyer.pid); await blocker.exec("COMMIT");
      expect(await pending).toMatchObject({ ok: true }); const result = await started;
      expect(result).toMatchObject({ ok: true }); if (!result.ok) throw result.error;
      expect(result.value.id).not.toBe(80);
      expect((await snapshot()).participations.find(row => row.id === result.value.id)).toMatchObject({ uid: 11, bargainId: 40, status: 1 });
    });
  }, 15_000);
});
