import { describe, expect, it } from 'vitest';
import { normalizeOutProductInput, normalizeOutPhysicalProductInput } from '@/services/out/OutProductService';
import { outRequestHash } from '@/services/out/OutIdempotency';

const base = { product_type: 1, cate_id: [9], store_name: '隔离卡密商品', slider_image: ['/card.png'], spec_type: 0,
  attrs: [{ price: '10.00', stock: 99, bar_code: 'CARD' }] };
describe('Out card-product author input', () => {
  it('supports fixed content with ordinary stock and no logistics', () => {
    expect(normalizeOutProductInput({ ...base, attrs: [{ ...base.attrs[0], disk_info: 'isolated-fixed-content' }] }))
      .toMatchObject({ productType: 1, deliveryType: '', freight: 2, postage: '0.00', tempId: 0, isPostage: 0,
        cardImports: [], skus: [{ diskInfo: 'isolated-fixed-content', stock: 99 }] });
  });
  it('derives one-time inventory from normalized imports and deduplicates legacy editor rows', async () => {
    const input = { ...base, attrs: [{ ...base.attrs[0], disk_info: [], virtual_list: [
      { key: 'isolated-card', value: 'isolated-value' }, { key: 'isolated-card', value: 'isolated-value' }] }] };
    const result = normalizeOutProductInput(input);
    expect(result).toMatchObject({ skus: [{ diskInfo: '', stock: 0 }], cardImports: [{ suk: '默认', cards: [{ cardNo: 'isolated-card', cardPwd: 'isolated-value' }] }] });
    const equivalent = normalizeOutProductInput({ ...base, attrs: [{ ...base.attrs[0], disk_info: '', virtual_list: [{ card_no: 'isolated-card', card_pwd: 'isolated-value' }] }] });
    expect(await outRequestHash(result)).toBe(await outRequestHash(equivalent));
    expect(input.attrs[0].virtual_list).toHaveLength(2);
    const changed = normalizeOutProductInput({ ...base, attrs: [{ ...base.attrs[0], virtual_list: [{ key: 'isolated-card', value: 'other-value' }] }] });
    expect(await outRequestHash(changed)).not.toBe(await outRequestHash(result));
  });
  it.each([
    { virtual_list: null }, { virtual_list: {} }, { virtual_list: [{}] },
    { virtual_list: [{ key: 'isolated', value: '' }] },
    { disk_info: 'fixed', virtual_list: [{ key: 'isolated', value: 'fixture' }] },
    { virtual_list: Array.from({ length: 1001 }, (_, i) => ({ key: String(i), value: 'fixture' })) },
  ])('rejects invalid card inventory %j', patch => expect(() => normalizeOutProductInput({ ...base, attrs: [{ ...base.attrs[0], ...patch }] })).toThrow());
  it('keeps the physical-only compatibility boundary and excludes presale', () => {
    expect(() => normalizeOutPhysicalProductInput(base)).toThrow();
    expect(() => normalizeOutProductInput({ ...base, is_presale_product: 1 })).toThrow('预售');
  });
});
