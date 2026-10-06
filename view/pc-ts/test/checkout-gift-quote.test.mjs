import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeCheckoutQuote } from '../../common/checkoutQuote.ts';
import { createCheckoutApi } from '../../common/checkoutApi.ts';

const selected = { id: 10, productId: 70, unique: 'red001', cartNum: 2, type: 0, isNew: 1, isValid: true,
  productInfo: { price: '10.00', storeName: '选购商品', image: '/item.png', stock: 8, otPrice: '',
    suk: '红色', systemFormId: 0, productType: 0 }, sumPrice: '20.00' };
const options = { addressId: 11, shippingType: 1, storeId: 0, couponId: 0, useIntegral: false, type: 0 };
const normal = () => ({ ...selected, truePrice: '10.00', trueSumPrice: '20.00', totalPriceCents: 2000 });
const gift = () => ({ id: '2147483647', cartId: '2147483647', productId: 71, product_id: 71,
  cartNum: 2, cart_num: 2, isGift: 1, is_gift: 1, promotions_id: 7,
  truePrice: '0.00', trueSumPrice: '0.00', sumPrice: '0.00',
  productInfo: { id: 71, storeName: '赠品水杯', store_name: '赠品水杯', image: '/gift.png',
    unitName: '件', unit_name: '件', productType: 0, price: '0.00',
    attrInfo: { product_id: 71, unique: 'cup001', suk: '蓝色', price: '0.00', image: '/gift.png' } } });
const priceGroup = { sumPrice: '20.00', totalPrice: '20.00', pay_price: '20.00',
  total_postage: '0.00', pay_postage: '0.00', storePostageDiscount: '0.00', vipPrice: '0.00',
  levelPrice: '0.00', memberPrice: '0.00', couponPrice: '0.00', deduction_price: '0.00',
  firstOrderPrice: '0.00', usedIntegral: 0, SurplusIntegral: 0, pay_integral: 0 };
const plain = () => ({ orderKey: 'gift_quote_1', quoteToken: 'a'.repeat(32), addressInfo: { id: 11 },
  cartInfo: [normal()], priceGroup });
const withGift = () => ({ ...plain(), cartInfo: [normal(), gift()], give_coupon: [
  { id: 21, title: '满送券', price: '10.00', minPrice: '100.00' }], give_integral: 8,
  promotions_detail: [{ id: 7, tierId: 8, name: '秋季满送', threshold: '100.00', repetitions: 2 }] });
const quote = value => normalizeCheckoutQuote(value, [selected], options);

test('old zero-gift quote still prices only the selected cart and exposes empty gifts', () => {
  const result = quote(plain());
  assert.deepEqual(result.gifts, { products: [], coupons: [], integral: 0, promotions: [] });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].quotedTotalPrice, '20.00');
});

test('gift quote separates a zero-price physical SKU and validates coupon and points previews', () => {
  const result = quote(withGift());
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.gifts.products, [{ id: '2147483647', productId: 71, name: '赠品水杯',
    image: '/gift.png', suk: '蓝色', unique: 'cup001', unitName: '件', quantity: 2, promotionId: 7 }]);
  assert.deepEqual(result.gifts.coupons, [{ id: 21, title: '满送券', price: '10.00', minPrice: '100.00' }]);
  assert.equal(result.gifts.integral, 8);
  assert.equal(result.gifts.promotions[0].tierId, 8);
  assert.equal(result.prices.payable, '20.00');
});

test('gift rows fail closed on ownership, duplicate IDs, quantity, SKU, money and unknown fields', () => {
  const replace = change => ({ ...withGift(), cartInfo: [normal(), { ...gift(), ...change }] });
  assert.throws(() => quote(replace({ promotions_id: 9 })), /归属/);
  assert.throws(() => quote({ ...withGift(), cartInfo: [normal(), gift(), gift()] }), /重复/);
  assert.throws(() => quote(replace({ id: '10', cartId: '10' })), /重复|身份/);
  assert.throws(() => quote(replace({ cart_num: 3 })), /身份|数量/);
  assert.throws(() => quote(replace({ cartNum: 0, cart_num: 0 })), /身份|数量/);
  assert.throws(() => quote(replace({ id: 99, cartId: 99 })), /身份/);
  assert.throws(() => quote(replace({ trueSumPrice: '0.01' })), /零金额/);
  assert.throws(() => quote(replace({ untrusted: true })), /未知字段/);
  assert.throws(() => quote(replace({ productInfo: { ...gift().productInfo,
    attrInfo: { ...gift().productInfo.attrInfo, unique: '' } } })), /规格/);
  assert.throws(() => quote(replace({ productInfo: { ...gift().productInfo, price: '1.00' } })), /规格|商品/);
  assert.throws(() => quote(replace({ productInfo: { ...gift().productInfo, productType: 1 } })), /规格|商品/);
  assert.throws(() => quote(replace({ productInfo: { ...gift().productInfo, attrInfo: {
    ...gift().productInfo.attrInfo, foreign: true } } })), /未知字段/);
});

test('reward metadata cannot be truncated or supplemented with unknown fields', () => {
  assert.throws(() => quote({ ...withGift(), give_coupon: undefined }), /不完整/);
  assert.throws(() => quote({ ...withGift(), give_integral: -1 }), /不完整/);
  assert.throws(() => quote({ ...withGift(), give_coupon: [{ ...withGift().give_coupon[0], extra: true }] }), /未知字段/);
  assert.throws(() => quote({ ...withGift(), give_coupon: [withGift().give_coupon[0], withGift().give_coupon[0]] }), /重复/);
  assert.throws(() => quote({ ...withGift(), promotions_detail: [{ ...withGift().promotions_detail[0], extra: true }] }), /未知字段/);
  assert.throws(() => quote({ ...withGift(), promotions_detail: [] }), /归属/);
  assert.throws(() => quote({ ...plain(), cartInfo: [normal(), gift()] }), /不完整/);
  assert.throws(() => quote({ ...plain(), cartInfo: [{ ...normal(), isGift: 1 }] }), /不完整|身份/);
});

test('accepts the full 256-character catalog product name without relaxing gift identity', () => {
  const name = '杯'.repeat(256), productInfo = { ...gift().productInfo, storeName: name, store_name: name };
  const result = quote({ ...withGift(), cartInfo: [normal(), { ...gift(), productInfo }] });
  assert.equal(result.gifts.products[0].name, name);
  assert.throws(() => quote({ ...withGift(), cartInfo: [normal(), { ...gift(), productInfo: {
    ...productInfo, storeName: `${name}杯`, store_name: `${name}杯` } }] }), /规格|商品/);
});

test('accepts the full 512-character gift SKU label and rejects an oversized label', () => {
  const suk = '规'.repeat(512);
  const productInfo = { ...gift().productInfo, attrInfo: { ...gift().productInfo.attrInfo, suk } };
  assert.equal(quote({ ...withGift(), cartInfo: [normal(), { ...gift(), productInfo }] }).gifts.products[0].suk, suk);
  assert.throws(() => quote({ ...withGift(), cartInfo: [normal(), { ...gift(), productInfo: {
    ...productInfo, attrInfo: { ...productInfo.attrInfo, suk: `${suk}格` } } }] }), /规格|商品/);
});

test('checkout request sends only selected cart IDs, never the numeric gift cart ID', async () => {
  const calls = [];
  const api = createCheckoutApi({ post: async (url, body) => { calls.push({ url, body }); return withGift(); },
    get: async () => { throw Error('unexpected GET'); } });
  const result = await api.confirm([selected], options);
  assert.equal(result.gifts.products.length, 1);
  assert.deepEqual(calls[0].body.cartIds, [10]);
  assert.equal(calls[0].body.cartIds.includes(2_147_483_647), false);
});
