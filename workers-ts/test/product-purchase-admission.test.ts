import { describe, expect, it } from 'vitest';
import { assertProductPurchaseBatch, assertProductPurchaseQuantity, productPurchaseLimits,
  type ProductLimitConfig } from '../src/services/order/ProductPurchaseAdmission';
import { ValidateException } from '../src/utils/errors';

const perOrder = (limitNum = 3): ProductLimitConfig => ({ isLimit: 1, limitType: 1, limitNum });
const malformed = (patch: Record<string, unknown>) => ({ ...perOrder(), ...patch }) as ProductLimitConfig;

describe('base-product purchase admission, without claiming cumulative history coverage', () => {
  it('ignores stale disabled rules while still requiring a valid purchase quantity', () => {
    const product = { isLimit: 0, limitType: 2, limitNum: -17 };
    expect(productPurchaseLimits(product)).toEqual({ mode: 'none', quantity: null });
    expect(() => assertProductPurchaseQuantity(product, 2_147_483_647)).not.toThrow();
    expect(() => assertProductPurchaseQuantity(product, 0)).toThrow(ValidateException);
  });

  it.each([1, 2_147_483_647])('retains an exact positive cap of %i', limitNum => {
    expect(productPurchaseLimits(perOrder(limitNum))).toEqual({ mode: 'per_order', quantity: limitNum });
    expect(() => assertProductPurchaseQuantity(perOrder(limitNum), limitNum)).not.toThrow();
  });

  it('permits the single-purchase boundary and rejects the next unit', () => {
    expect(() => assertProductPurchaseQuantity(perOrder(), 3)).not.toThrow();
    expect(() => assertProductPurchaseQuantity(perOrder(), 4)).toThrow('单次购买不能超过3件');
  });

  it('recognizes cumulative configuration but never manufactures a remaining allowance', () => {
    const product = { isLimit: 1, limitType: 2, limitNum: 100 };
    expect(productPurchaseLimits(product)).toEqual({ mode: 'cumulative', quantity: 100 });
    expect(() => assertProductPurchaseQuantity(product, 1)).toThrow('累计限购历史');
  });

  it.each([
    { isLimit: -1 }, { isLimit: 2 }, { isLimit: '1' }, { isLimit: null },
    { limitType: 0 }, { limitType: 3 }, { limitType: 1.5 }, { limitType: '1' },
    { limitNum: 0 }, { limitNum: -1 }, { limitNum: 1.5 }, { limitNum: 2_147_483_648 },
    { limitNum: Number.NaN }, { limitNum: Number.POSITIVE_INFINITY }, { limitNum: '3' }, { limitNum: null },
  ])('rejects an enabled malformed configuration %j', patch => {
    expect(() => productPurchaseLimits(malformed(patch))).toThrow(ValidateException);
  });

  it.each([0, -1, 1.5, 2_147_483_648, Number.NaN, Number.POSITIVE_INFINITY, '1', null])(
    'does not turn malformed requested quantity %j into a valid purchase', quantity => {
      expect(() => assertProductPurchaseQuantity(perOrder(), quantity as number)).toThrow(ValidateException);
      expect(() => assertProductPurchaseQuantity({ isLimit: 0, limitType: 0, limitNum: 0 }, quantity as number))
        .toThrow(ValidateException);
    });

  it('aggregates separate selected rows for one product before applying its cap', () => {
    const product = { id: 70, ...perOrder() };
    expect(() => assertProductPurchaseBatch([{ product, quantity: 2 }, { product, quantity: 1 }])).not.toThrow();
    expect(() => assertProductPurchaseBatch([{ product, quantity: 2 }, { product, quantity: 2 }]))
      .toThrow('单次购买不能超过3件');
  });

  it('does not pool quantities belonging to different base products', () => {
    expect(() => assertProductPurchaseBatch([
      { product: { id: 70, ...perOrder(2) }, quantity: 2 },
      { product: { id: 71, ...perOrder(1) }, quantity: 1 },
    ])).not.toThrow();
  });

  it.each([{ limitNum: 4 }, { limitType: 2 }, { isLimit: 0 }])(
    'rejects conflicting rules for the same selected product %j', patch => {
      const product = { id: 70, ...perOrder() };
      expect(() => assertProductPurchaseBatch([
        { product, quantity: 1 }, { product: { ...product, ...patch }, quantity: 1 },
      ])).toThrow('限购配置已变化');
    });

  it('compares disabled rows by effective rules, allowing irrelevant legacy residues to differ', () => {
    expect(() => assertProductPurchaseBatch([
      { product: { id: 70, isLimit: 0, limitType: 1, limitNum: 1 }, quantity: 2 },
      { product: { id: 70, isLimit: 0, limitType: 2, limitNum: 0 }, quantity: 2 },
    ])).not.toThrow();
  });

  it('rejects an overflowing aggregate even when individual rows and disabled rules are valid', () => {
    const product = { id: 70, isLimit: 0, limitType: 0, limitNum: 0 };
    expect(() => assertProductPurchaseBatch([
      { product, quantity: 2_147_483_647 }, { product, quantity: 1 },
    ])).toThrow(ValidateException);
  });

  it.each([{ id: 0, quantity: 1 }, { id: 1.5, quantity: 1 }, { id: 70, quantity: 0 }])(
    'rejects a malformed batch identity or quantity %j', row => {
      expect(() => assertProductPurchaseBatch([{ product: { ...perOrder(), id: row.id }, quantity: row.quantity }]))
        .toThrow(ValidateException);
    });
});
