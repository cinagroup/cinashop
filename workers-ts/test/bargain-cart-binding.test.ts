import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createBargainSelectionFixture } from "./helpers/bargainSelectionFixture";
import { orderCreate, orderCancel } from "../src/controllers/api/v1/OrderController";
import { StoreOrderCreateService } from "../src/services/order/StoreOrderCreateService";
import { StoreCartService } from "../src/services/order/StoreCartService";
import { BARGAIN_CART_PARTICIPATION_SQL } from "../src/migrations/bargainCartParticipation";
import { parseBargainSelection } from "../src/services/activity/BargainParticipationSelection";
import { storeCart, storeBargainUser, storeOrderCartInfo, storeOrderStatus, printDocument, systemStore } from "../src/models/schema";

describe("durable bargain identity through real HTTP/cart/quote/create/cancel", () => {
  let f: Awaited<ReturnType<typeof createBargainSelectionFixture>>, allocations: number;
  beforeEach(async () => {
    f = await createBargainSelectionFixture([storeOrderCartInfo, storeOrderStatus, printDocument]);
    await f.db.update(systemStore).set({ isStore: 1 }).where(eq(systemStore.id, 1));
    // Install the actual new CHECK as well as the fixture's real column/default/PK.
    await f.db.transaction(tx => tx.execute(sql.raw(BARGAIN_CART_PARTICIPATION_SQL)));
    allocations = 0;
    // Only the sequence binding is replaced. Real create and cancel handlers,
    // pricing, claims, participant consumption and compensation run against SQL.
    Object.assign(f.env, { SEQUENCE: {
      idFromName: (name: string) => { expect(name).toBe("seq"); return "owned-local-sequence"; },
      get: (id: string) => { expect(id).toBe("owned-local-sequence"); return {
        fetch: async (url: string) => { expect(url).toBe("https://internal/next-order-id?prefix=wx"); return new Response(`binding_local_${++allocations}`); },
      }; },
    } });
    f.app.post("/api/order/create/:key", orderCreate);
    f.app.post("/api/order/cancel", orderCancel);
  }, 30000);
  afterEach(async () => { await f?.close(); });
  async function wire<T>(url: string, body?: object, uid = "11") {
    const response = await f.app.request(`/api${url}`, { method: body ? "POST" : "GET",
      headers: { "x-fixture-user": uid, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
    }, f.env);
    return await response.json() as { status: number; msg: string; data: T };
  }
  async function add(id: number | null = 80, isNew = 1) {
    const response = await wire<{ id: number }>("/cart/add", { productId: 70, activityId: 40, type: 2,
      unique: "actred40", cartNum: 1, new: isNew, ...(id === null ? {} : { bargainUserId: id }) });
    expect(response.status, response.msg).toBe(200);
    return response.data.id;
  }
  const second = () => f.db.insert(storeBargainUser).values({ id: 90, uid: 11, bargainId: 40,
    bargainPrice: "10.00", bargainPriceMin: "4.00", price: "6.00", status: 3 });
  const checkout = { type: 2, addressId: 11, shippingType: 2, storeId: 1, realName: '隔离自提人', userPhone: '00000000000' };
  type Preview = { orderKey: string; priceGroup: { pay_price: string }; cartInfo: Array<{ bargainUserId: number; bargain_user_id: number }> };
  const confirm = (id: number, selection: object = {}) => wire<Preview>("/order/confirm", { ...checkout, cartIds: [id], ...selection });
  const create = (key: string, selection: object = {}) => wire<{ orderId: string }>(`/order/create/${key}`, { ...checkout, ...selection });
  const state = async () => {
    const value = await f.snapshot();
    return { ...value, sequences: undefined, kv: undefined, kvWrites: undefined,
      carts: value.carts.sort((a, b) => a.id - b.id), orders: value.orders.sort((a, b) => a.id - b.id),
      skus: value.skus.sort((a, b) => a.id - b.id), users: value.users.sort((a, b) => a.uid - b.uid),
      details: await f.db.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.id),
      statuses: await f.db.select().from(storeOrderStatus).orderBy(storeOrderStatus.id),
      prints: await f.db.select().from(printDocument) };
  };
  const rawQuote = (id: number, selection: object = {}) => new StoreOrderCreateService(f.container, f.env).quoteOrder({
    uid: 11, cartIds: [id], type: 2, shippingType: 2, storeId: 1, ...selection,
  });

  it("keeps two ready prices distinct from catalogue to cancellation and preserves a later participation", async () => {
    await second(); const initial = await state();
    for (const [id, price] of [[80, "2.00"], [90, "4.00"]] as const) {
      const catalog = await wire<{ participation: { id: number; catalog_price: string }; can_select: boolean }>(`/bargain/detail/40?view=skus&bargain_user_id=${id}`);
      expect(catalog).toMatchObject({ status: 200, data: { participation: { id, catalog_price: price }, can_select: true } });
    }
    const firstCart = await add(80), secondCart = await add(90);
    expect(secondCart).not.toBe(firstCart);
    const first = await confirm(firstCart), other = await confirm(secondCart);
    expect(first).toMatchObject({ status: 200, data: { priceGroup: { pay_price: "2.00" }, cartInfo: [{ bargainUserId: 80, bargain_user_id: 80 }] } });
    expect(other).toMatchObject({ status: 200, data: { priceGroup: { pay_price: "4.00" }, cartInfo: [{ bargainUserId: 90, bargain_user_id: 90 }] } });
    const before = await state();
    expect(await wire(`/order/computed/${other.data.orderKey}`, { ...checkout, bargainUserId: 90, bargainId: 40 })).toMatchObject({ status: 200, data: { pay_price: "4.00" } });
    expect(await state()).toEqual(before);
    const createdFirst = await create(first.data.orderKey), createdSecond = await create(other.data.orderKey, { bargain_user_id: "90" });
    expect(createdFirst.status, createdFirst.msg).toBe(200); expect(createdSecond.status, createdSecond.msg).toBe(200);
    const purchased = await state();
    expect(purchased.orders.map(row => row.payPrice)).toEqual(["2.00", "4.00"]);
    expect(purchased.details.map(row => JSON.parse(row.cartInfo!).bargainParticipation.participantId)).toEqual([80, 90]);
    expect(purchased.participations.filter(row => [80, 90].includes(row.id)).map(row => row.status)).toEqual([4, 4]);
    expect(await create(first.data.orderKey)).toMatchObject({ status: 200, data: createdFirst.data });
    expect(allocations).toBe(2);
    await f.db.insert(storeBargainUser).values({ id: 91, uid: 11, bargainId: 40, bargainPrice: "10.00", bargainPriceMin: "2.00", price: "0.00", status: 1 });
    expect(await wire("/order/cancel", { order_id: createdFirst.data.orderId })).toMatchObject({ status: 200 });
    let cancelled = await state();
    expect(cancelled.participations.find(row => row.id === 80)?.status).toBe(3);
    expect(cancelled.participations.find(row => row.id === 90)?.status).toBe(4);
    expect(await wire("/order/cancel", { order_id: createdSecond.data.orderId })).toMatchObject({ status: 200 });
    cancelled = await state();
    expect(cancelled.participations.filter(row => row.id !== 91)).toEqual(initial.participations);
    expect(cancelled.participations.find(row => row.id === 91)).toMatchObject({ status: 1, price: "0.00" });
    for (const field of ["products", "skus", "bargains", "bills"] as const) expect(cancelled[field]).toEqual(initial[field]);
    expect(cancelled.carts.map(row => [row.bargainUserId, row.isPay])).toEqual([[80, 0], [90, 0]]);
    expect(await confirm(firstCart)).toMatchObject({ status: 200, data: { priceGroup: { pay_price: "2.00" } } });
    expect(await confirm(secondCart)).toMatchObject({ status: 200, data: { priceGroup: { pay_price: "4.00" } } });
  });
  it("merges only the same binding, never legacy zero, another participant, or direct buys", async () => {
    await second();
    await f.db.insert(storeCart).values({ id: 100, uid: 11, productId: 70, productAttrUnique: "qared001", cartNum: 1, type: 2, activityId: 40 });
    const a = await add(80, 0), b = await add(90, 0);
    expect(a).not.toBe(100); expect(a).not.toBe(b);
    expect(await add(80, 0)).toBe(a);
    const direct = [await add(80), await add(80)];
    expect(new Set([100, a, b, ...direct]).size).toBe(5);
    const rows = (await state()).carts;
    expect(rows.find(row => row.id === 100)).toMatchObject({ bargainUserId: 0, cartNum: 1 });
    expect(rows.find(row => row.id === a)).toMatchObject({ bargainUserId: 80, cartNum: 2 });
    expect(rows.find(row => row.id === b)).toMatchObject({ bargainUserId: 90, cartNum: 1 });
    expect(rows.filter(row => direct.includes(row.id)).every(row => row.cartNum === 1 && row.isNew === 1)).toBe(true);
  });
  it("keeps legacy zero read-only and unambiguous, with a separate activity namespace", async () => {
    await f.db.insert(storeCart).values({ id: 100, uid: 11, productId: 70, productAttrUnique: "qared001", cartNum: 1, type: 2, activityId: 40, isNew: 1 });
    // The number 40 exists as another owner's participation, not just an activity.
    await f.db.insert(storeBargainUser).values({ id: 40, uid: 22, bargainId: 40, status: 3, bargainPrice: "10.00", bargainPriceMin: "2.00", price: "8.00" });
    const before = await state();
    expect(await confirm(100, { bargainId: 40 })).toMatchObject({ status: 200 });
    expect(await confirm(100, { bargainUserId: 40 })).toMatchObject({ status: 400 });
    expect(await confirm(100)).toMatchObject({ status: 200 });
    expect(await state()).toEqual(before);
    await second(); const ambiguous = await state();
    for (const choice of [{}, { bargainId: 40 }, { bargainUserId: 80 }]) {
      expect(await confirm(100, choice)).toMatchObject({ status: 400 });
      await expect(rawQuote(100, choice)).rejects.toThrow(/不唯一/);
    }
    expect(await state()).toEqual(ambiguous);
    expect((await state()).carts[0].bargainUserId).toBe(0);
    expect((await confirm(await add(80))).status).toBe(200);
  });
  it("binds the sole implicit add and does not silently select a newer record", async () => {
    const id = await add(null); await second();
    expect((await state()).carts.find(row => row.id === id)?.bargainUserId).toBe(80);
    expect(await confirm(id)).toMatchObject({ status: 200, data: { priceGroup: { pay_price: "2.00" } } });
    expect(await wire("/cart/add", { productId: 70, activityId: 40, type: 2, unique: "actred40", cartNum: 1, new: 1 })).toMatchObject({ status: 400 });
  });
  it("refuses request rebinding consistently at confirm, computed and create without allocating an order", async () => {
    await second(); const id = await add(80), good = await confirm(id);
    expect(good.status).toBe(200);
    const before = await state();
    for (const choice of [{ bargainUserId: 90 }, { bargainId: 90 }, { bargainUserId: 80, bargain_user_id: 90 },
      { bargainUserId: 80, bargainId: 40, bargain_id: 90 }, { bargainUserId: 40 }]) {
      expect(await confirm(id, choice)).toMatchObject({ status: 400 });
      expect(await wire(`/order/computed/${good.data.orderKey}`, { ...checkout, ...choice })).toMatchObject({ status: 400 });
      expect(await create(good.data.orderKey, choice)).toMatchObject({ status: 400 });
    }
    expect(await state()).toEqual(before); expect(allocations).toBe(0);
    expect(await confirm(id, { bargainUserId: 80, bargain_user_id: "80", bargainId: 40, bargain_id: "40" })).toMatchObject({ status: 200 });
  });
  it.each([{ uid: 22 }, { bargainId: 99 }, { isDel: 1 }, { status: 4 }, { status: 2 }, { price: "7.00" }])(
    "never falls back from a bound participant that changes to %j", async change => {
      const id = await add(80); await second();
      await f.db.update(storeBargainUser).set(change).where(eq(storeBargainUser.id, 80));
      const before = await state();
      expect(await wire(`/cart/list?scope=buy&ids=${id}`)).toMatchObject({ status: 400 });
      expect(await confirm(id)).toMatchObject({ status: 400 });
      await expect(rawQuote(id)).rejects.toThrow();
      expect(await wire(`/order/create/bound_invalid_${id}`, { ...checkout, cartIds: [id] })).toMatchObject({ status: 400 });
      expect(await wire("/cart/add", { productId: 70, activityId: 40, type: 2, unique: "actred40", cartNum: 1, new: 1, bargainUserId: 80 })).toMatchObject({ status: 400 });
      expect(await state()).toEqual(before); expect(allocations).toBe(0);
    });
  it.each([0, 90])("rejects a late binding change to %s at atomic claim", async value => {
    const id = await add(80); await second();
    let changed: Awaited<ReturnType<typeof state>>;
    await expect(StoreOrderCreateService.createWithRuntime(f.container, { CONFIG_KV: f.env.CONFIG_KV,
      nextOrderId: async () => { await f.db.update(storeCart).set({ bargainUserId: value }).where(eq(storeCart.id, id)); changed = await state(); return `changed_binding_${value}`; },
    }, { uid: 11, key: "late_binding", cartIds: [id], type: 2, shippingType: 2, storeId: 1,
      realName: "隔离测试", userPhone: "00000000000", userIp: "127.0.0.1" })).rejects.toThrow("砍价购物车已变化或被占用");
    expect(await state()).toEqual(changed!);
  });
  it("rejects malformed selectors and non-bargain reuse instead of coercing or ignoring them", async () => {
    const before = await state();
    for (const value of [null, true, false, "80x", "1e2", "080", [], {}, 2.5, -1, 2_147_483_648]) {
      expect(await wire("/cart/add", { productId: 70, activityId: 40, type: 2, unique: "actred40", cartNum: 1, new: 1, bargainUserId: value })).toMatchObject({ status: 400 });
    }
    expect(await wire("/cart/add", { productId: 70, type: 0, unique: "qared001", cartNum: 1, bargainUserId: 80 })).toMatchObject({ status: 400 });
    expect(await state()).toEqual(before);
  });
  it("does not merge with assisted/store-scoped rows even if their binding matches", async () => {
    for (const [id, scope] of [[100, { staffId: 1 }], [101, { touristUid: "another" }], [102, { storeId: 1 }]] as const)
      await f.db.insert(storeCart).values({ id, uid: 11, productId: 70, productAttrUnique: "qared001", cartNum: 1, type: 2, activityId: 40, bargainUserId: 80, ...scope });
    const added = await add(80, 0); expect([100, 101, 102]).not.toContain(added);
    expect((await state()).carts.filter(row => row.id >= 100).every(row => row.cartNum === 1)).toBe(true);
  });
  it("restores stricter caller deadlines after successful and rejected add", async () => {
    await f.db.execute(sql`SET statement_timeout='750ms'`);
    const settings = () => f.db.select({ statement: sql<string>`current_setting('statement_timeout')`,
      lock: sql<string>`current_setting('lock_timeout')`, idle: sql<string>`current_setting('idle_in_transaction_session_timeout')` }).from(sql`(values (1)) p(n)`);
    const before = await settings(); await add(); expect(await settings()).toEqual(before);
    await expect(new StoreCartService(f.container).add({ uid: 11, productId: 70, activityId: 40, type: 2,
      unique: "actred40", cartNum: 1, bargainUserId: 81 })).rejects.toThrow();
    expect(await settings()).toEqual(before);
  });
});

describe("bargain identity wire namespaces", () => {
  it("preserves canonical and legacy IDs separately and normalizes unused zero fields", () => {
    expect(parseBargainSelection({ bargainUserId: 80, bargain_id: "40" })).toEqual({ bargainUserId: 80, bargainId: 40 });
    expect(parseBargainSelection({ bargainUserId: 0, bargainId: "0" })).toEqual({ bargainUserId: undefined, bargainId: undefined });
    expect(() => parseBargainSelection({ bargainUserId: 0, bargain_user_id: 80 })).toThrow("冲突");
  });
});
