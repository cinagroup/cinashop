import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { createPcCouponFixture } from "./helpers/pcCouponFixture";
import { storeBrand, storeProductCategory, storeProduct, storeCouponIssue, storeCouponProduct, storeCouponUser, user } from "../src/models/schema";
import { couponScopeProducts } from "../src/controllers/api/v1/CouponScopeProductsController";
import { couponScopeProductsQuery, CouponScopeProductsService } from "../src/services/activity/CouponScopeProductsService";
import { resolveOrderCoupon } from "../src/services/activity/OrderCouponService";
import { CouponProductsSession, emptyCouponProducts, normalizeCouponProducts } from "../../view/common/couponProducts";

describe("owned coupon scope browsing uses checkout membership and disposable SQL", () => {
  let f: Awaited<ReturnType<typeof createPcCouponFixture>>;
  beforeAll(async () => {
    f = await createPcCouponFixture([storeProductCategory, storeBrand]);
    f.app.get("/api/coupons/user/:id/products", couponScopeProducts);
    await f.db.insert(storeProductCategory).values([{ id: 1, pid: 0, path: "" }, { id: 2, pid: 1, path: "1" }, { id: 3, pid: 2, path: "1,2" }, { id: 4, pid: 0, path: "" }]);
    await f.db.insert(storeBrand).values([{ id: 1 }, { id: 2, pid: 1, fid: "1" }, { id: 3, pid: 2, fid: "1" }, { id: 4 }]);
    await f.db.update(storeProduct).set({ pid: 700, cateId: "3", brandId: 3 }).where(eq(storeProduct.id, 70));
    await f.db.insert(storeProduct).values([71, 72, 73, 74, 75, 76, 77].map(id => ({ id, storeName: `范围样本${id}`, price: "10.00",
      cateId: id === 72 ? "2" : "4", brandId: id === 72 ? 2 : 4, isShow: id === 74 ? 0 : 1,
      isDel: id === 75 ? 1 : 0, isVerify: id === 76 ? 0 : 1, isVipProduct: id === 77 ? 1 : 0 })));
    await f.db.insert(storeCouponIssue).values([
      { id: 10, couponType: 2, type: 1, legacyProductIds: "700,71", productId: "[71,700]" },
      { id: 11, couponType: 1, type: 1, legacyCategoryId: 1 },
      { id: 12, couponType: 3, type: 1, legacyBrandId: 1 },
      { id: 13, couponType: 1, type: 1, category_id: "[4]" },
      { id: 14, couponType: 3, type: 1, brandId: "4" },
      { id: 15, couponType: 2, type: 1, productId: "70" },
      { id: 16, couponType: 2, type: 1 },
    ]);
    await f.db.insert(storeCouponProduct).values([{ couponId: 10, productId: 71 }, { couponId: 10, productId: 700 }, { couponId: 15, productId: 71 }]);
    await f.db.insert(storeCouponUser).values([10, 11, 12, 13, 14, 15, 16].map(id => ({ id: id + 100, uid: 11, issueCouponId: id, couponPrice: "1.00" })));
  }, 30000);
  afterAll(async () => { await f?.close(); });
  const list = (id: number, limit = 100, before = 0) => new CouponScopeProductsService(f.container).list(11, { couponId: id, limit, before });
  async function request(id: string, uid = "11", query = "") {
    const response = await f.app.request(`/api/coupons/user/${id}/products${query}`, { headers: { "x-fixture-user": uid } }, f.env);
    return { response, body: await response.json() as { status: number; msg: string; data: unknown } };
  }
  it("matches the actual checkout resolver for product parents, JSON/CSV, category paths and brand ancestors", async () => {
    for (const [couponId, expected] of [[110, [71, 70]], [111, [72, 70]], [112, [72, 70]], [113, [73, 71]], [114, [73, 71]]] as const) {
      const result = await list(couponId);
      expect(result.list.map(p => p.id)).toEqual(expected); expect(result.scope_only).toBe(true); expect(result.next_cursor).toBeNull();
      for (const id of [70, 71, 72, 73]) {
        const [product] = await f.db.select().from(storeProduct).where(eq(storeProduct.id, id));
        const quote = resolveOrderCoupon(f.container, 11, couponId, [{ product, cart: { cartNum: 1 }, unitPriceCents: 1000 }]);
        if ((expected as readonly number[]).includes(id)) expect((await quote).priceCents).toBe(100);
        else await expect(quote).rejects.toThrow("不适用于当前商品");
      }
    }
  });
  it("keeps catalogue visibility, excludes hidden/deleted/unverified and gates VIP-only goods by the current user", async () => {
    expect((await list(41)).list.map(p => p.id)).toEqual([73, 72, 71, 70]);
    await f.db.update(user).set({ isMoneyLevel: 1 }).where(eq(user.uid, 11));
    try { expect((await list(41)).list.map(p => p.id)).toEqual([77, 73, 72, 71, 70]); }
    finally { await f.db.update(user).set({ isMoneyLevel: 0 }).where(eq(user.uid, 11)); }
  });
  it("advances by the last scanned product through empty pages without returning unrelated goods", async () => {
    expect(await list(110, 2)).toMatchObject({ list: [], next_cursor: 72 });
    expect(await list(110, 2, 72)).toMatchObject({ list: [{ id: 71 }, { id: 70 }], next_cursor: null });
    expect((await list(110, 2, 70)).list).toEqual([]);
    expect((await list(116)).list).toEqual([]); // An empty configured scope is not the full catalogue.
  });
  it("rejects conflicting encoded and relational scope even when no candidates remain", async () => {
    await expect(list(115)).rejects.toThrow("范围数据不一致");
    await expect(list(115, 20, 1)).rejects.toThrow("范围数据不一致");
  });
  it("supports encoded-only and relation-only product scope, but never converts malformed or missing templates into general coupons", async () => {
    await f.db.insert(storeCouponIssue).values([{ id: 17, couponType: 2, type: 1, legacyProductIds: "71" }, { id: 18, couponType: 2, type: 1 }, { id: 19, couponType: 9, type: 1 }]);
    await f.db.insert(storeCouponProduct).values({ couponId: 18, productId: 700 });
    await f.db.insert(storeCouponUser).values([17, 18, 19, 9999].map(id => ({ id: id + 1000, uid: 11, issueCouponId: id, couponPrice: "1.00" })));
    expect((await list(1017)).list.map(p => p.id)).toEqual([71]);
    expect((await list(1018)).list.map(p => p.id)).toEqual([70]);
    await expect(list(1019)).rejects.toThrow("当前不可用");
    await expect(list(10999)).rejects.toThrow("当前不可用");
  });
  it("binds every request to its owner, fails unavailable coupons and rechecks revocation on the next page", async () => {
    expect((await request("110", "22")).body).toMatchObject({ status: 400, msg: "优惠券不存在" });
    expect((await request("110", "")).body.status).toBe(400);
    expect((await request("999999")).body.msg).toBe("优惠券不存在");
    expect((await request("110", "11", "?uid=22&couponId=48&ids=73")).body.data).toMatchObject({ coupon_id: 110, list: [{ id: 71 }, { id: 70 }] });
    for (const id of [43, 44, 45, 46, 47]) await expect(list(id)).rejects.toThrow("当前不可用");
    await f.db.update(storeCouponUser).set({ isFail: 1 }).where(eq(storeCouponUser.id, 110));
    try { await expect(list(110, 2, 72)).rejects.toThrow("当前不可用"); }
    finally { await f.db.update(storeCouponUser).set({ isFail: 0 }).where(eq(storeCouponUser.id, 110)); }
  });
  it("does not misrepresent scope membership as an eligible price, threshold satisfaction or redemption", async () => {
    const result = await list(50);
    expect(result.list.some(p => p.id === 70)).toBe(true); expect(result.scope_only).toBe(true);
    const [product] = await f.db.select().from(storeProduct).where(eq(storeProduct.id, 70));
    await expect(resolveOrderCoupon(f.container, 11, 50, [{ product, cart: { cartNum: 1 }, unitPriceCents: 1000 }])).rejects.toThrow("才能使用该券");
    expect(result.list[0]).not.toHaveProperty("estimated_discount");
  });
  it("validates pagination, returns only explicit catalogue fields and never writes business state", async () => {
    const before = await f.snapshot(), coupons = await f.db.select().from(storeCouponUser), links = await f.db.select().from(storeCouponProduct);
    const result = await request("110");
    expect(result.body.status).toBe(200); expect(result.response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(Object.keys((await list(110)).list[0]).sort()).toEqual(["catalog_price", "id", "image", "store_name"]);
    for (const id of ["0", "-1", "1.0", "NaN", "9007199254740992"]) expect((await request(id)).body.status).toBe(400);
    for (const query of [{ limit: "101" }, { limit: "0" }, { before: "-1" }, { before: "1x" }, { page: "1" }]) expect(() => couponScopeProductsQuery("110", query)).toThrow();
    expect(await f.snapshot()).toEqual(before); expect(await f.db.select().from(storeCouponUser)).toEqual(coupons);
    expect(await f.db.select().from(storeCouponProduct)).toEqual(links); expect(f.writes).toEqual([]);
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    expect(routes).toContain('v1Routes.get("/coupons/user/:id/products", authMiddleware({ force: true }), couponScopeProducts)');
  });
  it("feeds the shared frontend adapter and session through real controller pages, including an empty scanned page", async () => {
    let state = emptyCouponProducts(); const cursors: Array<number | undefined> = [];
    const session = new CouponProductsSession(async (id, before) => {
      cursors.push(before);
      const result = await request(String(id), "11", `?limit=2${before === undefined ? "" : `&before=${before}`}`);
      expect(result.body.status).toBe(200);
      return normalizeCouponProducts(result.body.data, id, before);
    }, next => { state = next; });
    await session.load(110); expect(state).toMatchObject({ loaded: true, list: [], nextCursor: 72, error: "" });
    await session.load(110, true); expect(state.list.map(p => p.id)).toEqual([71, 70]); expect(state.nextCursor).toBeNull();
    expect(state.list[0]).toMatchObject({ title: "范围样本71", catalogPrice: "10.00" }); expect(cursors).toEqual([undefined, 72]);
    await session.load(110, true); expect(cursors).toHaveLength(2); session.reset(); expect(state).toEqual(emptyCouponProducts());
  });
});
