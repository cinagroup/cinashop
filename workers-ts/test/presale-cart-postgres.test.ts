import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { AppVariables, Env } from "../src/env";
import { createContainerFromDb } from "../src/lib/di";
import { memberRight, systemConfig, storeCart, storeOrder, storeProduct, storeProductAttrValue, user } from "../src/models/schema";
import { StoreCartService } from "../src/services/order/StoreCartService";
import { addPresaleCart } from "../src/services/activity/PresaleCartService";
import { cartAdd, cartNum, cartList } from "../src/controllers/api/v1/OrderController";
import { financePostgres } from "./helpers/financePostgres";

describe("presale cart selection on isolated SQL (not checkout/payment admission)", () => {
  let f: Awaited<ReturnType<typeof financePostgres>>, service: StoreCartService;
  let app: Hono<{ Bindings: Env; Variables: AppVariables }>;
  const params = { uid: 11, productId: 70, unique: "pres0001", cartNum: 2, type: 0, isNew: 1 };
  const stamp = () => Math.floor(Date.now() / 1000);
  beforeAll(async () => {
    f = await financePostgres([storeCart, storeOrder, storeProduct, storeProductAttrValue, user, systemConfig, memberRight]);
    const container = createContainerFromDb(f.db); service = new StoreCartService(container);
    app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use("*", async (c, next) => { c.set("container", container); c.set("uid", c.req.header("x-fixture-user") === "11" ? 11 : 0); await next(); });
    app.onError((error, c) => c.json({ status: 400, msg: error.message, data: null }));
    app.post("/api/cart/add", cartAdd); app.post("/api/cart/num", cartNum); app.get("/api/cart/list", cartList);
  }, 60_000);
  afterAll(async () => { await f?.close(); }, 60_000);
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
  beforeEach(async () => {
    await f.reset();
    await f.db.insert(user).values({ uid: 11, account: "presale-cart", status: 1 });
    await f.db.insert(storeProduct).values({ id: 70, storeName: "隔离预售商品", stock: 7, sales: 3,
      price: "100.00", isShow: 1, isVerify: 1, isPresaleProduct: 1,
      presaleStartTime: stamp() - 3600, presaleEndTime: stamp() + 3600, presaleDay: 7 });
    await f.db.insert(storeProductAttrValue).values([
      { id: 1, productId: 70, type: 0, unique: "pres0001", suk: "红色", stock: 9, price: "80.25" },
      { id: 2, productId: 70, type: 6, unique: "wrong006", suk: "错误活动规格", stock: 99, price: "0.01" },
      { id: 3, productId: 71, type: 0, unique: "other001", suk: "其它商品", stock: 99 },
      { id: 4, productId: 70, type: 0, unique: "retired1", suk: "退役", stock: 99, isRetired: 1 },
      { id: 5, productId: 70, type: 0, unique: "short", suk: "非规范填充标识", stock: 99 },
    ]);
  });
  const state = async () => ({ carts: await f.db.select().from(storeCart), products: await f.db.select().from(storeProduct),
    skus: await f.db.select().from(storeProductAttrValue), users: await f.db.select().from(user), orders: await f.db.select().from(storeOrder) });
  const post = async (path: string, body: unknown, loggedIn = true) => (await app.request(path, { method: "POST",
    headers: { "content-type": "application/json", ...(loggedIn ? { "x-fixture-user": "11" } : {}) }, body: JSON.stringify(body) })).json();

  it("converts PHP immediate-buy aliases to fresh type-6 base-SKU selections without reserving inventory", async () => {
    const before = await state();
    expect(await post("/api/cart/add", { productId: 70, uniqueId: "pres0001", cartNum: 2, new: 1 }))
      .toMatchObject({ status: 200, data: { cartId: 1, cartNum: 2 } });
    expect(await service.add({ ...params, type: 6 })).toEqual({ id: 2, cartNum: 2 });
    const after = await state();
    expect(after.carts.map(row => ({ type: row.type, unique: row.productAttrUnique, quantity: row.cartNum, isNew: row.isNew, activity: row.activityId })))
      .toEqual(Array.from({ length: 2 }, () => ({ type: 6, unique: "pres0001", quantity: 2, isNew: 1, activity: 0 })));
    expect({ ...after, carts: [] }).toEqual(before);
  });
  it("rejects fake type-6 ordinary products, activity IDs and reusable presale carts", async () => {
    for (const patch of [{ isNew: 0 }, { activityId: 1 }, { bargainUserId: 1 }]) {
      const before = await state(); await expect(service.add({ ...params, ...patch })).rejects.toThrow(); expect(await state()).toEqual(before);
    }
    await f.db.update(storeProduct).set({ isPresaleProduct: 0 });
    await expect(service.add({ ...params, type: 6 })).rejects.toThrow("预售商品已失效");
    expect((await state()).carts).toEqual([]);
    // Existing ordinary routing remains ordinary, not selected by client type alone.
    await service.add(params); expect((await state()).carts[0].type).toBe(0);
  });
  it("fails invalid input before beginning a transaction", async () => {
    const container = createContainerFromDb(f.db), spy = vi.spyOn(f.db, "transaction");
    for (const patch of [{ uid: 0 }, { uid: 2_147_483_648 }, { productId: NaN }, { productId: 0 },
      { cartNum: 0 }, { cartNum: 1.5 }, { cartNum: 32768 }, { unique: "" }, { unique: " pres001" }, { unique: "123456789" }, { unique: "pre\n0001" }]) {
      await expect(addPresaleCart(container, { ...params, ...patch })).rejects.toThrow();
    }
    expect(spy).not.toHaveBeenCalled();
  });
  it("rejects unavailable base SKUs and checks both product and SKU stock", async () => {
    for (const unique of ["wrong006", "other001", "retired1", "missing1", "short"]) {
      await expect(service.add({ ...params, unique })).rejects.toThrow("规格已失效");
    }
    await expect(service.add({ ...params, cartNum: 8 })).rejects.toThrow("库存不足");
    await f.db.update(storeProductAttrValue).set({ stock: 1 }).where(eq(storeProductAttrValue.id, 1));
    await expect(service.add(params)).rejects.toThrow("库存不足");
    expect((await state()).carts).toEqual([]);
  });
  it("enforces current per-order limits on add and edit, without changing stock or an existing selection on rejection", async () => {
    await f.db.update(storeProduct).set({ isLimit: 1, limitType: 1, limitNum: 2 });
    const before = await state();
    await expect(service.add({ ...params, cartNum: 3 })).rejects.toThrow('每单限购2件'); expect(await state()).toEqual(before);
    const { id } = await service.add(params);
    await f.db.update(storeProduct).set({ limitNum: 1 });
    const selected = await state();
    await expect(service.setNum(11, id, 2)).rejects.toThrow('每单限购1件'); expect(await state()).toEqual(selected);
    await service.setNum(11, id, 1); expect((await state()).carts[0].cartNum).toBe(1);
    expect((await state()).products[0].stock).toBe(7); expect((await state()).skus[0].stock).toBe(9);
  });
  it.each([{ isLimit: 1, limitType: 2, limitNum: 3 }, { isLimit: 2 },
    { isLimit: 1, limitType: 0, limitNum: 3 }, { isLimit: 1, limitType: 1, limitNum: 0 }])(
    "closes unsupported/invalid limits on add and edit: %j", async config => {
      const { id } = await service.add(params);
      await f.db.update(storeProduct).set(config); const before = await state();
      await expect(service.add(params)).rejects.toThrow(/限购/);
      await expect(service.setNum(11, id, 1)).rejects.toThrow(/限购/);
      expect(await state()).toEqual(before);
    });
  it("rolls back cart inserts for future/ended/zero/invalid schedules", async () => {
    for (const patch of [{ presaleStartTime: stamp() + 60 }, { presaleEndTime: stamp() - 1 },
      { presaleStartTime: 0, presaleEndTime: 0 }, { presaleStartTime: 10, presaleEndTime: 9 }, { presaleDay: -1 }]) {
      await f.db.update(storeProduct).set({ presaleStartTime: stamp() - 3600, presaleEndTime: stamp() + 3600, presaleDay: 7, ...patch });
      const before = await state(); await expect(service.add(params)).rejects.toThrow(); expect(await state()).toEqual(before);
    }
  });
  it("rechecks visibility, principal state and paid-member-only admission", async () => {
    for (const patch of [{ isShow: 0 }, { isDel: 1 }, { isVerify: 0 }, { isPresaleProduct: 2 }, { isVipProduct: 1 }]) {
      await f.db.update(storeProduct).set({ isShow: 1, isDel: 0, isVerify: 1, isPresaleProduct: 1, isVipProduct: 0, ...patch });
      await expect(service.add(params)).rejects.toThrow();
    }
    await f.db.update(user).set({ isMoneyLevel: 1, overdueTime: stamp() - 1 });
    await expect(service.add(params)).rejects.toThrow("有效付费会员");
    await f.db.update(user).set({ overdueTime: stamp() + 60 }); await service.add(params);
    for (const patch of [{ status: 0 }, { isDel: 1 }]) {
      await f.db.update(user).set({ status: 1, isDel: 0, ...patch }); await expect(service.add(params)).rejects.toThrow("重新登录");
    }
    expect((await state()).carts).toHaveLength(1);
  });
  it("uses exact owned active unclaimed direct-buy scope for quantity edits", async () => {
    const { id } = await service.add(params);
    expect(await post("/api/cart/num", { id, cartNum: 3 })).toMatchObject({ status: 200 });
    const patches = [{ isPay: 1 }, { isDel: 1 }, { status: 0 }, { activityId: 1 }, { staffId: 1 },
      { touristUid: "other" }, { storeId: 1 }, { isNew: 0 }, { bargainUserId: 1 }];
    const [initial] = await f.db.select().from(storeCart);
    for (const patch of patches) {
      await f.db.update(storeCart).set({ ...initial, ...patch }); const before = await state();
      await expect(service.setNum(11, id, 4)).rejects.toThrow(); expect(await state()).toEqual(before);
    }
    await f.db.update(storeCart).set(initial);
    await expect(service.setNum(22, id, 4)).rejects.toThrow();
    expect(await post("/api/cart/num", { id, cartNum: 4 }, false)).toMatchObject({ status: 400 });
    expect((await state()).carts[0].cartNum).toBe(3);
  });
  it("revalidates presale flags, schedule, fulfillment type and stock when quantities change", async () => {
    const { id } = await service.add(params);
    for (const patch of [{ isPresaleProduct: 0 }, { presaleStartTime: stamp() + 60 }, { presaleEndTime: stamp() - 1 },
      { productType: 3 }, { stock: 2 }, { isShow: 0 }, { isVerify: 0 }]) {
      await f.db.update(storeProduct).set({ isPresaleProduct: 1, presaleStartTime: stamp() - 3600, presaleEndTime: stamp() + 3600,
        productType: 0, stock: 7, isShow: 1, isVerify: 1, ...patch });
      const before = await state(); await expect(service.setNum(11, id, 3)).rejects.toThrow(); expect(await state()).toEqual(before);
    }
  });
  it("marks changed selections invalid and makes scoped buy reads fail instead of downgrading them", async () => {
    const { id } = await service.add(params);
    expect(await service.list(11, { mode: "buy", ids: [id] })).toMatchObject([{ id, type: 6, isValid: true }]);
    for (const patch of [{ isPresaleProduct: 0 }, { presaleEndTime: stamp() - 1 }, { presaleStartTime: stamp() + 60 }]) {
      await f.db.update(storeProduct).set({ isPresaleProduct: 1, presaleStartTime: stamp() - 3600, presaleEndTime: stamp() + 3600, ...patch });
      expect(await service.list(11)).toMatchObject([{ id, isValid: false, productInfo: null }]);
      await expect(service.list(11, { mode: "buy", ids: [id] })).rejects.toThrow("已失效");
    }
    await f.db.update(storeProduct).set({ presaleStartTime: stamp() - 3600 });
    await f.db.update(storeCart).set({ type: 0 });
    expect(await service.list(11)).toMatchObject([{ id, isValid: false }]);
  });
  it("keeps legacy ordinary mutation paths from recreating presale type-0 rows", async () => {
    await expect(service.setProductQuantityLegacy({ uid: 11, productId: 70, unique: "pres0001", cartNum: 2, mode: -1 }))
      .rejects.toThrow("立即购买");
    expect((await state()).carts).toEqual([]);
  });
  it("does not display invalid or insufficient base SKUs as a valid unscoped presale cart", async () => {
    const { id } = await service.add(params);
    expect(await service.list(11)).toMatchObject([{ id, isValid: true, productInfo: { stock: 7 } }]);
    for (const patch of [{ stock: 1 }, { isRetired: 1 }]) {
      await f.db.update(storeProductAttrValue).set({ stock: 9, isRetired: 0, ...patch }).where(eq(storeProductAttrValue.id, 1));
      expect(await service.list(11)).toMatchObject([{ id, isValid: false, productInfo: null }]);
    }
  });
  it("preserves stricter transaction deadlines and restores session settings", async () => {
    const transaction = f.db.transaction.bind(f.db);
    const intercept: typeof f.db.transaction = (fn, config) => transaction(async tx => {
      await tx.execute(sql`SET LOCAL statement_timeout = '750ms'`);
      await tx.execute(sql`SET LOCAL lock_timeout = '300ms'`);
      await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout = '800ms'`);
      const result = await fn(tx);
      const [settings] = await tx.execute(sql`SELECT current_setting('transaction_isolation') AS isolation,
        current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock,
        current_setting('idle_in_transaction_session_timeout') AS idle`);
      expect(settings).toEqual({ isolation: "read committed", statement: "750ms", lock: "300ms", idle: "800ms" });
      return result;
    }, config);
    const db = new Proxy(f.db, { get(target, key, receiver) { return key === "transaction" ? intercept : Reflect.get(target, key, receiver); } });
    const [before] = await f.db.execute(sql`SHOW statement_timeout`);
    await addPresaleCart(createContainerFromDb(db), params);
    const [after] = await f.db.execute(sql`SHOW statement_timeout`); expect(after).toEqual(before);
  });

  // These require independent native PostgreSQL sessions, not a PGlite concurrency imitation.
  const native = it.skipIf(!process.env.TEST_FINANCE_POSTGRES_URL);
  async function waitBlocked(pid: number) {
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const [row] = await f.db.execute(sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
        WHERE ${pid} = ANY(pg_blocking_pids(pid))) AS blocked`);
      if (row?.blocked) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("No observed PostgreSQL lock wait");
  }
  native.each([
    { patch: { isPresaleProduct: 0 }, message: '预售商品已失效' },
    { patch: { isLimit: 1, limitType: 1, limitNum: 1 }, message: '每单限购1件' },
    { patch: { isLimit: 1, limitType: 2, limitNum: 3 }, message: '累计限购预售暂未开放' },
  ])("rechecks product changes after a real row-lock wait: $message", async ({ patch, message }) => {
    let release!: () => void, ready!: (pid: number) => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), acquired = new Promise<number>(resolve => { ready = resolve; });
    const holder = f.db.transaction(async tx => {
      await tx.update(storeProduct).set(patch).where(eq(storeProduct.id, 70));
      const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`); ready(Number(row.pid)); await gate;
    });
    const pid = await acquired;
    const result = service.add({ ...params, type: 6 }).then(() => null, error => error as Error);
    try { await waitBlocked(pid); } finally { release(); await holder; }
    expect((await result)?.message).toContain(message); expect((await state()).carts).toEqual([]);
  });
  native("quantity cannot change a cart claimed while it waits", async () => {
    const { id } = await service.add(params);
    let release!: () => void, ready!: (pid: number) => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), acquired = new Promise<number>(resolve => { ready = resolve; });
    const holder = f.db.transaction(async tx => {
      await tx.update(storeCart).set({ isPay: 1 }).where(eq(storeCart.id, id));
      const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`); ready(Number(row.pid)); await gate;
    });
    const pid = await acquired;
    const result = service.setNum(11, id, 3).then(() => null, error => error as Error);
    try { await waitBlocked(pid); } finally { release(); await holder; }
    expect((await result)?.message).toContain("已下单"); expect((await state()).carts[0]).toMatchObject({ cartNum: 2, isPay: 1 });
  });
  native("uses database wall time after an unchanged SKU lock crosses the inclusive cutoff", async () => {
    // Start after the first 300ms of a second: cutoff is 1-1.7s away, leaving
    // headroom below the service's 2-second lock timeout on a slow test host.
    await f.db.execute(sql`SELECT pg_sleep(GREATEST(0, 0.3 - mod(extract(epoch FROM clock_timestamp()), 1))::double precision)`);
    const [clock] = await f.db.execute(sql`SELECT extract(epoch FROM clock_timestamp())::double precision AS seconds`);
    const end = Math.floor(Number(clock.seconds)) + 1;
    await f.db.update(storeProduct).set({ presaleEndTime: end });
    let release!: () => void, ready!: (pid: number) => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), acquired = new Promise<number>(resolve => { ready = resolve; });
    const holder = f.db.transaction(async tx => {
      await tx.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1)).for("update");
      const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`); ready(Number(row.pid)); await gate;
    });
    const pid = await acquired;
    const result = service.add({ ...params, type: 6 }).then(() => null, error => error as Error);
    try {
      await waitBlocked(pid);
      // Freeze only the application clock inside the still-active window.
      // Native PostgreSQL must independently reject the later admission.
      vi.setSystemTime(new Date(end * 1000));
      const [remaining] = await f.db.execute(sql`SELECT GREATEST(0, ${end + 1} - extract(epoch FROM clock_timestamp()))::double precision AS seconds`);
      await new Promise(resolve => setTimeout(resolve, Number(remaining.seconds) * 1000 + 20));
    } finally { release(); await holder; }
    expect((await result)?.message).toContain("预售活动已结束"); expect((await state()).carts).toEqual([]);
  });
});
