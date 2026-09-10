import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createPcCheckoutQuoteFixture } from "./helpers/pcCheckoutQuoteFixture";
import { StoreCartService } from "../src/services/order/StoreCartService";
import { cancelStoreOrder, StoreOrderCreateService, type CreateOrderParams } from "../src/services/order/StoreOrderCreateService";
import { assertSeckillSchedule, loadSeckillSchedule } from "../src/services/activity/SeckillScheduleService";
import * as schedulePolicy from "../src/services/activity/SeckillScheduleService";
import { finalizeStoreOrderRefund } from "../src/services/order/StoreOrderRefundService";
import { storeActivity, storeSeckillTime, storeSeckill, storeProduct, storeProductAttrValue, systemStore,
  storeCart, storeOrder, storeOrderCartInfo, storeOrderStatus, printDocument, storeOrderRefund, storeOrderRefundPayment,
  storeOrderInvoice, userBrokerage, user, userBill } from "../src/models/schema";

/** Real cart, quote and order SQL. Only the external Sequence DO is replaced; no payment/provider. */
describe("seckill schedule admission on disposable SQL", () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  let initialBaseSku: typeof storeProductAttrValue.$inferSelect;
  let initialProduct: typeof storeProduct.$inferSelect;
  const params: CreateOrderParams = { uid: 11, key: "schedule_order", cartIds: [1], type: 1, seckillId: 20,
    shippingType: 2, storeId: 1, realName: "隔离秒杀样本", userPhone: "00000000000", userIp: "127.0.0.1" };
  const cartParams = { uid: 11, productId: 70, activityId: 20, type: 1, unique: "qatime01", cartNum: 1, isNew: 1 };
  const today = () => Math.floor((Date.now() + 28_800_000) / 86_400_000) * 86_400 - 28_800;
  beforeAll(async () => {
    f = await createPcCheckoutQuoteFixture([storeActivity, storeSeckillTime, storeSeckill, storeOrderCartInfo, storeOrderStatus, printDocument,
      storeOrderRefund, storeOrderRefundPayment, storeOrderInvoice, userBrokerage]);
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
    await f.db.update(systemStore).set({ isStore: 1 });
    [initialBaseSku] = await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1));
    [initialProduct] = await f.db.select().from(storeProduct).where(eq(storeProduct.id, 70));
  }, 30_000);
  beforeEach(async () => {
    f.cache.clear(); f.writes.length = 0;
    for (const table of [storeActivity, storeSeckillTime, storeSeckill, storeOrder, storeOrderCartInfo, storeOrderStatus, printDocument,
      storeOrderRefund, storeOrderRefundPayment, storeOrderInvoice, userBrokerage, userBill]) await f.db.delete(table);
    await f.db.update(user).set({ nowMoney: "0.00", integral: 100 });
    await f.db.delete(storeCart);
    await f.db.insert(storeCart).values({ id: 1, uid: 11, productId: 70, productAttrUnique: "qared001", cartNum: 2,
      activityId: 20, type: 1, isNew: 1, status: 1 });
    await f.exec("select setval(pg_get_serial_sequence('store_cart', 'id'), 1)");
    await f.db.update(storeProduct).set({ ...initialProduct, stock: 8, sales: 0 }).where(eq(storeProduct.id, 70));
    await f.db.delete(storeProductAttrValue).where(eq(storeProductAttrValue.type, 1));
    await f.db.update(storeProductAttrValue).set({ ...initialBaseSku, stock: 8, sales: 0 }).where(eq(storeProductAttrValue.id, 1));
    await f.db.insert(storeProductAttrValue).values({ id: 2, productId: 20, type: 1, unique: "qatime01", suk: "红色,大号",
      stock: 7, quota: 6, price: "6.25" });
    await f.db.insert(storeActivity).values({ id: 9, type: 1, status: 1, timeId: "4,8", startDay: today() - 86_400, endDay: today() + 86_400 });
    await f.db.insert(storeSeckillTime).values([{ id: 4, startTime: "0000", endTime: "2400", status: 1 },
      { id: 8, startTime: "00:00", endTime: "24:00", status: 0 }]);
    await f.db.insert(storeSeckill).values({ id: 20, productId: 70, activityId: 9, timeId: "4,8", storeName: "隔离秒杀",
      stock: 7, quota: 6, onceNum: 3, num: 10, status: 1, isShow: 1, isDel: 0 });
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  afterAll(async () => { await f?.close(); });
  const snapshot = async () => ({ ...await f.snapshot(), children: await f.db.select().from(storeSeckill),
    details: await f.db.select().from(storeOrderCartInfo), statuses: await f.db.select().from(storeOrderStatus),
    prints: await f.db.select().from(printDocument) });
  const quote = () => new StoreOrderCreateService(f.container, f.env).quoteOrder(params);
  const create = (nextOrderId = async () => "local_schedule_order") =>
    StoreOrderCreateService.createWithRuntime(f.container, { CONFIG_KV: f.env.CONFIG_KV, nextOrderId }, params);
  const prepareRefund = async () => {
    await create();
    const [order] = await f.db.update(storeOrder).set({ paid: 1, payType: "yue" }).returning();
    await f.db.insert(storeOrderRefund).values({ id: 1, storeOrderId: order.id, uid: 11, orderId: "isolated_refund",
      applyType: 1, refundType: 0, refundPrice: "12.50", refundNum: 2, cartInfo: JSON.stringify({ cartIds: [{ cartId: 1, cartNum: 2 }] }) });
  };
  const refundSnapshot = async () => ({ ...await snapshot(), refunds: await f.db.select().from(storeOrderRefund),
    invoices: await f.db.select().from(storeOrderInvoice), brokerage: await f.db.select().from(userBrokerage) });

  it.each(["parent-disabled", "child-ended", "child-missing"])("finalizes an isolated balance refund despite %s and replays without effects", async target => {
    await prepareRefund(); // Synthetic paid state, not a real payment/provider call.
    if (target === "parent-disabled") await f.db.update(storeActivity).set({ status: 0 });
    if (target === "child-ended") await f.db.update(storeSeckill).set({ stopTime: new Date(Date.now() - 172_800_000) });
    if (target === "child-missing") await f.db.delete(storeSeckill);
    expect(await finalizeStoreOrderRefund(f.container, 1)).toBe("completed");
    const state = await refundSnapshot();
    expect(state.products[0]).toMatchObject({ stock: 8, sales: 0 });
    expect(state.skus.find(sku => sku.id === 1)).toMatchObject({ stock: 8, sales: 0 });
    expect(state.skus.find(sku => sku.id === 2)).toMatchObject({ stock: 7, quota: 6, sales: 0 });
    if (target === "child-missing") expect(state.children).toEqual([]);
    else expect(state.children[0]).toMatchObject({ stock: 7, quota: 6, sales: 0 });
    expect(state.users[0].nowMoney).toBe("12.50");
    expect(state.bills.filter(bill => bill.type === "pay_product_refund")).toHaveLength(1);
    expect(state.refunds[0]).toMatchObject({ refundType: 6, refundedPrice: "12.50" });
    expect(await finalizeStoreOrderRefund(f.container, 1)).toBe("already-completed");
    expect(await refundSnapshot()).toEqual(state);
  });
  it("rolls back refund, balances, snapshots and all stock on a late missing activity SKU", async () => {
    await prepareRefund();
    await f.db.delete(storeProductAttrValue).where(eq(storeProductAttrValue.id, 2));
    const before = await refundSnapshot();
    await expect(finalizeStoreOrderRefund(f.container, 1)).rejects.toThrow("无法完整回退");
    expect(await refundSnapshot()).toEqual(before);
  });
  it("does not restore inventory for an already dispatched seckill order refund", async () => {
    await prepareRefund();
    await f.db.update(storeOrder).set({ status: 1 });
    const before = await refundSnapshot();
    expect(await finalizeStoreOrderRefund(f.container, 1)).toBe("completed");
    const after = await refundSnapshot();
    expect(after.products).toEqual(before.products); expect(after.skus).toEqual(before.skus);
    expect(after.children).toEqual(before.children); expect(after.users[0].nowMoney).toBe("12.50");
  });

  it.each(["parent-disabled", "slot-disabled", "child-ended", "parent-missing", "child-missing"])(
    "cancels an existing order and restores stock even when %s", async target => {
      const original = await snapshot();
      await create();
      if (target === "parent-disabled") await f.db.update(storeActivity).set({ status: 0 });
      if (target === "slot-disabled") await f.db.update(storeSeckillTime).set({ status: 0 });
      if (target === "child-ended") await f.db.update(storeSeckill).set({ stopTime: new Date(Date.now() - 172_800_000) });
      if (target === "parent-missing") await f.db.delete(storeActivity);
      if (target === "child-missing") await f.db.delete(storeSeckill);
      await cancelStoreOrder(f.container, { uid: 11, orderId: "local_schedule_order" });
      const state = await snapshot();
      expect(state.products).toEqual(original.products); expect(state.skus).toEqual(original.skus);
      expect(state.users).toEqual(original.users); expect(state.bills).toEqual(original.bills);
      expect(state.carts).toEqual(original.carts);
      expect(state.orders).toHaveLength(1); expect(state.orders[0]).toMatchObject({ status: -2, isDel: 1, paid: 0 });
      expect(state.details).toHaveLength(1); expect(state.statuses.filter(row => row.changeType === "cancel")).toHaveLength(1);
      if (target === "child-missing") expect(state.children).toEqual([]);
      else expect(state.children[0]).toMatchObject({ stock: 7, quota: 6, sales: 0 });
      await expect(cancelStoreOrder(f.container, { uid: 11, orderId: "local_schedule_order" })).rejects.toThrow("不允许取消");
      expect(await snapshot()).toEqual(state);
    });
  it.each(["paid", "other-owner", "missing-activity-sku"])("cancellation failure for %s rolls back all business changes", async target => {
    await create();
    if (target === "paid") await f.db.update(storeOrder).set({ paid: 1 });
    if (target === "missing-activity-sku") await f.db.delete(storeProductAttrValue).where(eq(storeProductAttrValue.id, 2));
    const before = await snapshot();
    await expect(cancelStoreOrder(f.container, { uid: target === "other-owner" ? 22 : 11, orderId: "local_schedule_order" })).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
  it("returns retired base SKU stock without increasing the visible product stock", async () => {
    await create();
    await f.db.update(storeProductAttrValue).set({ isRetired: 1 }).where(eq(storeProductAttrValue.id, 1));
    await cancelStoreOrder(f.container, { uid: 11, orderId: "local_schedule_order" });
    const state = await snapshot();
    expect(state.products[0]).toMatchObject({ stock: 6, sales: 0 });
    expect(state.skus.find(sku => sku.id === 1)).toMatchObject({ stock: 8, sales: 0, isRetired: 1 });
    expect(state.skus.find(sku => sku.id === 2)).toMatchObject({ stock: 7, quota: 6, sales: 0 });
    expect(state.children[0]).toMatchObject({ stock: 7, quota: 6, sales: 0 });
  });

  it.each(["claimed", "once-limit", "child-quota", "parent-disabled"])(
    "refuses quantity edits for %s without writes", async target => {
      if (target === "claimed") await f.db.update(storeCart).set({ isPay: 1 });
      if (target === "once-limit") await f.db.update(storeSeckill).set({ onceNum: 1 });
      if (target === "child-quota") await f.db.update(storeSeckill).set({ quota: 1 });
      if (target === "parent-disabled") await f.db.update(storeActivity).set({ status: 0 });
      const before = await snapshot();
      await expect(new StoreCartService(f.container).setNum(11, 1, 3)).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    });

  it("loads bounded schedule fields and locks them inside the actual SQL transaction without writes", async () => {
    const before = await snapshot();
    const unlocked = await loadSeckillSchedule(f.db, 20);
    const locked = await f.db.transaction(tx => loadSeckillSchedule(tx, 20, true));
    expect(locked).toEqual(unlocked); expect(assertSeckillSchedule(locked).activeSlotIds).toEqual([4]);
    expect(Object.keys(locked.child).sort()).toEqual(["id", "activityId", "productId", "status", "isShow", "isDel", "timeId", "startTime", "stopTime"].sort());
    expect(locked.slots.map(slot => slot.id)).toEqual([4, 8]);
    expect(await snapshot()).toEqual(before);
  });
  it.each([0, -1, 1.5, NaN, Infinity, 32768])("rejects invalid quantity %s without writes", async quantity => {
    const before = await snapshot();
    await expect(new StoreCartService(f.container).setNum(11, 1, quantity)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
  it.each(["other-owner", "deleted", "inactive", "staff", "tourist", "store", "product-hidden", "product-unapproved",
    "product-stock", "base-stock", "activity-stock", "activity-quota", "child-stock", "zero-once", "zero-total",
    "base-retired", "activity-retired", "wrong-product", "missing-child", "empty-sku"])(
    "rejects quantity change for %s without touching business state", async target => {
      if (target === "other-owner") await f.db.update(storeCart).set({ uid: 12 });
      if (target === "deleted") await f.db.update(storeCart).set({ isDel: 1 });
      if (target === "inactive") await f.db.update(storeCart).set({ status: 0 });
      if (target === "staff") await f.db.update(storeCart).set({ staffId: 9 });
      if (target === "tourist") await f.db.update(storeCart).set({ touristUid: "isolated" });
      if (target === "store") await f.db.update(storeCart).set({ storeId: 9 });
      if (target === "product-hidden") await f.db.update(storeProduct).set({ isShow: 0 });
      if (target === "product-unapproved") await f.db.update(storeProduct).set({ isVerify: 0 });
      if (target === "product-stock") await f.db.update(storeProduct).set({ stock: 1 });
      if (target === "base-stock") await f.db.update(storeProductAttrValue).set({ stock: 1 }).where(eq(storeProductAttrValue.id, 1));
      if (target === "activity-stock") await f.db.update(storeProductAttrValue).set({ stock: 1 }).where(eq(storeProductAttrValue.id, 2));
      if (target === "activity-quota") await f.db.update(storeProductAttrValue).set({ quota: 1 }).where(eq(storeProductAttrValue.id, 2));
      if (target === "child-stock") await f.db.update(storeSeckill).set({ stock: 1 });
      if (target === "zero-once") await f.db.update(storeSeckill).set({ onceNum: 0 });
      if (target === "zero-total") await f.db.update(storeSeckill).set({ num: 0 });
      if (target === "base-retired") await f.db.update(storeProductAttrValue).set({ isRetired: 1 }).where(eq(storeProductAttrValue.id, 1));
      if (target === "activity-retired") await f.db.update(storeProductAttrValue).set({ isRetired: 1 }).where(eq(storeProductAttrValue.id, 2));
      if (target === "wrong-product") await f.db.update(storeSeckill).set({ productId: 99 });
      if (target === "missing-child") await f.db.delete(storeSeckill);
      if (target === "empty-sku") await f.db.update(storeCart).set({ productAttrUnique: "" });
      const before = await snapshot();
      await expect(new StoreCartService(f.container).setNum(11, 1, 3)).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    });
  it.each(["qared001", "qatime01"])("changes quantity with %s identity without reserving inventory", async unique => {
    await f.db.update(storeCart).set({ productAttrUnique: unique });
    const before = await snapshot();
    await new StoreCartService(f.container).setNum(11, 1, 3);
    expect(await snapshot()).toEqual({ ...before, carts: before.carts.map(cart => ({ ...cart, cartNum: 3 })) });
  });
  it.each([
    { paid: 1, isDel: 0, pid: 0, counted: true },
    { paid: 1, isDel: 1, pid: -1, counted: true },
    { paid: 0, isDel: 0, pid: -1, counted: true },
    { paid: 0, isDel: 1, pid: 0, counted: false },
    { paid: 1, isDel: 0, pid: 99, counted: false },
  ])("uses PHP cumulative purchase scope $paid/$isDel/$pid", async ({ counted, ...order }) => {
    await f.db.insert(storeOrder).values({ ...order, uid: 11, orderId: "isolated_prior", type: 1, activityId: 20, totalNum: 8 });
    const before = await snapshot(), change = new StoreCartService(f.container).setNum(11, 1, 3);
    if (counted) { await expect(change).rejects.toThrow("累计限购"); expect(await snapshot()).toEqual(before); }
    else { await change; expect(await snapshot()).toEqual({ ...before, carts: before.carts.map(cart => ({ ...cart, cartNum: 3 })) }); }
  });
  it("rejects quantity editing after real order creation and preserves its inventory and snapshots", async () => {
    await create();
    const before = await snapshot();
    await expect(new StoreCartService(f.container).setNum(11, 1, 3)).rejects.toThrow("已下单");
    expect(await snapshot()).toEqual(before);
  });
  it("invalidates in-flight order pricing after a successful quantity edit", async () => {
    let before: Awaited<ReturnType<typeof snapshot>> | undefined;
    await expect(create(async () => {
      await new StoreCartService(f.container).setNum(11, 1, 3);
      before = await snapshot();
      return "isolated_stale_quantity";
    })).rejects.toThrow(/已变化|被占用/);
    expect(await snapshot()).toEqual(before);
    await create();
    expect((await snapshot()).orders[0]).toMatchObject({ totalNum: 3, payPrice: "18.75" });
  });
  it("refuses a quantity write when the database clock has passed the checked window", async () => {
    const current = Math.floor(Date.now() / 1000) * 1000 + 123;
    await f.db.update(storeSeckill).set({ stopTime: new Date(current - 10_000) });
    const before = await snapshot();
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(current - 60_000);
    const realAssert = schedulePolicy.assertSeckillSchedule;
    let evaluations = 0;
    vi.spyOn(schedulePolicy, "assertSeckillSchedule").mockImplementation((...args) => {
      const result = realAssert(...args);
      if (++evaluations === 2) vi.useRealTimers();
      return result;
    });
    await expect(new StoreCartService(f.container).setNum(11, 1, 3)).rejects.toThrow("时段已结束");
    expect(evaluations).toBe(2); expect(await snapshot()).toEqual(before);
  });
  it.each(["parent-disabled", "parent-deleted", "parent-missing", "parent-wrong-type", "parent-future", "parent-ended",
    "child-future", "child-ended", "slots-disabled", "slots-missing", "slots-disjoint", "slots-invalid", "slots-overnight", "clock-outside"])(
    "rejects %s consistently in add, cart validation, quote and create without effects", async scenario => {
      if (scenario === "parent-disabled") await f.db.update(storeActivity).set({ status: 0 });
      if (scenario === "parent-deleted") await f.db.update(storeActivity).set({ isDel: 1 });
      if (scenario === "parent-missing") await f.db.delete(storeActivity);
      if (scenario === "parent-wrong-type") await f.db.update(storeActivity).set({ type: 2 });
      if (scenario === "parent-future") await f.db.update(storeActivity).set({ startDay: today() + 86_400, endDay: today() + 172_800 });
      if (scenario === "parent-ended") await f.db.update(storeActivity).set({ startDay: today() - 172_800, endDay: today() - 86_400 });
      if (scenario === "child-future") await f.db.update(storeSeckill).set({ startTime: new Date(Date.now() + 86_400_000) });
      if (scenario === "child-ended") await f.db.update(storeSeckill).set({ stopTime: new Date(Date.now() - 172_800_000) });
      if (scenario === "slots-disabled") await f.db.update(storeSeckillTime).set({ status: 0 });
      if (scenario === "slots-missing") await f.db.delete(storeSeckillTime);
      if (scenario === "slots-disjoint") await f.db.update(storeActivity).set({ timeId: "12" });
      if (scenario === "slots-invalid") await f.db.update(storeSeckill).set({ timeId: "4,invalid" });
      if (scenario === "slots-overnight") await f.db.update(storeSeckillTime).set({ startTime: "2200", endTime: "0200" });
      if (scenario === "clock-outside") {
        await f.db.update(storeSeckillTime).set({ startTime: "08:00", endTime: "09:00" });
        vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(today() * 1000 + 9 * 3_600_000));
      }
      const before = await snapshot(), allocate = vi.fn(async () => "must_not_allocate");
      const cart = new StoreCartService(f.container);
      await expect(cart.add(cartParams)).rejects.toThrow();
      await expect(cart.setNum(11, 1, 3)).rejects.toThrow();
      await expect(cart.list(11, { mode: "buy", ids: [1] })).rejects.toThrow("已失效");
      expect(await cart.list(11)).toMatchObject([{ id: 1, isValid: false }]);
      await expect(quote()).rejects.toThrow(); await expect(create(allocate)).rejects.toThrow();
      expect(allocate).not.toHaveBeenCalled(); expect(await snapshot()).toEqual(before);
    });
  it("keeps the PHP final calendar day available in both add and quote, including HHmm slots", async () => {
    await f.db.update(storeSeckill).set({ stopTime: new Date(today() * 1000) });
    await f.db.update(storeActivity).set({ endDay: today() });
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(today() * 1000 + 20 * 3_600_000));
    const before = await snapshot();
    expect(await quote()).toMatchObject({ totalCents: 1250, totalNum: 2 });
    expect(await snapshot()).toEqual(before);
    expect(await new StoreCartService(f.container).add(cartParams)).toMatchObject({ cartNum: 1 });
  });
  it.each(["parent-disabled", "slot-disabled", "child-reparented", "child-ended"])(
    "rechecks %s after preflight pricing but before transaction admission", async scenario => {
      expect(await quote()).toMatchObject({ totalCents: 1250 });
      let before: Awaited<ReturnType<typeof snapshot>> | undefined;
      const allocate = vi.fn(async () => {
        if (scenario === "parent-disabled") await f.db.update(storeActivity).set({ status: 0 });
        if (scenario === "slot-disabled") await f.db.update(storeSeckillTime).set({ status: 0 });
        if (scenario === "child-reparented") await f.db.update(storeSeckill).set({ activityId: 99 });
        if (scenario === "child-ended") await f.db.update(storeSeckill).set({ stopTime: new Date(Date.now() - 172_800_000) });
        before = await snapshot();
        return "local_rechecked_order";
      });
      await expect(create(allocate)).rejects.toThrow(/秒杀父活动不存在或已停用|秒杀没有有效的启用时段|秒杀已结束|秒杀父子排期配置不一致/);
      expect(allocate).toHaveBeenCalledOnce();
      expect(await snapshot()).toEqual(before);
    });
  it("rejects at SQL reservation when wall clock moves past the previously evaluated window", async () => {
    const current = Math.floor(Date.now() / 1000) * 1000 + 123;
    await f.db.update(storeSeckill).set({ stopTime: new Date(current - 10_000) });
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(current - 60_000);
    expect(await quote()).toMatchObject({ totalCents: 1250 });
    const before = await snapshot(), allocate = vi.fn(async () => "local_expired_order");
    // PGlite shares the JS clock. Restore real time AFTER the real policy's final
    // evaluation, BEFORE its unchanged UPDATE executes. PG16 has its own clock.
    const realAssert = schedulePolicy.assertSeckillSchedule;
    let evaluations = 0;
    vi.spyOn(schedulePolicy, "assertSeckillSchedule").mockImplementation((...args) => {
      const result = realAssert(...args);
      if (++evaluations === 3) vi.useRealTimers();
      return result;
    });
    await expect(create(allocate)).rejects.toThrow("秒杀库存不足");
    expect(evaluations).toBe(3);
    expect(allocate).toHaveBeenCalledOnce(); expect(await snapshot()).toEqual(before);
  });
  it.each(["once-limit", "total-limit", "activity-price", "activity-retired", "base-retired", "cart-quantity",
    "activity-cost", "activity-identity", "activity-label", "activity-settlement", "activity-reward",
    "base-identity", "base-label", "base-weight", "base-price", "base-delivery", "base-validity",
    "child-postage", "child-reward", "child-form", "cart-sku", "cart-activity", "cart-mode",
    "product-hidden", "product-unapproved", "product-supplier", "product-refund", "product-type"])(
    "rolls back when %s changes after pricing and before transaction writes", async target => {
      let before: Awaited<ReturnType<typeof snapshot>> | undefined;
      const allocate = vi.fn(async () => {
        if (target === "once-limit") await f.db.update(storeSeckill).set({ onceNum: 1 });
        if (target === "total-limit") await f.db.update(storeSeckill).set({ num: 1 });
        if (target === "activity-price") await f.db.update(storeProductAttrValue).set({ price: "9.99" }).where(eq(storeProductAttrValue.id, 2));
        if (target === "activity-retired") await f.db.update(storeProductAttrValue).set({ isRetired: 1 }).where(eq(storeProductAttrValue.id, 2));
        if (target === "base-retired") await f.db.update(storeProductAttrValue).set({ isRetired: 1 }).where(eq(storeProductAttrValue.id, 1));
        if (target === "cart-quantity") await f.db.update(storeCart).set({ cartNum: 3 });
        if (target === "activity-cost") await f.db.update(storeProductAttrValue).set({ cost: "1.23" }).where(eq(storeProductAttrValue.id, 2));
        if (target === "activity-identity") await f.db.update(storeProductAttrValue).set({ unique: "changed1" }).where(eq(storeProductAttrValue.id, 2));
        if (target === "activity-label") await f.db.update(storeProductAttrValue).set({ suk: "替换规格" }).where(eq(storeProductAttrValue.id, 2));
        if (target === "activity-settlement") await f.db.update(storeProductAttrValue).set({ settlePrice: "1.23" }).where(eq(storeProductAttrValue.id, 2));
        if (target === "activity-reward") await f.db.update(storeProductAttrValue).set({ integral: 9 }).where(eq(storeProductAttrValue.id, 2));
        if (target === "base-identity") await f.db.update(storeProductAttrValue).set({ unique: "changed2" }).where(eq(storeProductAttrValue.id, 1));
        if (target === "base-label") await f.db.update(storeProductAttrValue).set({ suk: "替换规格" }).where(eq(storeProductAttrValue.id, 1));
        if (target === "base-weight") await f.db.update(storeProductAttrValue).set({ weight: "9.00" }).where(eq(storeProductAttrValue.id, 1));
        if (target === "base-price") await f.db.update(storeProductAttrValue).set({ price: "99.00" }).where(eq(storeProductAttrValue.id, 1));
        if (target === "base-delivery") await f.db.update(storeProductAttrValue).set({ diskInfo: "isolated new delivery definition" }).where(eq(storeProductAttrValue.id, 1));
        if (target === "base-validity") await f.db.update(storeProductAttrValue).set({ writeDays: 9 }).where(eq(storeProductAttrValue.id, 1));
        if (target === "child-postage") await f.db.update(storeSeckill).set({ postage: "8.00" });
        if (target === "child-reward") await f.db.update(storeSeckill).set({ giveIntegral: "9" });
        if (target === "child-form") await f.db.update(storeSeckill).set({ systemFormId: 99 });
        if (target === "cart-sku") await f.db.update(storeCart).set({ productAttrUnique: "changed3" });
        if (target === "cart-activity") await f.db.update(storeCart).set({ activityId: 99 });
        if (target === "cart-mode") await f.db.update(storeCart).set({ isNew: 0 });
        if (target === "product-hidden") await f.db.update(storeProduct).set({ isShow: 0 });
        if (target === "product-unapproved") await f.db.update(storeProduct).set({ isVerify: 0 });
        if (target === "product-supplier") await f.db.update(storeProduct).set({ relationId: 99 });
        if (target === "product-refund") await f.db.update(storeProduct).set({ isSupportRefund: 0 });
        if (target === "product-type") await f.db.update(storeProduct).set({ productType: 3 });
        before = await snapshot();
        return "local_changed_rules_order";
      });
      await expect(create(allocate)).rejects.toThrow(/已变化|被占用/);
      expect(allocate).toHaveBeenCalledOnce(); expect(await snapshot()).toEqual(before);
    });
  it("allows a fresh confirmation at the changed price and preserves idempotency after later rule changes", async () => {
    expect(await quote()).toMatchObject({ payCents: 1250 });
    await expect(create(async () => {
      await f.db.update(storeProductAttrValue).set({ price: "7.50" }).where(eq(storeProductAttrValue.id, 2));
      return "local_stale_price_order";
    })).rejects.toThrow("已变化");
    expect(await quote()).toMatchObject({ payCents: 1500 });
    const result = await create();
    expect((await snapshot()).orders[0]).toMatchObject({ payPrice: "15.00", totalNum: 2 });
    await f.db.update(storeSeckill).set({ onceNum: 1, num: 1 });
    expect(await create()).toEqual(result);
    expect((await snapshot()).orders).toHaveLength(1);
  });
  it("rejects unapproved seckill base products before quoting or allocating an order ID", async () => {
    await f.db.update(storeProduct).set({ isVerify: 0 });
    const before = await snapshot(), allocate = vi.fn(async () => "must_not_allocate");
    await expect(quote()).rejects.toThrow("未审核通过");
    await expect(create(allocate)).rejects.toThrow("未审核通过");
    expect(allocate).not.toHaveBeenCalled(); expect(await snapshot()).toEqual(before);
  });
  it("does not reject unrelated inventory changes when the current stock and quota still suffice", async () => {
    await create(async () => {
      await f.db.update(storeSeckill).set({ stock: 6, quota: 5, sales: 1 });
      await f.db.update(storeProductAttrValue).set({ stock: 6, quota: 5, sales: 1 }).where(eq(storeProductAttrValue.id, 2));
      await f.db.update(storeProductAttrValue).set({ stock: 7, sales: 1 }).where(eq(storeProductAttrValue.id, 1));
      await f.db.update(storeProduct).set({ stock: 7, sales: 1 });
      return "local_current_stock_order";
    });
    const result = await snapshot();
    expect(result.orders).toHaveLength(1);
    expect(result.children[0]).toMatchObject({ stock: 4, quota: 3, sales: 3 });
    expect(result.skus.find(sku => sku.id === 2)).toMatchObject({ stock: 4, quota: 3, sales: 3 });
    expect(result.products[0]).toMatchObject({ stock: 5, sales: 3 });
  });
  it("creates exactly one order during admission and preserves idempotent replay after the parent is stopped", async () => {
    const before = await snapshot(), result = await create();
    expect(result).toEqual({ key: params.key, orderId: "local_schedule_order" });
    const after = await snapshot();
    expect(after.orders).toHaveLength(1); expect(after.details).toHaveLength(1);
    expect(after.orders[0]).toMatchObject({ type: 1, activityId: 20, totalNum: 2, payPrice: "12.50", paid: 0 });
    expect(after.products[0].stock).toBe(before.products[0].stock - 2);
    expect(after.skus.find(sku => sku.id === 1)?.stock).toBe(6);
    expect(after.skus.find(sku => sku.id === 2)).toMatchObject({ stock: 5, quota: 4 });
    expect(after.children[0]).toMatchObject({ stock: 5, quota: 4 });
    expect(after.carts[0].isPay).toBe(1); expect(after.users).toEqual(before.users); expect(after.bills).toEqual(before.bills);
    await f.db.update(storeActivity).set({ status: 0 });
    const allocate = vi.fn(async () => "must_not_allocate");
    expect(await create(allocate)).toEqual(result); expect(allocate).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(after);
  });
  it.each(["activity-sku", "base-sku"])("rolls back cart, seckill stock and any inserted order after a later %s stock failure", async target => {
    let before: Awaited<ReturnType<typeof snapshot>> | undefined;
    const allocate = vi.fn(async () => {
      await f.db.update(storeProductAttrValue).set({ stock: 0 }).where(eq(storeProductAttrValue.id, target === "activity-sku" ? 2 : 1));
      before = await snapshot();
      return "local_rollback_order";
    });
    await expect(create(allocate)).rejects.toThrow("库存不足");
    expect(allocate).toHaveBeenCalledOnce(); expect(await snapshot()).toEqual(before);
  });
  it.each(["parent", "slot"])("does not reuse a confirmed price after its %s is stopped through the actual HTTP controllers", async target => {
    const body = { cartIds: [1], type: 1, seckillId: 20, shippingType: 2, storeId: 1 };
    const post = async (path: string) => {
      const response = await f.app.request(path, { method: "POST", headers: { "content-type": "application/json", "x-fixture-user": "11" },
        body: JSON.stringify(body) }, f.env);
      return response.json() as Promise<{ status: number; msg: string; data: { orderKey: string; priceGroup: { pay_price: string } } | null }>;
    };
    const confirmed = await post("/api/order/confirm");
    expect(confirmed.status, confirmed.msg).toBe(200); expect(confirmed.data?.priceGroup.pay_price).toBe("12.50");
    if (target === "parent") await f.db.update(storeActivity).set({ status: 0 });
    else await f.db.update(storeSeckillTime).set({ status: 0 });
    const before = await snapshot(), cached = [...f.cache], writes = [...f.writes];
    expect(await post(`/api/order/computed/${confirmed.data!.orderKey}`)).toMatchObject({ status: 400, data: null });
    expect(await post("/api/order/confirm")).toMatchObject({ status: 400, data: null });
    expect(await snapshot()).toEqual(before); expect([...f.cache]).toEqual(cached); expect(f.writes).toEqual(writes);
  });
});
