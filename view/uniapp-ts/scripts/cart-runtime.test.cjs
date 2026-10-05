const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
const row = (id = 1, price = '17.59') => ({ id, productId: 70, cartNum: 2, type: 0, unique: 'red001', isNew: 0, isValid: true,
  productInfo: { price: '19.99', otPrice: '25.00', storeName: '本地商品', image: '', stock: 8, suk: '红色', systemFormId: 0, productType: 0 },
  sumPrice: '39.98', truePrice: price, trueSumPrice: ((Number(price.replace('.', '')) * 2) / 100).toFixed(2), priceType: price === '19.99' ? '' : 'level', levelName: price === '19.99' ? '' : '银卡' });
function setup(override = () => undefined) {
  return runtime({ component: 'pages/cart/index.vue', send: call => override(call) ?? (call.url.endsWith('/cart/list')
    ? { data: [row(), { ...row(2), isValid: false, productInfo: null }] } : { data: null }) });
}
const promotion = (id = 1) => ({ key: id, productId: 70, quantity: 3, unitPriceCents: null, totalPriceCents: 2900,
  promotionSavingsCents: 100, segments: [
    { quantity: 1, unitPriceCents: 900, totalPriceCents: 900, promotionIds: [41] },
    { quantity: 2, unitPriceCents: 1000, totalPriceCents: 2000, promotionIds: [] },
  ] });
const promotionRow = () => ({ ...row(), cartNum: 3, productInfo: { ...row().productInfo, price: '10.00' },
  sumPrice: '30.00', truePrice: '9.66', trueSumPrice: '29.00', priceType: 'promotions', promotion: promotion() });
test('actual mobile cart selects only valid rows and uses membership totals', async () => {
  const r = setup(); try { await r.start(); const p = r.checkout; p.toggleAll();
    assert.equal(p.cartStore.totalPrice, '35.18'); assert.equal(p.allChecked.value, true);
    p.toggle(2); assert.equal(p.cartStore.items[1].checked, false); p.goCheckout();
    assert.deepEqual(r.navigations, ['/pages/order/confirm']);
    r.hooks.onHide(); assert.deepEqual(p.cartStore.checkedItems.map(row => row.id), [1]);
    assert.equal(p.blocked.value, true); p.goCheckout(); assert.equal(r.navigations.length, 1);
  } finally { r.stop(); }
});
test('partial activity cap displays the exact line total and priced segments, never floor unit times quantity', async () => {
  const r = setup(call => call.url.endsWith('/cart/list') ? { data: [promotionRow()] } : undefined);
  try {
    await r.start(); const p = r.checkout, line = p.cartStore.items[0]; p.toggleAll();
    const pricing = r.load(path.join(path.resolve(__dirname, '..'), '../common/cartPrice.ts'));
    assert.equal(p.cartStore.totalPrice, '29.00');
    assert.equal(pricing.cartUnitPrice(line), '9.66');
    assert.equal(pricing.cartLinePrice(line), '29.00');
    assert.match(pricing.cartPriceLabel(line), /分段计价/);
    assert.equal(pricing.cartPromotionSummary(line), '活动 1 件 ¥9.00，其余 2 件 ¥20.00');
  } finally { r.stop(); }
});
test('cart rejects a fabricated activity total instead of multiplying the display unit', async () => {
  const bad = promotionRow(); bad.promotion.totalPriceCents = 2899;
  const r = setup(call => call.url.endsWith('/cart/list') ? { data: [bad] } : undefined);
  try { await r.start(); assert.equal(r.checkout.cartStore.ready, false); assert.match(r.checkout.cartStore.error, /活动报价/); }
  finally { r.stop(); }
});
test('mobile initial failure is explicit and retry reads without automatically selecting or writing', async () => {
  let fail = true; const r = setup(call => call.url.endsWith('/cart/list') && fail ? { transport: 'offline' } : undefined);
  try { await r.start(); const p = r.checkout; assert.match(p.cartStore.error, /offline/); assert.equal(p.cartStore.ready, false);
    p.goCheckout(); assert.deepEqual(r.navigations, []); fail = false; await p.reload();
    assert.equal(p.cartStore.ready, true); assert.deepEqual(p.cartStore.checkedItems, []); assert.equal(r.calls.length, 2);
  } finally { r.stop(); }
});
test('mobile account replacement clears old rows and requests only after final token publication', async () => {
  const tokens = [], gate = deferred(); let slow = false;
  const r = setup(call => { if (call.url.endsWith('/cart/list')) { tokens.push(call.header['Authori-zation']); return slow ? gate.promise : undefined; } });
  try { await r.start(); const p = r.checkout; p.toggleAll(); slow = true; r.auth.setLogin('new-user', 22);
    assert.deepEqual(p.cartStore.items, []); assert.deepEqual(p.cartStore.selection, []); await tick(); assert.equal(tokens.at(-1), 'Bearer new-user');
    gate.resolve({ data: [row(3, '19.99')] }); await tick(); assert.equal(p.cartStore.items[0].id, 3); assert.deepEqual(p.cartStore.checkedItems, []);
  } finally { gate.resolve({ data: [] }); r.stop(); }
});
test('mobile stale prior-account failure cannot erase a newer successful list', async () => {
  const gate = deferred(); let slow = true;
  const r = setup(call => call.url.endsWith('/cart/list') && slow ? gate.promise : undefined);
  try { await r.start(); slow = false; r.auth.setLogin('second-user', 22); await tick();
    gate.resolve({ transport: 'old failure' }); await tick(); assert.equal(r.checkout.cartStore.ready, true); assert.equal(r.checkout.cartStore.items[0].id, 1); assert.equal(r.checkout.cartStore.error, '');
  } finally { gate.resolve({ data: [] }); r.stop(); }
});
for (const hook of ['onHide', 'onUnload']) test(`mobile pending quantity mutation is ignored after ${hook}`, async () => {
  const gate = deferred(); const r = setup(call => call.url.endsWith('/cart/num') ? gate.promise : undefined);
  try { await r.start(); const p = r.checkout, item = p.cartStore.items[0]; const first = p.changeNum(item, 1); await tick();
    r.hooks[hook](); const calls = r.calls.length; gate.resolve({ data: null }); await first;
    assert.equal(r.calls.length, calls); assert.equal(p.cartStore.ready, false); await p.changeNum(item, 1); assert.equal(r.calls.length, calls); assert.deepEqual(r.toasts, []);
  } finally { gate.resolve({ data: null }); r.stop(); }
});
test('mobile logout immediately removes rows, selection and badge without an unauthenticated cart read', async () => {
  const r = setup(); try { await r.start(); r.checkout.toggleAll(); r.checkout.cartStore.count = 9; const count = r.calls.length;
    r.auth.clear(); assert.deepEqual(r.checkout.cartStore.items, []); assert.equal(r.checkout.cartStore.count, 0); await tick();
    assert.equal(r.calls.length, count); assert.match(r.checkout.cartStore.error, /登录/); assert.equal(r.checkout.blocked.value, true);
  } finally { r.stop(); }
});
test('mobile hidden read cannot replace the refreshed page and returns with a fresh quote', async () => {
  const gate = deferred(); let slow = false;
  const r = setup(call => call.url.endsWith('/cart/list') && slow ? gate.promise : undefined);
  try { await r.start(); slow = true; const first = r.checkout.reload(); r.hooks.onHide(); slow = false; r.hooks.onShow(); await tick();
    gate.resolve({ data: [row(99)] }); await first; assert.equal(r.checkout.cartStore.items[0].id, 1); assert.equal(r.checkout.blocked.value, false);
  } finally { gate.resolve({ data: [] }); r.stop(); }
});
