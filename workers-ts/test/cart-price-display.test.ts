import { describe, expect, it } from 'vitest';
import { normalizeCartList, cartTotal, cartUnitPrice, cartLinePrice, cartPriceLabel } from '../../view/common/cartPrice';
const row = () => ({ id: 1, productId: 70, cartNum: 2, type: 0, unique: 'red001', isNew: 0, isValid: true,
  productInfo: { price: '19.99', otPrice: '25.00', storeName: '本地商品', image: '', stock: 8, suk: '红色', systemFormId: 0, productType: 0 },
  sumPrice: '39.98', truePrice: '17.59', trueSumPrice: '35.18', priceType: 'level', levelName: '银卡' });
describe('cart membership display contract', () => {
  it('keeps raw amounts but displays exact current membership unit, subtotal, label and selected total', () => {
    const [item] = normalizeCartList([row()]); item.checked = true;
    expect([item.productInfo?.price, item.sumPrice]).toEqual(['19.99', '39.98']);
    expect([cartUnitPrice(item), cartLinePrice(item), cartPriceLabel(item), cartTotal([item])]).toEqual(['17.59', '35.18', '银卡价', '35.18']);
  });
  it('older additive-field-free responses retain the raw catalogue amount, without inventing membership', () => {
    const { truePrice, trueSumPrice, priceType, levelName, ...old } = row();
    const [item] = normalizeCartList([old]); item.checked = true;
    expect([cartUnitPrice(item), cartTotal([item]), cartPriceLabel(item)]).toEqual(['19.99', '39.98', '']);
  });
  it.each([
    { truePrice: null }, { truePrice: '' }, { trueSumPrice: undefined }, { truePrice: '0.00', trueSumPrice: '0.00' },
    { truePrice: '20.00', trueSumPrice: '40.00' }, { trueSumPrice: '35.19' }, { priceType: '' }, { priceType: 'vip' },
    { levelName: {} }, { sumPrice: '39.97' }, { cartNum: 0 }, { cartNum: 1.5 }, { isNew: 1 }, { isValid: 1 }, { id: '1' },
  ])('rejects malformed or inconsistent cart contracts: %j', change => {
    expect(() => normalizeCartList([{ ...row(), ...change }])).toThrow();
  });
  it('rejects duplicate IDs rather than merging identity or quantities', () => { expect(() => normalizeCartList([row(), row()])).toThrow(); });
  it('retains validated activity/participation identity without accepting server selection state', () => {
    const [item] = normalizeCartList([{ ...row(), activityId: 101, bargainUserId: 202, checked: true }]);
    expect(item).toMatchObject({ activityId: 101, bargainUserId: 202, checked: false });
    expect(() => normalizeCartList([{ ...row(), activityId: '101' }])).toThrow();
  });
  it('rejects allegedly valid rows whose current stock cannot cover the quantity', () => {
    for (const stock of [0, 1]) expect(() => normalizeCartList([{ ...row(), productInfo: { ...row().productInfo, stock } }])).toThrow();
  });
  it('invalid rows expose no stale price and are excluded even if externally marked checked', () => {
    const [item] = normalizeCartList([{ ...row(), isValid: false, productInfo: null }]); item.checked = true;
    expect([cartUnitPrice(item), cartTotal([item])]).toEqual(['', '0.00']);
  });
  it('adds amounts as integer cents without binary rounding', () => {
    const values = ['0.10', '0.20', '900000000000.01'].map((price, index) => ({ ...row(), id: index + 1, cartNum: 1, productInfo: { ...row().productInfo, price },
      sumPrice: price, truePrice: price, trueSumPrice: price, priceType: '', levelName: '' }));
    const items = normalizeCartList(values).map(item => ({ ...item, checked: true })); expect(cartTotal(items)).toBe('900000000000.31');
  });
});
