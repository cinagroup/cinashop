import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createBargainSelectionFixture } from "./helpers/bargainSelectionFixture";
import { StoreOrderCreateService, cancelStoreOrder, type CreateOrderParams } from "../src/services/order/StoreOrderCreateService";
import { finalizeStoreOrderRefund } from "../src/services/order/StoreOrderRefundService";
import { storeBargain, storeCart, storeProductAttrValue, storeOrder, storeOrderCartInfo, storeOrderStatus,
  printDocument, systemStore, storeOrderRefund, storeOrderRefundPayment, storeOrderInvoice, userBrokerage } from "../src/models/schema";

describe("bargain inventory compensation on owned SQL (no provider)", () => {
  let f: Awaited<ReturnType<typeof createBargainSelectionFixture>>;
  const params: CreateOrderParams = { uid: 11, key: "bargain_inventory", cartIds: [10], type: 2, bargainUserId: 80,
    shippingType: 2, storeId: 1, realName: "隔离库存样本", userPhone: "00000000000", userIp: "127.0.0.1" };
  beforeEach(async () => {
    f = await createBargainSelectionFixture([storeOrderCartInfo, storeOrderStatus, printDocument,
      storeOrderRefund, storeOrderRefundPayment, storeOrderInvoice, userBrokerage]);
    await f.db.update(systemStore).set({ isStore: 1 }).where(eq(systemStore.id, 1));
    await f.db.insert(storeCart).values({ id: 10, uid: 11, productId: 70, productAttrUnique: "qared001",
      cartNum: 2, type: 2, activityId: 40, isNew: 1, status: 1 });
  }, 30_000);
  afterEach(async () => { await f?.close(); });
  const create = () => StoreOrderCreateService.createWithRuntime(f.container,
    { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => "isolated_bargain_inventory" }, params);
  const cancel = () => cancelStoreOrder(f.container, { uid: 11, orderId: "isolated_bargain_inventory" });
  const refund = (id = 1) => finalizeStoreOrderRefund(f.container, id);
  const snapshot = async () => {
    const state = await f.snapshot();
    return { ...state, sequences: undefined, carts: state.carts.sort((a, b) => a.id - b.id),
      skus: state.skus.sort((a, b) => a.id - b.id), users: state.users.sort((a, b) => a.uid - b.uid),
      details: await f.db.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.id),
      refunds: await f.db.select().from(storeOrderRefund).orderBy(storeOrderRefund.id),
      statuses: await f.db.select().from(storeOrderStatus).orderBy(storeOrderStatus.id) };
  };
  const prepareRefund = async (quantity = 2) => {
    await create();
    // Synthetic paid balance state only; this does not call payment/provider code.
    const [order] = await f.db.update(storeOrder).set({ paid: 1, payType: "yue" }).returning();
    await f.db.insert(storeOrderRefund).values({ id: 1, storeOrderId: order.id, uid: 11, orderId: "isolated_bargain_refund",
      applyType: 1, refundType: 0, refundPrice: (quantity * 2).toFixed(2), refundNum: quantity,
      cartInfo: JSON.stringify({ cartIds: [{ cartId: 10, cartNum: quantity }] }) });
    return order;
  };

  it.each([{ status: 0 }, { isDel: 1 }, { stopTime: new Date(1) }])("cancels an unavailable activity %j without requiring checkout admission", async values => {
    await create(); await f.db.update(storeBargain).set(values).where(eq(storeBargain.id, 40));
    await cancel(); const state = await snapshot();
    expect(state.bargains[0]).toMatchObject({ stock: 8, quota: 8, sales: 0 });
    expect(state.skus.find(row => row.id === 3)).toMatchObject({ stock: 7, quota: 6, sales: 0 });
    expect(state.participations.find(row => row.id === 80)?.status).toBe(3);
  });

  it("refunds distinct partial quantities once and does not reactivate a paid participation", async () => {
    const order = await prepareRefund(1);
    await f.db.update(storeBargain).set({ status: 0, stopTime: new Date(1) });
    expect(await refund()).toBe("completed"); let state = await snapshot();
    expect(state.bargains[0]).toMatchObject({ stock: 7, quota: 7, sales: 1 });
    expect(state.participations.find(row => row.id === 80)?.status).toBe(4);
    await f.db.insert(storeOrderRefund).values({ id: 2, storeOrderId: order.id, uid: 11, orderId: "isolated_bargain_refund_two",
      applyType: 1, refundType: 0, refundPrice: "2.00", refundNum: 1,
      cartInfo: JSON.stringify({ cartIds: [{ cartId: 10, cartNum: 1 }] }) });
    expect(await refund(2)).toBe("completed"); state = await snapshot();
    expect(state.bargains[0]).toMatchObject({ stock: 8, quota: 8, sales: 0 });
    expect(state.products[0]).toMatchObject({ stock: 8, sales: 0 });
    expect(state.skus.find(row => row.id === 3)).toMatchObject({ stock: 7, quota: 6, sales: 0 });
    expect(state.users.find(row => row.uid === 11)?.nowMoney).toBe("4.00");
    expect(state.bills.filter(row => row.type === "pay_product_refund")).toHaveLength(2);
    expect(await refund()).toBe("already-completed"); expect(await snapshot()).toEqual(state);
  });

  it.each([null, { version: 2, participantId: 80, activityId: 40, uid: 11 },
    { version: 1, participantId: 80, activityId: 41, uid: 11 }])("refuses invalid new refund identity %j with zero compensation", async identity => {
      await prepareRefund(); const [cart] = await f.db.select().from(storeOrderCartInfo);
      await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify({ ...JSON.parse(cart.cartInfo!), bargainParticipation: identity }) });
      const before = await snapshot(); await expect(refund()).rejects.toThrow("快照"); expect(await snapshot()).toEqual(before);
    });

  it.each([40, 80])("retains pre-snapshot refund activity/participation alias %s", async activityId => {
    await prepareRefund(); const [cart] = await f.db.select().from(storeOrderCartInfo);
    const value = JSON.parse(cart.cartInfo!); delete value.bargainParticipation;
    await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify(value) });
    await f.db.update(storeOrder).set({ activityId });
    expect(await refund()).toBe("completed"); expect((await snapshot()).bargains[0].stock).toBe(8);
  });

  it("does not reinterpret a valid snapshot as a participant alias when the activity main is gone", async () => {
    await prepareRefund(); await f.db.delete(storeBargain).where(eq(storeBargain.id, 40));
    expect(await refund()).toBe("completed"); const state = await snapshot();
    expect(state.bargains).toEqual([]); expect(state.skus.find(row => row.id === 3)).toMatchObject({ stock: 7, quota: 6 });
    expect(state.participations.find(row => row.id === 80)?.status).toBe(4);
  });

  it("rolls refund ledger and balance back on failed activity SKU compensation", async () => {
    await prepareRefund(); await f.db.delete(storeProductAttrValue).where(eq(storeProductAttrValue.id, 3));
    const before = await snapshot(); await expect(refund()).rejects.toThrow("库存无法完整回退"); expect(await snapshot()).toEqual(before);
  });

  it("does not restore stock for a shipped refund", async () => {
    await prepareRefund(); await f.db.update(storeOrder).set({ status: 1 });
    expect(await refund()).toBe("completed"); const state = await snapshot();
    expect(state.bargains[0]).toMatchObject({ stock: 6, quota: 6, sales: 2 });
    expect(state.users.find(row => row.uid === 11)?.nowMoney).toBe("4.00");
  });

  it("checks the activity again after actual order/snapshot writes and rolls every write back", async () => {
    // Owned schema-only trigger simulates the passage of the deadline at the
    // snapshot boundary; it is not a mock SQL executor or a production trigger.
    await f.exec(`CREATE FUNCTION expire_bargain_after_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN UPDATE store_bargain SET stop_time=(clock_timestamp() AT TIME ZONE 'UTC')-interval '1 second' WHERE id=40; RETURN NEW; END $$;
      CREATE TRIGGER expire_bargain AFTER INSERT ON store_order_cart_info FOR EACH ROW EXECUTE FUNCTION expire_bargain_after_snapshot()`);
    const before = await snapshot(); await expect(create()).rejects.toThrow("砍价活动已结束"); expect(await snapshot()).toEqual(before);
  });
});
