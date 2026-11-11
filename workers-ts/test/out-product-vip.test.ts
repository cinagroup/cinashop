import { describe, expect, it } from 'vitest';
import { normalizeOutPhysicalProductInput } from '../src/services/out/OutProductService';
import { outRequestHash } from '../src/services/out/OutIdempotency';

const product = { product_type: 0, supplier_id: 0, cate_id: [10], store_name: '会员商品', slider_image: ['/test.png'],
  delivery_type: [1], freight: 1, spec_type: 0, is_show: 1, attrs: [{ suk: '默认', price: '10.00', stock: 8, bar_code: 'VIP-1' }] };

describe('Out member-only product intent', () => {
  it('distinguishes omitted and explicit zero from previously ignored empty intent', async () => {
    const omitted = normalizeOutPhysicalProductInput(product);
    expect(omitted).not.toHaveProperty('isVipProduct');
    expect(normalizeOutPhysicalProductInput({ ...product, is_vip_product: undefined })).toEqual(omitted);
    const disabled = normalizeOutPhysicalProductInput({ ...product, is_vip_product: 0 });
    expect(disabled.isVipProduct).toBe(0);
    expect(await outRequestHash(disabled)).not.toBe(await outRequestHash(omitted));
    expect(normalizeOutPhysicalProductInput({ ...product, is_vip_product: false })).toEqual(disabled);
    expect(normalizeOutPhysicalProductInput({ ...product, is_vip_product: '1' }).isVipProduct).toBe(1);
    expect(normalizeOutPhysicalProductInput({ ...product, is_vip_product: true }).isVipProduct).toBe(1);
  });
  it.each([2, -1, 1.5, {}, [], 'yes'])('rejects invalid member-only flag %j', is_vip_product => {
    expect(() => normalizeOutPhysicalProductInput({ ...product, is_vip_product })).toThrow('会员专属');
  });
});
