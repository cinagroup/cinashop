import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createContainerFromDb } from "../src/lib/di";
import { StoreOrderCreateService } from "../src/services/order/StoreOrderCreateService";
import { ensureAutomaticOrderRefund, finalizeStoreOrderRefund, StoreOrderRefundService } from "../src/services/order/StoreOrderRefundService";
import { WechatPayService } from "../src/services/wechat/WechatPayService";
import {
  storeActivity, storeCart, storeOrder, storeOrderCartInfo, storeOrderStatus,
  storeProduct, storeProductAttrValue, storeSeckill, storeSeckillTime, printDocument, storeOrderOutbox,
  storeOrderRefund, storeOrderRefundPayment, storeOrderInvoice, userBrokerage, user as userTable, userBill,
} from "../src/models/schema";
import { createPcCheckoutQuoteFixture } from "./helpers/pcCheckoutQuoteFixture";
import { outcome, withFinancePeers } from "./helpers/financePeers";

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))("seckill historical multi-line refund compensation on independent PostgreSQL 16 backends", () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;

  beforeEach(async () => {
    f = await createPcCheckoutQuoteFixture([
      storeActivity, storeSeckillTime, storeSeckill, storeOrderCartInfo, storeOrderStatus, printDocument, storeOrderOutbox,
      storeOrderRefund, storeOrderRefundPayment, storeOrderInvoice, userBrokerage,
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
      useIntegral: "0.00", paid: 1, payType: "yue", status: 0, isDel: 0,
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

  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); });

  it("rolls back a second-target inventory conflict and finalizes the same refund exactly once after retry", async () => {
    const claim = await ensureAutomaticOrderRefund(f.container, { uid: 11, orderId: "isolated_legacy_multi",
      applyType: 1, refundReason: "Local reverse-SKU refund", refundExplain: "" });
    const state = async () => ({
      base: await f.db.select().from(storeProductAttrValue).orderBy(storeProductAttrValue.id),
      product: await f.db.select().from(storeProduct).orderBy(storeProduct.id),
      children: await f.db.select().from(storeSeckill).orderBy(storeSeckill.id),
      orders: await f.db.select().from(storeOrder).orderBy(storeOrder.id),
      carts: await f.db.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.id),
      refunds: await f.db.select().from(storeOrderRefund).orderBy(storeOrderRefund.id),
      users: await f.db.select().from(userTable).orderBy(userTable.uid),
      bills: await f.db.select().from(userBill).orderBy(userBill.id),
      statuses: await f.db.select().from(storeOrderStatus).orderBy(storeOrderStatus.id),
    });
    const before = await state();
    await withFinancePeers(f.db, async ([holder, refunder]) => {
      await holder.exec("BEGIN; SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE");
      let held = true;
      try {
        const busy = await outcome(finalizeStoreOrderRefund(createContainerFromDb(refunder.db), claim.refundId));
        expect(busy).toMatchObject({ ok: false, error: { code: 409, httpStatus: 409 } });
        expect(await state()).toEqual(before);
        await holder.exec("COMMIT"); held = false;
        expect(await finalizeStoreOrderRefund(createContainerFromDb(refunder.db), claim.refundId)).toBe("completed");
        const completed = await state();
        expect(await finalizeStoreOrderRefund(createContainerFromDb(refunder.db), claim.refundId)).toBe("already-completed");
        expect(await state()).toEqual(completed);
      } finally { if (held) await holder.exec("ROLLBACK"); }
    });
    const after = await state();
    expect(after.product.find(row => row.id === 70)).toMatchObject({ stock: 6, sales: 2 });
    expect(after.base.find(row => row.id === 1)).toMatchObject({ stock: 6, sales: 2 });
    expect(after.base.find(row => row.id === 4)).toMatchObject({ stock: 8, sales: 0 });
    expect(after.base.find(row => row.id === 5)).toMatchObject({ stock: 7, quota: 7, sales: 0 });
    expect(after.base.find(row => row.id === 6)).toMatchObject({ stock: 7, quota: 7, sales: 0 });
    expect(after.children.find(row => row.id === 21)).toMatchObject({ stock: 7, quota: 7, sales: 0 });
    expect(after.orders.find(row => row.id === 500)).toMatchObject({ refundStatus: 2, refundPrice: "12.50" });
    expect(after.refunds.find(row => row.id === claim.refundId)).toMatchObject({ refundType: 6, refundedPrice: "12.50" });
    expect(after.users.find(row => row.uid === 11)?.nowMoney).toBe("12.50");
    expect(after.bills.filter(row => row.type === "pay_product_refund")).toHaveLength(1);
  }, 30_000);
  it("recovers a recorded provider SUCCESS after a seckill stock conflict without a second provider call", async () => {
    await f.db.update(storeOrder).set({ payType: "weixin", tradeNo: "local-historical-payment" })
      .where(eq(storeOrder.id, 500));
    const claim = await ensureAutomaticOrderRefund(f.container, { uid: 11, orderId: "isolated_legacy_multi",
      applyType: 1, refundReason: "Local provider recovery", refundExplain: "" });
    const request = vi.spyOn(WechatPayService.prototype, "requestRefund")
      .mockResolvedValue({ status: "SUCCESS", providerRefundId: "local-historical-refund" });
    const query = vi.spyOn(WechatPayService.prototype, "queryRefund")
      .mockRejectedValue(Error("A known provider success must not be queried"));
    const business = async () => ({
      base: await f.db.select().from(storeProductAttrValue).orderBy(storeProductAttrValue.id),
      product: await f.db.select().from(storeProduct).orderBy(storeProduct.id),
      children: await f.db.select().from(storeSeckill).orderBy(storeSeckill.id),
      orders: await f.db.select().from(storeOrder).orderBy(storeOrder.id),
      carts: await f.db.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.id),
      refunds: await f.db.select().from(storeOrderRefund).orderBy(storeOrderRefund.id),
      users: await f.db.select().from(userTable).orderBy(userTable.uid),
      bills: await f.db.select().from(userBill).orderBy(userBill.id),
      statuses: await f.db.select().from(storeOrderStatus).orderBy(storeOrderStatus.id),
    });
    const before = await business();
    await withFinancePeers(f.db, async ([holder]) => {
      await holder.exec("BEGIN; SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE");
      let held = true;
      try {
        const busy = await outcome(new StoreOrderRefundService(f.container, f.env).agreeRefund(claim.refundId));
        expect(busy).toMatchObject({ ok: false, error: { code: 409, httpStatus: 409 } });
        expect(await business()).toEqual(before);
        expect(request).toHaveBeenCalledTimes(1);
        expect(query).not.toHaveBeenCalled();
        const [payment] = await f.db.select().from(storeOrderRefundPayment);
        expect(payment).toMatchObject({ providerStatus: "SUCCESS", requestAmount: 1250,
          totalAmount: 1250, attemptCount: 1 });
        await holder.exec("COMMIT"); held = false;
        const recovered = new StoreOrderRefundService(f.container, f.env);
        expect(await recovered.reconcilePendingRefunds()).toMatchObject({ checked: 1, completed: 1, errors: 0 });
        expect(request).toHaveBeenCalledTimes(1);
        expect(query).not.toHaveBeenCalled();
        expect((await f.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id, claim.refundId)))[0])
          .toMatchObject({ refundType: 6, refundedPrice: "12.50" });
        expect(await recovered.reconcilePendingRefunds()).toMatchObject({ checked: 0, completed: 0, errors: 0 });
      } finally { if (held) await holder.exec("ROLLBACK"); }
    });
  }, 30_000);});