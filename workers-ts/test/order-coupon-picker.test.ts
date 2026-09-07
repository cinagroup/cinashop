import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { createPcCouponFixture } from "./helpers/pcCouponFixture";
import { orderCoupons, parseOrderCouponRequest } from "../src/controllers/api/v1/OrderCouponController";
import { StoreOrderCreateService } from "../src/services/order/StoreOrderCreateService";
import { eligibleOrderCoupons } from "../src/services/activity/OrderCouponService";
import { storeBrand, storeProductCategory, storeCouponIssue, storeCouponUser, storeCouponProduct, storeProduct, storeCart } from "../src/models/schema";

describe("order coupon request bounds and real route wiring", () => {
  it("preserves legacy cartId/new without using an amount supplied by the client", () => {
    expect(parseOrderCouponRequest({ cartId: "1,2", new: "1" })).toMatchObject({ cartIds: [1, 2], isNew: 1, couponQuery: { limit: 1000, before: 0, unpaged: true } });
    expect(parseOrderCouponRequest({ cartId: "1", before: "5", limit: "2" }).couponQuery).toEqual({ limit: 2, before: 5, unpaged: false });
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    expect(routes).toContain('v1Routes.get("/coupons/order/:price", stationOpenMiddleware(), authMiddleware({ force: true }), OrderCouponController.orderCoupons)');
  });
  it.each([{}, { cartId: "" }, { cartId: "1,1" }, { cartId: "1," }, { cartId: "-1" }, { cartId: "1e2" },
    { cartId: "1", new: "2" }, { cartId: "1", limit: "101" }, { cartId: "1", before: "-1" },
    { cartId: "1", page: "2" }, { cartId: "1", shipping_type: "3" }, { cartId: "1", store_id: "NaN" },
    { cartId: Array.from({ length: 201 }, (_, i) => String(i + 1)).join(",") },
  ])("rejects malformed/bulk request %j", (query) => { expect(() => parseOrderCouponRequest(query)).toThrow(); });
});

describe("order coupon picker with authoritative pricing and disposable SQL", () => {
  let fixture: Awaited<ReturnType<typeof createPcCouponFixture>>;
  beforeAll(async () => {
    fixture = await createPcCouponFixture([storeBrand, storeProductCategory]);
    fixture.app.get("/api/coupons/order/:price", orderCoupons);
  }, 30000);
  afterAll(async () => { vi.restoreAllMocks(); await fixture?.close(); });
  async function get(query = "cartId=1&new=1", uid = "11", price = "0") {
    const response = await fixture.app.request(`/api/coupons/order/${price}?${query}`, { headers: { "x-fixture-user": uid } }, fixture.env);
    return { response, body: await response.json() as { status: number; msg: string; data: Array<Record<string, unknown>> } };
  }
  it("selects only applicable owned active coupons using member-priced goods, without any database/KV write", async () => {
    const before = await fixture.snapshot(), coupons = await fixture.db.select().from(storeCouponUser), writes = [...fixture.writes];
    const result = await get(); expect(result.body.status, result.body.msg).toBe(200);
    expect(result.response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(result.body.data.map((row) => row.id)).toEqual([42, 41]);
    expect(result.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 42, type: 0, coupon_type: 2, estimated_discount: "2.70", eligible_subtotal: "18.00" }),
      expect.objectContaining({ id: 41, cid: 1, coupon_title: "满10减5", estimated_discount: "5.00" }),
    ]));
    expect((await get(undefined, "11", "99999999999999")).body.data).toEqual(result.body.data);
    expect(await fixture.snapshot()).toEqual(before); expect(await fixture.db.select().from(storeCouponUser)).toEqual(coupons); expect(fixture.writes).toEqual(writes);
    for (const row of result.body.data) {
      const quote = await new StoreOrderCreateService(fixture.container, fixture.env).quoteOrder({ uid: 11, cartIds: [1], couponId: Number(row.id) });
      expect((quote.couponPriceCents / 100).toFixed(2)).toBe(row.estimated_discount);
    }
  });
  it("does not mistake an empty filtered page for end-of-list", async () => {
    const first = await get("cartId=1&new=1&limit=2");
    expect(first.body.status, first.body.msg).toBe(200); expect(first.body.data).toEqual([]);
    expect(first.response.headers.get("X-Coupon-Next-Cursor")).toBe("49");
    const second = await get("cartId=1&new=1&limit=2&before=49");
    expect(second.body.data.map((row) => row.id)).toEqual([42, 41]); expect(second.response.headers.get("X-Coupon-Next-Cursor")).toBe("");
  });
  it("allows coupon selection before choosing a pickup store without relaxing ordinary quote/create validation", async () => {
    const result = await get("cartId=1&new=1&shipping_type=2");
    expect(result.body.status, result.body.msg).toBe(200);
    expect(result.body.data.map((row) => row.id)).toEqual([42, 41]);
    const service = new StoreOrderCreateService(fixture.container, fixture.env);
    await expect(service.quoteOrder({ uid: 11, cartIds: [1], shippingType: 2 })).rejects.toThrow("请选择有效的自提门店");
    await expect(StoreOrderCreateService.createWithRuntime(fixture.container,
      { CONFIG_KV: fixture.env.CONFIG_KV, nextOrderId: async () => { throw new Error("Must not allocate an order ID"); } },
      { uid: 11, cartIds: [1], shippingType: 2, key: "pickup_requires_store", userIp: "127.0.0.1" },
    )).rejects.toThrow("请选择有效的自提门店");
  });
  it("rejects foreign, missing, paid, deleted, assisted and wrong new/cart modes before returning coupons", async () => {
    for (const [query, uid] of [["cartId=1&new=1", "22"], ["cartId=1&new=1", ""], ["cartId=999&new=1", "11"], ["cartId=1&new=0", "11"]]) {
      expect((await get(query, uid)).body.status).not.toBe(200);
    }
    for (const change of [{ isPay: 1 }, { isDel: 1 }, { staffId: 2 }, { touristUid: "wrong" }, { status: 0 }]) {
      try { await fixture.db.update(storeCart).set(change).where(eq(storeCart.id, 1)); expect((await get()).body.status).not.toBe(200); }
      finally { await fixture.db.update(storeCart).set({ isPay: 0, isDel: 0, staffId: 0, touristUid: "", status: 1 }).where(eq(storeCart.id, 1)); }
    }
  });
  it("uses the exact first-order exclusion even when its configured discount rounds to zero, and excludes marketing", async () => {
    fixture.config.first_order_status = "1"; fixture.config.first_order_discount = "100";
    try { expect((await get()).body.data).toEqual([]); }
    finally { fixture.config.first_order_status = "0"; fixture.config.first_order_discount = "90"; }
    try { await fixture.db.update(storeCart).set({ type: 1 }).where(eq(storeCart.id, 1)); expect((await get()).body.data).toEqual([]); }
    finally { await fixture.db.update(storeCart).set({ type: 0 }).where(eq(storeCart.id, 1)); }
  });
  it("shares category/brand ancestors and product-parent reconciliation with the create resolver", async () => {
    await fixture.db.insert(storeProductCategory).values({ id: 102, pid: 101, path: "100,101", cateName: "测试分类" });
    await fixture.db.insert(storeBrand).values({ id: 22, pid: 21, fid: "20", brandName: "测试品牌" });
    await fixture.db.update(storeProduct).set({ pid: 60, cateId: "102", brandId: 22 }).where(eq(storeProduct.id, 70));
    await fixture.db.insert(storeCouponIssue).values([
      { id: 61, couponType: 1, type: 1, legacyCategoryId: 100 }, { id: 62, couponType: 3, type: 1, legacyBrandId: 20 },
      { id: 63, couponType: 2, type: 1, productId: "60" }, { id: 64, couponType: 2, type: 1, productId: "60" },
    ]);
    await fixture.db.insert(storeCouponProduct).values([{ couponId: 63, productId: 60 }, { couponId: 64, productId: 999 }]);
    await fixture.db.insert(storeCouponUser).values([61, 62, 63, 64].map((id) => ({ id, uid: 11, issueCouponId: id, couponTitle: `范围${id}`, couponPrice: "1.00" })));
    try {
      const result = await get(); expect(result.body.status, result.body.msg).toBe(200);
      expect(result.body.data.map((row) => row.id)).toEqual([63, 62, 61, 42, 41]);
      for (const id of [61, 62, 63]) expect((await new StoreOrderCreateService(fixture.container, fixture.env).quoteOrder({ uid: 11, cartIds: [1], couponId: id })).couponPriceCents).toBe(100);
      await expect(new StoreOrderCreateService(fixture.container, fixture.env).quoteOrder({ uid: 11, cartIds: [1], couponId: 64 })).rejects.toThrow("范围数据不一致");
    } finally {
      await fixture.db.delete(storeCouponUser).where(inArray(storeCouponUser.id, [61, 62, 63, 64]));
      await fixture.db.update(storeProduct).set({ pid: 0, cateId: "", brandId: 0 }).where(eq(storeProduct.id, 70));
    }
  });
  it("excludes missing or invalid templates while the shared quote resolver explicitly rejects them", async () => {
    await fixture.db.insert(storeCouponIssue).values([{ id: 71, couponType: 4, type: 1 }, { id: 72, couponType: 0, type: 3 }]);
    await fixture.db.insert(storeCouponUser).values([71, 72, 73].map((id) => ({ id, uid: 11, issueCouponId: id, couponTitle: "无效模板样本", couponPrice: "1.00" })));
    try {
      const result = await get(); expect(result.body.status, result.body.msg).toBe(200);
      expect(result.body.data.map((row) => row.id)).toEqual([42, 41]);
      const service = new StoreOrderCreateService(fixture.container, fixture.env);
      for (const id of [71, 72]) await expect(service.quoteOrder({ uid: 11, cartIds: [1], couponId: id })).rejects.toThrow("优惠券类型配置无效");
      await expect(service.quoteOrder({ uid: 11, cartIds: [1], couponId: 73 })).rejects.toThrow("优惠券模板不存在");
    } finally { await fixture.db.delete(storeCouponUser).where(inArray(storeCouponUser.id, [71, 72, 73])); }
  });
  it("does not turn a database failure into an empty eligible list", async () => {
    const spy = vi.spyOn(fixture.container.storeCartDao, "getByIds").mockRejectedValueOnce(new Error("fixture database unavailable"));
    try { const result = await get(); expect(result.body.status).not.toBe(200); expect(result.body.msg).toContain("fixture database unavailable"); }
    finally { spy.mockRestore(); }
    const select = vi.spyOn(fixture.container.db, "select").mockImplementationOnce(() => { throw new Error("fixture coupon query unavailable"); });
    try {
      await expect(eligibleOrderCoupons(fixture.container, 11,
        [{ cart: { cartNum: 2 }, product: { id: 70, pid: 0, cateId: "", brandId: 0 }, unitPriceCents: 900 }],
        { limit: 20, before: 0, unpaged: false },
      )).rejects.toThrow("fixture coupon query unavailable");
    } finally { select.mockRestore(); }
  });
  it("bounds legacy unpaged reads and keeps batched query count independent of coupon count", async () => {
    const ids = Array.from({ length: 1001 }, (_, i) => 10000 + i);
    await fixture.db.insert(storeCouponUser).values(ids.map((id) => ({ id, uid: 11, issueCouponId: 1, couponTitle: "分页样本", couponPrice: "1.00" })));
    const items = [{ cart: { cartNum: 2 }, product: { id: 70, pid: 0, cateId: "", brandId: 0 }, unitPriceCents: 900 }];
    const spy = vi.spyOn(fixture.container.db, "select");
    try {
      expect((await get()).body.status).not.toBe(200);
      spy.mockClear();
      const one = await eligibleOrderCoupons(fixture.container, 11, items, { limit: 1, before: 0, unpaged: false });
      const oneQueries = spy.mock.calls.length;
      spy.mockClear();
      const hundred = await eligibleOrderCoupons(fixture.container, 11, items, { limit: 100, before: 0, unpaged: false });
      expect(one.list).toHaveLength(1); expect(hundred.list).toHaveLength(100);
      expect(oneQueries).toBe(1); expect(spy.mock.calls.length).toBe(oneQueries);
      expect(hundred.nextCursor).toBe(10901);
    } finally { spy.mockRestore(); await fixture.db.delete(storeCouponUser).where(inArray(storeCouponUser.id, ids)); }
  });
});
