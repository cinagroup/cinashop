const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runtime } = require('./uni-store-runtime.cjs');
const base = () => ({ id: 70, price: '10.00', stock: 8, isVip: 1, vipPrice: '0.00', otPrice: '99.00',
  attr_value: [
    { unique: 'red001', suk: '红色', price: '10', ot_price: '12.00', vip_price: '9.00', stock: 8 },
    { unique: 'blue001', suk: '蓝色', price: '20', otPrice: '25', vipPrice: '18', stock: 2 },
    { unique: 'empty001', suk: '售罄规格', price: '30', ot_price: '35', vip_price: '0', stock: 0 },
  ] });
function setup(goods = base()) {
  return runtime({ component: 'pages/goods/detail.vue', send: call => {
    if (call.url.includes('/product/detail/')) return { data: goods };
    if (call.url.includes('/reply/config/')) return { data: { total: 0, avgScore: '0', goodRate: 0 } };
    if (call.url.includes('/store_discounts/list/') || call.url.includes('/reply/list/')) return { data: [] };
    throw new Error(`Unexpected I/O ${call.url}`);
  } });
}
test('actual product page switches all SKU prices and stock without using parent member/strike prices', async () => {
  const r = setup(); try {
    await r.start({ id: '70' }); const p = r.checkout;
    assert.equal(p.selectedSku.value.unique, 'red001'); assert.equal(p.selectedSku.value.price, '10.00');
    assert.equal(p.displayOriginalPrice.value, '12.00'); assert.equal(p.displayVipPrice.value, '9.00'); assert.equal(p.maxNum.value, 8);
    p.openSku('cart'); p.num.value = 7; p.pickSku(p.skuList.value[1]);
    assert.equal(p.selectedSku.value.price, '20.00'); assert.equal(p.displayOriginalPrice.value, '25.00');
    assert.equal(p.displayVipPrice.value, '18.00'); assert.equal(p.maxNum.value, 2); assert.equal(p.num.value, 2);
    p.pickSku({ ...p.skuList.value[0], vip_price: '1.00' }); assert.equal(p.selectedSku.value.unique, 'blue001');
    p.pickSku(p.skuList.value[2]); assert.equal(p.selectedSku.value.vip_price, '0.00'); assert.equal(p.displayVipPrice.value, null); assert.equal(p.maxNum.value, 0);
    const calls = r.calls.length; await p.confirmSku(); assert.equal(r.calls.length, calls); assert.match(r.toasts.at(-1).title, /库存不足/);
    p.pickSku(p.skuList.value[0]); assert.equal(p.num.value, 1); assert.equal(p.displayVipPrice.value, '9.00');
    p.buying.value = true; p.pickSku(p.skuList.value[1]); assert.equal(p.selectedSku.value.unique, 'red001');
    assert.ok(r.calls.every(c => !/cart\/add|order\/create|pay/.test(c.url)));
  } finally { r.stop(); }
});
test('missing SKU money is absent, not a parent fallback; non-member product hides member price', async () => {
  const goods = base(); goods.attr_value[0] = { unique: 'red001', suk: '无可选价格', price: '10', stock: 8 };
  const r = setup(goods); try {
    await r.start({ id: '70' }); const p = r.checkout;
    assert.equal(p.displayOriginalPrice.value, null); assert.equal(p.displayVipPrice.value, null);
    p.pickSku(p.skuList.value[1]); p.detail.value.is_vip = 0; assert.equal(p.displayVipPrice.value, null);
    p.detail.value.stock = 1; assert.equal(p.maxNum.value, 1);
  } finally { r.stop(); }
});
test('no SKU and all-sold-out catalogues never invent a purchasable specification', async () => {
  for (const skus of [[], base().attr_value.map(s => ({ ...s, stock: 0 }))]) {
    const r = setup({ ...base(), attr_value: skus }); try {
      await r.start({ id: '70' }); const p = r.checkout;
      assert.equal(p.maxNum.value, 0); const calls = r.calls.length; await p.confirmSku(); assert.equal(r.calls.length, calls);
      assert.equal(p.selectedSku.value?.unique ?? null, skus[0]?.unique ?? null);
    } finally { r.stop(); }
  }
});
test('SKU decimal adapter preserves explicit zero, accepts equivalent aliases and rejects malformed/conflicting amounts', () => {
  const r = setup(); try {
    const { normalizeMobileGoods } = r.load(path.resolve(__dirname, '../src/api/productDetail.ts'));
    const map = sku => normalizeMobileGoods({ ...base(), attr_value: [{ ...base().attr_value[0], ...sku }] }).skus[0];
    assert.equal(map({ vip_price: '0' }).vip_price, '0.00');
    assert.equal(map({ vip_price: '9.0', vipPrice: '9.00' }).vip_price, '9.00');
    for (const name of ['price', 'ot_price', 'vip_price']) for (const bad of [-1, NaN, Infinity, {}, [], 'NaN', '-1', '1e2', '1.001', '90071992547409.92']) assert.throws(() => map({ [name]: bad }), `${name}:${String(bad)}`);
    for (const value of [undefined, null, '']) assert.equal(map({ vip_price: value }).vip_price, null);
    assert.throws(() => map({ vipPrice: '8.00' })); assert.throws(() => map({ vip_price: '', vipPrice: '9.00' }));
    assert.throws(() => map({ otPrice: '11.00' }));
  } finally { r.stop(); }
});
