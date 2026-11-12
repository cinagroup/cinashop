import { describe, expect, it } from 'vitest';
import { normalizeOutProductInput } from '@/services/out/OutProductService';
import { outRequestHash } from '@/services/out/OutIdempotency';

const base = { product_type: 0, cate_id: [9], store_name: '商品', slider_image: ['/product.png'], delivery_type: [1], freight: 1,
  spec_type: 0, attrs: [{ price: '10.00', vip_price: '8.00', brokerage: '2.00', brokerage_two: '1.00', stock: 4 }] };
describe('Out legacy member-price and commission selection', () => {
  it.each([
    { is_sub: [], isVip: 0, isSub: 0, brokerage: '0.00', brokerageTwo: '0.00' },
    { is_sub: [0], isVip: 1, isSub: 0, brokerage: '0.00', brokerageTwo: '0.00' },
    { is_sub: [1], isVip: 0, isSub: 1, brokerage: '2.00', brokerageTwo: '1.00' },
    { is_sub: [1, 0], isVip: 1, isSub: 1, brokerage: '2.00', brokerageTwo: '1.00' },
  ])('persists the independent switches $is_sub', ({ is_sub, isVip, isSub, brokerage, brokerageTwo }) => {
    const result = normalizeOutProductInput({ ...base, is_sub });
    expect(result).toMatchObject({ isVip, isSub, skus: [{ vipPrice: '8.00', brokerage, brokerageTwo }] });
  });
  it('preserves the historical normalized shape on omission and hashes explicit intent', async () => {
    const omitted = normalizeOutProductInput(base), disabled = normalizeOutProductInput({ ...base, is_sub: [] });
    expect(Object.hasOwn(omitted, 'isVip')).toBe(false); expect(Object.hasOwn(omitted, 'isSub')).toBe(false);
    expect(omitted.skus[0]).toMatchObject({ brokerage: '2.00', brokerageTwo: '1.00' });
    expect(await outRequestHash(omitted)).not.toBe(await outRequestHash(disabled));
    expect(normalizeOutProductInput({ ...base, is_sub: ['1', '0'] })).toEqual(normalizeOutProductInput({ ...base, is_sub: [0, 1] }));
  });
  it('clears disabled commissions before SKU price validation, without changing input', () => {
    const attrs = [{ ...base.attrs[0], brokerage: '1000.00', brokerage_two: '900.00' }];
    expect(normalizeOutProductInput({ ...base, attrs, is_sub: [] }).skus[0]).toMatchObject({ brokerage: '0.00', brokerageTwo: '0.00' });
    expect(attrs[0].brokerage).toBe('1000.00');
    expect(() => normalizeOutProductInput({ ...base, attrs, is_sub: [1] })).toThrow('佣金');
  });
  it('enforces nonzero member prices only when the option is explicitly enabled', () => {
    const attrs = [{ ...base.attrs[0], vip_price: '0' }];
    expect(() => normalizeOutProductInput({ ...base, attrs, is_sub: [0] })).toThrow('会员价');
    expect(normalizeOutProductInput({ ...base, attrs, is_sub: [1] }).isVip).toBe(0);
    expect(normalizeOutProductInput({ ...base, attrs }).skus[0].vipPrice).toBe('0.00');
  });
  it.each([null, 0, '0', {}, [0, 0], [0, '0'], [2], [true], ['01'], [0, 1, 1]])('rejects malformed selection %j', is_sub => {
    expect(() => normalizeOutProductInput({ ...base, is_sub })).toThrow('选项');
  });
  it.each([3, 4])('supports existing nonphysical product type %i', product_type => {
    const attrs = [{ ...base.attrs[0], ...(product_type === 4 ? { write_times: 3, write_valid: 2, days: 7 } : {}) }];
    const result = normalizeOutProductInput({ ...base, product_type, attrs, is_sub: [0] });
    expect(result).toMatchObject({ productType: product_type, isVip: 1, isSub: 0, skus: [{ brokerage: '0.00' }] });
  });
});
