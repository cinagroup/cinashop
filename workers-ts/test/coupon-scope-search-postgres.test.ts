import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createPcCouponFixture } from "./helpers/pcCouponFixture";
import { storeBrand, storeProductCategory, storeProduct, storeCouponIssue, storeCouponProduct, storeCouponUser, user } from "../src/models/schema";
import { couponScopeProducts } from "../src/controllers/api/v1/CouponScopeProductsController";
import { CouponScopeProductsService } from "../src/services/activity/CouponScopeProductsService";
import { couponScopeSearchQuery, couponScopeSorts } from "../src/services/activity/CouponScopeSearch";

describe("owned coupon global search and bounded sparse scanning (real disposable SQL)", () => {
  let f: Awaited<ReturnType<typeof createPcCouponFixture>>;
  beforeAll(async () => {
    f = await createPcCouponFixture([storeProductCategory, storeBrand]);
    f.app.get("/api/coupons/user/:id/products", couponScopeProducts);
    await f.db.insert(storeProductCategory).values([{ id: 1 }, { id: 3, pid: 1, path: "1" }]);
    await f.db.insert(storeBrand).values([{ id: 1 }, { id: 3, pid: 1, fid: "1" }]);
    const prices = ["9.99", "2.00", "2.00", "100.00", "0.00", "9999999999.99", "9.99"];
    const sorts = [0, 4, 4, -1, 2, 0, 0], stars = ["3.0", "5.0", "5.0", "4.0", "5.0", "3.0", "3.0"];
    const sales = [1, 2, 1, 10, 0, 2147483647, 1], ficti = [0, 0, 1, 0, 0, 2147483647, 0];
    await f.db.insert(storeProduct).values(prices.map((price, i) => ({ id: 100 + i, storeName: `Mode${i}`, price,
      sort: sorts[i], star: stars[i], sales: sales[i], ficti: ficti[i], pid: i === 0 ? 700 : 0,
      cateId: i === 0 ? "3e0" : "4", brandId: i === 0 ? 3 : 4, isShow: 1, isDel: 0, isVerify: 1 })));
    await f.db.insert(storeProduct).values([110, 111, 112, 113].map(id => ({ id, storeName: `Mode private ${id}`,
      isShow: id === 110 ? 0 : 1, isDel: id === 111 ? 1 : 0, isVerify: id === 112 ? 0 : 1, isVipProduct: id === 113 ? 1 : 0 })));
    await f.db.insert(storeProduct).values([{ id: 120, storeName: "折扣100%_\\中'文", isShow: 1, isVerify: 1 },
      { id: 121, storeName: "折扣100XYZ中'文", isShow: 1, isVerify: 1 }]);
    await f.db.insert(storeProduct).values(Array.from({ length: 605 }, (_, i) => ({ id: 200 + i,
      storeName: `Sparse${i}`, isShow: 1, isVerify: 1, pid: i === 0 ? 900 : 0 })));
    await f.db.insert(storeCouponIssue).values([
      { id: 10, couponType: 2, type: 1, productId: "700,101" },
      { id: 11, couponType: 1, type: 1, category_id: "1" },
      { id: 12, couponType: 3, type: 1, brandId: "1" },
      { id: 13, couponType: 2, type: 1, productId: "900" },
      { id: 14, couponType: 2, type: 1, productId: "200,302,500,804" },
      { id: 15, couponType: 2, type: 1, productId: "100" },
      { id: 16, couponType: 2, type: 1 },
    ]);
    await f.db.insert(storeCouponProduct).values([{ couponId: 10, productId: 700 }, { couponId: 10, productId: 101 }, { couponId: 15, productId: 101 }]);
    await f.db.insert(storeCouponUser).values([10, 11, 12, 13, 14, 15, 16].map(id => ({ id: id + 1000, uid: 11, issueCouponId: id, couponPrice: "1.00" })));
  }, 30000);
  afterAll(async () => { await f?.close(); });
  const search = (couponId = 41, query: Record<string, string | undefined> = {}, uid = 11) =>
    new CouponScopeProductsService(f.container).search(uid, String(couponId), { view: "search", keyword: "Mode", ...query });

  it.each([
    ["recommended", [102, 101, 104, 106, 105, 100, 103]],
    ["rating", [102, 101, 104, 103, 106, 105, 100]],
    ["newest", [106, 105, 104, 103, 102, 101, 100]],
    ["price_asc", [104, 102, 101, 106, 100, 103, 105]],
    ["price_desc", [105, 103, 106, 100, 102, 101, 104]],
    ["sales_asc", [104, 106, 100, 102, 101, 103, 105]],
    ["sales_desc", [105, 103, 102, 101, 106, 100, 104]],
  ] as const)("globally orders %s with all tie keys, exact decimals and replayable keyset pages", async (sort, expected) => {
    const result: number[] = []; let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const next = await search(41, { sort, limit: "2", cursor });
      expect(next).toEqual(await search(41, { sort, limit: "2", cursor }));
      result.push(...next.list.map(row => row.id));
      expect(next).toMatchObject({ sort, scope_only: true, scan_limit_reached: false });
      if (!next.next_cursor) break;
      expect(next.next_cursor).not.toBe(cursor); cursor = next.next_cursor;
    }
    expect(result).toEqual(expected);
  });
  it("uses literal case-insensitive names, including Chinese, quotes and escaped LIKE metacharacters", async () => {
    expect((await search(41, { keyword: "  mOdE  " })).list).toHaveLength(7);
    for (const keyword of ["%", "_", "\\", "%_\\", "100%_\\中'文"]) {
      expect((await search(41, { keyword })).list.map(row => row.id)).toEqual([120]);
    }
    expect((await search(41, { keyword: "中'文" })).list.map(row => row.id)).toEqual([121, 120]);
    expect((await search(41, { keyword: "' OR 1=1 --" })).list).toEqual([]);
  });
  it("reuses checkout membership for parents and legacy numeric category tokens, without broadening the scope", async () => {
    for (const sort of couponScopeSorts) {
      expect((await search(1010, { sort })).list.map(row => row.id).sort()).toEqual([100, 101]);
      for (const id of [1011, 1012]) expect((await search(id, { sort })).list.map(row => row.id)).toEqual([100]);
    }
    expect(await search(1016)).toMatchObject({ list: [], scanned_count: 0, next_cursor: null });
    await expect(search(1015, { keyword: "no matches" })).rejects.toThrow("范围数据不一致");
  });
  it("stops after 500 candidates and returns continuation, not false exhaustion, even with no matches", async () => {
    const spy = vi.spyOn(f.db, "select");
    let first: Awaited<ReturnType<typeof search>>;
    try { first = await search(1013, { keyword: "Sparse", sort: "newest" }); expect(spy.mock.calls.length).toBeLessThanOrEqual(8); }
    finally { spy.mockRestore(); }
    expect(first).toMatchObject({ list: [], scanned_count: 500, scan_limit_reached: true });
    expect(first.next_cursor).toEqual(expect.any(String));
    const next = await search(1013, { keyword: "Sparse", sort: "newest", cursor: first.next_cursor! });
    expect(next).toMatchObject({ list: [{ id: 200 }], scanned_count: 105, scan_limit_reached: false, next_cursor: null });
  });
  it("fills sparse pages across batches and resumes at the examined row without skipping the batch tail", async () => {
    const first = await search(1014, { keyword: "Sparse", sort: "newest", limit: "2" });
    expect(first).toMatchObject({ list: [{ id: 804 }, { id: 500 }], scanned_count: 305, scan_limit_reached: false });
    const next = await search(1014, { keyword: "Sparse", sort: "newest", limit: "2", cursor: first.next_cursor! });
    expect(next).toMatchObject({ list: [{ id: 302 }, { id: 200 }], scanned_count: 300, next_cursor: null });
  });
  it("continues from stored ordering keys even when the anchor row no longer exists", async () => {
    await f.db.insert(storeProduct).values([130, 131, 132].map(id => ({ id, storeName: `Anchor${id}`, price: "10.00", isShow: 1, isVerify: 1 })));
    const first = await search(41, { keyword: "Anchor", sort: "price_asc", limit: "1" });
    expect(first.list.map(row => row.id)).toEqual([132]);
    await f.db.delete(storeProduct).where(eq(storeProduct.id, 132));
    expect((await search(41, { keyword: "Anchor", sort: "price_asc", cursor: first.next_cursor! })).list.map(row => row.id)).toEqual([131, 130]);
  });
  it("rejects cross-query, cross-coupon and changed-scope cursors and rechecks owner, revocation and VIP state", async () => {
    const first = await search(1010, { limit: "1" }); const cursor = first.next_cursor!;
    for (const query of [{ keyword: "Mode0" }, { sort: "rating" }]) await expect(search(1010, { ...query, cursor })).rejects.toThrow("已变化");
    await expect(search(41, { cursor })).rejects.toThrow("已变化");
    await expect(search(1010, { cursor }, 22)).rejects.toThrow("优惠券不存在");
    await expect(search(1010, { cursor }, 0)).rejects.toThrow("请先登录");
    for (const id of [43, 44, 45, 46, 47, 99999]) await expect(search(id)).rejects.toThrow();
    await f.db.update(storeCouponUser).set({ isFail: 1 }).where(eq(storeCouponUser.id, 1010));
    try { await expect(search(1010, { cursor })).rejects.toThrow("当前不可用"); }
    finally { await f.db.update(storeCouponUser).set({ isFail: 0 }).where(eq(storeCouponUser.id, 1010)); }
    await f.db.update(user).set({ isMoneyLevel: 1 }).where(eq(user.uid, 11));
    try { await expect(search(1010, { cursor })).rejects.toThrow("已变化"); expect((await search()).list.some(row => row.id === 113)).toBe(true); }
    finally { await f.db.update(user).set({ isMoneyLevel: 0 }).where(eq(user.uid, 11)); }
    await f.db.update(storeCouponIssue).set({ productId: "700,102" }).where(eq(storeCouponIssue.id, 10));
    await f.db.update(storeCouponProduct).set({ productId: 102 }).where(eq(storeCouponProduct.productId, 101));
    try { await expect(search(1010, { cursor })).rejects.toThrow("已变化"); }
    finally {
      await f.db.update(storeCouponIssue).set({ productId: "700,101" }).where(eq(storeCouponIssue.id, 10));
      await f.db.update(storeCouponProduct).set({ productId: 101 }).where(eq(storeCouponProduct.productId, 102));
    }
    // Use a scope with more than one result to guarantee a continuation token.
    const generic = await search(41, { limit: "1" });
    await f.db.update(storeCouponIssue).set({ couponType: 1, category_id: "1" }).where(eq(storeCouponIssue.id, 1));
    try { await expect(search(41, { cursor: generic.next_cursor! })).rejects.toThrow("已变化"); }
    finally { await f.db.update(storeCouponIssue).set({ couponType: 0, category_id: "" }).where(eq(storeCouponIssue.id, 1)); }
  });
  it("does not treat a forged position as scope or visibility authorization and rejects unsafe cursor fields", async () => {
    const first = await search(1010, { limit: "1" });
    const token = JSON.parse(Buffer.from(first.next_cursor!, "base64url").toString("utf8"));
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const forged = [...token]; forged[2] = "2147483647";
    expect((await search(1010, { cursor: encode(forged) })).list.map(row => row.id).sort()).toEqual([100, 101]);
    const spy = vi.spyOn(f.db, "select");
    try {
      for (const [index, value] of [[0, 2], [1, ""], [2, "0;SELECT 1"], [2, "NaN"], [2, "1e30"], [3, "2147483648"], [4, 0], [4, 2147483648], [4, "100"]]) {
        const bad = [...token]; bad[Number(index)] = value;
        await expect(search(1010, { cursor: encode(bad) })).rejects.toThrow("参数或游标无效");
      }
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
  it("distinguishes an exactly exhausted 500-row catalogue from the scan limit", async () => {
    await f.db.insert(storeProduct).values(Array.from({ length: 500 }, (_, i) => ({ id: 900 + i, storeName: "Boundary", isShow: 1, isVerify: 1 })));
    expect(await search(1010, { keyword: "Boundary" })).toMatchObject({ list: [], scanned_count: 500, scan_limit_reached: false, next_cursor: null });
  });
  it("validates malformed input before any SQL and never accepts raw order expressions or mixed pagination", async () => {
    const spy = vi.spyOn(f.db, "select");
    try {
      for (const query of [{ sort: "price desc; DROP TABLE user" }, { keyword: "x".repeat(101) }, { keyword: "a\u0000b" },
        { cursor: "" }, { cursor: "x".repeat(513) }, { cursor: "W10" }, { before: "0" }, { page: "1" }, { limit: "NaN" }, { limit: "0" }, { limit: "101" }]) {
        await expect(search(41, query)).rejects.toThrow();
      }
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
    for (const id of ["0", "1.0", "-1", "9007199254740992"]) expect(() => couponScopeSearchQuery(id, { view: "search" })).toThrow();
  });
  it("returns only scope/catalogue data through the private controller, with no redemption or business writes", async () => {
    const before = await f.snapshot(), coupons = await f.db.select().from(storeCouponUser), links = await f.db.select().from(storeCouponProduct);
    const response = await f.app.request("/api/coupons/user/41/products?view=search&keyword=Mode&sort=price_asc&limit=2&uid=22&ids=113", { headers: { "x-fixture-user": "11" } }, f.env);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ status: 200, data: { coupon_id: 41, scope_only: true, list: [{ id: 104 }, { id: 102 }] } });
    expect(Object.keys((await search()).list[0]).sort()).toEqual(["catalog_price", "id", "image", "store_name"]);
    expect((await search(50)).list).toHaveLength(7); // Scope browsing does not promise minimum spend is met.
    expect(await f.snapshot()).toEqual(before); expect(await f.db.select().from(storeCouponUser)).toEqual(coupons);
    expect(await f.db.select().from(storeCouponProduct)).toEqual(links); expect(f.writes).toEqual([]);
  });
});
