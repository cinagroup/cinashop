import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createContainerFromDb } from "../src/lib/di";
import { cancelStoreOrder, StoreOrderCreateService } from "../src/services/order/StoreOrderCreateService";
import {
  storeActivity, storeCart, storeOrder, storeOrderCartInfo, storeOrderStatus,
  storeProduct, storeProductAttrValue, storeSeckill, storeSeckillTime, printDocument, storeOrderOutbox,
} from "../src/models/schema";
import { createPcCheckoutQuoteFixture } from "./helpers/pcCheckoutQuoteFixture";
import { outcome, withFinancePeers } from "./helpers/financePeers";

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))("seckill cross-activity legacy compensation on independent PostgreSQL 16 backends", () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;

  beforeEach(async () => {
    f = await createPcCheckoutQuoteFixture([
      storeActivity, storeSeckillTime, storeSeckill, storeOrderCartInfo, storeOrderStatus, printDocument, storeOrderOutbox,
    ]);
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, "0"])));
    await f.db.update(storeCart).set({ type: 1, activityId: 20 });
    await f.db.insert(storeProductAttrValue).values({
      id: 2, productId: 20, type: 1, unique: "qatime01", suk: "红色,大号",
      stock: 7, quota: 6, price: "6.25",
    });
    const today = Math.floor((Date.now() + 28_800_000) / 86_400_000) * 86_400 - 28_800;
    await f.db.insert(storeActivity).values([
      { id: 9, type: 1, status: 1, timeId: "4", startDay: today - 86_400, endDay: today + 86_400 },
      { id: 10, type: 1, status: 1, timeId: "4", startDay: today - 86_400, endDay: today + 86_400 },
    ]);
    await f.db.insert(storeSeckillTime).values({ id: 4, startTime: "0000", endTime: "2400", status: 1 });
    await f.db.insert(storeSeckill).values([
      { id: 20, productId: 70, activityId: 9, timeId: "4", storeName: "Current order",
        stock: 7, quota: 6, onceNum: 3, num: 10, status: 1, isShow: 1, isDel: 0 },
      { id: 21, productId: 70, activityId: 10, timeId: "4", storeName: "Legacy order",
        stock: 5, quota: 5, sales: 2, onceNum: 3, num: 10, status: 1, isShow: 1, isDel: 0 },
    ]);
    await StoreOrderCreateService.createWithRuntime(f.container,
      { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => "isolated_current_cancel" },
      { uid: 11, key: "current_cancel", cartIds: [1], type: 1, seckillId: 20,
        shippingType: 1, addressId: 11, cityId: 101, realName: "Isolated buyer", userPhone: "00000000000", userIp: "127.0.0.1" });

    // The active service creates one-line seckill orders. The cancellation
    // evidence contract also admits a valid historical two-line order.
    await f.db.insert(storeProductAttrValue).values([
      { id: 4, productId: 70, type: 0, unique: "qablue01", suk: "蓝色,大号",
        stock: 7, sales: 1, price: "10.00" },
      { id: 5, productId: 21, type: 1, unique: "qablue21", suk: "蓝色,大号",
        stock: 6, quota: 6, sales: 1, price: "6.25" },
      { id: 6, productId: 21, type: 1, unique: "qared021", suk: "红色,大号",
        stock: 6, quota: 6, sales: 1, price: "6.25" },
    ]);
    await f.db.update(storeProductAttrValue)
      .set({ stock: 5, sales: 3 }).where(eq(storeProductAttrValue.id, 1));
    await f.db.update(storeProduct).set({ stock: 4, sales: 4 }).where(eq(storeProduct.id, 70));
    await f.db.insert(storeCart).values([
      { id: 3, uid: 11, productId: 70, productAttrUnique: "qablue01", cartNum: 1,
        type: 1, activityId: 21, isNew: 1, status: 1, isPay: 1 },
      { id: 4, uid: 11, productId: 70, productAttrUnique: "qared001", cartNum: 1,
        type: 1, activityId: 21, isNew: 1, status: 1, isPay: 1 },
    ]);
    await f.db.insert(storeOrder).values({
      id: 500, uid: 11, orderId: "isolated_legacy_multi", type: 1, activityId: 21,
      cartId: "3,4", totalNum: 2, totalPrice: "12.50", payPrice: "12.50",
      useIntegral: "0.00", paid: 0, status: 0, isDel: 0,
    });
    await f.db.insert(storeOrderCartInfo).values([
      { id: 10, oid: 500, uid: 11, cartId: "3", productId: 70,
        skuUnique: "qablue01", cartNum: 1, splitSurplusNum: 1, surplusNum: 1,
        cartInfo: JSON.stringify({ sku: { id: 4 }, activitySku: { id: 5 } }) },
      { id: 11, oid: 500, uid: 11, cartId: "4", productId: 70,
        skuUnique: "qared001", cartNum: 1, splitSurplusNum: 1, surplusNum: 1,
        cartInfo: JSON.stringify({ sku: { id: 1 }, activitySku: { id: 6 } }) },
    ]);
  }, 30_000);

  afterEach(async () => { await f?.close(); });

  it("retries reverse-SKU cancellation after a second-target lock conflict without partial or duplicate restoration", async () => {
    const state = async () => ({
      base: await f.db.select().from(storeProductAttrValue).orderBy(storeProductAttrValue.id),
      product: await f.db.select().from(storeProduct).orderBy(storeProduct.id),
      children: await f.db.select().from(storeSeckill).orderBy(storeSeckill.id),
      orders: await f.db.select().from(storeOrder).orderBy(storeOrder.id),
      carts: await f.db.select().from(storeCart).orderBy(storeCart.id),
      statuses: await f.db.select().from(storeOrderStatus).orderBy(storeOrderStatus.id),
    });
    const before = await state();
    await withFinancePeers(f.db, async ([holder, current, legacy]) => {
      await holder.exec("BEGIN; SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE");
      let held = true;
      try {
        // The historical order acquires its first SKU and product, then finds
        // the second SKU busy. NOWAIT must roll those first locks and all writes
        // back instead of joining the cross-activity deadlock seen on main.
        const [legacyBusy, currentBusy] = await Promise.all([
          outcome(cancelStoreOrder(createContainerFromDb(legacy.db),
            { uid: 11, orderId: "isolated_legacy_multi" })),
          outcome(cancelStoreOrder(createContainerFromDb(current.db),
            { uid: 11, orderId: "isolated_current_cancel" })),
        ]);
        expect(legacyBusy).toMatchObject({ ok: false, error: { code: 409, httpStatus: 409 } });
        expect(currentBusy).toMatchObject({ ok: false, error: { code: 409, httpStatus: 409 } });
        expect(await state()).toEqual(before);
        await holder.exec("COMMIT"); held = false;
        await cancelStoreOrder(createContainerFromDb(current.db),
          { uid: 11, orderId: "isolated_current_cancel" });
        await cancelStoreOrder(createContainerFromDb(legacy.db),
          { uid: 11, orderId: "isolated_legacy_multi" });
      } finally { if (held) await holder.exec("ROLLBACK"); }
    });
    const base = await f.db.select().from(storeProductAttrValue).orderBy(storeProductAttrValue.id);
    const product = (await f.db.select().from(storeProduct).where(eq(storeProduct.id, 70)))[0];
    const children = await f.db.select().from(storeSeckill).orderBy(storeSeckill.id);
    const orders = await f.db.select().from(storeOrder).orderBy(storeOrder.id);
    const carts = await f.db.select().from(storeCart).orderBy(storeCart.id);
    const statuses = await f.db.select().from(storeOrderStatus);
    expect(product).toMatchObject({ stock: 8, sales: 0 });
    expect(base.find(row => row.id === 1)).toMatchObject({ stock: 8, sales: 0 });
    expect(base.find(row => row.id === 2)).toMatchObject({ stock: 7, quota: 6, sales: 0 });
    expect(base.find(row => row.id === 4)).toMatchObject({ stock: 8, sales: 0 });
    expect(base.find(row => row.id === 5)).toMatchObject({ stock: 7, quota: 7, sales: 0 });
    expect(base.find(row => row.id === 6)).toMatchObject({ stock: 7, quota: 7, sales: 0 });
    expect(children).toMatchObject([
      { id: 20, stock: 7, quota: 6, sales: 0 },
      { id: 21, stock: 7, quota: 7, sales: 0 },
    ]);
    expect(orders).toMatchObject([
      { orderId: "isolated_current_cancel", status: -2, isDel: 1 },
      { orderId: "isolated_legacy_multi", status: -2, isDel: 1 },
    ]);
    expect(carts.filter(row => [1, 3, 4].includes(row.id)).every(row => row.isPay === 0)).toBe(true);
    expect(statuses.filter(row => row.changeType === "cancel")).toHaveLength(2);
    await expect(cancelStoreOrder(f.container, { uid: 11, orderId: "isolated_current_cancel" })).rejects.toThrow();
    await expect(cancelStoreOrder(f.container, { uid: 11, orderId: "isolated_legacy_multi" })).rejects.toThrow();
    expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 70)))[0])
      .toMatchObject({ stock: 8, sales: 0 });
  }, 30_000);
});
