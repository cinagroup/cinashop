import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { financePostgres } from "./helpers/financePostgres";
import { createContainerFromDb } from "../src/lib/di";
import { storeActivity, storeSeckillTime, storeSeckill, storeProduct, storeProductAttrValue, storeCart, storeOrder, user } from "../src/models/schema";
import { SeckillSkuCatalogService } from "../src/services/activity/SeckillSkuCatalogService";
import { resolveLegacyActivitySkuPair } from "../src/services/activity/ActivityOrderSkuService";
import { StoreCartService } from "../src/services/order/StoreCartService";
import { seckillDetail } from "../src/controllers/api/v1/UserActivityController";
import { cartAdd } from "../src/controllers/api/v1/OrderController";
import type { AppVariables, Env } from "../src/env";

describe("read-only seckill SKU selection catalogue on disposable SQL", () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  let container: ReturnType<typeof createContainerFromDb>;
  let service: SeckillSkuCatalogService;
  let app: Hono<{ Bindings: Env; Variables: AppVariables }>;
  beforeAll(async () => {
    f = await financePostgres([storeActivity, storeSeckillTime, storeSeckill, storeProduct, storeProductAttrValue, storeCart, storeOrder, user]);
    container = createContainerFromDb(f.db);
    service = new SeckillSkuCatalogService(container);
    app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use("*", async (c, next) => { c.set("container", container); c.set("uid", c.req.header("x-fixture-user") === "11" ? 11 : 0); await next(); });
    app.onError((error, c) => c.json({ status: 400, msg: error.message, data: null }));
    app.get("/api/seckill/detail/:id/:time?", seckillDetail);
    // This test-only route can write a disposable direct cart, never an order/payment.
    app.post("/api/cart/add", cartAdd);
  }, 30_000);
  afterAll(async () => { await f?.close(); });
  beforeEach(async () => {
    await f.reset();
    await f.db.insert(user).values({ uid: 11, account: "seckill-fixture", status: 1, isMoneyLevel: 0 });
    await f.db.insert(storeProduct).values({ id: 70, storeName: "基础商品", stock: 12, price: "90.00", isShow: 1, isVerify: 1, image: "/base.svg" });
    const today = Math.floor((Date.now() + 28_800_000) / 86_400_000) * 86_400 - 28_800;
    await f.db.insert(storeActivity).values({ id: 900, type: 1, status: 1, startDay: today - 86_400, endDay: today + 86_400, timeId: "4,8" });
    await f.db.insert(storeSeckillTime).values({ id: 4, startTime: "0000", endTime: "2400", status: 1 });
    await f.db.insert(storeSeckill).values({ id: 20, activityId: 900, productId: 70, storeName: "秒杀<script>文字</script>",
      price: "8.00", cost: "1.00", stock: 10, quota: 9, quotaShow: 10, onceNum: 3, num: 6, image: "/seckill.svg", timeId: "4,8" });
    await f.db.insert(storeProductAttrValue).values([
      { id: 1, productId: 70, type: 0, unique: "basered1", suk: "红色,大号", stock: 8, price: "90.00" },
      { id: 2, productId: 70, type: 0, unique: "baseblu1", suk: "蓝色,小号", stock: 2, price: "100.00" },
      { id: 3, productId: 20, type: 1, unique: "actired1", suk: "红色,大号", stock: 7, quota: 6, price: "8.25", otPrice: "90.00", image: "/red.svg", cost: "0.12", brokerage: "1.50" },
      { id: 4, productId: 20, type: 1, unique: "actiblu1", suk: "蓝色,小号", stock: 5, quota: 4, price: "12.75", otPrice: "100.00" },
    ]);
  });
  const read = (uid = 0) => service.read(uid, "20");
  const snapshot = async () => ({ products: await f.db.select().from(storeProduct), skus: await f.db.select().from(storeProductAttrValue),
    activities: await f.db.select().from(storeSeckill), carts: await f.db.select().from(storeCart),
    orders: await f.db.select().from(storeOrder), users: await f.db.select().from(user) });

  it("returns only matching activity SKUs with decimal catalogue prices and a six-stock minimum, in three queries without writes", async () => {
    const before = await snapshot(), spy = vi.spyOn(f.db, "select");
    let result: Awaited<ReturnType<typeof read>>;
    try { result = await read(); expect(spy).toHaveBeenCalledTimes(3); } finally { spy.mockRestore(); }
    expect(result!).toEqual({ selection_only: true, type: 1, seckill_id: 20, product_id: 70, parent_activity_id: 900,
      title: "秒杀<script>文字</script>", image: "/seckill.svg", once_limit: 3, total_limit: 6,
      date_window: "active", start_time: null, stop_time: null, skus: [
        { unique: "actired1", base_unique: "basered1", suk: "红色,大号", catalog_price: "8.25", ot_price: "90.00", stock: 6, max_quantity: 3, image: "/red.svg" },
        { unique: "actiblu1", base_unique: "baseblu1", suk: "蓝色,小号", catalog_price: "12.75", ot_price: "100.00", stock: 2, max_quantity: 2, image: "/seckill.svg" },
      ] });
    expect(await snapshot()).toEqual(before);
    expect(JSON.stringify(result!)).not.toMatch(/cost|brokerage|diskInfo|quotaShow|current_user|account/);
  });
  it("rejects invalid IDs and internal principals before any SQL", async () => {
    const spy = vi.spyOn(f.db, "select"), auth = vi.spyOn(container.userDao, "findForAuth");
    try {
      for (const id of [undefined, null, 20, "0", "-1", "01", " 20", "20 ", "2e1", "20.0", "2147483648", "1 OR 1=1", "1".repeat(1000)]) {
        await expect(service.read(11, id)).rejects.toThrow("ID无效");
      }
      for (const uid of [-1, 1.5, NaN]) await expect(service.read(uid, "20")).rejects.toThrow("参数无效");
      expect(spy).not.toHaveBeenCalled(); expect(auth).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); auth.mockRestore(); }
  });
  it("mounts the opt-in view with private no-store, refuses unknown views, and retains the legacy detail", async () => {
    const response = await app.request("/api/seckill/detail/20/8?view=skus&uid=99&vip=1");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ status: 200, data: { selection_only: true, seckill_id: 20, product_id: 70 } });
    const spy = vi.spyOn(f.db, "select");
    try {
      const invalid = await app.request("/api/seckill/detail/20?view=unknown");
      expect(await invalid.json()).toMatchObject({ status: 400, data: null }); expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
    // The old detail includes its parent; use the existing no-parent branch for this fixture.
    await f.db.update(storeSeckill).set({ activityId: 0 }).where(eq(storeSeckill.id, 20));
    expect(await (await app.request("/api/seckill/detail/20")).json()).toMatchObject({ status: 200, data: { id: 20, productId: 70, activity: null, percent: 10 } });
  });
  it("does not expose hidden, deleted, disabled or missing activities", async () => {
    for (const change of [{ isShow: 0 }, { isDel: 1 }, { status: 0 }, { productId: 99 }]) {
      await f.db.update(storeSeckill).set({ isShow: 1, isDel: 0, status: 1, productId: 70, ...change });
      await expect(read()).rejects.toThrow("不可见");
    }
    await expect(service.read(0, "999")).rejects.toThrow("不可见");
  });
  it("does not expose hidden, deleted or unapproved base products", async () => {
    for (const change of [{ isShow: 0 }, { isDel: 1 }, { isVerify: 0 }, { isVerify: -2 }]) {
      await f.db.update(storeProduct).set({ isShow: 1, isDel: 0, isVerify: 1, ...change });
      await expect(read()).rejects.toThrow("不可见");
    }
  });
  it("uses current database membership, not forged query flags, and rechecks revoked or deleted identities", async () => {
    await f.db.update(storeProduct).set({ isVipProduct: 1 });
    await expect(read()).rejects.toThrow("不可见"); await expect(read(11)).rejects.toThrow("不可见");
    expect(await (await app.request("/api/seckill/detail/20?view=skus&uid=11&vip=1")).json()).toMatchObject({ status: 400 });
    await f.db.update(user).set({ isMoneyLevel: 1 }); expect((await read(11)).skus).toHaveLength(2);
    await f.db.update(user).set({ isMoneyLevel: 0 }); await expect(read(11)).rejects.toThrow("不可见");
    await f.db.update(user).set({ status: 0 }); await expect(read(11)).rejects.toThrow("重新登录");
  });
  it("isolates activity type, product ID and retired rows rather than filling from ordinary SKUs", async () => {
    await f.db.insert(storeProductAttrValue).values([
      { id: 5, productId: 20, type: 2, unique: "actired1", suk: "红色,大号", stock: 100 },
      { id: 6, productId: 21, type: 1, unique: "actired1", suk: "红色,大号", stock: 100 },
      { id: 7, productId: 20, type: 1, unique: "actired1", suk: "红色,大号", isRetired: 1 },
      { id: 8, productId: 70, type: 0, unique: "basered1", suk: "红色,大号", isRetired: 1 },
      { id: 9, productId: 70, type: 0, unique: "baseex01", suk: "非活动规格", stock: 100 },
    ]);
    expect((await read()).skus.map(sku => sku.unique)).toEqual(["actired1", "actiblu1"]);
  });
  it.each([
    [20, 1, "actired1", "另一规格"], [20, 1, "newact01", "红色,大号"],
    [70, 0, "basered1", "另一规格"], [70, 0, "newbase1", "红色,大号"],
  ])("fails closed for duplicate identity or label in scope %i/type %i", async (productId, type, unique, suk) => {
    await f.db.insert(storeProductAttrValue).values({ id: 5, productId, type, unique, suk });
    await expect(read()).rejects.toThrow("不唯一");
  });
  it("fails closed for missing or retired base mappings and malformed labels, without silently dropping a choice", async () => {
    await f.db.update(storeProductAttrValue).set({ isRetired: 1 }).where(eq(storeProductAttrValue.id, 1));
    await expect(read()).rejects.toThrow("缺少有效基础规格");
    await f.db.update(storeProductAttrValue).set({ isRetired: 0, suk: " 红色,大号 " }).where(eq(storeProductAttrValue.id, 1));
    await expect(read()).rejects.toThrow("名称配置无效");
  });
  it("refuses cross-namespace unique collisions on different labels but allows identical identities for the same label", async () => {
    await f.db.update(storeProductAttrValue).set({ unique: "baseblu1" }).where(eq(storeProductAttrValue.id, 3));
    await expect(read()).rejects.toThrow("标识冲突");
    await f.db.update(storeProductAttrValue).set({ unique: "basered1" }).where(eq(storeProductAttrValue.id, 3));
    const sku = (await read()).skus[0]!;
    expect(sku).toMatchObject({ unique: "basered1", base_unique: "basered1" });
    const pair = await resolveLegacyActivitySkuPair(f.db, { activityId: 20, productId: 70, type: 1, unique: sku.unique });
    expect(pair.activitySku.suk).toBe(pair.baseSku.suk);
  });
  it.each([1, 2, 3] as const)("rejects contradictory activity/base identities in the real resolver for type %i", async type => {
    await f.db.update(storeProductAttrValue).set({ type }).where(eq(storeProductAttrValue.type, 1));
    await f.db.update(storeProductAttrValue).set({ unique: "baseblu1" }).where(eq(storeProductAttrValue.id, 3));
    const before = await snapshot();
    await expect(resolveLegacyActivitySkuPair(f.db, { activityId: 20, productId: 70, type, unique: "baseblu1" })).rejects.toThrow("标识冲突");
    await expect(resolveLegacyActivitySkuPair(f.db, { activityId: 20, productId: 70, type, unique: "baseblu1", suk: "蓝色,小号" })).rejects.toThrow("标识冲突");
    expect(await snapshot()).toEqual(before);
  });
  it.each([1, 2, 3] as const)("rejects unique/label contradictions but preserves both identity aliases for type %i", async type => {
    await f.db.update(storeProductAttrValue).set({ type }).where(eq(storeProductAttrValue.type, 1));
    for (const unique of ["actired1", "basered1"]) {
      await expect(resolveLegacyActivitySkuPair(f.db, { activityId: 20, productId: 70, type, unique, suk: "蓝色,小号" })).rejects.toThrow("指定规格不匹配");
      const pair = await resolveLegacyActivitySkuPair(f.db, { activityId: 20, productId: 70, type, unique, suk: "红色,大号" });
      expect(pair.activitySku.unique).toBe("actired1"); expect(pair.baseSku.unique).toBe("basered1");
    }
  });
  it("keeps sold-out choices disabled, applies each inventory ceiling and does not invent cumulative remaining quota", async () => {
    await f.db.update(storeProductAttrValue).set({ stock: 0 }).where(eq(storeProductAttrValue.id, 4));
    expect((await read()).skus[1]).toMatchObject({ stock: 0, max_quantity: 0 });
    await f.db.update(storeProduct).set({ stock: 1 }); expect((await read()).skus[0].stock).toBe(1);
    await f.db.update(storeProduct).set({ stock: 12 });
    await f.db.update(storeSeckill).set({ stock: 2 }); expect((await read()).skus[0].stock).toBe(2);
    await f.db.update(storeSeckill).set({ stock: 10, quota: 1 }); expect((await read()).skus[0].stock).toBe(1);
    await f.db.update(storeSeckill).set({ quota: 9, onceNum: 5, num: 2 });
    expect((await read()).skus[0]).toMatchObject({ stock: 6, max_quantity: 2 });
    expect(await read()).not.toHaveProperty("remaining_limit");
  });
  it("preserves zero/maximum numeric prices and rejects negative prices, inventory and zero limits", async () => {
    await f.db.update(storeProductAttrValue).set({ price: "9999999999.99" }).where(eq(storeProductAttrValue.id, 3));
    expect((await read()).skus[0].catalog_price).toBe("9999999999.99");
    await f.db.update(storeProductAttrValue).set({ price: "0.00" }).where(eq(storeProductAttrValue.id, 3));
    expect((await read()).skus[0].catalog_price).toBe("0.00");
    await f.db.update(storeProductAttrValue).set({ price: "-0.01" }).where(eq(storeProductAttrValue.id, 3));
    await expect(read()).rejects.toThrow("价格配置无效");
    await f.db.update(storeProductAttrValue).set({ price: "8.25", stock: -1 }).where(eq(storeProductAttrValue.id, 3));
    await expect(read()).rejects.toThrow("库存配置无效");
    await f.db.update(storeSeckill).set({ onceNum: 0 }); await expect(read()).rejects.toThrow("限购配置无效");
  });
  it("projects only the date window, leaving parent/time-slot eligibility to the order path", async () => {
    await f.db.update(storeSeckill).set({ startTime: new Date("2026-09-07T10:00:00Z"), stopTime: new Date("2026-09-07T11:00:00Z") });
    for (const [clock, state] of [["09:59:59", "future"], ["10:00:00", "active"], ["11:00:00", "active"], ["11:00:01", "ended"]]) {
      expect(await service.read(0, "20", new Date(`2026-09-07T${clock}Z`))).toMatchObject({ date_window: state, selection_only: true });
    }
    await f.db.update(storeSeckill).set({ stopTime: new Date("2026-09-06T10:00:00Z") });
    await expect(read()).rejects.toThrow("日期配置无效");
  });
  it("filters unsafe image URLs and leaves names as literal text", async () => {
    for (const image of ["javascript:alert(1)", "//evil.test/i", "/\\evil.test/i", "https://u:p@example.test/i", "http://example.test/i"]) {
      await f.db.update(storeProductAttrValue).set({ image }).where(eq(storeProductAttrValue.id, 3));
      expect((await read()).skus[0].image).toBe("/seckill.svg");
    }
    await f.db.update(storeProductAttrValue).set({ image: "https://cdn.example.test/i.png" }).where(eq(storeProductAttrValue.id, 3));
    expect((await read()).skus[0].image).toBe("https://cdn.example.test/i.png");
  });
  it.each([[20, 1], [70, 0]])("rejects overflow in product %i/type %i rather than returning a truncated selector", async (productId, type) => {
    await f.db.insert(storeProductAttrValue).values(Array.from({ length: 499 }, (_, i) => ({ id: 100 + i, productId, type,
      unique: `qa${String(i).padStart(6, "0")}`, suk: `样本${i}` })));
    await expect(read()).rejects.toThrow("超过500项");
  });
  it("returns all 500 valid choices at the exact boundary without N+1 queries", async () => {
    await f.db.insert(storeProductAttrValue).values(Array.from({ length: 498 }, (_, i) => [
      { id: 100 + i, productId: 20, type: 1, unique: `aa${String(i).padStart(6, "0")}`, suk: `规格${i}`, stock: 1, quota: 1, price: "1.23" },
      { id: 1000 + i, productId: 70, type: 0, unique: `bb${String(i).padStart(6, "0")}`, suk: `规格${i}`, stock: 1 },
    ]).flat());
    const spy = vi.spyOn(f.db, "select");
    try {
      const result = await read(); expect(result.skus).toHaveLength(500); expect(spy).toHaveBeenCalledTimes(3);
      expect(result.skus.at(-1)).toMatchObject({ unique: "aa000497", base_unique: "bb000497", catalog_price: "1.23", max_quantity: 1 });
    } finally { spy.mockRestore(); }
  });
  it("returns no manufactured default SKU when there are no active activity SKUs", async () => {
    await f.db.update(storeProductAttrValue).set({ isRetired: 1 }).where(eq(storeProductAttrValue.type, 1));
    expect((await read()).skus).toEqual([]);
  });
  it("allows a real single unnamed SKU but rejects an unnamed member of a multi-SKU catalogue", async () => {
    await f.db.update(storeProductAttrValue).set({ suk: "" }).where(eq(storeProductAttrValue.id, 1));
    await f.db.update(storeProductAttrValue).set({ suk: "" }).where(eq(storeProductAttrValue.id, 3));
    await expect(read()).rejects.toThrow("缺少规格名称");
    await f.db.update(storeProductAttrValue).set({ isRetired: 1 }).where(eq(storeProductAttrValue.id, 4));
    const sku = (await read()).skus[0]!; expect(sku.suk).toBe("");
    for (const unique of [sku.unique, sku.base_unique]) {
      const pair = await resolveLegacyActivitySkuPair(f.db, { activityId: 20, productId: 70, type: 1, unique });
      expect(pair.baseSku.unique).toBe(sku.base_unique);
    }
  });
  it("bridges each returned activity SKU through the actual cart controller into its base identity and activity price", async () => {
    const before = await snapshot(), catalog = await read(11);
    for (const sku of catalog.skus) {
      const pair = await resolveLegacyActivitySkuPair(f.db, { activityId: catalog.seckill_id, productId: catalog.product_id, type: catalog.type, unique: sku.unique });
      expect(pair.baseSku.unique).toBe(sku.base_unique);
      const response = await app.request("/api/cart/add", { method: "POST", headers: { "content-type": "application/json", "x-fixture-user": "11" },
        body: JSON.stringify({ productId: catalog.product_id, activityId: catalog.seckill_id, type: 1, unique: sku.unique, cartNum: 1, new: 1 }) });
      const body = await response.json() as { status: number; data: { id: number } };
      expect(body.status).toBe(200);
      const [item] = await new StoreCartService(container).list(11, { mode: "buy", ids: [body.data.id] });
      expect(item).toMatchObject({ type: 1, activityId: 20, productId: 70, unique: sku.base_unique, isNew: 1, cartNum: 1, isValid: true,
        productInfo: { price: sku.catalog_price, suk: sku.suk } });
    }
    const after = await snapshot(); expect(after.carts).toHaveLength(2);
    expect({ ...after, carts: [] }).toEqual({ ...before, carts: [] });
  });
  it("does not reserve stock: changed inventory rejects the previously returned selection in the real cart service", async () => {
    const catalog = await read(11), sku = catalog.skus[0]!;
    await f.db.update(storeProductAttrValue).set({ quota: 0 }).where(eq(storeProductAttrValue.id, 3));
    await expect(new StoreCartService(container).add({ uid: 11, productId: catalog.product_id, activityId: catalog.seckill_id,
      type: 1, unique: sku.unique, cartNum: 1, isNew: 1 })).rejects.toThrow("库存不足");
    expect((await snapshot()).carts).toEqual([]); expect((await read()).skus[0].stock).toBe(0);
  });
  it("blocks a new cart on identity collision and invalidates an existing cart when a later collision appears", async () => {
    const cart = new StoreCartService(container);
    const created = await cart.add({ uid: 11, productId: 70, activityId: 20, type: 1, unique: "actired1", cartNum: 1, isNew: 1 });
    await f.db.update(storeProductAttrValue).set({ unique: "basered1" }).where(eq(storeProductAttrValue.id, 4));
    const before = await snapshot();
    await expect(cart.list(11, { mode: "buy", ids: [created.id] })).rejects.toThrow("已失效");
    const response = await app.request("/api/cart/add", { method: "POST", headers: { "content-type": "application/json", "x-fixture-user": "11" },
      body: JSON.stringify({ productId: 70, activityId: 20, type: 1, unique: "basered1", cartNum: 1, new: 1 }) });
    expect(await response.json()).toMatchObject({ status: 400, msg: "活动与基础商品规格标识冲突" });
    expect(await snapshot()).toEqual(before);
  });
});
