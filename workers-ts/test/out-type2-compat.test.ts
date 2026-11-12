import { describe, expect, it } from 'vitest';
import { normalizeOutProductInput, normalizeOutPhysicalProductInput } from '@/services/out/OutProductService';
import { assertManualOrderDeliveryType, assertProductCheckoutShippingType, isManualVirtualProductType } from '@/services/order/ManualVirtualDeliveryPolicy';
import { customerVisibleManualVirtualContent } from '@/services/order/StoreOrderCreateService';
import { outRequestHash } from '@/services/out/OutIdempotency';

const body = { product_type: 2, store_name: '历史优惠券类型', cate_id: [9], slider_image: ['/type2.png'], spec_type: 0,
  attrs: [{ price: '10.00', stock: 5, bar_code: 'TYPE2' }] };
describe('Out historical type-two generic reward and manual delivery', () => {
  it('keeps the historical non-logistics type and binds generic product coupon selections', async () => {
    const input = normalizeOutProductInput({ ...body, coupon_ids: [91] });
    expect(input).toMatchObject({ productType: 2, freight: 2, postage: '0.00', tempId: 0, deliveryType: '', couponIds: [91], skus: [{ stock: 5, diskInfo: '' }] });
    expect(await outRequestHash(input)).not.toBe(await outRequestHash(normalizeOutProductInput({ ...body, coupon_ids: [] })));
    expect(await outRequestHash(input)).not.toBe(await outRequestHash(normalizeOutProductInput({ ...body, product_type: 3, coupon_ids: [91] })));
    expect(() => normalizeOutPhysicalProductInput(body)).toThrow();
  });
  it('supports complete multi-SKU authoring and retains normal stock', () => {
    const value = normalizeOutProductInput({ ...body, spec_type: 1, items: [{ value: '档位', detail: ['甲', '乙'] }], attrs: [
      { suk: '甲', detail: { 档位: '甲' }, price: '10.00', stock: 3 }, { suk: '乙', detail: { 档位: '乙' }, price: '20.00', stock: 7 }] });
    expect(value.productType).toBe(2); expect(value.skus.map(s => ({ suk: s.suk, stock: s.stock }))).toEqual([{ suk: '甲', stock: 3 }, { suk: '乙', stock: 7 }]);
  });
  it.each([{ is_presale_product: 1 }, { attrs: [{ price: '10.00', stock: 1, disk_info: 'secret' }] },
    { attrs: [{ price: '10.00', stock: 1, virtual_list: [{ key: 'isolated', value: 'fixture' }] }] }])
    ('rejects incompatible author intent %j', patch => expect(() => normalizeOutProductInput({ ...body, ...patch })).toThrow());
  it('permits only whole-order manual virtual delivery and non-pickup checkout', () => {
    expect(isManualVirtualProductType(2)).toBe(true); expect(isManualVirtualProductType(3)).toBe(true);
    for (const type of [0, 1, 4, 5]) expect(isManualVirtualProductType(type)).toBe(false);
    expect(() => assertManualOrderDeliveryType(2, 'fictitious')).not.toThrow();
    for (const mode of ['express', 'send', 'city_delivery'] as const) expect(() => assertManualOrderDeliveryType(2, mode)).toThrow('只能使用虚拟交付');
    expect(() => assertProductCheckoutShippingType(2, 2)).toThrow(); expect(() => assertProductCheckoutShippingType(2, 1)).not.toThrow();
  });
  it('exposes the authenticated manual-content projection only after payment and delivery', () => {
    const delivered = { productType: 2, paid: 1, status: 1, deliveryType: 'fictitious', fictitiousContent: '隔离兑换说明' };
    expect(customerVisibleManualVirtualContent(delivered)).toBe(delivered.fictitiousContent);
    for (const patch of [{ paid: 0 }, { status: 0 }, { productType: 1 }, { deliveryType: 'express' }])
      expect(customerVisibleManualVirtualContent({ ...delivered, ...patch })).toBe('');
  });
});
