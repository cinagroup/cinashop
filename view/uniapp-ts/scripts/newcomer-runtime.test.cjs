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

test('newcomer activity detail reads only type-7 endpoint and never offers ordinary checkout', async () => {
  const r = runtime({ component: 'pages/activity/newcomerDetail.vue', send: call => ({ data: detail(81) }) });
  try {
    await r.start({ id: '81' });
    assert.deepEqual(r.calls.map(c => c.url), ['/api/marketing/newcomer/product_detail/81']);
    assert.equal(r.checkout.detail.value.id, 81); assert.equal(r.checkout.detail.value.skus[0].price, '9.90');
    assert.equal(typeof r.checkout.purchase, 'undefined');
    r.auth.clear(); assert.equal(r.checkout.detail.value, null);
  } finally { r.stop(); }
});

test('invalid detail id and mismatched activity response fail closed', async () => {
  const bad = runtime({ component: 'pages/activity/newcomerDetail.vue', send: () => ({ data: detail(81) }) });
  try { await bad.start({ id: '81&x=1' }); assert.equal(bad.calls.length, 0); assert.match(bad.checkout.error.value, /链接无效/); } finally { bad.stop(); }
  const mismatch = runtime({ component: 'pages/activity/newcomerDetail.vue', send: () => ({ data: detail(82) }) });
  try { await mismatch.start({ id: '81' }); assert.equal(mismatch.checkout.detail.value, null); assert.match(mismatch.checkout.error.value, /响应无效/); } finally { mismatch.stop(); }
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
      '', 'id=81', 'type=7', 'id=81&type=4', 'id=81&type=0', 'id=81&type=77',
      'id=0&type=7', 'id=081&type=7', 'id=81.0&type=7', 'id=8e1&type=7',
      'id=2147483648&type=7', 'id=81&id=82&type=7', 'id=81&%69d=82&type=7',
      'id=81&type=7&type=1', 'id=81&type=3&pink_id=0',
      'id=81&type=3&pink_id=70&pinkId=71', 'id=81&type=%',
    ]) {
      assert.equal(navigation.resolveRegisteredPageRoute(old, query), '', query);
      assert.equal(diy.normalizeDiyLink(`${old}?${query}`), '', query);
    }
    diy.openDiyLink(`${old}?id=81&type=4`);
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
