import { describe, expect, it } from 'vitest';
import { normalizeOutPhysicalProductInput } from '../src/services/out/OutProductService';
import { outRequestHash } from '../src/services/out/OutIdempotency';

const product = { product_type: 0, supplier_id: 0, cate_id: [10], store_name: '推荐商品', slider_image: ['/test.png'],
  delivery_type: [1], freight: 1, spec_type: 0, is_show: 1, attrs: [{ suk: '默认', price: '10.00', stock: 8, bar_code: 'REC-1' }] };

describe('Out product recommendation references', () => {
  it('distinguishes omission from clearing and preserves the order and duplicates of PHP references', async () => {
    const omitted = normalizeOutPhysicalProductInput(product);
    expect(omitted).not.toHaveProperty('recommendList');
    expect(normalizeOutPhysicalProductInput({ ...product, recommend_list: undefined })).toEqual(omitted);
    const clear = normalizeOutPhysicalProductInput({ ...product, recommend_list: [] });
    expect(clear.recommendList).toBe('');
    expect(await outRequestHash(clear)).not.toBe(await outRequestHash(omitted));
    expect(normalizeOutPhysicalProductInput({ ...product, recommend_list: ['0071', 72, 71, 999] }).recommendList).toBe('71,72,71,999');
  });
  it('accepts the legacy recommendation echo without changing independent flags or the receipt', async () => {
    const input = { ...product, is_hot: 0, is_good: 1 };
    const echo = normalizeOutPhysicalProductInput({ ...input, recommend: ['is_hot', 'is_good'] });
    expect(echo).toEqual(normalizeOutPhysicalProductInput(input));
    expect(echo).toMatchObject({ isHot: 0, isGood: 1 });
    expect(await outRequestHash(echo)).toBe(await outRequestHash(normalizeOutPhysicalProductInput(input)));
    expect(() => normalizeOutPhysicalProductInput({ ...input, recommend: 'is_hot' })).toThrow('商品推荐回显');
  });
  it.each([null, '', {}, [null], [''], [0], [-1], [1.5], [2147483648], ['1,2'], [{ product_id: 1 }], Array(101).fill(1), Array(26).fill(2147483647)])
    ('rejects malformed or oversized recommendation references %j', recommend_list => {
      expect(() => normalizeOutPhysicalProductInput({ ...product, recommend_list })).toThrow('推荐商品');
    });
});
