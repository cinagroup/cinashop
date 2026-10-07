const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');

const info = () => ({ register_give_coupon: [{ id: 81, coupon_price: '20', coupon_type: 1, use_min_price: '50', applicable_type: 2 }],
  register_give_integral: 12, register_give_money: '5.00', first_order_status: 1, first_order_discount: 90, newcomer_agreement: '<p>新人规则</p>' });
const product = id => ({ id, product_id: id + 100, store_name: `新人商品${id}`, image: '/safe.png', price: '9.90', ot_price: '19.90', stock: 4 });
const list = page => page === 1 ? Array.from({ length: 9 }, (_, i) => product(90 - i)) : [product(81), product(80)];
const detail = id => ({ storeInfo: { id, product_id: id + 100, title: `新人商品${id}`, image: '/safe.png', price: '9.90', ot_price: '19.90', stock: 4, info: '测试商品' },
  productValue: { 红色: { unique: 'new-sku-1', suk: '红色', price: '9.90', stock: 3, image: '/sku.png' } } });
const publicDesignUrl = '/api/v2/diy/product_detail';
const newcomerAddUrl = '/api/cart/add/newcomer-replay';
const cartRow = (id = 15, activityId = 81, productId = 181) => ({ id, productId, cartNum: 1, type: 7, activityId,
  unique: 'base-sku', isNew: 1, isValid: true, sumPrice: '9.90', productInfo: {
    storeName: '新人商品', image: '', price: '9.90', stock: 4, otPrice: '19.90', suk: '红色', systemFormId: 0, productType: 0,
  } });
function detailRuntime(send) {
  let r;
  r = runtime({ component: 'pages/activity/newcomerDetail.vue', send: call => {
    if (call.url !== publicDesignUrl) return send(call);
    assert.equal(call.method, 'GET');
    assert.deepEqual(call.data, {});
    return { data: { product_detail: r.load(path.resolve(__dirname, '../../common/productDetailDesign.ts')).cloneProductDetailDesign(),
      product_detail_design_state: { configured: true } } };
  } });
  return r;
}
function setup(send = call => call.url.endsWith('/info') ? { data: info() } : { data: list(call.data.page) }) {
  return runtime({ feature: 'useNewcomerGift', component: 'pages/activity/new_customer/index.vue', send });
}

test('old newcomer route reads account benefits and exact type-7 catalogue, paginates, and enters activity detail', async () => {
  const r = setup(); try {
    await r.start(); const p = r.checkout;
    assert.deepEqual(r.calls.map(c => c.url).sort(), ['/api/marketing/newcomer/info', '/api/marketing/newcomer/product_list']);
    assert.deepEqual(r.calls.find(c => c.url.endsWith('/product_list')).data, { page: 1, limit: 9 });
    assert.equal(p.info.value.points, 12); assert.equal(p.info.value.coupons[0].benefit, '¥20.00');
    assert.equal(p.products.value.length, 9); assert.equal(p.hasMore.value, true);
    await p.load(true); assert.deepEqual(r.calls.at(-1).data, { page: 2, limit: 9 });
    assert.equal(p.products.value.length, 11); assert.equal(p.page.value, 2); assert.equal(p.hasMore.value, false);
    p.openProduct(999); p.openProduct(81);
    assert.deepEqual(r.navigations, ['/pages/activity/newcomerDetail?id=81']);
    assert.equal(r.calls.some(c => /\/api\/(?:products|cart)/.test(c.url)), false);
  } finally { r.stop(); }
});

test('append failure keeps the committed page and retries the exact failed page', async () => {
  let fail = true;
  const r = setup(call => call.url.endsWith('/info') ? { data: info() }
    : call.data.page === 2 && fail ? { transport: '离线' } : { data: list(call.data.page) });
  try {
    await r.start(); const p = r.checkout;
    await p.load(true); assert.equal(p.page.value, 1); assert.equal(p.products.value.length, 9); assert.match(p.error.value, /离线/);
    r.hooks.onReachBottom(); await tick(); assert.equal(r.calls.length, 3);
    fail = false; await p.load(true); assert.equal(p.page.value, 2); assert.equal(p.products.value.length, 11);
    assert.deepEqual(r.calls.filter(c => c.url.endsWith('/product_list')).map(c => c.data.page), [1, 2, 2]);
  } finally { r.stop(); }
});

test('anonymous entry goes to login; returning with a new account makes fresh reads', async () => {
  const r = setup(); try {
    r.auth.clear(); await r.start(); assert.deepEqual(r.navigations, ['/pages/auth/login']); assert.equal(r.calls.length, 0);
    r.hooks.onHide(); r.auth.setLogin('returning-owner', 42); r.hooks.onShow(); await tick();
    assert.equal(r.calls.length, 2); assert.equal(r.checkout.products.value.length, 9);
  } finally { r.stop(); }
});

for (const boundary of ['onHide', 'onUnload', 'identity']) test(`late newcomer response cannot restore benefits or products after ${boundary}`, async () => {
  const gate = deferred();
  const r = setup(call => call.url.endsWith('/info') ? { data: info() } : gate.promise);
  try {
    await r.start();
    if (boundary === 'identity') r.auth.clear(); else r.hooks[boundary]();
    gate.resolve({ data: list(1) }); await tick();
    assert.equal(r.checkout.products.value.length, 0); assert.equal(r.checkout.info.value, null);
    assert.equal(r.checkout.loading.value, false);
  } finally { gate.resolve({ data: list(1) }); r.stop(); }
});

test('newcomer activity detail selects the exact SKU and enters isolated type-7 checkout with one item', async () => {
  const r = detailRuntime(call => ({ data: call.url === newcomerAddUrl ? { id: 15, cartId: 15, cartNum: 1, replayed: false } : detail(81) }));
  try {
    await r.start({ id: '81' });
    assert.deepEqual(r.calls.map(c => c.url), [publicDesignUrl, '/api/marketing/newcomer/product_detail/81']);
    assert.equal(r.checkout.activityDesignError.value, '');
    assert.equal(r.checkout.detail.value.id, 81); assert.equal(r.checkout.detail.value.skus[0].price, '9.90');
    assert.equal(r.checkout.canBuy.value, false);
    r.checkout.choose('new-sku-1');
    assert.equal(r.checkout.canBuy.value, true);
    await r.checkout.purchase();
    assert.equal(r.calls.length, 3);
    assert.equal(r.calls[2].url, newcomerAddUrl);
    assert.deepEqual({ ...r.calls[2].data, requestKey: undefined }, { productId: 181, unique: 'new-sku-1', cartNum: 1,
      type: 7, activityId: 81, new: 1, requestKey: undefined });
    assert.match(r.calls[2].data.requestKey, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.deepEqual(r.navigations, ['/pages/order/confirm?mode=buy&cartId=15&type=7&newcomerId=81']);
    r.auth.clear(); assert.equal(r.checkout.detail.value, null);
  } finally { r.stop(); }
});

test('selected base SKU with zero stock disables type-7 purchase despite positive product stock', async () => {
  const soldOut = detail(81);
  soldOut.productValue.红色.stock = 0;
  const r = detailRuntime(() => ({ data: soldOut }));
  try {
    await r.start({ id: '81' });
    r.checkout.choose('new-sku-1');
    assert.equal(r.checkout.detail.value.stock, 4);
    assert.equal(r.checkout.selectedSku.value.stock, 0);
    assert.equal(r.checkout.canBuy.value, false);
    await r.checkout.purchase();
    assert.deepEqual(r.calls.map(call => call.url), [publicDesignUrl, '/api/marketing/newcomer/product_detail/81']);
    assert.equal(r.checkout.activityDesignError.value, '');
  } finally { r.stop(); }
});

test('failed checkout navigation reuses the prepared cart instead of adding again', async () => {
  const r = runtime({ component: 'pages/activity/newcomerDetail.vue', navigationFails: true,
    send: call => ({ data: call.url === newcomerAddUrl ? { id: 15, cartId: 15, cartNum: 1, replayed: false } : detail(81) }) });
  try {
    await r.start({ id: '81' }); r.checkout.choose('new-sku-1');
    await r.checkout.purchase();
    assert.equal(r.checkout.prepared.value, 15);
    assert.match(r.checkout.error.value, /无需重新加购/);
    await r.checkout.purchase();
    assert.equal(r.calls.filter(call => call.url === newcomerAddUrl).length, 1);
    assert.deepEqual(r.navigations, [
      '/pages/order/confirm?mode=buy&cartId=15&type=7&newcomerId=81',
      '/pages/order/confirm?mode=buy&cartId=15&type=7&newcomerId=81',
    ]);
  } finally { r.stop(); }
});

test('late type-7 add cannot navigate after hide or account change', async () => {
  for (const boundary of ['hide', 'identity']) {
    const gate = deferred();
    const r = runtime({ component: 'pages/activity/newcomerDetail.vue',
      send: call => call.url === newcomerAddUrl ? gate.promise : { data: detail(81) } });
    try {
      await r.start({ id: '81' }); r.checkout.choose('new-sku-1');
      const purchase = r.checkout.purchase(); await tick();
      if (boundary === 'hide') r.hooks.onHide(); else r.auth.setLogin('different-owner', 42);
      gate.resolve({ data: { id: 15, cartId: 15, cartNum: 1, replayed: false } }); await purchase; await tick();
      assert.equal(r.checkout.prepared.value, null);
      assert.deepEqual(r.navigations, []);
    } finally { gate.resolve({ data: { id: 15, cartId: 15, cartNum: 1, replayed: false } }); r.stop(); }
  }
});

test('successful navigation then return verifies the same buy-scope cart and does not add twice', async () => {
  const r = runtime({ component: 'pages/activity/newcomerDetail.vue', send: call => {
    if (call.url === newcomerAddUrl) return { data: { id: 15, cartId: 15, cartNum: 1, replayed: false } };
    if (call.url.endsWith('/cart/list')) return { data: [cartRow()] };
    return { data: detail(81) };
  } });
  try {
    await r.start({ id: '81' }); r.checkout.choose('new-sku-1'); await r.checkout.purchase();
    assert.equal(r.storage.has('cinashop_newcomer_purchase_v1_11'), true);
    r.hooks.onHide(); r.hooks.onShow(); await tick();
    assert.equal(r.checkout.prepared.value, 15);
    assert.deepEqual(r.calls.find(call => call.url.endsWith('/cart/list')).data, { scope: 'buy', ids: 15 });
    await r.checkout.purchase();
    assert.equal(r.calls.filter(call => call.url === newcomerAddUrl).length, 1);
    assert.deepEqual(r.navigations, Array(2).fill('/pages/order/confirm?mode=buy&cartId=15&type=7&newcomerId=81'));
  } finally { r.stop(); }
});

test('unknown network result survives hide and retries only the same persisted request key after confirmation', async () => {
  let attempts = 0;
  const r = runtime({ component: 'pages/activity/newcomerDetail.vue', modal: true, send: call => {
    if (call.url === newcomerAddUrl) return ++attempts === 1 ? { transport: 'timeout' }
      : { data: { id: 15, cartId: 15, cartNum: 1, replayed: true } };
    return { data: detail(81) };
  } });
  try {
    await r.start({ id: '81' }); r.checkout.choose('new-sku-1'); await r.checkout.purchase();
    const first = r.calls.find(call => call.url === newcomerAddUrl).data.requestKey;
    assert.equal(r.checkout.recovery.value.state, 'unknown'); assert.equal(r.checkout.canBuy.value, false);
    r.hooks.onHide(); r.hooks.onShow(); await tick();
    assert.equal(r.calls.filter(call => call.url === newcomerAddUrl).length, 1);
    await r.checkout.purchase(); assert.equal(r.calls.filter(call => call.url === newcomerAddUrl).length, 1);
    await r.checkout.retryOriginal();
    assert.equal(r.calls.filter(call => call.url === newcomerAddUrl).length, 2);
    assert.equal(r.calls.filter(call => call.url === newcomerAddUrl)[1].data.requestKey, first);
    assert.equal(r.checkout.recovery.value.state, 'acknowledged'); assert.equal(r.checkout.prepared.value, 15);
  } finally { r.stop(); }
});

test('hidden successful response persists for its original account; switching account never reuses the cart', async () => {
  const gate = deferred();
  const r = runtime({ component: 'pages/activity/newcomerDetail.vue', send: call => {
    if (call.url === newcomerAddUrl) return gate.promise;
    if (call.url.endsWith('/cart/list')) return { data: [cartRow()] };
    return { data: detail(81) };
  } });
  try {
    await r.start({ id: '81' }); r.checkout.choose('new-sku-1');
    const pending = r.checkout.purchase(); await tick(); r.hooks.onHide();
    gate.resolve({ data: { id: 15, cartId: 15, cartNum: 1, replayed: false } }); await pending;
    assert.equal(JSON.parse(r.storage.get('cinashop_newcomer_purchase_v1_11')).cartId, 15);
    r.auth.setLogin('other-account', 42); r.hooks.onShow(); await tick();
    assert.equal(r.checkout.recovery.value, null); assert.equal(r.checkout.prepared.value, null);
    r.auth.setLogin('original-account', 11); await tick();
    assert.equal(r.checkout.prepared.value, 15);
    assert.equal(r.calls.filter(call => call.url === newcomerAddUrl).length, 1);
  } finally { gate.resolve({ data: { id: 15, cartId: 15, cartNum: 1, replayed: false } }); r.stop(); }
});

test('unknown intent locks another activity and changed SKU until explicit read and abandon', async () => {
  let changed = false;
  const r = runtime({ component: 'pages/activity/newcomerDetail.vue', modal: true, send: call => {
    if (call.url === newcomerAddUrl) return { transport: 'timeout' };
    if (call.url.endsWith('/cart/list')) return { data: [cartRow()] };
    const id = Number(call.url.split('/').at(-1));
    const value = detail(Number.isSafeInteger(id) ? id : 81);
    if (id === 81 && changed) value.productValue = { 蓝色: { unique: 'new-sku-2', suk: '蓝色', price: '11.90', stock: 3, image: '' } };
    return { data: value };
  } });
  try {
    await r.start({ id: '81' }); r.checkout.choose('new-sku-1'); await r.checkout.purchase();
    changed = true; r.hooks.onHide(); r.hooks.onShow(); await tick();
    assert.equal(r.checkout.detail.value.skus[0].unique, 'new-sku-2');
    r.checkout.choose('new-sku-2'); await r.checkout.purchase();
    assert.equal(r.calls.filter(call => call.url === newcomerAddUrl).length, 1);
    r.hooks.onHide(); r.hooks.onLoad({ id: '82' }); r.hooks.onShow(); await tick();
    assert.equal(r.checkout.recovery.value.activityId, 81);
    r.checkout.choose('new-sku-1'); await r.checkout.purchase(); await r.checkout.retryOriginal();
    assert.equal(r.calls.filter(call => call.url === newcomerAddUrl).length, 1);
    assert.match(r.checkout.error.value, /返回原活动/);
    await r.checkout.inspect();
    assert.deepEqual(r.checkout.candidates.value, [{ id: 15, sku: '红色', valid: true }]);
    await r.checkout.abandon();
    assert.equal(r.storage.has('cinashop_newcomer_purchase_v1_11'), false);
    assert.match(r.checkout.error.value, /额外购物行/);
  } finally { r.stop(); }
});

test('duplicate taps create one persisted type-7 intent and one request', async () => {
  const gate = deferred();
  const r = runtime({ component: 'pages/activity/newcomerDetail.vue', send: call =>
    call.url === newcomerAddUrl ? gate.promise : { data: detail(81) } });
  try {
    await r.start({ id: '81' }); r.checkout.choose('new-sku-1');
    const first = r.checkout.purchase(), second = r.checkout.purchase(); await tick();
    assert.equal(r.calls.filter(call => call.url === newcomerAddUrl).length, 1);
    gate.resolve({ data: { id: 15, cartId: 15, cartNum: 1, replayed: false } }); await Promise.all([first, second]);
    assert.equal(r.checkout.prepared.value, 15);
  } finally { gate.resolve({ data: { id: 15, cartId: 15, cartNum: 1, replayed: false } }); r.stop(); }
});

test('cancelled login returns to newcomer detail without reopening login automatically', async () => {
  const r = runtime({ component: 'pages/activity/newcomerDetail.vue', send: () => ({ data: detail(81) }) });
  try {
    r.auth.clear(); await r.start({ id: '81' });
    assert.deepEqual(r.navigations, ['/pages/auth/login']);
    r.hooks.onHide(); r.hooks.onShow(); await tick();
    assert.deepEqual(r.navigations, ['/pages/auth/login']);
    r.checkout.login(); assert.deepEqual(r.navigations, ['/pages/auth/login', '/pages/auth/login']);
    r.hooks.onHide(); r.auth.setLogin('returning-account', 11); r.hooks.onShow(); await tick();
    assert.equal(r.checkout.detail.value.id, 81);
  } finally { r.stop(); }
});

test('old Worker 404 and terminal replay keep the original key and never fall back to unkeyed add', async () => {
  for (const response of [{ status: 404, msg: 'not found' },
    { status: 409, msg: 'terminal', data: { code: 'cart_terminal', cartId: 15 } }]) {
    const r = runtime({ component: 'pages/activity/newcomerDetail.vue', modal: true,
      send: call => call.url === newcomerAddUrl ? response : { data: detail(81) } });
    try {
      await r.start({ id: '81' }); r.checkout.choose('new-sku-1'); await r.checkout.purchase();
      const first = r.calls.find(call => call.url === newcomerAddUrl).data.requestKey;
      assert.equal(r.checkout.recovery.value.state, 'unknown');
      await r.checkout.retryOriginal();
      assert.deepEqual(r.calls.filter(call => call.url === newcomerAddUrl).map(call => call.data.requestKey), [first, first]);
      assert.equal(r.calls.some(call => call.url === '/api/cart/add'), false);
      assert.equal(r.checkout.canBuy.value, false);
      if (response.status === 409) assert.match(r.checkout.error.value, /已成单/);
    } finally { r.stop(); }
  }
});

test('acknowledged recovery refuses a mismatched exact cart row', async () => {
  const storage = new Map([['cinashop_newcomer_purchase_v1_11', JSON.stringify({ version: 1, actor: 11,
    activityId: 81, productId: 181, activityUnique: 'new-sku-1',
    requestKey: '11111111-1111-4111-8111-111111111111', state: 'acknowledged', cartId: 15 })]]);
  const r = runtime({ component: 'pages/activity/newcomerDetail.vue', storage, send: call =>
    call.url.endsWith('/cart/list') ? { data: [cartRow(15, 82)] } : { data: detail(81) } });
  try {
    await r.start({ id: '81' });
    assert.deepEqual(r.calls.find(call => call.url.endsWith('/cart/list')).data, { scope: 'buy', ids: 15 });
    assert.equal(r.checkout.prepared.value, null); assert.equal(r.checkout.canBuy.value, false);
    assert.match(r.checkout.error.value, /无法核对/);
    r.checkout.choose('new-sku-1'); await r.checkout.purchase();
    assert.equal(r.calls.some(call => call.url === newcomerAddUrl), false);
  } finally { r.stop(); }
});

test('rejected type-7 add clears stale detail and requires a fresh selection', async () => {
  const r = runtime({ component: 'pages/activity/newcomerDetail.vue',
    send: call => call.url === newcomerAddUrl ? { status: 400, msg: '新人专享资格已失效' } : { data: detail(81) } });
  try {
    await r.start({ id: '81' }); r.checkout.choose('new-sku-1');
    await r.checkout.purchase();
    assert.equal(r.checkout.detail.value, null); assert.equal(r.checkout.canBuy.value, false);
    assert.match(r.checkout.error.value, /资格已失效/);
  } finally { r.stop(); }
});

test('expired shopper session clears the selected activity and opens login once', async () => {
  const r = runtime({ component: 'pages/activity/newcomerDetail.vue',
    send: call => call.url === newcomerAddUrl ? { status: 410000, msg: '登录已失效' } : { data: detail(81) } });
  try {
    await r.start({ id: '81' }); r.checkout.choose('new-sku-1');
    await r.checkout.purchase(); await tick();
    assert.equal(r.auth.isLoggedIn, false);
    assert.equal(r.checkout.detail.value, null);
    assert.equal(r.checkout.prepared.value, null);
    assert.deepEqual(r.navigations, ['/pages/auth/login']);
    r.hooks.onHide(); r.hooks.onShow(); await tick();
    assert.deepEqual(r.navigations, ['/pages/auth/login']);
  } finally { r.stop(); }
});

test('checkout binds type-7 cart row to the route activity and quote identity', async () => {
  const item = { id: 15, productId: 181, cartNum: 1, type: 7, activityId: 81,
    unique: 'base0001', isNew: 1, isValid: true, sumPrice: '9.90', productInfo: {
      storeName: '新人商品', image: '', price: '9.90', stock: 4, otPrice: '19.90', suk: '红色', systemFormId: 0, productType: 0,
    } };
  const mismatched = runtime({ send: call => ({ data: call.url.endsWith('/cart/list') ? [item] : [] }) });
  try {
    await mismatched.start({ mode: 'buy', cartId: '15', type: '7', newcomerId: '82' });
    assert.match(mismatched.checkout.error.value, /活动不匹配/);
    assert.equal(mismatched.calls.filter(call => !call.url.endsWith('/cart/list')).length, 0);
    const quote = mismatched.load(path.resolve(__dirname, '../../common/checkoutQuote.ts'));
    assert.notEqual(quote.checkoutQuoteFingerprint([item], { type: 7, addressId: 11, shippingType: 1, storeId: 0, couponId: 0, useIntegral: false }),
      quote.checkoutQuoteFingerprint([{ ...item, activityId: 82 }], { type: 7, addressId: 11, shippingType: 1, storeId: 0, couponId: 0, useIntegral: false }));
  } finally { mismatched.stop(); }
  const valid = runtime({ send: call => ({ data: call.url.endsWith('/cart/list') ? [item] : [] }) });
  try {
    await valid.start({ mode: 'buy', cartId: '15', type: '7', newcomerId: '81' });
    assert.equal(valid.checkout.error.value, '');
    assert.equal(valid.checkout.items.value[0].activityId, 81);
  } finally { valid.stop(); }
});

test('invalid detail id and mismatched activity response fail closed', async () => {
  const bad = detailRuntime(() => { throw new Error('Invalid activity identity must not read or purchase a private product'); });
  try { await bad.start({ id: '81&x=1' }); assert.deepEqual(bad.calls.map(call => call.url), [publicDesignUrl]); assert.equal(bad.checkout.activityDesignError.value, ''); assert.match(bad.checkout.error.value, /链接无效/); } finally { bad.stop(); }
  const mismatch = detailRuntime(() => ({ data: detail(82) }));
  try { await mismatch.start({ id: '81' }); assert.deepEqual(mismatch.calls.map(call => call.url), [publicDesignUrl, '/api/marketing/newcomer/product_detail/81']); assert.equal(mismatch.checkout.detail.value, null); assert.equal(mismatch.checkout.canBuy.value, false); assert.match(mismatch.checkout.error.value, /响应无效/); } finally { mismatch.stop(); }
});

test('H5 reused detail route clears the old product and rejects duplicate activity IDs', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'window'), listeners = new Map();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { hash: '#/pages/activity/newcomerDetail?id=81' },
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) } });
  const r = runtime({ component: 'pages/activity/newcomerDetail.vue', send: call => ({ data: detail(Number(call.url.split('/').at(-1))) }) });
  try {
    await r.start({ id: '81' }); assert.equal(r.checkout.detail.value.id, 81);
    window.location.hash = '#/pages/activity/newcomerDetail?id=82'; listeners.get('hashchange')(); await tick();
    assert.equal(r.checkout.detail.value.id, 82);
    const count = r.calls.length;
    window.location.hash = '#/pages/activity/newcomerDetail?id=81&id=82'; listeners.get('hashchange')(); await tick();
    assert.equal(r.checkout.detail.value, null); assert.equal(r.calls.length, count); assert.match(r.checkout.error.value, /链接无效/);
  } finally { r.stop(); assert.equal(listeners.size, 0); if (saved) Object.defineProperty(globalThis, 'window', saved); else delete globalThis.window; }
});

test('legacy activity deep links route by exact type and activity ID, never to ordinary goods', () => {
  const r = setup(); try {
    const navigation = r.load(path.resolve(__dirname, '../src/config/navigation.ts'));
    const diy = r.load(path.resolve(__dirname, '../src/utils/diy.ts'));
    const old = '/pages/activity/goods_details/index';
    assert.equal(navigation.LEGACY_ROUTE_RULES[old].target, '/pages/activity/index');
    const cases = [
      ['id=81&type=7', '/pages/activity/newcomerDetail?id=81'],
      ['id=20&type=1&time_id=2&spid=99', '/pages/activity/seckillDetail?id=20'],
      ['id=30&type=3&pink_id=70', '/pages/activity/detail?id=30&pinkId=70'],
      ['id=40&type=6', '/pages/activity/presaleDetail?id=40'],
      ['id=41&type=4', '/pages/activity/integralDetail?id=41'],
      ['id=41&type=4&spid=99', '/pages/activity/integralDetail?id=41&spid=99'],
    ];
    for (const [query, expected] of cases) {
      assert.equal(navigation.resolveRegisteredPageRoute(old, query), expected);
      assert.equal(diy.normalizeDiyLink(`${old}?${query}`), expected);
    }
    diy.openDiyLink(`${old}?id=81&type=7`);
    assert.deepEqual(r.navigations, ['/pages/activity/newcomerDetail?id=81']);
    assert.equal(r.navigations.some(url => url.startsWith('/pages/goods/detail')), false);
  } finally { r.stop(); }
});

test('legacy activity deep links fail closed on ambiguous identity, unsupported type and malformed query', () => {
  const r = setup(); try {
    const navigation = r.load(path.resolve(__dirname, '../src/config/navigation.ts'));
    const diy = r.load(path.resolve(__dirname, '../src/utils/diy.ts'));
    const old = '/pages/activity/goods_details/index';
    for (const query of [
      '', 'id=81', 'type=7', 'id=81&type=0', 'id=81&type=77',
      'id=0&type=7', 'id=081&type=7', 'id=81.0&type=7', 'id=8e1&type=7',
      'id=2147483648&type=7', 'id=81&id=82&type=7', 'id=81&%69d=82&type=7',
      'id=81&type=7&type=1', 'id=81&type=3&pink_id=0',
      'id=81&type=3&pink_id=70&pinkId=71', 'id=81&type=%',
      'id=41&type=4&spid=0', 'id=41&type=4&spid=99&%73pid=100',
    ]) {
      assert.equal(navigation.resolveRegisteredPageRoute(old, query), '', query);
      assert.equal(diy.normalizeDiyLink(`${old}?${query}`), '', query);
    }
    for (const query of ['', 'id=0', 'id=041', 'id=41&id=42', 'id=41&%69d=42', 'id=41&spid=0']) {
      assert.equal(navigation.resolveRegisteredPageRoute('/pages/activity/integralDetail', query), '', query);
    }
    assert.equal(navigation.resolveRegisteredPageRoute('/pages/activity/integralDetail', 'id=41&spid=99'), '/pages/activity/integralDetail?id=41&spid=99');
    diy.openDiyLink(`${old}?id=81&type=77`);
    assert.deepEqual(r.navigations, []);
  } finally { r.stop(); }
});

test('parsers reject duplicate identities and unsafe prices; image URL is sanitized', () => {
  const r = setup(); try {
    const api = r.load(path.resolve(__dirname, '../src/api/newcomer.ts'));
    assert.throws(() => api.parseNewcomerProducts([product(1), product(1)]));
    assert.throws(() => api.parseNewcomerProducts([{ ...product(1), price: '9.90<script>' }]));
    assert.equal(api.parseNewcomerProducts([{ ...product(1), image: 'javascript:alert(1)' }])[0].image, '');
    assert.throws(() => api.parseNewcomerDetail(detail(82), 81));
    assert.throws(() => api.parseNewcomerDetail({ ...detail(81), productValue: {
      红色: { unique: 'duplicated', suk: '红色', price: '9.90', stock: 3 },
      蓝色: { unique: 'duplicated', suk: '蓝色', price: '11.90', stock: 3 },
    } }, 81), /规格标识重复/);
    assert.throws(() => api.parseNewcomerInfo({ ...info(), register_give_coupon: 'bad' }));
    assert.throws(() => api.parseNewcomerInfo({ ...info(), register_give_coupon: [{ id: 1, coupon_type: 1 }] }));
    assert.throws(() => api.parseNewcomerInfo({ ...info(), register_give_coupon: [{ id: 1, coupon_price: '20.00', coupon_type: 1 }] }));
    assert.deepEqual(api.parseNewcomerInfo({ ...info(), register_give_coupon: [{ id: 2, couponPrice: '15.00', useMinPrice: '50.00', type: 1 }] }).coupons,
      [{ id: 2, benefit: '¥15.00', minimum: '50.00', scope: '适用范围以券详情为准' }]);
    assert.equal(api.parseNewcomerInfo({ ...info(), register_give_coupon: [{ id: 3, couponPrice: '85.00', useMinPrice: '0.00', type: 0 }] }).coupons[0].benefit,
      '查看券详情');
    assert.equal(api.parseNewcomerInfo({ ...info(), register_give_coupon: [{ id: 2,
      coupon_price: '15.00', use_min_price: '50.00', coupon_type: 1, applicable_type: -1 }] }).coupons[0].scope,
      '适用范围以券详情为准');
  } finally { r.stop(); }
});
