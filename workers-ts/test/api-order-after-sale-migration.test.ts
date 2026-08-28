import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseLegacyCartIds,
  parseLegacyRefundSelections,
} from "@/services/order/LegacyOrderCompatibilityService";
import { calculateAuthoritativeRefundCents } from "@/services/order/StoreOrderRefundService";

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

  it("uses short-lived opaque checkout and Alipay keys instead of trusting client totals", () => {
    const compatibility = source("src/services/order/LegacyOrderCompatibilityService.ts");
    const controller = source("src/controllers/api/v1/OrderController.ts");
    expect(compatibility).toContain("order:confirm:${uid}:${key}");
    expect(compatibility).toContain("pay:alipay:${key}");
    expect(compatibility).toContain("expirationTtl: CHECKOUT_TTL_SECONDS");
    expect(compatibility).toContain("expirationTtl: LEGACY_ALIPAY_TTL_SECONDS");
    expect(controller).toContain("StoreOrderCreateService");
    expect(controller).toContain("checkoutCartIds(uid, key)");
  });

  it("binds after-sale mutations to the authenticated user and guarded states", () => {
    const refund = source("src/services/order/StoreOrderRefundService.ts");
    expect(refund).toContain("eq(storeOrderRefund.uid, uid)");
    expect(refund).toContain("refund.applyType !== 2 || refund.refundType !== 4");
    expect(refund).toContain("previous.refundType !== 3");
    expect(refund).toContain("![3, 6].includes(refund.refundType)");
    expect(refund).toContain("退款商品数量超过可退数量");
    expect(refund).toContain("pg_advisory_xact_lock");
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
