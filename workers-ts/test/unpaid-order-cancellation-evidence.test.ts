import { describe, expect, it } from 'vitest';
import { verifyUnpaidCancellationLines } from '@/services/order/UnpaidOrderCancellationEvidence';

const order = () => ({ id: 10, uid: 11, type: 0, cartId: '2,1', totalNum: 3, refundStatus: 0, refundType: 0, useIntegral: '50.00' });
const lines = () => [1, 2].map(id => ({ id: id + 20, oid: 10, uid: 11, cartId: String(id), oldCartId: '', productId: 70,
  skuUnique: `sku${id}`, cartNum: id, refundNum: 0, splitStatus: 0, splitSurplusNum: id, surplusNum: id, isWriteoff: 0,
  cartInfo: JSON.stringify({ financial_version: 'checkout-line-finance-v1', id: String(id), cart_num: id,
    product: { id: 70 }, sku: { id: id + 30, unique: `sku${id}` }, use_integral: id === 1 ? '50' : '0' }) }));

describe('unpaid cancellation original quantity evidence', () => {
  it('aggregates original product quantities, not SKU count, and returns canonical cart IDs', () => {
    expect(verifyUnpaidCancellationLines(order(), lines())).toEqual({ version: 'unpaid-cancellation-lines-v1', modern: true,
      products: [{ productId: 70, quantity: 3 }], cartIds: [1, 2] });
  });
  it.each([{ totalNum: 4 }, { totalNum: 0 }, { uid: 22 }, { id: 99 }, { cartId: '1,1' }, { cartId: '1,3' },
    { cartId: '01,2' }, { cartId: '1' }, { cartId: '1,2,3' }, { refundStatus: 1 }, { refundType: 6 },
    { useIntegral: '51.00' }, { useIntegral: '50.01' }])('rejects order drift %j', change => {
    expect(() => verifyUnpaidCancellationLines({ ...order(), ...change }, lines())).toThrow(/取消订单数量或归属/);
  });
  it.each([{ uid: 22 }, { oid: 12 }, { id: 22 }, { cartId: '2' }, { cartId: '3' }, { productId: 71 }, { cartNum: 2 },
    { cartNum: 0 }, { cartNum: -1 }, { cartNum: 32768 }, { oldCartId: '5' }, { refundNum: 1 }, { splitStatus: 1 },
    { splitSurplusNum: 0 }, { surplusNum: 0 }, { isWriteoff: 1 }, { skuUnique: 'other' }, { cartInfo: '[]' },
    { cartInfo: 'null' }, { cartInfo: '{invalid' }])('rejects line drift %j', change => {
    const rows = lines(); Object.assign(rows[0], change);
    expect(() => verifyUnpaidCancellationLines(order(), rows)).toThrow(/取消订单数量或归属/);
  });
  it.each([{ financial_version: 'refund-order-line-finance-v1' }, { financial_version: null }, { id: '3' }, { cart_num: 2 },
    { product: { id: 71 } }, { sku: { id: '31', unique: 'sku1' } }, { sku: { id: 31, unique: 'other' } },
    { use_integral: '50.5' }, { use_integral: '-1' }, { refund_order_generation: null }])('rejects frozen evidence drift %j', change => {
    const rows = lines(); rows[0].cartInfo = JSON.stringify({ ...JSON.parse(rows[0].cartInfo), ...change });
    expect(() => verifyUnpaidCancellationLines(order(), rows)).toThrow(/取消订单数量或归属/);
  });
  it('keeps coherent legacy cancellation separate from modern evidence, with no invented point proof', () => {
    const rows = lines().map(row => ({ ...row, cartInfo: JSON.stringify({ sku: { id: 31 } }) }));
    expect(verifyUnpaidCancellationLines(order(), rows).modern).toBe(false);
  });
  it('rejects a missing version on just one modern line rather than silently mixing contracts', () => {
    const rows = lines(); rows[0].cartInfo = JSON.stringify({ sku: { id: 31 } });
    expect(() => verifyUnpaidCancellationLines(order(), rows)).toThrow();
  });
  it('rejects empty, oversized and duplicate line collections', () => {
    for (const rows of [[], Array.from({ length: 201 }, () => lines()[0]), [lines()[0], lines()[0]]])
      expect(() => verifyUnpaidCancellationLines(order(), rows)).toThrow();
  });
  it('rejects unbounded snapshot parsing before decoding JSON', () => {
    const rows = lines(); rows[0].cartInfo = ' '.repeat(65537);
    expect(() => verifyUnpaidCancellationLines(order(), rows)).toThrow();
  });
  it('bounds UTF-8 bytes, not only JavaScript character count', () => {
    const rows = lines();
    rows[0].cartInfo = JSON.stringify({ ...JSON.parse(rows[0].cartInfo), note: '图'.repeat(22000) });
    expect(rows[0].cartInfo.length).toBeLessThan(65536);
    expect(() => verifyUnpaidCancellationLines(order(), rows)).toThrow();
  });
  it('rejects aggregate snapshot bytes above 8 MiB even when individual rows are bounded', () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ ...lines()[0], id: i + 1, cartId: String(i + 1),
      cartInfo: JSON.stringify({ sku: { id: 31 }, note: 'x'.repeat(45000) }) }));
    expect(() => verifyUnpaidCancellationLines({ ...order(), totalNum: 200,
      cartId: rows.map(row => row.cartId).join(',') }, rows)).toThrow();
  });
  it('preserves guest assisted-order cancellation with exact uid=0 lineage', () => {
    expect(verifyUnpaidCancellationLines({ ...order(), uid: 0 }, lines().map(row => ({ ...row, uid: 0 }))).modern).toBe(true);
  });
  it.each([1, 2, 3])('recognizes the exact frozen activity SKU for old client type=%s', type => {
    const rows = lines().map(row => ({ ...row, skuUnique: 'activity', cartInfo: JSON.stringify({ ...JSON.parse(row.cartInfo),
      activitySku: { id: 99, unique: 'activity' } }) }));
    expect(verifyUnpaidCancellationLines({ ...order(), type }, rows).modern).toBe(true);
    expect(() => verifyUnpaidCancellationLines({ ...order(), type: 6 }, rows)).toThrow();
  });
});
