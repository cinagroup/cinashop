const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vue = require('vue');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
const dir = path.resolve(__dirname, '../src');
function estimate(ownerUid = 11, productId = 70, skuUnique = 'red001') {
  const price = skuUnique === 'blue001' ? '20.00' : '10.00';
  return { version: 1, view: 'uni_product_estimate_v1', ownerUid, productId, skuUnique, quantity: 1,
    evaluatedAt: 1_794_744_000, firstOrderEligible: false,
    computed: { promotions: [], coupon: { source: 'issue', issueId: 81, ownedId: null, requiresClaim: true,
      isMember: false, title: '完整最优券', benefitType: 1, benefitValue: '2.00', minimum: '0.00', savings: '2.00' },
    deduction: { sum_price: price, vip_price: '0.00', promotions_price: '0.00', first_order_price: '0.00',
      coupon_price: '2.00', pay_price: price === '20.00' ? '18.00' : '8.00' } },
    excludes: ['shipping', 'integral', 'payment'], requiresCheckoutRequote: true };
}
function goods(id = 70, presale = false) {
  return { id, storeName: '当前普通商品', price: '10.00', stock: 8, cart_button: 1, is_presale_product: presale ? 1 : 0,
    attr_value: [{ unique: 'red001', suk: '红色', price: '10.00', stock: 8 },
      { unique: 'blue001', suk: '蓝色', price: '20.00', stock: 8 }] };
}
function setup(options = {}) {
  const traces = []; let reads = 0;
  const r = runtime({ component: 'pages/goods/detail.vue', platform: options.platform ?? 'H5',
    authenticated: options.authenticated ?? true, storage: options.storage ?? new Map(), send: call => {
      const uid = !call.header['Authori-zation'] ? 0 : /22/u.test(call.header['Authori-zation']) ? 22 : 11;
      traces.push({ method: call.method, url: call.url, data: structuredClone(call.data), uid });
      if (call.url.includes('/product/detail/activity/') && call.data.view === 'uni_product_estimate_v1') {
        assert.equal(call.method, 'GET'); assert.deepEqual(Object.keys(call.data).sort(), ['unique', 'view']);
        const data = estimate(uid, Number(call.url.split('/').at(-1)), call.data.unique);
        return options.read?.(call, data, reads++) ?? { data };
      }
      if (/\/product\/detail\/\d+$/u.test(call.url)) return { data: goods(Number(call.url.split('/').at(-1)), options.presale) };
      if (call.url.includes('/product/detail/activity/')) return { data: { coupons: [], promotions: [] } };
      if (call.url.endsWith('/cart/count')) return { data: { count: 0 } };
      return { data: [] };
    } });
  return { ...r, traces, async open() { await r.start({ id: '70' }); }, get e() { return r.checkout.productEstimate; } };
}
const reads = r => r.traces.filter(c => c.data.view === 'uni_product_estimate_v1');
function decode(r) { return r.load(path.resolve(__dirname, '../../common/publicProductEstimate.ts')).decodePublicProductEstimate; }
const expected = { ownerUid: 11, productId: 70, skuUnique: 'red001' };
async function render(r) {
  const sfc = require('@vue/compiler-sfc'), compiler = require('@vue/compiler-dom');
  const file = path.join(dir, 'components/productDetail/ProductEstimate.vue');
  const descriptor = sfc.parse(fs.readFileSync(file, 'utf8'), { filename: file }).descriptor;
  const bindings = sfc.compileScript(descriptor, { id: 'actual-product-estimate' }).bindings;
  const fn = new Function('Vue', compiler.compile(descriptor.template.content, { mode: 'function', prefixIdentifiers: true,
    bindingMetadata: bindings, isCustomElement: tag => ['view', 'text'].includes(tag) }).code)(vue);
  const component = r.load(file).default; component.render = fn;
  const app = vue.createSSRApp({ render: () => vue.h(component, { estimate: r.e, quantity: r.checkout.num.value }) });
  app.use(require('pinia').getActivePinia());
  return (await require('@vue/server-renderer').renderToString(app)).replace(/<!--[\s\S]*?-->/gu, '');
}

test('strict shared decoder preserves exact canonical DTO and separates owned IDs from issue IDs', () => {
  const r = setup(); try {
    assert.deepEqual(decode(r)(estimate(), expected), estimate());
    const owned = estimate(); Object.assign(owned.computed.coupon, { source: 'owned', ownedId: 5001, requiresClaim: false });
    assert.deepEqual(decode(r)(owned, expected).computed.coupon, owned.computed.coupon);
    const guest = estimate(0); assert.equal(decode(r)(guest, { ...expected, ownerUid: 0 }).ownerUid, 0);
  } finally { r.stop(); }
});
const invalid = {
  'wrong owner': x => x.ownerUid = 22,
  'wrong product': x => x.productId = 71,
  'wrong SKU': x => x.skuUnique = 'blue001',
  'padded SKU': x => x.skuUnique = 'red001  ',
  'quantity authority': x => x.quantity = 2,
  'old view': x => x.view = 'uni_product_estimate',
  'invented receipt': x => x.quoteToken = 'fake',
  'missing amount': x => delete x.computed.deduction.pay_price,
  'numeric amount': x => x.computed.deduction.sum_price = 10,
  'negative amount': x => x.computed.deduction.sum_price = '-10.00',
  'noncanonical amount': x => x.computed.deduction.sum_price = '010.00',
  'one digit cents': x => x.computed.deduction.sum_price = '10.0',
  'unsafe amount': x => x.computed.deduction.sum_price = '90071992547409.92',
  'unreconciled deduction': x => x.computed.deduction.pay_price = '0.00',
  'unreconciled coupon saving': x => x.computed.coupon.savings = '1.00',
  'zero saving coupon': x => { x.computed.coupon.savings = '0.00'; x.computed.deduction.coupon_price = '0.00'; x.computed.deduction.pay_price = '10.00'; },
  'missing coupon': x => x.computed.coupon = null,
  'issue pretending owned ID': x => x.computed.coupon.ownedId = 5001,
  'issue pretending already owned': x => x.computed.coupon.requiresClaim = false,
  'owned missing actual ID': x => Object.assign(x.computed.coupon, { source: 'owned', requiresClaim: false }),
  'array source': x => x.computed.coupon.source = ['issue'],
  'invalid benefit': x => x.computed.coupon.benefitType = 3,
  'saving exceeds money benefit': x => x.computed.coupon.benefitValue = '1.99',
  'invalid percent': x => Object.assign(x.computed.coupon, { benefitType: 2, benefitValue: '100.01' }),
  'control title': x => x.computed.coupon.title = '券\u0001',
  'invented first order': x => { x.computed.deduction.first_order_price = '1.00'; x.computed.deduction.pay_price = '7.00'; },
  'exclusive zero first order with coupon': x => x.firstOrderEligible = true,
  'unreconciled promotions': x => x.computed.promotions.push({ id: 9, type: 1, name: '促销', savings: '1.00', quantity: 1 }),
  'invented exclusions': x => x.excludes = [['shipping'], 'integral', 'payment'],
  'checkout authority': x => x.requiresCheckoutRequote = false,
  'invalid clock': x => x.evaluatedAt = Number.MAX_SAFE_INTEGER,
};
for (const [name, change] of Object.entries(invalid)) test('strict decoder rejects ' + name, () => {
  const r = setup(); try { const data = estimate(); change(data); assert.throws(() => decode(r)(data, expected)); } finally { r.stop(); }
});
test('anonymous cannot receive an owned or member result, and zero-saving exclusive first order remains exclusive', () => {
  const r = setup(); try {
    for (const fields of [{ source: 'owned', ownedId: 5001, requiresClaim: false }, { isMember: true }]) {
      const x = estimate(0); Object.assign(x.computed.coupon, fields); assert.throws(() => decode(r)(x, { ...expected, ownerUid: 0 }));
    }
    const first = estimate(); first.firstOrderEligible = true; first.computed.coupon = null;
    first.computed.deduction.coupon_price = '0.00'; first.computed.deduction.pay_price = '10.00';
    assert.equal(decode(r)(first, expected).firstOrderEligible, true);
    first.computed.promotions = [{ id: 9, type: 1, name: '零优惠促销', savings: '0.00', quantity: 1 }];
    assert.throws(() => decode(r)(first, expected));
  } finally { r.stop(); }
});
test('promotion records reconcile, require exact types and retain actual fractional percentage coupon facts', () => {
  const r = setup(); try {
    const x = estimate(); x.computed.promotions = [{ id: 9, type: 2, name: '所选促销', savings: '1.00', quantity: 1 }];
    x.computed.deduction.promotions_price = '1.00'; x.computed.deduction.pay_price = '7.00';
    Object.assign(x.computed.coupon, { benefitType: 2, benefitValue: '85.99' });
    assert.equal(decode(r)(x, expected).computed.coupon.benefitValue, '85.99');
    for (const bad of [{ type: '2' }, { quantity: 0 }, { quantity: 1.5 }, { id: 0 }, { savings: '0.01' }]) {
      const changed = structuredClone(x); Object.assign(changed.computed.promotions[0], bad); assert.throws(() => decode(r)(changed, expected));
    }
    const duplicate = structuredClone(x); duplicate.computed.promotions.push({ ...duplicate.computed.promotions[0], savings: '0.00' });
    assert.throws(() => decode(r)(duplicate, expected));
  } finally { r.stop(); }
});

for (const platform of ['H5', 'MP-WEIXIN', 'APP-PLUS']) test(platform + ' actual page reads a strict selected-SKU quantity-one advisory with no purchase or grant', async () => {
  const r = setup({ platform }); try {
    await r.open(); assert.equal(r.e.state.result.skuUnique, 'red001'); assert.equal(r.e.state.result.ownerUid, 11);
    assert.equal(r.checkout.displayPrice.value, '10.00');
    assert.deepEqual(reads(r).map(c => c.data), [{ view: 'uni_product_estimate_v1', unique: 'red001' }]);
    r.checkout.num.value = 3; await tick(); assert.equal(reads(r).length, 1);
    const html = await render(r); for (const text of ['单件预估到手', '¥8.00', '仅为 1 件预估', '会员优惠', '促销优惠', '首单优惠', '优惠券优惠', '完整最优券', '需领取后使用', '未含运费和积分抵扣', '结算时重新确认']) assert.ok(html.includes(text), text);
    assert.equal(r.traces.filter(c => c.method === 'POST').length, 0); assert.equal(r.storage.size, 2);
  } finally { r.stop(); }
});
test('real anonymous page gets owner0 without a forced login or synthetic private fallback', async () => {
  const r = setup({ authenticated: false }); try { await r.open(); assert.equal(r.e.state.result.ownerUid, 0); assert.equal(reads(r)[0].uid, 0); assert.deepEqual(r.navigations, []); } finally { r.stop(); }
});
test('selected SKU changes clear synchronously and A to B to A cannot accept the first A response', async () => {
  const gates = [deferred(), deferred(), deferred()]; const r = setup({ read: (_, data, index) => gates[index].promise.then(() => ({ data })) });
  try {
    await r.open(); assert.equal(r.e.state.loading, true); assert.equal(r.e.state.result, null);
    r.checkout.pickSku(r.checkout.skuList.value[1]); assert.equal(r.e.state.result, null); await tick();
    r.checkout.pickSku(r.checkout.skuList.value[0]); await tick(); assert.equal(reads(r).length, 3);
    gates[0].resolve(); gates[1].resolve(); await tick(); assert.equal(r.e.state.result, null); assert.equal(r.e.state.loading, true);
    gates[2].resolve(); await tick(); assert.equal(r.e.state.result.skuUnique, 'red001'); assert.equal(r.e.state.loading, false);
  } finally { for (const gate of gates) gate.resolve(); r.stop(); }
});
for (const next of ['different owner', 'same owner refresh', 'logout']) test(next + ' clears immediately and fences a late private estimate', async () => {
  const gate = deferred(); const r = setup({ read: (_, data, index) => index === 0 ? gate.promise.then(() => ({ data })) : { data } });
  try {
    await r.open(); if (next === 'logout') r.auth.clear(); else r.auth.setLogin(next === 'different owner' ? 'owner-22' : 'replacement-token', next === 'different owner' ? 22 : 11);
    assert.equal(r.e.state.result, null); gate.resolve(); await tick();
    assert.equal(r.e.state.result.ownerUid, next === 'logout' ? 0 : next === 'different owner' ? 22 : 11);
    assert.equal(r.e.state.loading, false); assert.equal(r.e.state.error, '');
  } finally { gate.resolve(); r.stop(); }
});
for (const end of ['onHide', 'onUnload']) test(end + ' removes advisory state and rejects late results', async () => {
  const gate = deferred(), r = setup({ read: (_, data) => gate.promise.then(() => ({ data })) });
  try { await r.open(); r.hooks[end](); assert.equal(r.e.state.result, null); assert.equal(r.e.state.loading, false); gate.resolve(); await tick(); assert.equal(r.e.state.result, null); assert.equal(r.e.state.error, ''); } finally { gate.resolve(); r.stop(); }
});
test('transport and decoder failures show retry without zero or stale price, and retry reads the same current SKU', async () => {
  let mode = 'ok'; const r = setup({ read: (_, data) => mode === 'network' ? { transport: 'offline' } : mode === 'invalid' ? { data: [] } : { data } });
  try {
    await r.open(); assert.ok(r.e.state.result);
    for (const failure of ['network', 'invalid']) {
      mode = failure; const pending = r.e.load(); assert.equal(r.e.state.result, null); await pending;
      assert.equal(r.e.state.result, null); assert.ok(r.e.state.error); const html = await render(r);
      assert.ok(html.includes('重新读取预估')); assert.ok(!html.includes('¥8.00')); assert.ok(!html.includes('¥0.00'));
      mode = 'ok'; await r.e.load(); assert.equal(r.e.state.result.skuUnique, 'red001'); assert.equal(r.e.state.error, '');
    }
  } finally { r.stop(); }
});
test('reloading the product invalidates the previous request even for the same actor and SKU', async () => {
  const gate = deferred(), r = setup({ read: (_, data, index) => index === 0 ? gate.promise.then(() => ({ data })) : { data } });
  try { await r.open(); await r.checkout.load(); await tick(); assert.equal(reads(r).length, 2); gate.resolve(); await tick(); assert.equal(r.e.state.result.skuUnique, 'red001'); assert.equal(r.e.state.loading, false); } finally { gate.resolve(); r.stop(); }
});
test('presale and missing selected SKU never dispatch the ordinary estimate', async () => {
  const r = setup({ presale: true }); try { await r.open(); assert.equal(reads(r).length, 0); assert.equal(r.e.state.result, null); } finally { r.stop(); }
  const x = setup(); try { await x.open(); x.checkout.selectedSku.value = null; assert.equal(x.e.state.result, null); await tick(); assert.equal(reads(x).length, 1); } finally { x.stop(); }
});
test('H5 visibility and persisted owner events clear state and never resurrect the old account', async () => {
  const saved = Object.fromEntries(['window', 'document'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const target = () => { const listeners = new Map(); return { addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); }, fire(name) { for (const fn of [...listeners.get(name) ?? []]) fn(); } }; };
  const doc = { ...target(), visibilityState: 'visible' }, win = { ...target(), location: { hash: '' }, navigator: {} };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
  const r = setup();
  try {
    await r.open(); assert.ok(r.e.state.result); doc.visibilityState = 'hidden'; doc.fire('visibilitychange');
    assert.equal(r.e.state.result, null); assert.equal(r.e.state.loading, false); const hiddenCount = reads(r).length; await tick(); assert.equal(reads(r).length, hiddenCount);
    doc.visibilityState = 'visible'; doc.fire('visibilitychange'); await tick(); assert.equal(r.e.state.result.ownerUid, 11);
    r.storage.set('uni_token', 'owner-22'); r.storage.set('uni_uid', 22); win.fire('storage'); assert.equal(r.e.state.result, null); await tick(); assert.equal(r.e.state.result.ownerUid, 22);
    win.fire('focus'); assert.equal(r.e.state.result, null); await tick(); assert.equal(r.e.state.result.ownerUid, 22);
  } finally { r.stop(); for (const name of ['window', 'document']) if (saved[name]) Object.defineProperty(globalThis, name, saved[name]); else delete globalThis[name]; }
});
test('detail template wires the independent estimate panel while preserving original displayed SKU price and purchase actions', () => {
  const source = fs.readFileSync(path.join(dir, 'pages/goods/detail.vue'), 'utf8');
  assert.match(source, /<ProductEstimate v-if="!detail\.is_presale_product" :estimate="productEstimate" :quantity="num"/u);
  assert.match(source, /<text class="price">¥\{\{ displayPrice \}\}/u);
  assert.match(source, /computed\(\(\) => selectedSku\.value\?\.unique \?\? ''\)/u);
  assert.match(source, /productEstimate\.clear\(\)/u);
  const component = fs.readFileSync(path.join(dir, 'components/productDetail/ProductEstimate.vue'), 'utf8');
  assert.doesNotMatch(component, /coupon\/receive|apiCartAdd|quoteToken|emit\('buy'/u);
});
