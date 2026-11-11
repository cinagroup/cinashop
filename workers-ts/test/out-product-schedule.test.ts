import { describe, expect, it } from 'vitest';
import { normalizeOutPhysicalProductInput } from '../src/services/out/OutProductService';
import { outRequestHash } from '../src/services/out/OutIdempotency';
import { outProductScheduleInput } from '../src/services/out/OutProductScheduleBindings';
const product = { product_type: 0, supplier_id: 0, cate_id: [10], store_name: '定时商品', slider_image: ['/test.png'],
  delivery_type: [1], freight: 1, spec_type: 0, is_show: 1, attrs: [{ suk: '默认', price: '10.00', stock: 8, bar_code: 'SHELF-1' }] };
describe('Out product shelf schedule intent', () => {
  it('distinguishes omission and explicit cancellation in the original request receipt', async () => {
    const omitted = normalizeOutPhysicalProductInput(product);
    expect(omitted).not.toHaveProperty('autoOnTime'); expect(omitted).not.toHaveProperty('autoOffTime');
    expect(normalizeOutPhysicalProductInput({ ...product, auto_on_time: undefined, auto_off_time: undefined })).toEqual(omitted);
    const cleared = normalizeOutPhysicalProductInput({ ...product, auto_on_time: 0, auto_off_time: '' });
    expect(cleared).toMatchObject({ autoOnTime: 0, autoOffTime: 0, isShow: 1 });
    expect(cleared).toEqual(normalizeOutPhysicalProductInput({ ...product, auto_on_time: '0', auto_off_time: 0 }));
    expect(await outRequestHash(omitted)).not.toBe(await outRequestHash(cleared));
    const legacyIgnoredClear = { ...cleared }; delete legacyIgnoredClear.scheduleIntentVersion;
    expect(await outRequestHash(legacyIgnoredClear)).not.toBe(await outRequestHash(cleared));
    expect(await outRequestHash(normalizeOutPhysicalProductInput({ ...product, auto_on_time: 0 })))
      .not.toBe(await outRequestHash(normalizeOutPhysicalProductInput({ ...product, auto_off_time: 0 })));
  });
  it('uses Beijing wall time and hides a product while a requested on-time is scheduled', () => {
    const input = normalizeOutPhysicalProductInput({ ...product, auto_on_time: '2026-10-17 16:00', auto_off_time: '2026-10-17T09:00:00Z' });
    expect(input).toMatchObject({ autoOnTime: 1792224000, autoOffTime: 1792227600, isShow: 0 });
    expect(normalizeOutPhysicalProductInput({ ...product, auto_off_time: 100 })).toMatchObject({ autoOffTime: 100, isShow: 1 });
    expect(() => normalizeOutPhysicalProductInput({ ...product, is_show: 2, auto_on_time: 100 })).toThrow('状态');
  });
  it.each([null, false, -1, 1.5, 2147483648, '1', '2026-02-30 12:00', '2026-10-17T09:00:00+08:00', {}])
    ('rejects invalid schedule value %j', value => expect(() => outProductScheduleInput({ auto_on_time: value })).toThrow('定时'));
});
