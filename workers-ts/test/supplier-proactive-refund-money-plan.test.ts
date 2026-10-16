import { describe, expect, it } from 'vitest';
import { planSupplierProactiveMoneyRefund as plan, type SupplierMoneyHistory } from '@/services/supplier/SupplierProactiveRefundMoneyPlan';

const a = '13b48210-1570-4da2-85ee-10ea27b9dc22', b = 'ffe89662-aa82-4c80-b52f-0ec5cf296d66';
const base = (): SupplierMoneyHistory => ({ paid: '18.75', firstGoodsRefund: '7.00', payType: 'offline', completions: [], payments: [] });
const completion = (operationId = a, amount = '4.00', beforeRefunded = '7.00', afterRefunded = '11.00') =>
  ({ operationId, amount, beforeRefunded, afterRefunded });
describe('Supplier monetary continuation after a real whole-goods refund', () => {
  it.each(['cash', 'offline', 'yue', 'weixin', 'alipay'] as const)('preserves the original18.75 = first7.00 + remainder11.75 for %s', payType => {
    const result = plan({ ...base(), payType }, '11.75');
    expect(result).toEqual({ version: 'supplier-proactive-money-plan-v1', paid: '18.75', first_goods_refund: '7.00',
      refunded: '7.00', provider_reserved: '0.00', available: '11.75', requested: '11.75', after_refunded: '18.75', after_available: '0.00' });
    expect(Object.isFrozen(result)).toBe(true);
  });
  it('chains multiple genuine money deltas by exact amounts, independently of SQL/time order', () => {
    const history = { ...base(), completions: [completion(b, '1.25', '11.00', '12.25'), completion()] };
    expect(plan(history, '6.50')).toMatchObject({ refunded: '12.25', available: '6.50', after_refunded: '18.75' });
    expect(() => plan(history, '6.51')).toThrow('超过原付款');
  });
  it.each(['INIT', 'REQUESTING', 'PROCESSING', 'UNKNOWN', 'ABNORMAL'] as const)('reserves the full amount of an uncertain %s provider operation', status => {
    const history = { ...base(), payType: 'weixin' as const, payments: [{ operationId: a, amount: '4.00', status }] };
    expect(plan(history, '7.75')).toMatchObject({ provider_reserved: '4.00', available: '7.75', after_available: '0.00' });
    expect(() => plan(history, '7.76')).toThrow('超过原付款');
  });
  it('counts a successful provider payout once and keeps another request reserved', () => {
    const history = { ...base(), payType: 'alipay' as const, completions: [completion()], payments: [
      { operationId: a, amount: '4.00', status: 'SUCCESS' as const }, { operationId: b, amount: '2.00', status: 'UNKNOWN' as const }] };
    expect(plan(history, '5.75')).toMatchObject({ refunded: '11.00', provider_reserved: '2.00', available: '5.75', after_refunded: '16.75' });
  });
  it('releases only a conclusively closed operation without treating it as a completed payout', () => {
    expect(plan({ ...base(), payType: 'weixin', payments: [{ operationId: a, amount: '4.00', status: 'CLOSED' }] }, '11.75'))
      .toMatchObject({ refunded: '7.00', provider_reserved: '0.00', available: '11.75' });
  });
  it.each([
    { completions: [completion(), completion(a, '1.25', '11.00', '12.25')] },
    { completions: [completion(), completion(b, '1.25', '7.00', '8.25')] },
    { completions: [completion(b, '1.25', '11.00', '12.25')] },
    { completions: [completion(a, '4.00', '7.00', '11.01')] },
    { completions: [completion(a, '11.76', '7.00', '18.76')] },
    { completions: [completion(a, '0.00', '7.00', '7.00')] },
  ])('rejects a duplicate, forked, missing or inconsistent completion chain %j', patch => {
    expect(() => plan({ ...base(), ...patch }, '0.01')).toThrow();
  });
  it.each([
    { payType: 'weixin', payments: [{ operationId: a, amount: '4.00', status: 'SUCCESS' }] },
    { payType: 'weixin', completions: [completion()], payments: [] },
    { payType: 'alipay', completions: [completion()], payments: [{ operationId: a, amount: '4.00', status: 'PROCESSING' }] },
    { payType: 'weixin', completions: [completion()], payments: [{ operationId: a, amount: '4.01', status: 'SUCCESS' }] },
    { payType: 'offline', payments: [{ operationId: a, amount: '4.00', status: 'UNKNOWN' }] },
    { payType: 'yue', payments: [{ operationId: a, amount: '4.00', status: 'CLOSED' }] },
    { payType: 'weixin', payments: [{ operationId: a, amount: '4.00', status: 'UNKNOWN' }, { operationId: a, amount: '4.00', status: 'UNKNOWN' }] },
  ] satisfies Array<Partial<SupplierMoneyHistory>>)('requires actual matching channel completion and disjoint pending reservations %j', patch => {
    expect(() => plan({ ...base(), ...patch }, '0.01')).toThrow();
  });
  it.each(['0.00', '-0.01', '11.751', '1e2', '011.75', '11.7', ' 11.75'])('rejects an invalid new delta %s without rounding', amount => {
    expect(() => plan(base(), amount)).toThrow();
  });
  it('keeps integer cents exact at the SQL numeric12,2 boundary', () => {
    expect(plan({ ...base(), paid: '9999999999.99', firstGoodsRefund: '0.01' }, '9999999999.98'))
      .toMatchObject({ after_refunded: '9999999999.99', after_available: '0.00' });
    expect(() => plan({ ...base(), paid: '10000000000.00' }, '0.01')).toThrow();
  });
  it('refuses invalid first completion, exhausted balances and over-reservations', () => {
    expect(() => plan({ ...base(), firstGoodsRefund: '18.76' }, '0.01')).toThrow();
    expect(() => plan({ ...base(), firstGoodsRefund: '0.00' }, '0.01')).toThrow();
    expect(() => plan({ ...base(), firstGoodsRefund: '18.75' }, '0.01')).toThrow();
    expect(() => plan({ ...base(), payType: 'weixin', payments: [{ operationId: a, amount: '11.76', status: 'UNKNOWN' }] }, '0.01')).toThrow();
    expect(() => plan({ ...base(), paid: '0.00', firstGoodsRefund: '0.00' }, '0.01')).toThrow();
  });
  it('does not accept arbitrary channel/status strings or unbounded SQL histories', () => {
    expect(() => plan({ ...base(), payType: 'arbitrary' as never }, '0.01')).toThrow();
    expect(() => plan({ ...base(), payType: 'weixin', payments: [{ operationId: a, amount: '1.00', status: 'FAILED' as never }] }, '0.01')).toThrow();
    expect(() => plan({ ...base(), completions: Array(201).fill(completion()) }, '0.01')).toThrow();
  });
});
