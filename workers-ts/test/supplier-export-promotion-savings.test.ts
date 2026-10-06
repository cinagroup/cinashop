import { describe, expect, it } from "vitest";
import { projectSupplierExportCartSnapshot } from "../src/services/supplier/SupplierExportService";

type Cart = Parameters<typeof projectSupplierExportCartSnapshot>[0];

const allocation = { promotionId: 101, rootId: 101, type: 1,
  savingsCents: 50, discountQuantity: 1, labelIds: [], name: "限时五折" };

function snapshot() {
  return {
    cart_num: 2,
    product: { storeName: "商品" }, sku: { suk: "标准", price: "0.67" },
    sum_price: "0.67", vip_truePrice: "0.07",
    coupon_price: "0.00", integral_price: "0.00", first_order_price: "0.00",
    sum_true_price: "1.35",
    promotion_quote_version: "order-promotion-quote-v1",
    promotion_line_price: "1.35", promotion_line_savings: "0.50",
    promotion_line_member_savings: "0.15", promotion_discount_quantity: 1,
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

function cart(value: Record<string, unknown>, cartNum = 2): Cart {
  return { cartNum, skuUnique: "standard", snapshot: value } as Cart;
}

describe("supplier export member savings on a partially discounted line", () => {
  it("uses verified exact savings instead of a rounded unit multiplied by quantity", () => {
    const projected = projectSupplierExportCartSnapshot(cart(snapshot()));
    expect(projected.price).toBe("0.67");
    expect(projected.vipCents).toBe(15n); // Display unit 0.07 × 2 would lose a cent.
  });

  it("keeps historical per-unit truncation without a promotion version", () => {
    expect(projectSupplierExportCartSnapshot(cart({
      product: { storeName: "旧商品" }, sku: { price: "1.10" },
      sum_price: "1.10", vip_truePrice: "0.05",
    })).vipCents).toBe(10n);
  });

  it("rejects inconsistent new evidence rather than exporting a guessed saving", () => {
    expect(() => projectSupplierExportCartSnapshot(cart({ ...snapshot(),
      promotion_line_member_savings: "0.14",
    }))).toThrow("快照");
    expect(() => projectSupplierExportCartSnapshot(cart({ ...snapshot(),
      promotion_quote_version: "unknown",
    }))).toThrow("快照");
    expect(() => projectSupplierExportCartSnapshot(cart(snapshot(), 1))).toThrow("快照");
  });
});
