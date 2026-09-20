import { describe, expect, it } from 'vitest';
import { normalizeGoodsDetail } from '../../view/pc-ts/src/api/productDetail';
import { normalizeMobileGoods } from '../../view/uniapp-ts/src/api/productDetail';
import { productCartInput } from '../../view/pc-ts/src/api/productPurchase';

const base = { id: 70, price: '100.00', stock: 8, isVip: 1, vipPrice: '1.00',
  productType: 0, isPresaleProduct: 0, systemFormId: 0, isShow: 1, isDel: 0,
  attr_value: [{ unique: 'red001', suk: '红色', price: '19.99', vip_price: '10.00', stock: 8,
    member_price: '17.59', price_type: 'level', level_name: '银卡' }] };

describe.each([['PC', normalizeGoodsDetail], ['UniApp', normalizeMobileGoods]] as const)('%s SKU membership adapter', (_, normalize) => {
  it('preserves the selected SKU membership quote and does not replace original price', () => {
    expect(normalize(base).skus[0]).toMatchObject({ price: '19.99', member_price: '17.59', price_type: 'level', level_name: '银卡' });
  });
  it('old wire data has no invented parent membership discount', () => {
    expect(normalize({ ...base, attr_value: [{ unique: 'old001', price: '19.99', stock: 8 }] }).skus[0].member_price).toBeUndefined();
  });
  it.each([-1, NaN, Infinity, {}, [], 'NaN', '-1', '1e2', '1.001', '90071992547409.92', '0.00', '20.00'])('rejects invalid member price %j', member_price => {
    expect(() => normalize({ ...base, attr_value: [{ ...base.attr_value[0], member_price }] })).toThrow();
  });
  it.each([{ price_type: 'vip' }, { price_type: '' }, { price_type: null }, { level_name: {} }, { member_price: '19.99' }])('rejects inconsistent classification %j', patch => {
    expect(() => normalize({ ...base, attr_value: [{ ...base.attr_value[0], ...patch }] })).toThrow();
  });
  it('accepts an undiscounted or zero-base SKU without calling it a member offer', () => {
    for (const price of ['19.99', '0.00']) expect(normalize({ ...base, attr_value: [{ ...base.attr_value[0], price, member_price: price, price_type: '', level_name: '' }] }).skus[0].member_price).toBe(price);
  });
});
it('cart input still sends only SKU identity and quantity, not client prices', () => {
  expect(productCartInput(normalizeGoodsDetail(base), 'red001', 2, false)).toEqual({ productId: 70, unique: 'red001', cartNum: 2, new: 0 });
});
