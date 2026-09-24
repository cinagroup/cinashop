const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');

// Real page/composable, Vue, Pinia, request adapter and shared contract. Only
// native lifecycle and transport are synthetic; no production authentication/I/O.
function catalogue(id = 70) {
  const stamp = Math.floor(Date.now() / 1000);
  return { version: 1, selection_only: true, type: 6, payment_mode: 'full', product_id: id,
    title: `预售${id}`, subtitle: '全款预售', image: '', images: [], sales: 3, unit_name: '件', product_type: 0, system_form_id: 0,
    purchase_limits: { mode: 'per_order', quantity: 3 },
    schedule: { timezone: 'Asia/Shanghai', state: 'active', presale_pay_status: 2, start_time: stamp - 60, stop_time: stamp + 60,
      starts_at: new Date((stamp - 60) * 1000).toISOString(), ends_at: new Date((stamp + 61) * 1000).toISOString(), shipping_days_after_end: 7 },
    skus: [{ unique: 'pres0001', base_unique: 'pres0001', suk: '红色', catalog_price: '80.25', ot_price: '100.00', stock: 7, max_quantity: 3, image: '' },
      { unique: 'pres0002', base_unique: 'pres0002', suk: '蓝色', catalog_price: '90.50', ot_price: '120.00', stock: 2, max_quantity: 2, image: '' }] };
}
function setup({ detail = c => ({ data: catalogue(Number(c.url.split('/').at(-1))) }), add = () => ({ data: { id: 91 } }), component } = {}) {
  const r = runtime({ feature: 'usePresalePurchase', component, send: c => {
    if (/\/product\/detail\/\d+$/.test(c.url)) return detail(c);
    if (c.url === '/api/cart/add') return add(c);
    throw new Error(`Unexpected presale I/O: ${c.url}`);
  } });
  r.uni.navigateTo = opts => { r.navigations.push(opts.url); opts.success?.({}); };
  return r;
}
const adds = r => r.calls.filter(c => c.url === '/api/cart/add');
const reads = r => r.calls.filter(c => c.url.includes('/product/detail/'));
const start = r => r.start({ id: '70' });

test('selection is explicit and submits only the true base SKU with full-payment type 6, not a quote', async () => {
  const r = setup(); try {
    await start(r); const p = r.checkout;
    assert.deepEqual(reads(r)[0].data, { view: 'presale' });
    assert.equal(p.canBuy.value, false); await p.purchase(); assert.equal(adds(r).length, 0);
    p.choose('pres0001'); p.quantity.value = 2; assert.equal(p.canBuy.value, true); await p.purchase();
    assert.deepEqual(adds(r).map(c => c.data), [{ productId: 70, activityId: 0, type: 6, unique: 'pres0001', cartNum: 2, new: 1 }]);
    assert.deepEqual(r.navigations, ['/pages/order/confirm?mode=buy&cartId=91&type=6']);
    assert.equal(r.calls.length, 2); // selection + cart only, no quote/order/payment
  } finally { r.stop(); }
});
test('actual SFC quantity input rejects empty, fractional, negative, exponent and over-limit choices', async () => {
  const r = setup({ component: 'pages/activity/presaleDetail.vue' }); try {
    await start(r); const p = r.checkout; p.choose('pres0001');
    for (const value of ['', '0', '-1', '1.5', '1e1', '4', '999999']) {
      p.setQuantity({ detail: { value } }); assert.equal(p.canBuy.value, false, value); await p.purchase();
    }
    assert.equal(adds(r).length, 0); p.setQuantity({ detail: { value: '3' } }); assert.equal(p.canBuy.value, true);
    await p.purchase(); p.setQuantity({ detail: { value: '1' } }); assert.equal(p.quantity.value, 3);
  } finally { r.stop(); }
});
for (const mode of ['future', 'ended', 'cumulative', 'soldout', 'empty']) test(`${mode} is browseable but cannot create a cart`, async () => {
  const r = setup({ detail: () => { const data = catalogue();
    if (mode === 'future' || mode === 'ended') { data.schedule.state = mode; data.schedule.presale_pay_status = mode === 'future' ? 1 : 3; }
    if (mode === 'cumulative') { data.purchase_limits.mode = mode; data.skus.forEach(s => s.max_quantity = 0); }
    if (mode === 'soldout') data.skus.forEach(s => { s.stock = 0; s.max_quantity = 0; });
    if (mode === 'empty') data.skus = [];
    return { data };
  } }); try { await start(r); const p = r.checkout; assert.ok(p.detail.value); p.choose('pres0001');
    assert.equal(p.canBuy.value, false); await p.purchase(); assert.equal(adds(r).length, 0);
  } finally { r.stop(); }
});
test('invalid route and catalogue identities fail closed without ordinary fallback', async () => {
  for (const id of [undefined, '', '0', '-1', '070', '7e1', '70.0', '2147483648', ['70']]) {
    const r = setup(); try { await r.start({ id }); assert.equal(r.calls.length, 0); assert.ok(r.checkout.error.value); } finally { r.stop(); }
  }
  for (const change of [d => ({ ...d, product_id: 71 }), d => ({ ...d, type: 0 }), d => ({ ...d, purchase_limits: undefined }),
    d => ({ ...d, skus: [{ ...d.skus[0], base_unique: 'other001' }] })]) {
    const r = setup({ detail: () => ({ data: change(catalogue()) }) }); try {
      await start(r); assert.equal(r.checkout.detail.value, null); assert.ok(r.checkout.error.value); await r.checkout.purchase(); assert.equal(adds(r).length, 0);
    } finally { r.stop(); }
  }
});
test('anonymous and expired login returns restore intent, never a stale quote or automatic purchase', async () => {
  for (const expired of [false, true]) {
    const r = setup({ add: () => ({ status: 410002, msg: 'synthetic expiry' }) }); try {
      if (!expired) r.auth.clear(); await start(r); const p = r.checkout;
      p.choose('pres0002'); p.quantity.value = 2; await p.purchase();
      assert.equal(r.navigations.at(-1), '/pages/auth/login'); assert.equal(adds(r).length, expired ? 1 : 0);
      r.hooks.onHide(); r.auth.setLogin('fresh', 11); r.hooks.onShow(); await tick();
      assert.equal(p.selected.value, 'pres0002'); assert.equal(p.quantity.value, 2); assert.equal(p.canBuy.value, true);
      assert.equal(reads(r).length, 2); assert.equal(adds(r).length, expired ? 1 : 0); assert.equal(p.prepared.value, null);
    } finally { r.stop(); }
  }
});
test('login return does not silently reduce quantity when fresh stock or limit shrinks', async () => {
  let reduced = false; const r = setup({ detail: () => { const data = catalogue(); if (reduced) data.skus[0].max_quantity = 1; return { data }; } });
  try { r.auth.clear(); await start(r); const p = r.checkout; p.choose('pres0001'); p.quantity.value = 3; await p.purchase();
    r.hooks.onHide(); reduced = true; r.auth.setLogin('new', 11); r.hooks.onShow(); await tick();
    assert.equal(p.quantity.value, 3); assert.equal(p.canBuy.value, false); assert.match(p.error.value, /库存或限购/);
  } finally { r.stop(); }
});
test('known cart navigation retries never repeat writes and ignore callbacks from earlier attempts', async () => {
  const r = setup(), callbacks = []; r.uni.navigateTo = o => callbacks.push(o);
  try { await start(r); const p = r.checkout; p.choose('pres0001'); await p.purchase(); callbacks[0].fail();
    assert.equal(p.prepared.value, 91); assert.match(p.error.value, /继续结算/);
    await p.purchase(); await p.purchase(); await p.load(); callbacks[0].fail();
    assert.equal(p.navigating.value, true); assert.equal(callbacks.length, 2); assert.equal(adds(r).length, 1); assert.equal(reads(r).length, 1);
    callbacks[1].fail(); assert.equal(p.navigating.value, false);
  } finally { r.stop(); }
});
for (const ending of ['onHide', 'onUnload', 'route', 'identity']) test(`late reads and cart results cannot survive ${ending}`, async () => {
  for (const operation of ['read', 'write']) {
    const gate = deferred(), r = setup(operation === 'read' ? { detail: () => gate.promise } : { add: () => gate.promise });
    try { await start(r); const p = r.checkout; let work;
      if (operation === 'write') { p.choose('pres0001'); work = p.purchase(); await tick(); }
      if (ending === 'route') r.hooks.onLoad({ id: '71' });
      else if (ending === 'identity') r.auth.setLogin('another', 22);
      else r.hooks[ending]();
      gate.resolve(operation === 'read' ? { data: catalogue() } : { data: { id: 91 } }); await work; await tick();
      assert.equal(p.prepared.value, null); assert.equal(p.selected.value, ''); assert.deepEqual(r.navigations, []);
      if (ending !== 'route') assert.equal(p.detail.value, null);
    } finally { gate.resolve({ data: catalogue() }); r.stop(); }
  }
});
test('an old write cannot clear a new visible generation busy flag', async () => {
  const old = deferred(), next = deferred(); let count = 0; const r = setup({ add: () => ++count === 1 ? old.promise : next.promise });
  try { await start(r); const p = r.checkout; p.choose('pres0001'); const a = p.purchase(); await tick();
    r.hooks.onHide(); r.hooks.onShow(); await tick(); p.choose('pres0001'); const b = p.purchase(); await tick();
    old.resolve({ data: { id: 91 } }); await a; assert.equal(p.buying.value, true); assert.deepEqual(r.navigations, []);
    next.resolve({ data: { id: 92 } }); await b; assert.match(r.navigations.at(-1), /cartId=92&type=6/);
  } finally { old.resolve({ data: { id: 91 } }); next.resolve({ data: { id: 92 } }); r.stop(); }
});
test('late expiry after a lifecycle boundary never reinstates the old selection intent', async () => {
  const gate = deferred(), r = setup({ add: () => gate.promise }); try {
    await start(r); const p = r.checkout; p.choose('pres0002'); const work = p.purchase(); await tick();
    r.hooks.onHide(); r.hooks.onShow(); await tick();
    gate.resolve({ status: 410002, msg: 'old expiry' }); await work;
    r.hooks.onHide(); r.auth.setLogin('new', 11); r.hooks.onShow(); await tick();
    assert.equal(p.selected.value, ''); assert.equal(p.prepared.value, null);
  } finally { gate.resolve({ data: { id: 91 } }); r.stop(); }
});
test('write-time clock closes purchase even before the next display timer tick', async () => {
  const r = setup(), original = Date.now; try { await start(r); const p = r.checkout; p.choose('pres0001');
    const deadline = (p.detail.value.schedule.stop_time + 1) * 1000; Date.now = () => deadline;
    await p.purchase(); assert.equal(adds(r).length, 0); assert.equal(p.detail.value, null); assert.match(p.error.value, /不可购买/);
  } finally { Date.now = original; r.stop(); }
});
for (const result of [{ data: { id: 0 } }, { data: { id: 2147483648 } }, { transport: 'uncertain write' }, { status: 400, msg: '资格变化' }])
  test(`unconfirmed write requires explicit refresh: ${JSON.stringify(result)}`, async () => {
    const r = setup({ add: () => result }); try { await start(r); const p = r.checkout; p.choose('pres0001'); await p.purchase();
      await p.purchase(); assert.equal(adds(r).length, 1); assert.equal(p.canBuy.value, false); assert.equal(p.detail.value, null);
      assert.ok(p.error.value); assert.equal(p.prepared.value, null); await p.load(); assert.ok(p.detail.value); assert.equal(p.selected.value, '');
    } finally { r.stop(); }
  });
test('H5 reused routes validate exactly one canonical ID and dispose their listener', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'window'), listeners = new Map();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { hash: '#/pages/activity/presaleDetail?id=70' },
    addEventListener: (n, f) => listeners.set(n, f), removeEventListener: n => listeners.delete(n) } });
  const r = setup(); try { await start(r); const p = r.checkout; p.choose('pres0001');
    window.location.hash = '#/pages/activity/presaleDetail?id=71'; listeners.get('hashchange')(); await tick();
    assert.equal(p.detail.value.product_id, 71); assert.equal(p.selected.value, '');
    const count = r.calls.length;
    for (const query of ['id=70&id=71', 'id=0', 'id=70.0', 'id=7e1', 'id=2147483648']) {
      window.location.hash = `#/pages/activity/presaleDetail?${query}`; listeners.get('hashchange')(); await tick();
      assert.equal(p.detail.value, null); assert.equal(r.calls.length, count);
    }
    window.location.hash = '#/pages/activity/presaleDetail?id=70'; listeners.get('hashchange')(); await tick();
    r.auth.clear(); await p.load(); p.choose('pres0002'); p.quantity.value = 2; await p.purchase();
    window.location.hash = '#/pages/auth/login'; listeners.get('hashchange')(); r.hooks.onHide();
    r.auth.setLogin('after-h5-login', 11); window.location.hash = '#/pages/activity/presaleDetail?id=70'; r.hooks.onShow(); await tick();
    assert.equal(p.selected.value, 'pres0002'); assert.equal(p.quantity.value, 2);
  } finally { r.stop(); assert.equal(listeners.size, 0); if (saved) Object.defineProperty(globalThis, 'window', saved); else delete globalThis.window; }
});
test('ordinary detail routes presale to its dedicated page and never submits ordinary or package carts', async () => {
  const r = runtime({ component: 'pages/goods/detail.vue', send: c => c.url.includes('/product/detail/')
    ? { data: { id: 70, stock: 5, price: '10.00', isPresaleProduct: 1, attr_value: [{ unique: 'pres0001', stock: 5, price: '10.00' }] } }
    : { data: [] } });
  try { await start(r); const p = r.checkout; assert.equal(p.detail.value.is_presale_product, 1);
    p.openSku('cart'); await p.confirmSku(); await p.buyPackage(); p.goPresale();
    assert.deepEqual(r.navigations, ['/pages/activity/presaleDetail?id=70']); assert.equal(p.skuVisible.value, false); assert.equal(adds(r).length, 0);
    const parser = r.load(path.resolve(__dirname, '../src/api/productDetail.ts')).normalizeMobileGoods;
    for (const flag of [{ is_presale_product: 1, isPresaleProduct: 0 }, { is_presale_product: 2 }, { is_presale_product: '1' }, { is_presale_product: null }])
      assert.throws(() => parser({ id: 70, price: '10.00', stock: 5, ...flag }), /预售标记/);
  } finally { r.stop(); }
});

module.exports = { catalogue };
