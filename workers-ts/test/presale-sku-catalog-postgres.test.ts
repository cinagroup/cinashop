import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { AppVariables, Env } from "../src/env";
import { createContainerFromDb } from "../src/lib/di";
import { storeProduct, storeProductAttrValue, storeCart, storeOrder, user } from "../src/models/schema";
import { PresaleSkuCatalogService } from "../src/services/activity/PresaleSkuCatalogService";
import { detail, presaleList } from "../src/controllers/api/v1/ProductController";
import { PublicCatalogService } from "../src/services/product/PublicCatalogService";
import { financePostgres } from "./helpers/financePostgres";
import { parsePresaleSelection, presaleCartInput } from "../../view/common/presalePurchase";
import { parsePresaleCatalog } from "../../view/common/presaleCatalog";

const now = new Date("2026-09-21T02:00:00.500Z"), stamp = Math.floor(now.getTime() / 1000);
describe("presale selection view with real disposable SQL", () => {
  let f: Awaited<ReturnType<typeof financePostgres>>, service: PresaleSkuCatalogService;
  let app: Hono<{ Bindings: Env; Variables: AppVariables }>;
  beforeAll(async () => {
    f = await financePostgres([storeProduct, storeProductAttrValue, storeCart, storeOrder, user]);
    const container = createContainerFromDb(f.db); service = new PresaleSkuCatalogService(container);
    app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    // Synthetic principal only: production middleware/JWT/Hyperdrive are not exercised here.
    app.use("*", async (c, next) => { c.set("container", container); c.set("uid", c.req.header("x-fixture-user") === "11" ? 11 : 0); await next(); });
    app.onError((error, c) => c.json({ status: 400, msg: error.message, data: null }));
    app.get("/api/product/detail/:id/:type?", detail);
    app.get("/api/presale/list", presaleList);
  }, 60_000);
  afterAll(async () => { await f?.close(); }, 60_000);
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
  beforeEach(async () => {
    vi.setSystemTime(now); await f.reset();
    await f.db.insert(user).values({ uid: 11, account: "presale-fixture", status: 1 });
    await f.db.insert(storeProduct).values({ id: 70, storeName: "预售<script>文本</script>", storeInfo: "全款预售",
      stock: 7, sales: 3, ficti: 900, price: "100.00", isShow: 1, isVerify: 1, unitName: "件", image: "/base.svg",
      sliderImage: JSON.stringify(["/base.svg", "https://example.invalid/image.jpg"]), isPresaleProduct: 1,
      presaleStartTime: stamp - 3600, presaleEndTime: stamp + 3600, presaleDay: 7 });
    await f.db.insert(storeProductAttrValue).values([
      { id: 1, productId: 70, type: 0, unique: "pres0001", suk: "红色", stock: 9, price: "80.25", otPrice: "100.00", vipPrice: "1.00", cost: "2.00" },
      { id: 2, productId: 70, type: 0, unique: "pres0002", suk: "蓝色", stock: 2, price: "90.50", otPrice: "120.00", image: "/blue.svg" },
      { id: 3, productId: 70, type: 6, unique: "wrong006", suk: "不可读取", stock: 100, price: "0.01" },
      { id: 4, productId: 71, type: 0, unique: "other001", suk: "其它商品", stock: 100, price: "0.02" },
      { id: 5, productId: 70, type: 0, unique: "retired1", suk: "已退役", stock: 100, isRetired: 1 },
    ]);
  });
  const read = (uid = 0, clock = now) => service.read(uid, "70", clock);
  const snapshot = () => Promise.all([f.db.select().from(storeProduct), f.db.select().from(storeProductAttrValue),
    f.db.select().from(user), f.db.select().from(storeCart), f.db.select().from(storeOrder)]);

  it("returns only live type-0 base SKUs, exact decimals and configured shipping without writes or private fields", async () => {
    const before = await snapshot(), result = await read();
    expect(result).toMatchObject({ version: 1, selection_only: true, type: 6, payment_mode: "full", product_id: 70,
      title: "预售<script>文本</script>", subtitle: "全款预售", sales: 3, unit_name: "件", product_type: 0, system_form_id: 0,
      schedule: { state: "active", presale_pay_status: 2, shipping_days_after_end: 7 }, skus: [
        { unique: "pres0001", base_unique: "pres0001", catalog_price: "80.25", ot_price: "100.00", stock: 7, max_quantity: 7, image: "/base.svg" },
        { unique: "pres0002", base_unique: "pres0002", catalog_price: "90.50", stock: 2, max_quantity: 2, image: "/blue.svg" },
      ] });
    expect(result.skus).toHaveLength(2);
    expect(JSON.stringify(result)).not.toMatch(/cost|brokerage|vip_price|account|pwd|can_buy|deposit/);
    expect(await snapshot()).toEqual(before);
  });
  it("feeds the shared frontend contract using a real HTTP response, without creating a cart or quoting", async () => {
    const before = await snapshot();
    const response = await app.request('/api/product/detail/70?view=presale');
    const body = await response.json() as { data: unknown };
    const parsed = parsePresaleSelection(body.data, 70);
    expect(parsed.purchase_limits).toEqual({ mode: 'none', quantity: null });
    expect(presaleCartInput(parsed, 'pres0001', 2, now.getTime())).toEqual({ productId: 70, activityId: 0, type: 6, unique: 'pres0001', cartNum: 2, new: 1 });
    expect(await snapshot()).toEqual(before);
  });
  it("reports stock separately from per-order bounds and explicitly closes cumulative mode", async () => {
    await f.db.update(storeProduct).set({ isLimit: 1, limitType: 1, limitNum: 3 });
    let result = await read();
    expect(result.purchase_limits).toEqual({ mode: 'per_order', quantity: 3 });
    expect(result.skus.map(sku => [sku.stock, sku.max_quantity])).toEqual([[7, 3], [2, 2]]);
    expect(() => presaleCartInput(parsePresaleSelection(result, 70), 'pres0001', 4, now.getTime())).toThrow('数量');
    await f.db.update(storeProduct).set({ limitType: 2 });
    result = await read();
    expect(result.purchase_limits).toEqual({ mode: 'cumulative', quantity: 3 });
    expect(result.skus.map(sku => [sku.stock, sku.max_quantity])).toEqual([[7, 0], [2, 0]]);
    expect(() => presaleCartInput(parsePresaleSelection(result, 70), 'pres0001', 1, now.getTime())).toThrow('不可购买');
  });
  it('feeds both frontend catalogues from actual SQL HTTP rows for all three time filters without writes', async () => {
    for (const [type, start, end] of [[1, stamp + 1, stamp + 60], [2, stamp, stamp], [3, stamp - 60, stamp - 1]] as const) {
      await f.db.update(storeProduct).set({ presaleStartTime: start, presaleEndTime: end });
      const before = await snapshot();
      const response = await app.request(`/api/presale/list?time_type=${type}&page=1&limit=8`);
      const body = await response.json() as { data: unknown };
      const parsed = parsePresaleCatalog(body.data, type, 1);
      expect(parsed).toMatchObject({ count: 1, list: [{ id: 70, price: '100.00', shippingDays: 7 }] });
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      const selected = await app.request(`/api/product/detail/${parsed.list[0].id}?view=presale`);
      expect(parsePresaleSelection((await selected.json() as { data: unknown }).data, 70).schedule.presale_pay_status).toBe(type);
      expect(await snapshot()).toEqual(before);
    }
  });
  it.each([{ isLimit: 2 }, { isLimit: 1, limitType: 0, limitNum: 3 }, { isLimit: 1, limitType: 1, limitNum: 0 },
    { isLimit: 1, limitType: 2, limitNum: -1 }])("rejects invalid purchase limits rather than advertising stock: %j", async config => {
    await f.db.update(storeProduct).set(config);
    const before = await snapshot(); await expect(read()).rejects.toThrow('限购配置无效'); expect(await snapshot()).toEqual(before);
  });
  it.each([['sku', '0'], ['sku', '750ms'], ['list', '0'], ['list', '750ms']])("%s uses one read-only snapshot and preserves the caller deadline %s", async (view, deadline) => {
    const transaction = f.db.transaction.bind(f.db), observed: unknown[] = [];
    let transactionCount = 0;
    // Interpose without replacing the PGlite adapter's own transaction method:
    // replacing it would wrap the raw-row adapter twice rather than test the service.
    const intercept: typeof f.db.transaction = (fn, config) => transaction(async tx => {
      transactionCount++;
      // SET, not a read query: the service can still establish transaction isolation next.
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${deadline}'`));
      await tx.execute(sql.raw(`SET LOCAL idle_in_transaction_session_timeout = '${deadline}'`));
      const queries = vi.spyOn(tx, "select");
      try {
        const result = await fn(tx);
        expect(queries).toHaveBeenCalledTimes(3); // principal + product/SKU, or principal + list/count
        observed.push(...await tx.execute(sql`SELECT current_setting('transaction_isolation') AS isolation,
          current_setting('transaction_read_only') AS readonly, current_setting('statement_timeout') AS deadline,
          current_setting('idle_in_transaction_session_timeout') AS idle`));
        // Use the driver's savepoint API so postgres.js also scopes its error tracker.
        await expect(tx.transaction(async guard => {
          await guard.update(storeProduct).set({ stock: 999 }).where(eq(storeProduct.id, 70));
        }))
          .rejects.toMatchObject({ cause: { code: "25006" } });
        return result;
      } finally { queries.mockRestore(); }
    }, config);
    const instrumented = createContainerFromDb(new Proxy(f.db, {
      get(target, property, receiver) { return property === "transaction" ? intercept : Reflect.get(target, property, receiver); },
    }));
    const before = await snapshot();
    if (view === 'sku') await new PresaleSkuCatalogService(instrumented).read(11, '70', now);
    else await new PublicCatalogService(instrumented, {} as Env).presale(11, 0, 1, 10);
    expect(transactionCount).toBe(1);
    expect(observed).toEqual([{ isolation: "repeatable read", readonly: "on",
      deadline: deadline === "0" ? "5s" : "750ms", idle: deadline === "0" ? "5s" : "750ms" }]);
    expect(await snapshot()).toEqual(before);
    const [restored] = await f.db.execute(sql`SHOW transaction_read_only`);
    expect(restored).toEqual({ transaction_read_only: "off" });
  });
  it("keeps future/ended detail browseable and includes the whole final second", async () => {
    for (const [clock, state] of [[stamp - 3601, "future"], [stamp - 3600, "active"], [stamp + 3600, "active"], [stamp + 3601, "ended"]] as const) {
      expect(await read(0, new Date(clock * 1000 + 999))).toMatchObject({ schedule: { state }, skus: [{ unique: "pres0001" }, { unique: "pres0002" }] });
    }
  });
  it("mounts the opt-in contract with private no-store and does not trust UID/VIP/type query overrides", async () => {
    const response = await app.request("/api/product/detail/70?view=presale&uid=11&vip=1&type=6");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ status: 200, data: { type: 6, product_id: 70, skus: [{ unique: "pres0001" }, { unique: "pres0002" }] } });
    await f.db.update(storeProduct).set({ isVipProduct: 1 });
    expect(await (await app.request("/api/product/detail/70?view=presale&uid=11&vip=1")).json()).toMatchObject({ status: 400, data: null });
    await f.db.update(user).set({ isMoneyLevel: 1, overdueTime: stamp + 60 });
    expect(await (await app.request("/api/product/detail/70?view=presale", { headers: { "x-fixture-user": "11" } })).json())
      .toMatchObject({ status: 200, data: { product_id: 70 } });
  });
  it.each([
    { name: 'anonymous', uid: 0, paid: 0, ever: 0, expiry: 0, visible: false },
    { name: 'ordinary', uid: 11, paid: 0, ever: 0, expiry: stamp + 60, visible: false },
    { name: 'expired', uid: 11, paid: 1, ever: 0, expiry: stamp - 1, visible: false },
    { name: 'expiry boundary', uid: 11, paid: 1, ever: 0, expiry: stamp, visible: false },
    { name: 'active', uid: 11, paid: 1, ever: 0, expiry: stamp + 1, visible: true },
    { name: 'lifetime', uid: 11, paid: 0, ever: 1, expiry: 0, visible: true },
  ])('keeps list/count and SKU visibility consistent for $name', async entry => {
    await f.db.update(user).set({ isMoneyLevel: entry.paid, isEverLevel: entry.ever, overdueTime: entry.expiry });
    await f.db.update(storeProduct).set({ isVipProduct: 1 });
    const [vip] = await f.db.select().from(storeProduct);
    await f.db.insert(storeProduct).values([{ ...vip, id: 71, isVipProduct: 0 }, { ...vip, id: 72, isVipProduct: 2 }]);
    const before = await snapshot();
    const headers = entry.uid ? { 'x-fixture-user': '11' } : undefined;
    const response = await app.request('/api/presale/list?uid=11&vip=1', { headers });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = await response.json() as { data: { list: { id: number }[]; count: number } };
    expect(body.data.count).toBe(entry.visible ? 2 : 1);
    expect(body.data.list.map(row => row.id)).toEqual(entry.visible ? [71, 70] : [71]);
    if (entry.visible) expect(await read(entry.uid)).toMatchObject({ product_id: 70 });
    else await expect(read(entry.uid)).rejects.toThrow('不存在或不可见');
    expect(JSON.stringify(body)).not.toMatch(/presale-fixture|overdue_time|is_ever_level|pwd/);
    expect(await snapshot()).toEqual(before);
  });
  it('rejects missing, disabled or deleted principals for lists as well as selections', async () => {
    const catalog = new PublicCatalogService(createContainerFromDb(f.db), {} as Env);
    for (const patch of [{ status: 0, isDel: 0 }, { status: 1, isDel: 1 }]) {
      await f.db.update(user).set(patch);
      await expect(catalog.presale(11, 0, 1, 10)).rejects.toThrow('重新登录');
      await expect(read(11)).rejects.toThrow('重新登录');
    }
    await expect(catalog.presale(99, 0, 1, 10)).rejects.toThrow('重新登录');
    for (const uid of [-1, NaN, 0.5, 2_147_483_648]) await expect(catalog.presale(uid, 0, 1, 10)).rejects.toThrow('用户无效');
    await expect(catalog.presale(0, NaN, 1, 10)).rejects.toThrow('时段');
    await expect(catalog.presale(0, 0, 2_147_483_647, 100)).rejects.toThrow('页码');
  });
  it('uses one clock for time filters and status, and stable ID ordering for equal timestamps', async () => {
    const [product] = await f.db.select().from(storeProduct);
    await f.db.insert(storeProduct).values([
      { ...product, id: 71, presaleStartTime: stamp + 1, presaleEndTime: stamp + 60 },
      { ...product, id: 72, presaleStartTime: stamp - 60, presaleEndTime: stamp - 1 },
      { ...product, id: 73, presaleStartTime: stamp, presaleEndTime: stamp },
    ]);
    const catalog = new PublicCatalogService(createContainerFromDb(f.db), {} as Env);
    for (const [type, ids] of [[1, [71]], [2, [73, 70]], [3, [72]]] as const) {
      const result = await catalog.presale(0, type, 1, 10);
      expect(result.list.map(row => row.id)).toEqual(ids);
      expect(result.list.every(row => row.presale_pay_status === type)).toBe(true);
      expect(result.count).toBe(ids.length);
    }
    expect((await catalog.presale(0, 0, 1, 2)).list.map(row => row.id)).toEqual([73, 72]);
    expect((await catalog.presale(0, 0, 2, 2)).list.map(row => row.id)).toEqual([71, 70]);
  });
  it("rejects malformed IDs/principals and unknown, duplicate or conflicting views before SQL", async () => {
    const spy = vi.spyOn(f.db, "transaction");
    for (const id of [undefined, 70, "0", "-1", "01", " 70", "70 ", "7e1", "70.0", "2147483648", "1;select"]) {
      await expect(service.read(0, id)).rejects.toThrow("ID无效");
    }
    for (const uid of [-1, NaN, 0.5, 2_147_483_648]) await expect(service.read(uid, "70")).rejects.toThrow("参数无效");
    await expect(service.read(0, "70", new Date(NaN))).rejects.toThrow("参数无效");
    for (const path of ["70?view=other", "70?view=", "70?view=presale&view=presale", "70/6?view=presale"]) {
      const response = await app.request(`/api/product/detail/${path}`);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toMatchObject({ status: 400, data: null });
    }
    expect(spy).not.toHaveBeenCalled();
  });
  it("rechecks current principal and product visibility without falling back to ordinary products", async () => {
    for (const patch of [{ isShow: 0 }, { isDel: 1 }, { isVerify: 0 }, { isPresaleProduct: 0 }, { isPresaleProduct: 2 }]) {
      await f.db.update(storeProduct).set({ isShow: 1, isDel: 0, isVerify: 1, isPresaleProduct: 1, ...patch });
      await expect(read()).rejects.toThrow("不存在或不可见");
    }
    await f.db.update(storeProduct).set({ isPresaleProduct: 1 });
    for (const patch of [{ status: 0 }, { isDel: 1 }]) {
      await f.db.update(user).set({ status: 1, isDel: 0, ...patch });
      await expect(read(11)).rejects.toThrow("重新登录");
    }
    await expect(read(99)).rejects.toThrow("重新登录");
  });
  it("uses current stock/prices and treats missing or sold-out SKUs as unavailable selections", async () => {
    await read();
    await f.db.update(storeProductAttrValue).set({ price: "82.34", stock: 0 }).where(eq(storeProductAttrValue.id, 1));
    expect((await read()).skus[0]).toMatchObject({ catalog_price: "82.34", stock: 0, max_quantity: 0 });
    await f.db.update(storeProductAttrValue).set({ isRetired: 1 }).where(eq(storeProductAttrValue.productId, 70));
    expect((await read()).skus).toEqual([]);
  });
  it("rejects duplicate/padded base identities and bad stock, amount or time configuration", async () => {
    await f.db.update(storeProductAttrValue).set({ unique: "pres0001" }).where(eq(storeProductAttrValue.id, 2));
    await expect(read()).rejects.toThrow("标识");
    await f.db.update(storeProductAttrValue).set({ unique: "short" }).where(eq(storeProductAttrValue.id, 2));
    await expect(read()).rejects.toThrow("标识");
    await f.db.update(storeProductAttrValue).set({ unique: "pres0002" }).where(eq(storeProductAttrValue.id, 2));
    await f.db.update(storeProductAttrValue).set({ stock: -1 }).where(eq(storeProductAttrValue.id, 2));
    await expect(read()).rejects.toThrow("库存");
    await f.db.update(storeProductAttrValue).set({ stock: 1, price: "-1.00" }).where(eq(storeProductAttrValue.id, 2));
    await expect(read()).rejects.toThrow("价格");
    await f.db.update(storeProductAttrValue).set({ price: "1.00" }).where(eq(storeProductAttrValue.id, 2));
    await f.db.update(storeProduct).set({ presaleStartTime: stamp + 7200 });
    await expect(read()).rejects.toThrow("时间");
  });
  it("fails explicitly for 501 live SKUs instead of dropping unseen variants", async () => {
    await f.db.insert(storeProductAttrValue).values(Array.from({ length: 499 }, (_, index) => ({ id: index + 10,
      productId: 70, type: 0, unique: `x${String(index).padStart(7, "0")}`, suk: String(index), stock: 1 })));
    await expect(read()).rejects.toThrow("超过500项");
  });
  it("bounds optional images, drops unsafe URLs and keeps restricted product/form information explicit", async () => {
    await f.db.update(storeProduct).set({ image: "http://example.invalid/unsafe.jpg", productType: 3, systemFormId: 9,
      sliderImage: JSON.stringify(["javascript:alert(1)", "//external.invalid/a", "https://user:pass@example.invalid/a", "/safe.svg", "/safe.svg",
        ...Array.from({ length: 25 }, (_, index) => `/pic${index}.svg`)]) });
    const result = await read();
    expect(result).toMatchObject({ image: "", product_type: 3, system_form_id: 9 });
    expect(result.images[0]).toBe("/safe.svg"); expect(result.images.length).toBeLessThanOrEqual(20);
    expect(result.images.every(value => value.startsWith("/") && !value.startsWith("//"))).toBe(true);
    await f.db.update(storeProduct).set({ image: "/base.svg", sliderImage: "invalid-json" });
    expect((await read()).images).toEqual(["/base.svg"]);
  });
});
