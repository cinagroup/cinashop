import { describe, expect, it } from 'vitest';
import { normalizeOutPhysicalProductInput } from '../src/services/out/OutProductService';
import { outRequestHash } from '../src/services/out/OutIdempotency';
import { outProductPresaleInput, outProductPresalePlan } from '../src/services/out/OutProductPresaleBindings';
import type { storeProduct } from '../src/models/schema';

const product = { product_type: 0, supplier_id: 0, cate_id: [10], store_name: '预售商品', slider_image: ['/test.png'],
  delivery_type: [1], freight: 1, spec_type: 0, is_show: 1, attrs: [{ suk: '默认', price: '10.00', stock: 8, bar_code: 'PRE-1' }] };
const existing = { isPresaleProduct: 1, presaleStartTime: 100, presaleEndTime: 200, presaleDay: 7 } as typeof storeProduct.$inferSelect;

describe('Out product presale authoring intent', () => {
  it('keeps omission, explicit cancellation, and the legacy ignored-empty receipt distinct', async () => {
    const omitted = normalizeOutPhysicalProductInput(product);
    expect(omitted).not.toHaveProperty('isPresaleProduct'); expect(omitted).not.toHaveProperty('presalePeriod');
    expect(outProductPresalePlan({}, existing)).toMatchObject({ ...existing, authored: false });
    const disabled = normalizeOutPhysicalProductInput({ ...product, is_presale_product: 0, presale_time: [], presale_day: 0 });
    expect(disabled).toMatchObject({ isPresaleProduct: 0, presalePeriod: [], presaleDay: 0 });
    expect(await outRequestHash(disabled)).not.toBe(await outRequestHash(omitted));
    expect(outProductPresalePlan(disabled, existing)).toMatchObject({ isPresaleProduct: 0, presaleStartTime: 0, presaleEndTime: 0, presaleDay: 0 });
    expect(normalizeOutPhysicalProductInput({ ...product, is_vip_product: 1 }).isVipProduct).toBe(1);
  });
  it('normalizes Shanghai and UTC, preserves begun plans on unrelated edits, and validates newly authored windows', () => {
    const parsed = outProductPresaleInput({ is_presale_product: '1', presale_time: ['2026-10-17 16:00', '2026-10-17T09:00:00Z'], presale_day: '7' });
    expect(parsed).toEqual({ isPresaleProduct: 1, presalePeriod: [1792224000, 1792227600], presaleDay: 7 });
    expect(outProductPresalePlan(parsed)).toMatchObject({ isPresaleProduct: 1, presaleStartTime: 1792224000, presaleEndTime: 1792227600, requireFuture: true });
    expect(outProductPresalePlan({ presaleDay: 8 }, existing)).toMatchObject({ presaleStartTime: 100, presaleEndTime: 200, presaleDay: 8, requireFuture: false });
    expect(() => outProductPresalePlan({ isPresaleProduct: 1, presalePeriod: [200, 100] })).toThrow('预售起止');
    expect(() => outProductPresalePlan({ isPresaleProduct: 1, presalePeriod: [] }, existing)).toThrow('必须设置');
    expect(() => outProductPresalePlan({ isPresaleProduct: 0, presalePeriod: [100, 200] }, existing)).toThrow('关闭预售');
  });
  it.each([{ is_presale_product: null }, { is_presale_product: 2 }, { presale_day: -1 }, { presale_day: 1.5 },
    { presale_time: null }, { presale_time: [100] }, { presale_time: ['2026-02-30 12:00', 100] }, { presale_time: [2147483648, 100] }])
    ('rejects invalid presale terms %j', value => expect(() => outProductPresaleInput(value)).toThrow('预售'));
});
