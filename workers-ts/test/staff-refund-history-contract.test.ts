import { describe, expect, it } from 'vitest';
import { parseRefundHistory } from '../../view/common/refundHistory';

const scope = { id: 5, sourceOrderId: 7, refundType: 6, refundNum: 2, isCancel: 0 };
const valid = () => ({ version: 1, refundId: 5, sourceOrderId: 7, physicalOrderId: 12, itemsError: '',
  items: [{ id: 9, cartId: 90, name: '<b>纯文本商品</b>', sku: '红色', image: '', quantity: 2 }] });
describe('staff archive response identity and bounded projection', () => {
  it('accepts explicit history and keeps original source identity distinct from the selected child', () => {
    expect(parseRefundHistory(valid(), scope)).toEqual(valid());
    expect(parseRefundHistory(null, scope)).toBeNull(); expect(parseRefundHistory(undefined, scope)).toBeNull();
    expect(parseRefundHistory({ ...valid(), privateArchive: 'not projected' }, scope)).not.toHaveProperty('privateArchive');
  });
  it('accepts an explicit error only with no products and no physical-order claim', () => {
    const failed = { ...valid(), physicalOrderId: null, items: [], itemsError: '请核对后重试' };
    expect(parseRefundHistory(failed, scope)).toEqual(failed);
  });
  it.each([
    { version: 2 }, { refundId: 6 }, { sourceOrderId: 8 }, { physicalOrderId: 0 },
    { physicalOrderId: '12' }, { items: [] }, { itemsError: 'error' },
    { items: [valid().items[0], valid().items[0]] },
    { items: [{ ...valid().items[0], quantity: 1 }] },
    { items: [{ ...valid().items[0], quantity: null }] },
    { items: [{ ...valid().items[0], name: '测'.repeat(1366) }] },
    { items: Array.from({ length: 101 }, () => valid().items[0]) },
    { items: [{ ...valid().items[0], image: {} }] },
  ])('rejects malformed or mismatched archive: %j', change => {
    expect(() => parseRefundHistory({ ...valid(), ...change }, scope)).toThrow('退款商品快照');
  });
  it('does not accept a successful historical projection on pending or cancelled refunds', () => {
    for (const change of [{ refundType: 0 }, { isCancel: 1 }, { refundNum: 3 }])
      expect(() => parseRefundHistory(valid(), { ...scope, ...change })).toThrow('退款商品快照');
  });
});
