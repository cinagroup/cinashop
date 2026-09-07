import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createPcCheckoutQuoteFixture } from "./helpers/pcCheckoutQuoteFixture";
import { StoreCartService } from "../src/services/order/StoreCartService";
import { StoreOrderCreateService, type CreateOrderParams } from "../src/services/order/StoreOrderCreateService";
import { assertSeckillSchedule, loadSeckillSchedule } from "../src/services/activity/SeckillScheduleService";
import * as schedulePolicy from "../src/services/activity/SeckillScheduleService";
import { storeActivity, storeSeckillTime, storeSeckill, storeProduct, storeProductAttrValue, systemStore,
  storeCart, storeOrder, storeOrderCartInfo, storeOrderStatus, printDocument } from "../src/models/schema";

/** Real cart, quote and order SQL. Only the external Sequence DO is replaced; no payment/provider. */
describe("seckill schedule admission on disposable SQL", () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  const params: CreateOrderParams = { uid: 11, key: "schedule_order", cartIds: [1], type: 1, seckillId: 20,
    shippingType: 2, storeId: 1, realName: "隔离秒杀样本", userPhone: "00000000000", userIp: "127.0.0.1" };
  const cartParams = { uid: 11, productId: 70, activityId: 20, type: 1, unique: "qatime01", cartNum: 1, isNew: 1 };
  const today = () => Math.floor((Date.now() + 28_800_000) / 86_400_000) * 86_400 - 28_800;
  beforeAll(async () => {
    f = await createPcCheckoutQuoteFixture([storeActivity, storeSeckillTime, storeSeckill, storeOrderCartInfo, storeOrderStatus, printDocument]);
    for (const key of Object.keys(f.config)) f.config[key] = "0";
    await f.db.update(systemStore).set({ isStore: 1 });
  }, 30_000);
  beforeEach(async () => {
    f.cache.clear(); f.writes.length = 0;
    for (const table of [storeActivity, storeSeckillTime, storeSeckill, storeOrder, storeOrderCartInfo, storeOrderStatus, printDocument]) await f.db.delete(table);
    await f.db.delete(storeCart);
    await f.db.insert(storeCart).values({ id: 1, uid: 11, productId: 70, productAttrUnique: "qared001", cartNum: 2,
      activityId: 20, type: 1, isNew: 1, status: 1 });
    await f.exec("select setval(pg_get_serial_sequence('store_cart', 'id'), 1)");
    await f.db.update(storeProduct).set({ stock: 8, sales: 0 }).where(eq(storeProduct.id, 70));
    await f.db.delete(storeProductAttrValue).where(eq(storeProductAttrValue.type, 1));
    await f.db.update(storeProductAttrValue).set({ stock: 8, sales: 0 }).where(eq(storeProductAttrValue.id, 1));
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

  it("loads bounded schedule fields and locks them inside the actual SQL transaction without writes", async () => {
    const before = await snapshot();
    const unlocked = await loadSeckillSchedule(f.db, 20);
    const locked = await f.db.transaction(tx => loadSeckillSchedule(tx, 20, true));
    expect(locked).toEqual(unlocked); expect(assertSeckillSchedule(locked).activeSlotIds).toEqual([4]);
    expect(Object.keys(locked.child).sort()).toEqual(["id", "activityId", "productId", "status", "isShow", "isDel", "timeId", "startTime", "stopTime"].sort());
    expect(locked.slots.map(slot => slot.id)).toEqual([4, 8]);
    expect(await snapshot()).toEqual(before);
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
