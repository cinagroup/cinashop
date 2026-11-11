import { describe, expect, it } from 'vitest';
import { normalizeOutPhysicalProductInput } from '../src/services/out/OutProductService';
import { outRequestHash } from '../src/services/out/OutIdempotency';
const product = { product_type: 0, supplier_id: 0, cate_id: [10], store_name: '赠券商品', slider_image: ['/test.png'],
  delivery_type: [1], freight: 1, spec_type: 0, attrs: [{ suk: '默认', price: '10.00', stock: 8, bar_code: 'COUPON-1' }] };
describe('Out product coupon intent', () => {
  it('keeps omission distinct from clear and canonicalizes issuance IDs for replay', async () => {
    const omitted = normalizeOutPhysicalProductInput(product);
    expect(Object.hasOwn(omitted, 'couponIds')).toBe(false);
    expect(normalizeOutPhysicalProductInput({ ...product, coupon_ids: undefined })).toEqual(omitted);
    const empty = normalizeOutPhysicalProductInput({ ...product, coupon_ids: [] });
    expect(empty.couponIds).toEqual([]);
    expect(await outRequestHash(empty)).not.toBe(await outRequestHash(omitted));
    const selected = normalizeOutPhysicalProductInput({ ...product, coupon_ids: ['2', 1, 2] });
    expect(selected.couponIds).toEqual([1, 2]);
    expect(selected).toEqual(normalizeOutPhysicalProductInput({ ...product, coupon_ids: '1,2' }));
    expect(await outRequestHash(selected)).not.toBe(await outRequestHash(empty));
  });
  it.each([null, false, {}, [0], [-1], ['bad'], [2147483648], Array(101).fill(1)])('rejects invalid coupon intent %j', value => {
    expect(() => normalizeOutPhysicalProductInput({ ...product, coupon_ids: value })).toThrow('优惠券');
  });
});
