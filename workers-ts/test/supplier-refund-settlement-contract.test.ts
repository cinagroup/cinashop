import { describe, expect, it } from 'vitest';
import { parseSupplierRefundSettlement, SUPPLIER_REFUND_SETTLEMENT_VERSION } from '../../view/common/supplierRefundSettlement';

const target = { order_id: 41, order_no: 'order_41', uid: 11, supplier_id: 7, store_id: 0,
  refund_id: 53, refund_no: 'SRoriginal', goods_refunded: '7.00' };
const value = () => ({ version: SUPPLIER_REFUND_SETTLEMENT_VERSION, state: 'verified', ...target,
  pay_type: 'offline', paid: '18.75', money_refunded: '5.00', refunded: '12.00', available: '6.75', money_payouts: 1 });

describe('closed read-only Supplier refund settlement projection', () => {
  it.each([
    { name: 'first goods only', later: '0.00', refunded: '7.00', available: '11.75', count: 0 },
    { name: 'one money payout', later: '5.00', refunded: '12.00', available: '6.75', count: 1 },
    { name: 'exact final remainder', later: '11.75', refunded: '18.75', available: '0.00', count: 2 },
  ])('accepts a separately bound $name without changing its first goods amount', row => {
    const original = { ...value(), money_refunded: row.later, refunded: row.refunded, available: row.available, money_payouts: row.count };
    const result = parseSupplierRefundSettlement(original, target);
    expect(result).toEqual(original);
    expect(result).not.toBe(original);
    expect(result.goods_refunded).toBe('7.00');
  });
  it.each(['order_id', 'order_no', 'uid', 'supplier_id', 'store_id', 'refund_id', 'refund_no', 'goods_refunded'] as const)(
    'rejects a response for another reviewed %s', key => {
      const changed = { ...value(), [key]: typeof target[key] === 'number' ? Number(target[key]) + 1 : 'wrong' };
      expect(() => parseSupplierRefundSettlement(changed, target)).toThrow();
    });
  it.each([
    { name: 'extra raw proof', patch: { proof: { source: 'private' } } },
    { name: 'extra execution identity', patch: { operation_id: '00000000-0000-4000-8000-000000000001' } },
    { name: 'unverified state', patch: { state: 'unverified' } },
    { name: 'unknown version', patch: { version: 'supplier-refund-settlement-v2' } },
    { name: 'provider channel', patch: { pay_type: 'weixin' } },
    { name: 'coercible pay type', patch: { pay_type: { toString: (): string => 'offline' } } },
    { name: 'overpaid total', patch: { refunded: '19.00' } },
    { name: 'invented remaining budget', patch: { available: '18.75' } },
    { name: 'unexplained cumulative total', patch: { money_refunded: '4.99' } },
    { name: 'zero later payout count', patch: { money_payouts: 0 } },
    { name: 'fractional payout count', patch: { money_payouts: 1.5 } },
    { name: 'unbounded payout count', patch: { money_payouts: 201 } },
    { name: 'noncanonical amount', patch: { paid: '018.75' } },
    { name: 'numeric amount', patch: { paid: 18.75 } },
    { name: 'negative amount', patch: { available: '-0.01' } },
  ])('rejects $name', row => {
    expect(() => parseSupplierRefundSettlement({ ...value(), ...row.patch }, target)).toThrow();
  });
  it('does not accept an older refund-detail response as a verified cumulative settlement', () => {
    expect(() => parseSupplierRefundSettlement({ ...target, refundPrice: '7.00', refundedPrice: '7.00' }, target)).toThrow();
  });
});
