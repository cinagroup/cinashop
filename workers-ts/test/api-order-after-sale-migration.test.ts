import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseLegacyCartIds,
  parseLegacyRefundSelections,
} from "@/services/order/LegacyOrderCompatibilityService";
import {
  calculateAuthoritativeRefundCents,
  isRefundWindowOpen,
} from "@/services/order/StoreOrderRefundService";
import {
  calculateIntegralDeduction,
  calculateMemberUnitPriceCents,
  isPaidMembershipActive,
} from "@/services/order/StoreOrderCreateService";

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), "utf8");

describe("API-002 order and after-sale migration", () => {
  it("registers every executable legacy order contract except the separate callback boundary", () => {
    const routes = source("src/routes/v1/index.ts");
    for (const contract of [
      '"/ali_pay"',
      '"/order/check_shipping"',
      '"/order/confirm"',
      '"/order/computed/:key"',
      '"/order/data"',
      '"/order/prize/:orderId"',
      '"/order/write/records/:id"',
      '"/order/refund/reason"',
      '"/order/refund/cart_info/:id"',
      '"/order/refund/cart_info"',
      '"/order/refund/verify"',
      '"/order/refund/express"',
      '"/order/refund/again/:id"',
      '"/order/refund/del/:uni"',
      '"/order/product"',
      '"/order/pay_cashier"',
    ]) {
      expect(routes).toContain(contract);
    }
    expect(routes).not.toContain('"/order_call_back"');
  });

  it("normalizes legacy cart identifiers without accepting duplicates or invalid values", () => {
    expect(parseLegacyCartIds("3,1,2")).toEqual([3, 1, 2]);
    expect(parseLegacyCartIds([7, 8])).toEqual([7, 8]);
    expect(() => parseLegacyCartIds("1,1")).toThrow("有效的购物车商品");
    expect(() => parseLegacyCartIds("0,2")).toThrow("有效的购物车商品");
  });

  it("preserves authoritative quantities from legacy partial-refund selections", () => {
    expect(parseLegacyRefundSelections([
      { cart_id: 11, cart_num: 2 },
      { cartId: 12, cartNum: 1 },
    ])).toEqual([
      { cartId: 11, cartNum: 2 },
      { cartId: 12, cartNum: 1 },
    ]);
    expect(() => parseLegacyRefundSelections([{ cart_id: 11, cart_num: 0 }]))
      .toThrow("退款商品件数错误");
  });

  it("prices partial refunds from server snapshots instead of item-count ratios", () => {
    const lines = [
      { cartId: 11, cartNum: 1, lineCents: 9_000 },
      { cartId: 12, cartNum: 9, lineCents: 900 },
    ];
    expect(calculateAuthoritativeRefundCents(
      9_900,
      lines,
      new Map(),
      [{ cartId: 11, cartNum: 1 }],
    )).toBe(9_000);
    expect(calculateAuthoritativeRefundCents(
      1_001,
      [{ cartId: 21, cartNum: 3, lineCents: 1_001 }],
      new Map([[21, 1]]),
      [{ cartId: 21, cartNum: 1 }],
    )).toBe(334);
  });

  it("enforces the PHP receipt-based after-sale boundary inclusively", () => {
    const receivedAt = 1_700_000_000;
    expect(isRefundWindowOpen(receivedAt, 0, receivedAt + 99_999_999)).toBe(true);
    expect(isRefundWindowOpen(receivedAt, 7, receivedAt + 7 * 86_400)).toBe(true);
    expect(isRefundWindowOpen(receivedAt, 7, receivedAt + 7 * 86_400 + 1)).toBe(false);
    expect(isRefundWindowOpen(0, 7, receivedAt + 99_999_999)).toBe(true);
  });

  it("uses member and integral policies shared by preview and order creation", () => {
    expect(isPaidMembershipActive({ isMoneyLevel: 1, isEverLevel: 0, overdueTime: 101 }, 100))
      .toBe(true);
    expect(isPaidMembershipActive({ isMoneyLevel: 1, isEverLevel: 0, overdueTime: 100 }, 100))
      .toBe(false);
    expect(isPaidMembershipActive({ isMoneyLevel: 0, isEverLevel: 1, overdueTime: 0 }, 100))
      .toBe(true);
    expect(calculateMemberUnitPriceCents({
      basePriceCents: 10_000,
      levelDiscountPercent: 90,
      paidMemberPriceCents: 8_000,
      paidMemberActive: true,
      paidMemberPriceEnabled: true,
      productPaidMemberPriceEnabled: true,
    })).toEqual({ unitPriceCents: 8_000, discountCents: 2_000, priceType: "member" });
    expect(calculateMemberUnitPriceCents({
      basePriceCents: 10_000,
      levelDiscountPercent: 90,
      paidMemberPriceCents: 8_000,
      paidMemberActive: false,
      paidMemberPriceEnabled: true,
      productPaidMemberPriceEnabled: true,
    })).toEqual({ unitPriceCents: 9_000, discountCents: 1_000, priceType: "level" });
    expect(calculateIntegralDeduction({
      requested: true,
      enabled: true,
      usablePoints: 500,
      payableCents: 10_000,
      ratio: "0.01",
      maxType: 1,
      maxNum: 200,
      maxRate: 0,
    })).toEqual({ deductionCents: 200, usedPoints: 200, surplusPoints: 300 });
    expect(calculateIntegralDeduction({
      requested: true,
      enabled: true,
      usablePoints: 500,
      payableCents: 1_000,
      ratio: "0.01",
      maxType: 2,
      maxNum: 0,
      maxRate: 20,
    })).toEqual({ deductionCents: 200, usedPoints: 200, surplusPoints: 300 });
  });

  it("uses short-lived opaque checkout and Alipay keys instead of trusting client totals", () => {
    const compatibility = source("src/services/order/LegacyOrderCompatibilityService.ts");
    const controller = source("src/controllers/api/v1/OrderController.ts");
    expect(compatibility).toContain("order:confirm:${uid}:${key}");
    expect(compatibility).toContain("pay:alipay:${key}");
    expect(compatibility).toContain("expirationTtl: CHECKOUT_TTL_SECONDS");
    expect(compatibility).toContain("expirationTtl: LEGACY_ALIPAY_TTL_SECONDS");
    expect(controller).toContain("StoreOrderCreateService");
    expect(controller).toContain("checkoutCartIds(uid, key)");
    expect(compatibility).toContain(".quoteOrder({");
    expect(compatibility).not.toContain('pay_postage: "0.00"');
  });

  it("binds after-sale mutations to the authenticated user and guarded states", () => {
    const refund = source("src/services/order/StoreOrderRefundService.ts");
    expect(refund).toContain("eq(storeOrderRefund.uid, uid)");
    expect(refund).toContain("refund.applyType !== 2 || refund.refundType !== 4");
    expect(refund).toContain("previous.refundType !== 3");
    expect(refund).toContain("![3, 6].includes(refund.refundType)");
    expect(refund).toContain("退款商品数量超过可退数量");
    expect(refund).toContain("pg_advisory_xact_lock");
    expect(refund).toContain('get("refund_time_available")');
    expect(refund).toContain('inArray(storeOrderStatus.changeType, ["user_take_delivery", "take_delivery"])');
  });

  it("retires only the PHP route whose controller method does not exist", () => {
    const decisions = JSON.parse(source("audit/legacy-route-decisions.json")) as {
      decisions: Array<{ surface: string; method: string; path: string }>;
    };
    expect(decisions.decisions).toContainEqual(expect.objectContaining({
      surface: "api",
      method: "GET",
      path: "/api/order/nopay",
    }));
  });
});
