import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { couponWalletQuery } from "../src/services/activity/UserCouponWalletService";
import { normalizeCouponPage, CouponWalletSession, type CouponWalletState, type CouponPage } from "../../view/pc-ts/src/api/couponWallet";

const row = { id: 42, coupon_title: "八五折", coupon_price: "85.00", use_min_price: "10.00", coupon_type: 2, applicable_type: 3,
  start_time: "2026-09-06T16:00:00.000Z", end_time: null, availability: "available", availability_message: "未使用" };
describe("PC coupon wallet and selection contracts", () => {
  it("honours path status, retains the existing query override and bounds pagination", () => {
    expect(couponWalletQuery("2", {})).toEqual({ status: 2, limit: 20, before: 0, page: 1, filter: null });
    expect(couponWalletQuery("0", { status: "1", before: "88", limit: "10" })).toEqual({ status: 1, limit: 10, before: 88, page: 1, filter: null });
    expect(couponWalletQuery("3", {}).status).toBe(3);
    for (const q of [{ status: "-1" }, { status: "4" }, { status: "1x" }, { limit: "0" }, { limit: "101" }, { before: "NaN" }, { before: "2", page: "2" }, { page: "1001" }]) expect(() => couponWalletQuery("0", q)).toThrow();
  });
  it("distinguishes percentage coupons from money and uses the v1 scope meaning", () => {
    expect(normalizeCouponPage([row], "").list[0]).toMatchObject({ id: 42, benefit: "8.5折", minimum: "10.00", scope: "品牌券", availability: "available" });
    expect(normalizeCouponPage([{ ...row, coupon_type: 1, coupon_price: "5.00", applicable_type: 0 }], "").list[0]).toMatchObject({ benefit: "¥5.00", scope: "通用券" });
    expect(normalizeCouponPage([{ ...row, coupon_price: "85.99" }], "").list[0].benefit).toBe("8.5折");
    expect(normalizeCouponPage([row], "42").nextCursor).toBe(42);
  });
  it("renders dates in the shop timezone and nullable validity without guessing Unix/string units", () => {
    expect(normalizeCouponPage([row], "").list[0].validity).toContain("2026/09/07");
    expect(normalizeCouponPage([{ ...row, start_time: null }], "").list[0].validity).toBe("不限 至 不限");
  });
  it.each([{ id: 0 }, { coupon_type: "2" }, { coupon_type: 3 }, { coupon_price: "101.00" }, { coupon_price: "NaN" }, { coupon_price: "-1" },
    { use_min_price: "1e3" }, { start_time: 1788739200 }, { availability: "guessed" }])("rejects malformed server contracts %j", (change) => {
    expect(() => normalizeCouponPage([{ ...row, ...change }], "")).toThrow();
  });
  it("rejects duplicate rows, malformed cursors and cursor/row mismatches", () => {
    expect(() => normalizeCouponPage([row, row], "")).toThrow();
    expect(() => normalizeCouponPage([row], "43")).toThrow();
    expect(() => normalizeCouponPage([row], "bad")).toThrow();
  });
  it("discards old-tab success and failure without restoring stale lists", async () => {
    const requests: { resolve: (p: CouponPage) => void; reject: (e: Error) => void }[] = [];
    let state: CouponWalletState;
    const wallet = new CouponWalletSession(() => new Promise((resolve, reject) => requests.push({ resolve, reject })), (s) => { state = s; });
    const first = wallet.load(0), second = wallet.load(1);
    requests[1].resolve(normalizeCouponPage([{ ...row, availability: "used" }], "")); await second;
    requests[0].reject(new Error("old error")); await first;
    expect(state!.list[0].availability).toBe("used"); expect(state!.error).toBe("");
    const third = wallet.load(0); wallet.reset(); requests[2].resolve(normalizeCouponPage([row], "")); await third;
    expect(state!.list).toEqual([]);
  });
  it("retries the same append cursor after failure without discarding already loaded rows", async () => {
    const calls: (number | undefined)[] = []; let count = 0; let state: CouponWalletState;
    const wallet = new CouponWalletSession(async (_, before) => { calls.push(before); if (++count === 2) throw new Error("offline");
      return normalizeCouponPage([{ ...row, id: before ? 41 : 42 }], before ? "" : "42"); }, (s) => { state = s; });
    await wallet.load(0); await wallet.load(0, true);
    expect(state!.list).toHaveLength(1); expect(state!.nextCursor).toBe(42); expect(state!.error).toBe("offline");
    await wallet.load(0, true); expect(calls).toEqual([undefined, 42, 42]); expect(state!.list.map((x) => x.id)).toEqual([42, 41]);
  });
  it("passes selected coupon IDs into the authoritative quote and freezes the same options for creation", () => {
    const checkout = readFileSync("../view/pc-ts/src/pages/order/Checkout.vue", "utf8");
    expect(checkout).toContain("couponId: activityOptions.value.type === 0 ? selectedCouponId.value : 0");
    expect(checkout).toContain("watch(quoteOptions"); expect(checkout).toContain("...quoteOptions.value,");
    expect(checkout).toContain("couponDiscount === '0.00'");
    expect(checkout).toContain('if (pendingSubmission.value || couponState.value.loading');
    expect(checkout).toContain('couponState.value.fingerprint !== couponContext.value.scope?.fingerprint');
    expect(checkout).toContain('!couponState.value.list.some');
    expect(checkout).not.toContain("couponPrice:");
    const page = readFileSync("../view/pc-ts/src/pages/user/CouponList.vue", "utf8");
    expect(page).not.toContain("as any"); expect(page).toContain('name="3"'); expect(page).toContain("state.error");
  });
});
