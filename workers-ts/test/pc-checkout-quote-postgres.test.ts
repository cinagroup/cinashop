import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createPcCheckoutQuoteFixture } from "./helpers/pcCheckoutQuoteFixture";
import { normalizeCheckoutQuote, type CheckoutQuoteOptions } from "../../view/pc-ts/src/api/checkoutQuote";
import type { CartItem } from "../../view/pc-ts/src/types/order";
import { storeProductAttrValue, userAddress, storeIntegral, storeCart } from "../src/models/schema";

describe("PC full quote through real controller/service/SQL", () => {
  let fixture: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  let selected: CartItem[];
  const options: CheckoutQuoteOptions = { type: 0, addressId: 11, shippingType: 1, storeId: 0, couponId: 0, useIntegral: false };
  beforeAll(async () => { fixture = await createPcCheckoutQuoteFixture(); selected = await fixture.readItems() as CartItem[]; }, 30000);
  afterAll(async () => { await fixture?.close(); });
  async function post(path: string, body: object, uid = "11") {
    const response = await fixture.app.request(path, { method: "POST", headers: { "Content-Type": "application/json", "x-fixture-user": uid }, body: JSON.stringify(body) }, fixture.env);
    return response.json() as Promise<{ status: number; msg: string; data: Record<string, unknown> }>;
  }
  it("returns real member/first-order/postage discounts without reserving stock, points or orders", async () => {
    const before = await fixture.snapshot();
    const response = await post("/api/order/confirm", { cartIds: [1], ...options });
    expect(response.status, response.msg).toBe(200);
    const quote = normalizeCheckoutQuote(response.data, selected, options);
    expect(quote.prices).toMatchObject({ subtotal: "20.00", goodsPayable: "18.00", payable: "19.20", memberDiscount: "2.00", firstOrderDiscount: "1.80",
      postage: "6.00", postageDiscount: "3.00", postagePayable: "3.00", integralDiscount: "0.00" });
    expect(quote.items[0].quotedUnitPrice).toBe("9.00");
    expect(quote.prices.requiredIntegral).toBe(0);
    expect(fixture.writes.slice(-2)).toEqual([
      { key: `order:confirm:11:${quote.key}`, ttl: 1800 },
      { key: `order:quote:v1:11:0:${quote.key}:${quote.quoteToken}`, ttl: 1800 },
    ]);
    expect(await fixture.snapshot()).toEqual(before);
  });
  it("returns required redemption points from activity SKU/quantity on confirm and computed without writes", async () => {
    const redemption = await createPcCheckoutQuoteFixture([storeIntegral]);
    try {
      await redemption.db.insert(storeIntegral).values({ id: 9, productId: 70, storeName: "points sample", stock: 8, quota: 8, status: 1, isShow: 1, isDel: 0, freight: 1 });
      await redemption.db.insert(storeProductAttrValue).values({ id: 2, productId: 9, type: 4, unique: "point001", suk: "红色,大号", stock: 8, quota: 8, price: "2.00", integral: 30 });
      await redemption.db.update(storeCart).set({ type: 4, activityId: 9 }).where(eq(storeCart.id, 1));
      const before = await redemption.snapshot();
      const activityBefore = await redemption.db.select().from(storeIntegral);
      const selected = await redemption.readItems() as CartItem[];
      const requested = { ...options, type: 4 };
      async function call(path: string, body: object) {
        const response = await redemption.app.request(path, { method: "POST", headers: { "Content-Type": "application/json", "x-fixture-user": "11" }, body: JSON.stringify(body) }, redemption.env);
        return response.json() as Promise<{ status: number; msg: string; data: Record<string, unknown> }>;
      }
      const first = await call("/api/order/confirm", { ...requested, cartIds: [1] });
      expect(first.status, first.msg).toBe(200);
      const quote = normalizeCheckoutQuote(first.data, selected, requested);
      expect(quote.prices).toMatchObject({ requiredIntegral: 60, usedIntegral: 0, integralDiscount: "0.00", payable: "4.00" });
      const computed = await call(`/api/order/computed/${quote.key}`, requested);
      expect(computed.status, computed.msg).toBe(200);
      expect(normalizeCheckoutQuote(computed.data, selected, requested, quote.key).prices).toEqual(quote.prices);
      expect(() => normalizeCheckoutQuote({ ...computed.data, pay_integral: undefined }, selected, requested, quote.key)).toThrow("报价积分无效");
      expect(await redemption.snapshot()).toEqual(before);
      expect(await redemption.db.select().from(storeIntegral)).toEqual(activityBefore);
    } finally { await redemption.close(); }
  });
  it("recalculates the selected address and points under the same owned key, preserving legacy flat amounts", async () => {
    const before = await fixture.snapshot();
    const initial = await post("/api/order/confirm", { cartIds: [1], ...options });
    const key = String(initial.data.orderKey);
    const requested = { ...options, addressId: 12, useIntegral: true };
    const response = await post(`/api/order/computed/${key}`, requested);
    expect(response.status, response.msg).toBe(200);
    expect(response.data.pay_price).toBe("21.70");
    const quote = normalizeCheckoutQuote(response.data, selected, requested, key);
    expect(quote.prices).toMatchObject({ payable: "21.70", postage: "12.00", postagePayable: "6.00", integralDiscount: "0.50", usedIntegral: 50, remainingIntegral: 50 });
    const fresh = await post("/api/order/confirm", { cartIds: [1], ...requested });
    expect(normalizeCheckoutQuote(fresh.data, selected, requested).prices).toEqual(quote.prices);
    expect(await fixture.snapshot()).toEqual(before);
  });
  it("recalculates pickup as zero postage instead of retaining the delivery quote", async () => {
    const requested: CheckoutQuoteOptions = { ...options, shippingType: 2, storeId: 1, addressId: 0 };
    const response = await post("/api/order/confirm", { cartIds: [1], ...requested });
    expect(response.status, response.msg).toBe(200);
    expect(normalizeCheckoutQuote(response.data, selected, requested).prices).toMatchObject({ postage: "0.00", payable: "16.20" });
  });
  it("does not accept missing/other-user/expired confirmation keys or unauthenticated requests", async () => {
    const initial = await post("/api/order/confirm", { cartIds: [1], ...options });
    const key = String(initial.data.orderKey);
    expect((await post(`/api/order/computed/${key}`, options, "22")).status).not.toBe(200);
    expect((await post("/api/order/confirm", { cartIds: [1], ...options }, "")).status).not.toBe(200);
    fixture.cache.delete(`order:confirm:11:${key}`);
    expect((await post(`/api/order/computed/${key}`, options)).status).not.toBe(200);
  });
  it("returns updated line prices on computed and fails the PC adapter for a missing selected address", async () => {
    const initial = await post("/api/order/confirm", { cartIds: [1], ...options });
    const key = String(initial.data.orderKey);
    await fixture.db.update(storeProductAttrValue).set({ vipPrice: "8.00" }).where(eq(storeProductAttrValue.id, 1));
    try {
      const response = await post(`/api/order/computed/${key}`, options);
      expect(response.status, response.msg).toBe(200);
      expect(normalizeCheckoutQuote(response.data, selected, options, key).items[0].quotedUnitPrice).toBe("8.00");
      await fixture.db.update(userAddress).set({ isDel: 1 }).where(eq(userAddress.id, 11));
      const deleted = await post(`/api/order/computed/${key}`, options);
      expect(() => normalizeCheckoutQuote(deleted.data, selected, options, key)).toThrow();
    } finally {
      await fixture.db.update(storeProductAttrValue).set({ vipPrice: "9.00" }).where(eq(storeProductAttrValue.id, 1));
      await fixture.db.update(userAddress).set({ isDel: 0 }).where(eq(userAddress.id, 11));
    }
  });
});
