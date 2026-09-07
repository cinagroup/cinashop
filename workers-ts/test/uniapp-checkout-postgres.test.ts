import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { createPcCouponFixture } from "./helpers/pcCouponFixture";
import { uniCheckoutRuntime } from "./helpers/uniCheckoutRuntime";
import { cartList } from "../src/controllers/api/v1/OrderController";
import { orderCoupons } from "../src/controllers/api/v1/OrderCouponController";
import { storeCart, storeCouponUser } from "../src/models/schema";
import { orderCouponScope } from "../../view/common/orderCoupons";

describe("UniApp request + checkout adapter against actual controllers and isolated SQL", () => {
  let fixture: Awaited<ReturnType<typeof createPcCouponFixture>>;
  const options = { type: 0, addressId: 11, shippingType: 1 as const, storeId: 0, couponId: 0, useIntegral: false };
  beforeAll(async () => {
    fixture = await createPcCouponFixture();
    fixture.app.get("/api/cart/list", cartList);
    fixture.app.get("/api/coupons/order/:price", orderCoupons);
    await fixture.db.insert(storeCart).values({ id: 2, uid: 11, productId: 70, productAttrUnique: "qared001", cartNum: 1, isNew: 0, status: 1 });
  }, 30000);
  afterAll(async () => { await fixture?.close(); });
  function runtime(uid = "11") {
    return uniCheckoutRuntime((call) => {
      const path = new URL(call.url, "http://isolated.invalid").pathname;
      const query = call.method === "GET" ? `?${new URLSearchParams(Object.entries(call.data).map(([key, value]) => [key, String(value)]))}` : "";
      void Promise.resolve(fixture.app.request(`${path}${query}`, {
        method: call.method, headers: { "Content-Type": "application/json", "x-fixture-user": uid },
        ...(call.method === "GET" ? {} : { body: JSON.stringify(call.data) }),
      }, fixture.env)).then(async (response) => call.success({ statusCode: response.status, data: await response.json(), header: Object.fromEntries(response.headers) }))
        .catch((error: Error) => call.fail({ errMsg: error.message }));
    });
  }
  it("isolates immediate-purchase and ordinary-cart selections with real owner/new checks", async () => {
    const { checkoutApi: api } = runtime();
    expect((await api.items({ mode: "buy", ids: [1] }))[0]).toMatchObject({ id: 1, isNew: 1, cartNum: 2 });
    expect((await api.items({ mode: "cart" }, [2]))[0]).toMatchObject({ id: 2, isNew: 0, cartNum: 1 });
    await expect(api.items({ mode: "buy", ids: [2] })).rejects.toThrow();
    await expect(api.items({ mode: "cart" }, [1, 2])).rejects.toThrow("结算商品不完整");
    await expect(runtime("22").checkoutApi.items({ mode: "buy", ids: [1] })).rejects.toThrow();
  });
  it("uses actual full quotes and percent/cash discounts instead of wallet or cached amounts", async () => {
    const before = await fixture.snapshot();
    const { checkoutApi: api } = runtime();
    const items = await api.items({ mode: "buy", ids: [1] });
    const coupons = await api.coupons(orderCouponScope(items, 1, 0));
    expect(coupons.list.map((row) => row.id)).toEqual([42, 41]);
    expect(coupons.list[0]).toMatchObject({ benefit: "8.5折", eligibleSubtotal: "18.00", estimatedDiscount: "2.70" });
    const initial = await api.confirm(items, options);
    expect(initial.prices).toMatchObject({ payable: "21.00", memberDiscount: "2.00", postagePayable: "3.00" });
    expect((await api.computed(initial.key, items, { ...options, couponId: 42 })).prices).toMatchObject({ couponDiscount: "2.70", payable: "18.30" });
    expect((await api.computed(initial.key, items, { ...options, couponId: 41 })).prices).toMatchObject({ couponDiscount: "5.00", payable: "16.00" });
    expect((await api.computed(initial.key, items, { ...options, addressId: 12, useIntegral: true })).prices).toMatchObject({ payable: "23.50", integralDiscount: "0.50", postagePayable: "6.00" });
    expect(await fixture.snapshot()).toEqual(before);
  });
  it("continues beyond 20 ineligible candidates using the actual response header and last-scanned cursor", async () => {
    const ids = Array.from({ length: 24 }, (_, i) => 100 + i);
    await fixture.db.insert(storeCouponUser).values(ids.map((id) => ({ id, uid: 11, issueCouponId: 1, couponTitle: "门槛不足", couponPrice: "1.00", useMinPrice: "100.00" })));
    try {
      const { checkoutApi: api } = runtime();
      const scope = orderCouponScope(await api.items({ mode: "buy", ids: [1] }), 1, 0);
      const first = await api.coupons(scope);
      expect(first).toEqual({ list: [], nextCursor: 104 });
      expect((await api.coupons(scope, first.nextCursor!)).list.map((row) => row.id)).toEqual([42, 41]);
    } finally { await fixture.db.delete(storeCouponUser).where(inArray(storeCouponUser.id, ids)); }
  });
  it("does not turn changed quantities or expired confirmation into an accepted quote", async () => {
    const { checkoutApi: api } = runtime();
    const items = await api.items({ mode: "buy", ids: [1] });
    const initial = await api.confirm(items, options);
    await fixture.db.update(storeCart).set({ cartNum: 1 }).where(eq(storeCart.id, 1));
    try { await expect(api.computed(initial.key, items, options)).rejects.toThrow("报价商品或数量已变化"); }
    finally { await fixture.db.update(storeCart).set({ cartNum: 2 }).where(eq(storeCart.id, 1)); }
    fixture.cache.delete(`order:confirm:11:${initial.key}`);
    await expect(api.computed(initial.key, items, options)).rejects.toThrow();
  });
});
