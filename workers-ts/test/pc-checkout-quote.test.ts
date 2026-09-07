import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  CheckoutQuoteSession, normalizeCheckoutQuote, quoteMoney,
  type CheckoutQuote, type CheckoutQuoteOptions, type CheckoutQuoteState,
} from "../../view/pc-ts/src/api/checkoutQuote";
import type { CartItem } from "../../view/pc-ts/src/types/order";

const selected: CartItem[] = [{ id: 1, productId: 70, unique: "qared001", cartNum: 2, type: 0, isNew: 1, isValid: true,
  productInfo: { storeName: "fixture", image: "", price: "999.99", stock: 8, otPrice: "", suk: "red", systemFormId: 0, productType: 0 }, sumPrice: "1999.98" }];
const options: CheckoutQuoteOptions = { type: 0, addressId: 11, shippingType: 1, storeId: 0, couponId: 0, useIntegral: false };
const priceGroup = { sumPrice: "20.00", totalPrice: "18.00", pay_price: "20.50", total_postage: "6.00", storePostageDiscount: "2.00",
  pay_postage: "4.00", vipPrice: "2.00", levelPrice: "0.00", memberPrice: "2.00", couponPrice: "0.00", deduction_price: "0.50",
  firstOrderPrice: "1.00", usedIntegral: 50, SurplusIntegral: 100 };
function preview(key = "fixture_quote_1") {
  return { orderKey: key, addressInfo: { id: 11 }, priceGroup,
    cartInfo: selected.map((item) => ({ ...item, productInfo: { ...item.productInfo, price: "10.00" }, truePrice: "9.00", sumPrice: "20.00" })) };
}
function quote(key = "fixture_quote_1") { return normalizeCheckoutQuote(preview(key), selected, options); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("FE-002E server-authoritative PC checkout quote", () => {
  it("uses the complete server amount and item snapshot, never the cached cart total", () => {
    expect(quote()).toMatchObject({ key: "fixture_quote_1", items: [{ productInfo: { price: "10.00" }, quotedUnitPrice: "9.00", sumPrice: "20.00" }],
      prices: { payable: "20.50", postage: "6.00", postageDiscount: "2.00", memberDiscount: "2.00", firstOrderDiscount: "1.00", integralDiscount: "0.50" } });
    const { priceGroup: prices, ...detail } = preview();
    expect(normalizeCheckoutQuote({ ...prices, ...detail }, selected, options, detail.orderKey)).toEqual(quote());
  });
  it("preserves cents and zero but rejects missing, malformed and unsafe monetary values", () => {
    expect(quoteMoney("000.1")).toBe("0.10");
    expect(quoteMoney("0")).toBe("0.00");
    for (const value of [null, undefined, 1, "NaN", "-1", "1e3", " 1.00", "1.001", "90071992547409.92"]) {
      expect(() => quoteMoney(value)).toThrow();
      expect(() => normalizeCheckoutQuote({ ...preview(), priceGroup: { ...priceGroup, pay_price: value } }, selected, options)).toThrow();
    }
    expect(() => normalizeCheckoutQuote({ ...preview(), priceGroup: { ...priceGroup, usedIntegral: "50" } }, selected, options)).toThrow();
  });
  it("rejects changed, missing, duplicate or foreign selections and a mismatched address/key", () => {
    for (const change of [{ id: 2 }, { productId: 99 }, { unique: "bad" }, { cartNum: 1 }, { isNew: 0 }, { type: 1 }, { isValid: false }]) {
      expect(() => normalizeCheckoutQuote({ ...preview(), cartInfo: [{ ...preview().cartInfo[0], ...change }] }, selected, options)).toThrow();
    }
    for (const change of [{ cartInfo: [] }, { cartInfo: [preview().cartInfo[0], preview().cartInfo[0]] },
      { addressInfo: null }, { addressInfo: { id: 12 } }, { orderKey: "bad/key" }]) {
      expect(() => normalizeCheckoutQuote({ ...preview(), ...change }, selected, options)).toThrow();
    }
    expect(() => normalizeCheckoutQuote(preview(), selected, options, "another_key")).toThrow();
    expect(normalizeCheckoutQuote({ ...preview(), addressInfo: null }, selected, { ...options, shippingType: 2, addressId: 0, storeId: 2 })).toBeTruthy();
  });
  it("discards out-of-order success and reuses only the newest accepted key", async () => {
    const first = deferred<CheckoutQuote>(), second = deferred<CheckoutQuote>();
    const confirm = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const computed = vi.fn().mockResolvedValue(quote("second_key"));
    let state!: CheckoutQuoteState;
    const session = new CheckoutQuoteSession({ confirm, computed }, (value) => { state = value; });
    const a = session.load(selected, options);
    const b = session.load(selected, { ...options, addressId: 12 });
    expect(state).toMatchObject({ loading: true, result: null });
    second.resolve(quote("second_key")); await b;
    first.resolve(quote("first_key")); await a;
    expect(state.result?.key).toBe("second_key");
    await session.load(selected, options);
    expect(computed).toHaveBeenCalledWith("second_key", selected, options);
  });
  it("invalidates an old amount immediately and ignores late failure after a newer success", async () => {
    const old = deferred<CheckoutQuote>();
    const confirm = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(quote("newest_key"));
    let state!: CheckoutQuoteState;
    const session = new CheckoutQuoteSession({ confirm, computed: vi.fn() }, (value) => { state = value; });
    const a = session.load(selected, options);
    await session.load(selected, { ...options, useIntegral: true });
    old.reject(new Error("stale error")); await a;
    expect(state.error).toBe(""); expect(state.result?.key).toBe("newest_key");
    session.invalidate(); expect(state.result).toBeNull();
  });
  it("fails closed on a current quote failure; explicit renewal obtains a new confirmation", async () => {
    const confirm = vi.fn().mockResolvedValue(quote());
    const computed = vi.fn().mockRejectedValue(new Error("订单已过期"));
    let state!: CheckoutQuoteState;
    const session = new CheckoutQuoteSession({ confirm, computed }, (value) => { state = value; });
    await session.load(selected, options);
    await session.load(selected, { ...options, useIntegral: true });
    expect(state).toMatchObject({ loading: false, error: "订单已过期", result: null });
    session.reset(); await session.load(selected, options);
    expect(confirm).toHaveBeenCalledTimes(2);
  });
  it("does not reuse a confirmation key across changed cart selections or a departed route", async () => {
    const pending = deferred<CheckoutQuote>();
    const confirm = vi.fn().mockResolvedValueOnce(quote()).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(quote("final_key"));
    const computed = vi.fn();
    let state!: CheckoutQuoteState;
    const session = new CheckoutQuoteSession({ confirm, computed }, (value) => { state = value; });
    await session.load(selected, options);
    const changing = session.load([{ ...selected[0], cartNum: 1 }], options);
    session.reset(); pending.resolve(quote("stale_key")); await changing;
    expect(state.result).toBeNull();
    await session.load(selected, options);
    expect(computed).not.toHaveBeenCalled(); expect(state.result?.key).toBe("final_key");
  });
  it("wires the quote guard and accepted address/options to creation without automatic payment", () => {
    const source = readFileSync("../view/pc-ts/src/pages/order/Checkout.vue", "utf8");
    expect(source).toContain('confirm: apiOrderConfirm, computed: apiOrderComputed');
    expect(source).toContain(':disabled="!canSubmit"');
    expect(source).toContain('quoteState.value.result!.key');
    expect(source).toContain('...quoteOptions.value');
    expect(source).toContain('apiOrderCreate(orderKey.value, pendingSubmission.value!)');
    expect(source).toContain('await Promise.all([loadAddresses(generation), loadPickupStores(generation), loadSystemForm(rows, generation)])');
    expect(source).toContain('class="checkout-mobile-items" aria-label="结算商品"');
    expect(source).toContain('.checkout-desktop-items { display: none; }');
    expect(source).toContain('.checkout-mobile-items { display: block; }');
    expect(source).not.toContain('apiFirstOrderQuote');
    expect(source).not.toContain('crypto.randomUUID');
    expect(source).not.toContain('payType:');
    expect(source).not.toContain('checkoutTotal');
  });
});
