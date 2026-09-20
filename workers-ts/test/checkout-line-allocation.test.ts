import { describe, expect, it } from 'vitest';
import { allocateCheckoutLineUnits, fitCheckoutLineCapacities } from '../src/services/order/CheckoutLineAllocation';
import { calculateOrderPostageBreakdown, type ShippingItemInput, type ShippingRegionInput } from '../src/services/order/ShippingCalculator';
import { calculateOrderBrokerage, type OrderBrokerageLineAmounts } from '../src/services/order/OrderBrokerageService';

const item = (overrides: Partial<ShippingItemInput> = {}): ShippingItemInput => ({
  freight: 3, postage: '0.00', tempId: 10, quantity: 1, unitPrice: '10.00', weight: '1.00', volume: '1.00', ...overrides,
});
const region = (templateId = 10, overrides: Partial<ShippingRegionInput> = {}): ShippingRegionInput => ({
  id: templateId, templateId, regionId: 0, regionName: '全国', first: '2.00', firstPrice: '6.00',
  continue: '1.00', continuePrice: '1.00', ...overrides,
});

describe('admitted checkout line allocation', () => {
  it('uses the PHP points ratio and preserves final residues without assigning zero-weight lines', () => {
    expect(allocateCheckoutLineUnits(7, [1, 2, 0], 4)).toEqual([2, 5, 0]);
    expect(allocateCheckoutLineUnits(0, [0, 0], 4)).toEqual([0, 0]);
    expect(allocateCheckoutLineUnits(1, [1, 1], null)).toEqual([0, 1]);
    expect(allocateCheckoutLineUnits(999999999999, [999999999999, 1], null)).toEqual([999999999998, 1]);
  });
  it('rounds template shares after a six-place ratio without overflowing the admitted charge', () => {
    expect(allocateCheckoutLineUnits(700, [2, 1], 6)).toEqual([467, 233]);
    expect(allocateCheckoutLineUnits(2, [1, 1, 1, 1], 6)).toEqual([1, 1, 0, 0]);
  });
  it('conserves totals with nonnegative shares over small weight/total combinations', () => {
    for (const precision of [null, 4, 6] as const) for (let total = 0; total < 20; total++) {
      for (let a = 0; a < 5; a++) for (let b = 1; b < 5; b++) {
        const shares = allocateCheckoutLineUnits(total, [a, b, 0], precision);
        expect(shares.reduce((sum, value) => sum + value, 0)).toBe(total);
        expect(shares.every(value => Number.isInteger(value) && value >= 0)).toBe(true);
        expect(shares[2]).toBe(0);
        if (!a) expect(shares[0]).toBe(0);
      }
    }
  });
  it.each([
    { total: 1, weights: [] }, { total: 1, weights: [0, 0] }, { total: -1, weights: [1] },
    { total: 1.5, weights: [1] }, { total: 1, weights: [NaN] }, { total: 1, weights: [-1] },
    { total: 1, weights: Array(201).fill(1) as number[] },
  ])('rejects incomplete evidence $total / $weights', ({ total, weights }) => {
    expect(() => allocateCheckoutLineUnits(total, weights, 4)).toThrow();
  });
  it('only moves discount overflow, keeping other PHP shares and all admitted totals', () => {
    expect(fitCheckoutLineCapacities([99, 1], [200, 1])).toEqual([99, 1]);
    expect(fitCheckoutLineCapacities([100, 1], [101, 0])).toEqual([101, 0]);
    expect(fitCheckoutLineCapacities([1, 9, 3], [4, 5, 9])).toEqual([1, 5, 7]);
    expect(() => fitCheckoutLineCapacities([2, 2], [1, 1])).toThrow('超过商品金额');
  });
});

describe('line postage comes from the actual winning template charges', () => {
  it('retains fixed charges and free lines separately', () => {
    expect(calculateOrderPostageBreakdown([item({ freight: 2, quantity: 2, postage: '3.00' }), item({ freight: 1 })], [], [], {}))
      .toEqual({ totalCents: 600, lineCents: [600, 0] });
  });
  it('allocates within a template by quantities, not item price', () => {
    expect(calculateOrderPostageBreakdown([item({ quantity: 2, unitPrice: '1.00' }), item({ unitPrice: '100.00' })], [{ id: 10, type: 1 }], [region()], {}))
      .toEqual({ totalCents: 700, lineCents: [467, 233] });
  });
  it.each([2, 3])('uses the template measurement type %i', type => {
    expect(calculateOrderPostageBreakdown([item(), item({ weight: '3.00', volume: '3.00' })], [{ id: 10, type }],
      [region(10, { first: '1.00', firstPrice: '10.00', continuePrice: '2.00' })], {}))
      .toEqual({ totalCents: 1600, lineCents: [400, 1200] });
  });
  it('selects the same highest-cost first-fee candidate and retains each template contribution', () => {
    expect(calculateOrderPostageBreakdown([item({ quantity: 5 }), item({ tempId: 20 })], [{ id: 10, type: 1 }, { id: 20, type: 1 }],
      [region(10, { firstPrice: '5.00', continue: '2.00' }), region(20, { first: '1.00', firstPrice: '5.00', continuePrice: '10.00' })], {}))
      .toEqual({ totalCents: 1700, lineCents: [700, 1000] });
  });
  it('preserves the first candidate on an equal-price tie', () => {
    expect(calculateOrderPostageBreakdown([item(), item({ tempId: 20 })], [{ id: 10, type: 1 }, { id: 20, type: 1 }],
      [region(10, { firstPrice: '5.00', continuePrice: '2.00' }), region(20, { firstPrice: '5.00', continuePrice: '2.00' })], {}))
      .toEqual({ totalCents: 700, lineCents: [500, 200] });
  });
  it('does not allocate a fee to designated-free templates', () => {
    expect(calculateOrderPostageBreakdown([item(), item({ freight: 2, postage: '3.00' })], [{ id: 10, type: 1, appoint: 1 }], [], {},
      [{ id: 1, tempId: 10, provinceId: 0, cityId: 0, number: '1', price: '1.00', value: '' }]))
      .toEqual({ totalCents: 300, lineCents: [0, 300] });
  });
  it('waives money but still checks no-delivery eligibility', () => {
    expect(calculateOrderPostageBreakdown([item()], [], [], {}, [], [], { waivePostage: true }))
      .toEqual({ totalCents: 0, lineCents: [0] });
    expect(() => calculateOrderPostageBreakdown([item()], [{ id: 10, type: 1, noDelivery: 1 }], [], {}, [],
      [{ id: 1, tempId: 10, provinceId: 0, cityId: 0, value: '' }], { waivePostage: true })).toThrow('不支持配送');
  });
  it('preserves a configured first fee at zero weight using quantities', () => {
    expect(calculateOrderPostageBreakdown([item({ weight: '0' }), item({ weight: '0', quantity: 3 })], [{ id: 10, type: 2 }],
      [region(10, { firstPrice: '10.00' })], {})).toEqual({ totalCents: 1000, lineCents: [250, 750] });
  });
});

describe('commission evidence keeps per-SKU rule contributions', () => {
  it('captures specified/percentage/profit/recipient exclusions without changing public totals', () => {
    for (const computeType of [1, 2, 3] as const) {
      const lines: OrderBrokerageLineAmounts[] = [];
      const total = calculateOrderBrokerage({ items: [
        { grossCents: 10000, costCents: 6000, quantity: 2, specified: true, specifiedOneCents: 300, specifiedTwoCents: 100 },
        { grossCents: 5000, costCents: 2000, quantity: 1, specified: false, specifiedOneCents: 0, specifiedTwoCents: 0 },
      ], actualProductCents: 12500, computeType, oneBasisPoints: 1000, twoBasisPoints: 500,
        staffBasisPoints: 100, agentBasisPoints: 200, divisionBasisPoints: 300, oneEligible: true, twoEligible: false }, line => { lines.push(line); });
      expect(lines).toHaveLength(2);
      expect(lines[0]).toEqual({ oneCents: 600, twoCents: 0, staffCents: 0, agentCents: 0, divisionCents: 0 });
      for (const field of ['oneCents', 'twoCents', 'staffCents', 'agentCents', 'divisionCents'] as const) {
        expect(lines.reduce((sum, line) => sum + line[field], 0)).toBe(total[field]);
      }
      expect(lines[1].oneCents).toBe(computeType === 1 ? 500 : computeType === 2 ? 416 : 216);
    }
  });
});
