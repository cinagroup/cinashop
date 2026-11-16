import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { calculateCouponDiscountCents } from '@/services/activity/ProductCouponService';
import { calculateFirstOrderDiscountCents, parseFirstOrderPayPercent } from '@/services/activity/StoreNewcomerService';
import { allocateCheckoutLineUnits, fitCheckoutLineCapacities } from '@/services/order/CheckoutLineAllocation';

type Goldens = {
  arithmetic: Array<{ price: string; percent: string; coupon: { pay: string; discount: string }; first_order_before_cap: string }>;
  quantity: Array<{ unitCents: number; quantity: number; storedPayPercent: string; expectedCouponDiscountCents: number }>;
  allocations: Array<{ eligibleWeightsCents: number[]; couponDiscountCents: number;
    phpRawEligibleLineSharesCents: number[]; expectedBoundedPhpSharesCents: number[] }>;
};
// Captured from the fixed PHP expressions executed by a real BCMath runtime.
// They deliberately distinguish truncating the payable amount from truncating
// the discount, and the coupon rule from the independent first-order rule.
const goldens = JSON.parse(readFileSync('test/fixtures/php-coupon-rounding-goldens.json', 'utf8')) as Goldens;
const cents = (value: string) => {
  const [whole, fraction] = value.split('.');
  return Number(whole) * 100 + Number(fraction);
};

describe('fixed PHP percentage coupon BCMath goldens', () => {
  it.each(goldens.arithmetic)('quotes $price at stored pay percent $percent without losing a cent', sample => {
    const subtotal = cents(sample.price);
    const discount = calculateCouponDiscountCents({ discountType: 2, couponPrice: sample.percent,
      eligibleSubtotalCents: subtotal });
    expect(discount).toBe(cents(sample.coupon.discount));
    expect(subtotal - discount).toBe(cents(sample.coupon.pay));
    expect(calculateFirstOrderDiscountCents(subtotal, {
      enabled: true, limitEnabled: false, limitDays: 0,
      payPercent: parseFirstOrderPayPercent(sample.percent), limitCents: 99_999_999,
    })).toBe(cents(sample.first_order_before_cap));
  });

  it.each(goldens.quantity)('rounds the aggregated $quantity items of $unitCents cents', sample => {
    expect(calculateCouponDiscountCents({ discountType: 2, couponPrice: sample.storedPayPercent,
      eligibleSubtotalCents: sample.unitCents * sample.quantity })).toBe(sample.expectedCouponDiscountCents);
  });

  it.each(goldens.allocations)('preserves PHP scale4 line shares and bounds only overflowing residue %#', sample => {
    const raw = allocateCheckoutLineUnits(sample.couponDiscountCents, sample.eligibleWeightsCents, 4);
    expect(raw).toEqual(sample.phpRawEligibleLineSharesCents);
    const shares = fitCheckoutLineCapacities(raw, sample.eligibleWeightsCents);
    expect(shares).toEqual(sample.expectedBoundedPhpSharesCents);
    expect(shares.reduce((sum, value) => sum + value, 0)).toBe(sample.couponDiscountCents);
    shares.forEach((share, index) => {
      expect(share).toBeGreaterThanOrEqual(0);
      expect(share).toBeLessThanOrEqual(sample.eligibleWeightsCents[index]!);
    });
  });

  it.each(['0', '-1', '100.01', '101', '85.999', 'NaN', '1e2'])('keeps rejecting invalid configured percentage %s', couponPrice => {
    expect(() => calculateCouponDiscountCents({ discountType: 2, couponPrice, eligibleSubtotalCents: 1999 })).toThrow();
  });

  it('retains fixed-money clipping and integer safety at the largest admitted subtotal', () => {
    expect(calculateCouponDiscountCents({ discountType: 1, couponPrice: '20.00', eligibleSubtotalCents: 1999 })).toBe(1999);
    expect(calculateCouponDiscountCents({ discountType: 1, couponPrice: '0.01', eligibleSubtotalCents: 1999 })).toBe(1);
    const subtotal = Number.MAX_SAFE_INTEGER;
    const saving = calculateCouponDiscountCents({ discountType: 2, couponPrice: '99.99', eligibleSubtotalCents: subtotal });
    expect(Number.isSafeInteger(saving)).toBe(true);
    expect(BigInt(subtotal) - BigInt(saving)).toBe(BigInt(subtotal) * 99n / 100n);
    expect(() => calculateCouponDiscountCents({ discountType: 2, couponPrice: '85', eligibleSubtotalCents: subtotal + 1 })).toThrow();
  });
});
