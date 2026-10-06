import { describe, expect, it } from "vitest";
import { cartProjection } from "../src/services/kefu/KefuOrderService";

type Cart = Parameters<typeof cartProjection>[0];

const allocation = { promotionId: 101, rootId: 101, type: 1,
  savingsCents: 50, discountQuantity: 1, labelIds: [], name: "限时五折" };

function promotionSnapshot() {
  return {
    cart_num: 2,
    sku: { price: "0.67", suk: "标准" },
    vip_truePrice: "0.07",
    coupon_price: "0.05",
    integral_price: "0.00",
    first_order_price: "0.00",
    sum_true_price: "1.30",
    promotion_quote_version: "order-promotion-quote-v1",
    promotion_line_price: "1.35",
    promotion_line_savings: "0.50",
    promotion_line_member_savings: "0.15",
    promotion_discount_quantity: 1,
    promotion_allocations: [allocation],
    promotion_segments: [
      { quantity: 1, rawGrossCents: 100, totalPriceCents: 50, unitPriceCents: 50,
        membershipSavingsCents: 0, promotionIds: [101], promotionAllocations: [allocation],
        couponEligibleGrossCents: 0 },
      { quantity: 1, rawGrossCents: 100, totalPriceCents: 85, unitPriceCents: 85,
        membershipSavingsCents: 15, promotionIds: [], promotionAllocations: [],
        couponEligibleGrossCents: 85 },
    ],
  };
}

function cart(cartInfo: string, cartNum = 2): Cart {
  return { id: 1, oid: 9, uid: 7, cartId: "1", productId: 31, productType: 0,
    skuUnique: "standard", unique: "line-1", cartNum, refundNum: 0, surplusNum: cartNum,
    isGift: 0, isSupportRefund: 1, cartInfo } as Cart;
}

describe("customer-service exact promotion line projection", () => {
  it("uses the verified net line and member saving for a partially discounted quantity", () => {
    const projected = cartProjection(cart(JSON.stringify(promotionSnapshot())));
    expect(projected.truePrice).toBe("0.67"); // Legacy display unit is rounded down.
    expect(projected.sum_true_price).toBe("1.30"); // Exact 1.35 line less 0.05 coupon.
    expect(projected.vip_sum_truePrice).toBe("0.15"); // One member-priced unit, not 0.07 × 2.
  });

  it("keeps the historical unit-price fallback when no quote evidence exists", () => {
    const projected = cartProjection(cart(JSON.stringify({ sku: { price: "1.10" }, vip_truePrice: "0.05" })));
    expect(projected.sum_true_price).toBe("2.20");
    expect(projected.vip_sum_truePrice).toBe("0.10");
  });

  it("rejects malformed or inconsistent versioned evidence instead of displaying a guessed total", () => {
    const wrongTotal = { ...promotionSnapshot(), sum_true_price: "1.31" };
    expect(() => cartProjection(cart(JSON.stringify(wrongTotal)))).toThrow("快照");
    const wrongVersion = { ...promotionSnapshot(), promotion_quote_version: "unknown" };
    expect(() => cartProjection(cart(JSON.stringify(wrongVersion)))).toThrow("快照");
    expect(() => cartProjection(cart('{"promotion_quote_version":"order-promotion-quote-v1",')))
      .toThrow("客服订单商品促销金额快照无效");
  });
});
