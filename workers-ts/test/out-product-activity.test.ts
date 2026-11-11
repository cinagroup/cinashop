import { describe, expect, it } from 'vitest';
import { normalizeOutPhysicalProductInput } from '../src/services/out/OutProductService';
import { outRequestHash } from '../src/services/out/OutIdempotency';

const product = { product_type: 0, supplier_id: 0, cate_id: [10], store_name: '活动商品', slider_image: ['/test.png'],
  delivery_type: [1], freight: 1, spec_type: 0, is_show: 1, attrs: [{ suk: '默认', price: '10.00', stock: 8, bar_code: 'ACT-1' }] };

describe('Out product activity authoring', () => {
  it('keeps omission distinct from clearing and maps legacy labels in order', async () => {
    const omitted = normalizeOutPhysicalProductInput(product);
    expect(omitted).not.toHaveProperty('activity');
    expect(normalizeOutPhysicalProductInput({ ...product, activity: undefined })).toEqual(omitted);
    const cleared = normalizeOutPhysicalProductInput({ ...product, activity: [] });
    expect(cleared.activity).toBe('');
    expect(await outRequestHash(cleared)).not.toBe(await outRequestHash(omitted));
    expect(normalizeOutPhysicalProductInput({ ...product, activity: ['拼团', '默认', '秒杀', '砍价'] }).activity).toBe('3,0,1,2');
    expect(normalizeOutPhysicalProductInput({ ...product, activity: ['未知'] }).activity).toBe('0');
  });
  it.each([null, '', {}, [1], ['秒杀', '秒杀'], ['默认', '未知'], ['默认', '秒杀', '砍价', '拼团', '多余'], ['\u0000']])
    ('rejects an invalid or ambiguous activity order %j', activity => {
      expect(() => normalizeOutPhysicalProductInput({ ...product, activity })).toThrow('活动顺序');
    });
});
