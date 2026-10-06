import { describe, expect, it } from 'vitest';
import { projectPickingSheetCartSnapshot } from '../src/services/supplier/SupplierPickingSheetReadService';

const allocation = { promotionId: 101, rootId: 101, type: 1,
  savingsCents: 50, discountQuantity: 1, labelIds: [], name: '限时五折' };

function mixedLine() {
  return {
    cart_num: 2, product: { storeName: '混合折扣商品' }, sku: { suk: '标准', price: '0.67' },
    sum_price: '0.67', vip_truePrice: '0.07',
    coupon_price: '0.05', integral_price: '0.00', first_order_price: '0.00', sum_true_price: '1.30',
    promotion_quote_version: 'order-promotion-quote-v1', promotion_line_price: '1.35',
    promotion_line_savings: '0.50', promotion_line_member_savings: '0.15',
    promotion_discount_quantity: 1, promotion_allocations: [allocation],
    promotion_segments: [
      { quantity: 1, rawGrossCents: 100, totalPriceCents: 50, unitPriceCents: 50,
        membershipSavingsCents: 0, promotionIds: [101], promotionAllocations: [allocation], couponEligibleGrossCents: 0 },
      { quantity: 1, rawGrossCents: 100, totalPriceCents: 85, unitPriceCents: 85,
        membershipSavingsCents: 15, promotionIds: [], promotionAllocations: [], couponEligibleGrossCents: 85 },
    ],
  };
}

function cart(snapshot: Record<string, unknown>, cartNum = 2) {
  return { cartNum, skuUnique: 'standard', settlePrice: '99.00', cartInfo: JSON.stringify(snapshot) };
}

describe('supplier picking sheet exact promotion line projection', () => {
  it('prints the verified mixed line subtotal and member saving while retaining the historical display unit', () => {
    const projected = projectPickingSheetCartSnapshot(cart(mixedLine()), 1);
    expect(projected.item).toMatchObject({ product_name: '混合折扣商品', unit_price: '0.67',
      quantity: 2, subtotal: '1.35' });
    expect(projected.vipDiscount).toBe(15n); // The rounded display unit gives only 0.14 when multiplied.
  });

  it('retains legacy per-unit totals and rejects inconsistent new evidence', () => {
    const legacy = projectPickingSheetCartSnapshot(cart({ sum_price: '1.10', vip_truePrice: '0.05' }), 2);
    expect(legacy.item).toMatchObject({ unit_price: '1.10', quantity: 2, subtotal: '2.20' });
    expect(legacy.vipDiscount).toBe(10n);
    expect(() => projectPickingSheetCartSnapshot(cart({ ...mixedLine(), promotion_line_member_savings: '0.14' }), 1))
      .toThrow('快照');
    expect(() => projectPickingSheetCartSnapshot(cart({ ...mixedLine(), promotion_quote_version: 'unknown' }), 1))
      .toThrow('快照');
    expect(() => projectPickingSheetCartSnapshot(cart(mixedLine(), 1), 1)).toThrow('快照');
  });
});
