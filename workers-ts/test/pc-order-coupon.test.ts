import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OrderCouponSession, normalizeOrderCouponPage, orderCouponRequest, orderCouponScope, type OrderCouponPage, type OrderCouponState } from "../../view/pc-ts/src/api/orderCoupons";
import type { CartItem } from "../../view/pc-ts/src/types/order";

const item: CartItem = { id: 1, productId: 70, cartNum: 2, type: 0, unique: "qared001", isNew: 1, isValid: true,
  productInfo: { storeName: "商品", image: "", price: "10.00", stock: 8, otPrice: "12.00", suk: "红色", systemFormId: 0, productType: 0 }, sumPrice: "20.00" };
const row = { id: 42, coupon_title: "八五折", coupon_price: "85.00", use_min_price: "10.00", coupon_type: 2, applicable_type: 0,
  start_time: null, end_time: null, availability: "available", availability_message: "未使用", estimated_discount: "2.70", eligible_subtotal: "18.00" };
const scope = orderCouponScope([item], 1, 0);
const page = (id = 42, cursor = "") => normalizeOrderCouponPage([{ ...row, id }], cursor);

describe("PC order coupon request and last-scanned cursor contract", () => {
  it("sends IDs/new/delivery and a bounded scan, never the client's product total or a coupon selection", () => {
    expect(orderCouponRequest(scope)).toEqual({ cartId: "1", new: 1, shipping_type: 1, store_id: 0, limit: 20 });
    expect(orderCouponRequest(orderCouponScope([{ ...item, isNew: 0 }], 2, 0), 49)).toEqual({ cartId: "1", new: 0, shipping_type: 2, store_id: 0, limit: 20, before: 49 });
    expect(() => orderCouponRequest(scope, 0)).toThrow();
  });
  it("invalidates snapshots for quantity, SKU, purchase mode, selected cart IDs and delivery changes", () => {
    for (const change of [{ cartNum: 1 }, { unique: "qablue01" }, { isNew: 0 }, { id: 2 }]) expect(orderCouponScope([{ ...item, ...change }], 1, 0).fingerprint).not.toBe(scope.fingerprint);
    expect(orderCouponScope([item], 2, 0).fingerprint).not.toBe(scope.fingerprint);
    expect(orderCouponScope([item], 2, 1).fingerprint).not.toBe(orderCouponScope([item], 2, 0).fingerprint);
    expect(orderCouponScope([item], 1, 99).fingerprint).toBe(scope.fingerprint);
    expect(orderCouponScope([item, { ...item, id: 2 }], 1, 0).fingerprint).toBe(orderCouponScope([{ ...item, id: 2 }, item], 1, 0).fingerprint);
  });
  it.each([[], [item, item], [item, { ...item, id: 2, isNew: 0 }], [{ ...item, type: 1 }], [{ ...item, isNew: 2 }],
    [{ ...item, isValid: false }], [{ ...item, cartNum: 0 }], [{ ...item, unique: "" }], [{ ...item, productInfo: null }],
  ].map((items) => ({ items })))("rejects invalid or mixed coupon scope %j", ({ items }) => {
    expect(() => orderCouponScope(items, 1, 0)).toThrow("订单筛券商品范围无效");
  });
  it("keeps an empty eligible page's scan cursor and displays server amounts without recomputing discounts", () => {
    expect(normalizeOrderCouponPage([], "49")).toEqual({ list: [], nextCursor: 49 });
    expect(normalizeOrderCouponPage([row], "40", 49)).toMatchObject({ list: [{ benefit: "8.5折", estimatedDiscount: "2.70", eligibleSubtotal: "18.00" }], nextCursor: 40 });
    expect(normalizeOrderCouponPage([], "", 40).nextCursor).toBeNull();
  });
  it.each(["NaN", "0", "-1", "1e3", "9007199254740992", 42])("rejects malformed scan cursor %j", (cursor) => {
    expect(() => normalizeOrderCouponPage([], cursor)).toThrow();
  });
  it("rejects repeated/backwards scans, out-of-order rows and wrong eligibility amounts", () => {
    for (const [rows, cursor, before] of [[[], "49", 49], [[row], "", 42], [[row], "43", undefined], [[{ ...row, id: 41 }, row], "", undefined]] as const) {
      expect(() => normalizeOrderCouponPage([...rows], cursor, before)).toThrow();
    }
    for (const change of [{ availability: "reserved" }, { estimated_discount: "NaN" }, { estimated_discount: "18.01" }, { eligible_subtotal: "0.00" }, { eligible_subtotal: "9.99" }]) {
      expect(() => normalizeOrderCouponPage([{ ...row, ...change }], "")).toThrow();
    }
  });
});

describe("PC order coupon scope lifecycle", () => {
  it("continues through an empty page instead of silently treating it as the end", async () => {
    const calls: (number | undefined)[] = []; let state: OrderCouponState;
    const session = new OrderCouponSession(async (_, before) => { calls.push(before); return before ? page() : { list: [], nextCursor: 49 }; }, (s) => { state = s; });
    await session.load(scope); expect(state!.list).toEqual([]); expect(state!.nextCursor).toBe(49);
    await session.load(scope, true); expect(calls).toEqual([undefined, 49]); expect(state!.list[0].id).toBe(42); expect(state!.nextCursor).toBeNull();
  });
  it("retains loaded rows and retries the same scan cursor after an append failure", async () => {
    const calls: (number | undefined)[] = []; let state: OrderCouponState;
    const session = new OrderCouponSession(async (_, before) => { calls.push(before); if (calls.length === 2) throw new Error("temporary failure"); return before ? page(39) : page(42, "40"); }, (s) => { state = s; });
    await session.load(scope); await session.load(scope, true);
    expect(state!.list.map((x) => x.id)).toEqual([42]); expect(state!.nextCursor).toBe(40); expect(state!.error).toBe("temporary failure");
    await session.load(scope, true); expect(calls).toEqual([undefined, 40, 40]); expect(state!.list.map((x) => x.id)).toEqual([42, 39]);
  });
  it.each(["success", "failure"])("discards late %s from a previous delivery scope", async (result) => {
    const requests: { resolve: (value: OrderCouponPage) => void; reject: (error: Error) => void }[] = []; let state: OrderCouponState;
    const session = new OrderCouponSession(() => new Promise((resolve, reject) => requests.push({ resolve, reject })), (s) => { state = s; });
    const first = session.load(scope), pickup = orderCouponScope([item], 2, 1), second = session.load(pickup);
    requests[1].resolve(page(41)); await second;
    if (result === "success") requests[0].resolve(page()); else requests[0].reject(new Error("old failure"));
    await first; expect(state!.fingerprint).toBe(pickup.fingerprint); expect(state!.list[0].id).toBe(41); expect(state!.error).toBe("");
  });
  it("invalidates in-flight reads on reset and preserves the visible page when submission freezes it", async () => {
    let resolve!: (value: OrderCouponPage) => void; let state: OrderCouponState; let calls = 0;
    const session = new OrderCouponSession(async () => ++calls === 1 ? page(42, "40") : new Promise((done) => { resolve = done; }), (s) => { state = s; });
    await session.load(scope); const pending = session.load(scope, true); session.pause(); const frozen = state!;
    resolve(page(39)); await pending; expect(state!).toBe(frozen); expect(state!.list.map((x) => x.id)).toEqual([42]);
    const stale = session.load(scope); session.reset(); resolve(page()); await stale; expect(state!.list).toEqual([]); expect(state!.fingerprint).toBe("");
  });
  it("refuses non-progressing append pages even if a caller bypasses the wire adapter", async () => {
    let state: OrderCouponState; const session = new OrderCouponSession(async (_, before) => before ? { list: [], nextCursor: before } : page(42, "40"), (s) => { state = s; });
    await session.load(scope); await session.load(scope, true);
    expect(state!.error).toContain("分页顺序"); expect(state!.nextCursor).toBe(40); expect(state!.list[0].id).toBe(42);
  });
  it("wires checkout to the order picker, retains full quote/create, and leaves the personal wallet separate", () => {
    const checkout = readFileSync("../view/pc-ts/src/pages/order/Checkout.vue", "utf8");
    const api = readFileSync("../view/pc-ts/src/api/order.ts", "utf8");
    expect(api).toContain('request.get("/coupons/order/0", { params: orderCouponRequest(scope, before) })');
    expect(checkout).toContain("new OrderCouponSession(apiOrderCoupons"); expect(checkout).not.toContain("apiMyCoupons");
    expect(checkout).toContain("couponPicker.pause()"); expect(checkout).toContain("本页暂无适用优惠券，可继续查找");
    expect(checkout).toContain("if (refreshUnselectedQuote) void reloadQuote()");
    expect(checkout).toContain('v-if="!pendingSubmission && couponContext.scope');
    expect(checkout).toContain("提交内容已锁定，确认结果前不能更换优惠券");
    expect(checkout).toContain("selectedCouponId.value = 0"); expect(checkout).toContain("await apiOrderCreate(orderKey.value, pendingSubmission.value!)");
    expect(readFileSync("../view/pc-ts/src/pages/user/CouponList.vue", "utf8")).toContain("new CouponWalletSession(apiMyCoupons");
  });
});
