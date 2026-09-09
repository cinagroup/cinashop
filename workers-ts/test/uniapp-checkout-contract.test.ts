import { describe, expect, it, vi } from "vitest";
import { createCheckoutApi } from "../../view/common/checkoutApi";
import { parseCheckoutSelection, validateCheckoutItems, type CheckoutCartItem } from "../../view/common/checkoutSelection";
import { orderCouponScope } from "../../view/common/orderCoupons";
import { uniCheckoutRuntime, type UniRequestCall } from "./helpers/uniCheckoutRuntime";

const item: CheckoutCartItem = { id: 1, productId: 70, cartNum: 2, unique: "sku1", type: 0, isNew: 1, isValid: true,
  productInfo: { price: "999.99", storeName: "test", image: "", stock: 8, otPrice: "", suk: "red", systemFormId: 0, productType: 0 }, sumPrice: "1999.98" };
const options = { type: 0, addressId: 11, shippingType: 1 as const, storeId: 0, couponId: 0, useIntegral: false };
const prices = { sumPrice: "20.00", totalPrice: "18.00", pay_price: "21.00", total_postage: "6.00", storePostageDiscount: "3.00", pay_postage: "3.00",
  vipPrice: "2.00", levelPrice: "0.00", memberPrice: "2.00", couponPrice: "0.00", deduction_price: "0.00", firstOrderPrice: "0.00", usedIntegral: 0, SurplusIntegral: 100 };
const preview = () => ({ orderKey: "checkout_key1", quoteToken: "a".repeat(32), priceGroup: prices, addressInfo: { id: 11 }, cartInfo: [{ ...item, productInfo: { ...item.productInfo, price: "10.00" }, sumPrice: "20.00", truePrice: "9.00" }] });

describe("UniApp checkout transport and strict shared boundary", () => {
  it("retains existing data-only callers and exposes case-normalized pagination metadata separately", async () => {
    const calls: UniRequestCall[] = [];
    const runtime = uniCheckoutRuntime((call) => { calls.push(call); call.success({ statusCode: 200, data: { status: 200, data: [1] }, header: { "X-Coupon-Next-Cursor": "104" } }); });
    expect(await runtime.request.http.get("/test")).toEqual([1]);
    expect(await runtime.request.http.getResponse("/test")).toEqual({ data: [1], headers: { "x-coupon-next-cursor": "104" } });
    expect(calls[0].header["Authori-zation"]).toBe("Bearer local-synthetic-token");
    expect(calls[0].withCredentials).toBeUndefined();
    await runtime.request.http.get("/test", {}, { noAuth: true, withCredentials: true });
    expect(calls[2].header["Authori-zation"]).toBeUndefined(); expect(calls[2].withCredentials).toBe(true);
  });
  it("retains machine-readable pre-creation rejection without misclassifying transport failure", async () => {
    const runtime = uniCheckoutRuntime((call) => call.success({ statusCode: 200, data: { status: 400, msg: "请填写表单", data: { errorCode: "ORDER_FORM_REJECTED", orderKey: "checkout_key1" } } }));
    await expect(runtime.request.http.post("/order/create/checkout_key1")).rejects.toMatchObject({ status: 400, httpStatus: 200, data: { errorCode: "ORDER_FORM_REJECTED", orderKey: "checkout_key1" } });
    const offline = uniCheckoutRuntime((call) => call.fail({ errMsg: "timeout" }));
    await expect(offline.request.http.post("/test")).rejects.toMatchObject({ message: "timeout", status: undefined, data: undefined });
  });
  it.each([null, { status: 200, data: [] }])("does not accept an HTTP failure with body %j", async (body) => {
    const runtime = uniCheckoutRuntime((call) => call.success({ statusCode: 503, data: body }));
    await expect(runtime.request.http.get("/test")).rejects.toMatchObject({ httpStatus: 503 });
  });
  it("preserves expiry clearing/navigation and rejects ambiguous cursor headers", async () => {
    const runtime = uniCheckoutRuntime((call) => call.success({ statusCode: 200, data: { status: 410001, msg: "登录过期" } }));
    await expect(runtime.request.http.get("/test")).rejects.toMatchObject({ status: 410001 });
    expect(runtime.auth.uid).toBe(0); expect(runtime.navigations).toEqual(["/pages/auth/login"]);
    const duplicate = uniCheckoutRuntime((call) => call.success({ statusCode: 200, data: { status: 200, data: [] }, header: { "X-Coupon-Next-Cursor": "10", "x-coupon-next-cursor": "8" } }));
    await expect(duplicate.request.http.getResponse("/test")).rejects.toThrow("响应头重复");
  });
  it("does not return a stale successful checkout read after account/token replacement", async () => {
    let pending!: UniRequestCall;
    const runtime = uniCheckoutRuntime((call) => { pending = call; });
    const request = runtime.checkoutApi.items({ mode: "buy", ids: [1] });
    runtime.auth.token = "new-local-token";
    pending.success({ statusCode: 200, data: { status: 200, data: [item] } });
    await expect(request).rejects.toThrow("登录状态已变化");
    runtime.auth.clear();
    await expect(runtime.checkoutApi.items({ mode: "buy", ids: [1] })).rejects.toThrow("请先登录");
  });
  it("keeps an empty filtered page's last-scanned cursor through the actual Uni adapter", async () => {
    const runtime = uniCheckoutRuntime((call) => {
      expect(call.url).toMatch(/\/api\/coupons\/order\/0$/);
      expect(call.data).toEqual({ cartId: "1", new: 1, shipping_type: 1, store_id: 0, limit: 20 });
      call.success({ statusCode: 200, data: { status: 200, data: [] }, header: { "X-Coupon-Next-Cursor": "104" } });
    });
    expect(await runtime.checkoutApi.coupons(orderCouponScope([item], 1, 0))).toEqual({ list: [], nextCursor: 104 });
  });
  it("a late auth-expiry response cannot clear a newer session, even with the same uid and token", async () => {
    let pending!: UniRequestCall;
    const runtime = uniCheckoutRuntime((call) => { pending = call; });
    const read = runtime.request.http.get("/cart/list");
    runtime.auth.sessionVersion++;
    pending.success({ statusCode: 200, data: { status: 410001, msg: "old login expired" } });
    await expect(read).rejects.toThrow("登录状态已变化");
    expect(runtime.auth.uid).toBe(11); expect(runtime.auth.token).toBe("local-synthetic-token");
    expect(runtime.navigations).toEqual([]);
  });
  it.each([{ mode: "buy" }, { mode: "buy", cartId: "1,x" }, { mode: "buy", cartId: "1,1" }, { mode: "buy", cartId: "1", cartIds: "1" }])("rejects invalid selection without ordinary-cart fallback %j", (query) => {
    expect(() => parseCheckoutSelection(query)).toThrow(/立即购买/);
  });
  it.each([{ isNew: 0 }, { id: 2 }, { isValid: false }, { cartNum: 0 }, { productInfo: null }, { productId: 0 }])("rejects a mismatched or invalid exact row %j", (change) => {
    expect(() => validateCheckoutItems([{ ...item, ...change }], [1], 1)).toThrow("结算商品或购买模式已失效");
  });
  it("reads exact buy rows separately from selected normal cart rows, preserving no partial selection", async () => {
    const get = vi.fn().mockResolvedValueOnce({ data: [item], headers: {} }).mockResolvedValueOnce({ data: [{ ...item, isNew: 0 }, { ...item, id: 2, isNew: 0 }], headers: {} });
    const api = createCheckoutApi({ get, post: vi.fn() });
    expect(await api.items({ mode: "buy", ids: [1] })).toHaveLength(1);
    expect(get).toHaveBeenNthCalledWith(1, "/cart/list", { scope: "buy", ids: "1" });
    expect(await api.items({ mode: "cart" }, [1])).toHaveLength(1);
    expect(get).toHaveBeenNthCalledWith(2, "/cart/list", { scope: "cart" });
    get.mockResolvedValue({ data: [{ ...item, isNew: 0 }], headers: {} });
    await expect(api.items({ mode: "cart" }, [1, 2])).rejects.toThrow("结算商品不完整");
  });
  it("quotes a frozen snapshot, strips extra prices/payment fields and requires the same computed key", async () => {
    let resolve!: (value: unknown) => void;
    const post = vi.fn().mockImplementationOnce(() => new Promise((yes) => { resolve = yes; })).mockResolvedValue(preview());
    const api = createCheckoutApi({ get: vi.fn(), post });
    const selected = [{ ...item }];
    const requestOptions = { ...options, payable: "0.01", payType: "yue" };
    const request = api.confirm(selected, requestOptions);
    selected[0].cartNum = 100; requestOptions.addressId = 22;
    resolve(preview());
    const confirmed = await request;
    expect(confirmed.prices.payable).toBe("21.00"); expect(confirmed.quoteToken).toBe("a".repeat(32));
    expect(post).toHaveBeenNthCalledWith(1, "/order/confirm", { cartIds: [1], ...options });
    expect((await api.computed("checkout_key1", [item], options)).quoteToken).toBe("a".repeat(32));
    expect(post).toHaveBeenNthCalledWith(2, "/order/computed/checkout_key1", options);
    await expect(api.computed("wrong_key1", [item], options)).rejects.toThrow("订单报价标识无效");
  });
  it.each([undefined, null, "", "a".repeat(31), "g".repeat(32)])("rejects a missing or malformed quote receipt %j", async quoteToken => {
    const api = createCheckoutApi({ get: vi.fn(), post: vi.fn().mockResolvedValue({ ...preview(), quoteToken }) });
    await expect(api.confirm([item], options)).rejects.toThrow("订单报价凭据无效");
    await expect(api.computed("checkout_key1", [item], options)).rejects.toThrow("订单报价凭据无效");
  });
});
