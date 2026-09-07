import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { createPcCouponFixture } from "./helpers/pcCouponFixture";
import { orderCoupons } from "../src/controllers/api/v1/OrderCouponController";
import { storeCouponUser } from "../src/models/schema";
import { StoreOrderCreateService } from "../src/services/order/StoreOrderCreateService";
import type { CartItem } from "../../view/pc-ts/src/types/order";
import { OrderCouponSession, normalizeOrderCouponPage, orderCouponRequest, orderCouponScope, type OrderCouponScope, type OrderCouponState } from "../../view/pc-ts/src/api/orderCoupons";

describe("PC order picker through the actual order coupon controller and disposable SQL", () => {
  let fixture: Awaited<ReturnType<typeof createPcCouponFixture>>;
  beforeAll(async () => { fixture = await createPcCouponFixture(); fixture.app.get("/api/coupons/order/:price", orderCoupons); }, 30000);
  afterAll(async () => { await fixture?.close(); });
  // The real legacy service returns unknown[]; the frontend scope builder validates the fields it consumes.
  const readItems = async () => await fixture.readItems() as CartItem[];
  async function fetchPage(scope: OrderCouponScope, before?: number, uid = "11") {
    const params = new URLSearchParams(Object.entries(orderCouponRequest(scope, before)).map(([key, value]) => [key, String(value)]));
    const response = await fixture.app.request(`/api/coupons/order/0?${params}`, { headers: { "x-fixture-user": uid } }, fixture.env);
    const body = await response.json() as { status: number; data: unknown; msg: string };
    if (body.status !== 200) throw new Error(body.msg);
    return normalizeOrderCouponPage(body.data, response.headers.get("X-Coupon-Next-Cursor"), before);
  }
  it("normalizes actual scope/discount fields and agrees with authoritative cash/percentage quotes without writes", async () => {
    const before = await fixture.snapshot(), coupons = await fixture.db.select().from(storeCouponUser), writes = [...fixture.writes];
    const page = await fetchPage(orderCouponScope(await readItems(), 1, 0));
    expect(page.list.map((row) => row.id)).toEqual([42, 41]);
    expect(page.list[0]).toMatchObject({ benefit: "8.5折", estimatedDiscount: "2.70", eligibleSubtotal: "18.00" });
    for (const coupon of page.list) {
      const quote = await new StoreOrderCreateService(fixture.container, fixture.env).quoteOrder({ uid: 11, cartIds: [1], couponId: coupon.id });
      expect((quote.couponPriceCents / 100).toFixed(2)).toBe(coupon.estimatedDiscount);
    }
    expect(await fixture.snapshot()).toEqual(before); expect(await fixture.db.select().from(storeCouponUser)).toEqual(coupons); expect(fixture.writes).toEqual(writes);
  });
  it("uses the real 20-candidate scan to progress through an empty page and recover the two eligible coupons", async () => {
    const ids = Array.from({ length: 24 }, (_, index) => 100 + index);
    await fixture.db.insert(storeCouponUser).values(ids.map((id) => ({ id, uid: 11, issueCouponId: 1, couponTitle: "门槛不足样本", couponPrice: "1.00", useMinPrice: "100.00" })));
    try {
      let state: OrderCouponState; const scope = orderCouponScope(await readItems(), 1, 0);
      const session = new OrderCouponSession(fetchPage, (next) => { state = next; });
      await session.load(scope); expect(state!.error).toBe(""); expect(state!.list).toEqual([]); expect(state!.nextCursor).toBe(104);
      await session.load(scope, true); expect(state!.error).toBe(""); expect(state!.list.map((x) => x.id)).toEqual([42, 41]); expect(state!.nextCursor).toBeNull();
    } finally { await fixture.db.delete(storeCouponUser).where(inArray(storeCouponUser.id, ids)); }
  });
  it("can filter for pickup before selecting a store, and does not trust a wrong purchase mode or another owner", async () => {
    const items = await readItems();
    expect((await fetchPage(orderCouponScope(items, 2, 0))).list.map((x) => x.id)).toEqual([42, 41]);
    await expect(fetchPage(orderCouponScope(items.map((item) => ({ ...item, isNew: 0 })), 1, 0))).rejects.toThrow();
    await expect(fetchPage(orderCouponScope(items, 1, 0), undefined, "22")).rejects.toThrow();
  });
  it("does not turn a previously selectable coupon into a promise of acceptance after revocation", async () => {
    const scope = orderCouponScope(await readItems(), 1, 0);
    expect((await fetchPage(scope)).list.some((x) => x.id === 41)).toBe(true);
    try {
      await fixture.db.update(storeCouponUser).set({ isFail: 1 }).where(eq(storeCouponUser.id, 41));
      await expect(new StoreOrderCreateService(fixture.container, fixture.env).quoteOrder({ uid: 11, cartIds: [1], couponId: 41 })).rejects.toThrow("已失效");
      expect((await fetchPage(scope)).list.some((x) => x.id === 41)).toBe(false);
    } finally { await fixture.db.update(storeCouponUser).set({ isFail: 0 }).where(eq(storeCouponUser.id, 41)); }
  });
  it("renders the real first-order exclusion as a complete empty page, not a failed adapter or spendable coupon", async () => {
    fixture.config.first_order_status = "1";
    try { expect(await fetchPage(orderCouponScope(await readItems(), 1, 0))).toEqual({ list: [], nextCursor: null }); }
    finally { fixture.config.first_order_status = "0"; }
  });
});
