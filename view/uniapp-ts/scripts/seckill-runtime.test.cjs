const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');

// Synthetic transport only: execute the real composable, Vue reactivity, Pinia,
// API adapter and catalogue parser. No authentication, provider or production I/O.
function catalogue() {
  return {
    selection_only: true, type: 1, seckill_id: 20, product_id: 70,
    title: 'Isolated seckill', image: '', once_limit: 4, total_limit: 8,
    schedule: { timezone: 'Asia/Shanghai', state: 'active', message: '',
      starts_at: new Date(Date.now() - 60_000).toISOString(), ends_at: new Date(Date.now() + 60_000).toISOString() },
    skus: [
      { unique: 'sale0001', base_unique: 'base0001', suk: 'Red', catalog_price: '10.00', ot_price: '12.00', image: '', stock: 6, max_quantity: 2 },
      { unique: 'sale0002', base_unique: 'base0002', suk: 'Blue', catalog_price: '15.00', ot_price: '18.00', image: '', stock: 8, max_quantity: 4 },
    ],
  };
}
function setup({ detail = () => ({ data: catalogue() }), add = call => ({ data: { id: 901, cartNum: call.data.cartNum } }) } = {}) {
  const r = runtime({ feature: 'useSeckillPurchase', send: call => {
    if (call.url === '/api/seckill/detail/20') return detail(call);
    if (call.url === '/api/cart/add') return add(call);
    throw new Error(`Unexpected seckill I/O: ${call.url}`);
  } });
  // The native test harness's default navigateTo records URLs without callbacks.
  // Complete navigation explicitly so tests exercise the real success/fail path.
  r.uni.navigateTo = opts => { r.navigations.push(opts.url); opts.success?.({}); opts.complete?.({}); };
  return r;
}
const adds = r => r.calls.filter(call => call.url === '/api/cart/add');
const reads = r => r.calls.filter(call => call.url === '/api/seckill/detail/20');
const start = r => r.start({ id: '20' });

test('mobile seckill reads the selection catalogue and submits its activity SKU without quoting or paying', async () => {
  const r = setup(); try {
    await start(r); const p = r.checkout;
    assert.deepEqual(reads(r).map(call => call.data), [{ view: 'skus' }]);
    assert.equal(p.seckillId.value, 20); assert.equal(p.detail.value.product_id, 70);
    assert.equal(p.selectedSku.value, undefined); assert.equal(p.open.value, true); assert.equal(p.canBuy.value, false);
    await p.purchase(); assert.equal(adds(r).length, 0);
    p.choose('sale0002'); p.quantity.value = 3; assert.equal(p.canBuy.value, true);
    await p.purchase();
    assert.deepEqual(adds(r).map(call => call.data), [{ productId: 70, activityId: 20, type: 1, unique: 'sale0002', cartNum: 3, new: 1 }]);
    assert.deepEqual(r.navigations, ['/pages/order/confirm?mode=buy&cartId=901&type=1&seckillId=20']);
    assert.ok(r.calls.every(call => !/order\/(confirm|computed|create)|pay/.test(call.url)));
  } finally { r.stop(); }
});

test('invalid route identity never requests an ordinary product or a fabricated activity', async () => {
  for (const id of [undefined, '', '0', '-1', '20x', '1.5', '2147483648']) {
    const r = setup(); try {
      await r.start({ id }); assert.equal(r.calls.length, 0, `id ${id}`);
      assert.equal(r.checkout.detail.value, null); assert.equal(r.checkout.canBuy.value, false);
      assert.ok(r.checkout.error.value); await r.checkout.purchase(); assert.equal(adds(r).length, 0);
    } finally { r.stop(); }
  }
});

test('legacy, mismatched and ambiguous catalogues fail closed before selection or cart creation', async () => {
  const wrong = [
    data => ({ ...data, selection_only: false }), data => ({ ...data, seckill_id: 21 }),
    data => ({ ...data, type: 0 }), data => ({ ...data, skus: [data.skus[0], data.skus[0]] }),
    data => ({ ...data, skus: [{ ...data.skus[0], max_quantity: 7 }] }),
  ];
  for (const alter of wrong) {
    const r = setup({ detail: () => ({ data: alter(catalogue()) }) }); try {
      await start(r); assert.equal(r.checkout.detail.value, null); assert.equal(r.checkout.canBuy.value, false);
      assert.ok(r.checkout.error.value); await r.checkout.purchase(); assert.equal(adds(r).length, 0);
    } finally { r.stop(); }
  }
});

test('empty, sold-out, not-yet-open and expired catalogues cannot invent a purchasable specification', async () => {
  const unavailable = [
    data => ({ ...data, skus: [] }),
    data => ({ ...data, skus: data.skus.map(sku => ({ ...sku, stock: 0, max_quantity: 0 })) }),
    data => ({ ...data, schedule: { ...data.schedule, state: 'future' } }),
    data => ({ ...data, schedule: { ...data.schedule, starts_at: new Date(Date.now() - 120_000).toISOString(), ends_at: new Date(Date.now() - 60_000).toISOString() } }),
  ];
  for (const alter of unavailable) {
    const r = setup({ detail: () => ({ data: alter(catalogue()) }) }); try {
      await start(r); r.checkout.choose('sale0001'); assert.equal(r.checkout.canBuy.value, false);
      await r.checkout.purchase(); assert.equal(adds(r).length, 0); assert.equal(r.navigations.length, 0);
    } finally { r.stop(); }
  }
});

test('quantity and SKU validity are enforced against the selected activity row, not base stock', async () => {
  const r = setup(); try {
    await start(r); const p = r.checkout; p.choose('sale0001');
    for (const quantity of ['', '2', 0, -1, 1.5, '1.5', 3, Infinity, NaN]) {
      p.quantity.value = quantity; assert.equal(p.canBuy.value, false, `quantity ${quantity}`);
      await p.purchase(); assert.equal(adds(r).length, 0);
    }
    p.quantity.value = 2; assert.equal(p.canBuy.value, true);
    p.selected.value = 'base0001'; assert.equal(p.canBuy.value, false);
    await p.purchase(); assert.equal(adds(r).length, 0);
  } finally { r.stop(); }
});

test('concurrent purchase calls create one direct-purchase cart and ignore choice changes while buying', async () => {
  const pending = deferred(); const r = setup({ add: () => pending.promise }); try {
    await start(r); const p = r.checkout; p.choose('sale0001'); p.quantity.value = 2;
    const first = p.purchase(); await tick(); const second = p.purchase();
    p.choose('sale0002'); assert.equal(p.selected.value, 'sale0001');
    assert.equal(p.buying.value, true); assert.equal(adds(r).length, 1);
    pending.resolve({ data: { id: 901, cartNum: 2 } }); await Promise.all([first, second]);
    assert.equal(adds(r).length, 1); assert.equal(r.navigations.length, 1);
  } finally { r.stop(); }
});

test('anonymous login round-trip rereads the catalogue and preserves only the explicit SKU and quantity intent', async () => {
  let raw = catalogue(); const r = setup({ detail: () => ({ data: raw }) }); try {
    r.auth.clear(); await start(r); const p = r.checkout;
    p.choose('sale0002'); p.quantity.value = 3; await p.purchase();
    assert.deepEqual(r.navigations, ['/pages/auth/login']); assert.equal(adds(r).length, 0);
    r.hooks.onHide(); assert.equal(p.detail.value, null);
    r.auth.setLogin('synthetic-login-return', 11); await tick();
    raw = { ...catalogue(), skus: catalogue().skus.map(sku => ({ ...sku, catalog_price: '11.00' })) };
    r.hooks.onShow(); await tick();
    assert.equal(reads(r).length, 2); assert.equal(p.selected.value, 'sale0002'); assert.equal(Number(p.quantity.value), 3);
    assert.equal(p.selectedSku.value.catalog_price, '11.00'); assert.equal(p.canBuy.value, true);
    await p.purchase(); assert.equal(adds(r).length, 1); assert.equal(adds(r)[0].data.cartNum, 3);
  } finally { r.stop(); }
});

test('login return never silently reduces a requested quantity after the catalogue limit shrinks', async () => {
  let raw = catalogue(); const r = setup({ detail: () => ({ data: raw }) }); try {
    r.auth.clear(); await start(r); const p = r.checkout; p.choose('sale0002'); p.quantity.value = 4;
    await p.purchase(); r.hooks.onHide(); r.auth.setLogin('synthetic-login-return', 11); await tick();
    raw = { ...catalogue(), skus: catalogue().skus.map(sku => ({ ...sku, max_quantity: 1 })) };
    r.hooks.onShow(); await tick();
    assert.equal(p.selected.value, 'sale0002'); assert.equal(Number(p.quantity.value), 4);
    assert.equal(p.canBuy.value, false); await p.purchase(); assert.equal(adds(r).length, 0);
  } finally { r.stop(); }
});

test('an expired-token cart response uses the real request login flow and restores only its rejected purchase intent', async () => {
  let attempts = 0;
  const r = setup({ add: call => ++attempts === 1 ? { status: 410002, msg: 'Synthetic session expired' } : { data: { id: 901, cartNum: call.data.cartNum } } }); try {
    await start(r); const p = r.checkout; p.choose('sale0002'); p.quantity.value = 2;
    const previousVersion = r.auth.sessionVersion; await p.purchase();
    assert.equal(r.auth.isLoggedIn, false); assert.equal(r.auth.sessionVersion, previousVersion + 1);
    assert.equal(p.detail.value, null); assert.equal(p.prepared.value, null); assert.equal(p.canBuy.value, false);
    assert.deepEqual(r.navigations, ['/pages/auth/login']); assert.equal(adds(r).length, 1);
    r.hooks.onHide(); r.auth.setLogin('synthetic-renewed-token', 11); await tick();
    r.hooks.onShow(); await tick();
    assert.equal(reads(r).length, 2); assert.equal(p.selected.value, 'sale0002'); assert.equal(p.quantity.value, 2);
    assert.equal(p.canBuy.value, true); await p.purchase();
    assert.equal(adds(r).length, 2); assert.deepEqual(adds(r)[1].data, adds(r)[0].data);
    assert.equal(r.navigations.at(-1), '/pages/order/confirm?mode=buy&cartId=901&type=1&seckillId=20');
  } finally { r.stop(); }
});

test('ordinary hide and unload clear the catalogue; the newest visible refresh owns the published selection', async () => {
  const pending = deferred(); let delay = false;
  const r = setup({ detail: () => delay ? pending.promise : ({ data: catalogue() }) }); try {
    await start(r); const p = r.checkout; p.choose('sale0002'); p.quantity.value = 3;
    r.hooks.onHide(); assert.equal(p.visible.value, false); assert.equal(p.detail.value, null); assert.equal(p.canBuy.value, false);
    r.hooks.onShow(); await tick(); assert.equal(p.selected.value, ''); assert.equal(Number(p.quantity.value), 1);
    delay = true; const loading = p.load(); await tick(); r.hooks.onUnload();
    pending.resolve({ data: catalogue() }); await loading; await tick();
    assert.equal(p.detail.value, null); assert.equal(p.visible.value, false); assert.equal(p.canBuy.value, false);
    assert.equal(adds(r).length, 0); assert.equal(r.navigations.length, 0);
  } finally { r.stop(); }
  const older = deferred(), newer = deferred(); const queue = [];
  const refreshed = setup({ detail: () => queue.shift() ?? { data: catalogue() } }); try {
    await start(refreshed); queue.push(older.promise, newer.promise);
    const first = refreshed.checkout.load(); await tick();
    const second = refreshed.checkout.load(); await tick();
    newer.resolve({ data: { ...catalogue(), title: 'Newest catalogue' } }); await second;
    assert.equal(refreshed.checkout.detail.value.title, 'Newest catalogue');
    older.resolve({ data: { ...catalogue(), title: 'Outdated catalogue' } }); await first;
    assert.equal(refreshed.checkout.detail.value.title, 'Newest catalogue');
    assert.equal(refreshed.checkout.loading.value, false); assert.equal(reads(refreshed).length, 3);
  } finally { refreshed.stop(); }
});

test('a repeated login with identical uid and token invalidates in-flight reads and purchase results', async () => {
  for (const operation of ['read', 'purchase']) {
    const pending = deferred(); let delay = false;
    const r = setup({ detail: () => delay && operation === 'read' ? pending.promise : ({ data: catalogue() }), add: () => pending.promise }); try {
      await start(r); const p = r.checkout; p.choose('sale0001'); delay = true;
      const work = operation === 'read' ? p.load() : p.purchase(); await tick();
      assert.equal(operation === 'read' ? reads(r).length : adds(r).length, operation === 'read' ? 2 : 1);
      r.auth.setLogin(r.auth.token, r.auth.uid); await tick();
      assert.equal(p.detail.value, null); assert.equal(p.canBuy.value, false);
      pending.resolve(operation === 'read' ? { data: catalogue() } : { data: { id: 901, cartNum: 1 } });
      await work; await tick();
      assert.equal(p.detail.value, null); assert.equal(p.prepared.value, null); assert.equal(r.navigations.length, 0);
    } finally { r.stop(); }
  }
});

test('a hidden page ignores late cart creation; rejected or malformed cart results require fresh catalogue', async () => {
  const pending = deferred(); const hidden = setup({ add: () => pending.promise }); try {
    await start(hidden); hidden.checkout.choose('sale0001'); const purchase = hidden.checkout.purchase(); await tick();
    assert.equal(adds(hidden).length, 1); hidden.hooks.onHide();
    pending.resolve({ data: { id: 901, cartNum: 1 } }); await purchase;
    assert.equal(hidden.checkout.detail.value, null); assert.equal(hidden.checkout.prepared.value, null); assert.equal(hidden.navigations.length, 0);
  } finally { hidden.stop(); }
  for (const result of [{ status: 400, msg: 'Activity quota changed' }, { data: { id: 0, cartNum: 1 } }]) {
    const r = setup({ add: () => result }); try {
      await start(r); r.checkout.choose('sale0001'); await r.checkout.purchase();
      assert.equal(r.checkout.detail.value, null); assert.equal(r.checkout.canBuy.value, false); assert.ok(r.checkout.error.value);
      await r.checkout.purchase(); assert.equal(adds(r).length, 1); assert.equal(r.navigations.length, 0);
      await r.checkout.load(); assert.equal(reads(r).length, 2); assert.equal(r.checkout.canBuy.value, false);
      r.checkout.choose('sale0001'); assert.equal(r.checkout.canBuy.value, true);
    } finally { r.stop(); }
  }
});

test('failed checkout navigation retries the prepared cart without adding another and hide discards that shortcut', async () => {
  const r = setup(); try {
    await start(r); r.checkout.choose('sale0001'); let fail = true;
    r.uni.navigateTo = opts => { r.navigations.push(opts.url); if (fail) opts.fail?.({ errMsg: 'isolated navigation failure' }); else opts.success?.({}); };
    await r.checkout.purchase(); assert.equal(r.checkout.prepared.value, 901); assert.equal(adds(r).length, 1);
    await r.checkout.load(); assert.equal(reads(r).length, 1); assert.equal(r.checkout.prepared.value, 901);
    r.checkout.choose('sale0002'); assert.equal(r.checkout.selected.value, 'sale0001');
    fail = false; await r.checkout.purchase(); assert.equal(adds(r).length, 1);
    assert.deepEqual(r.navigations, Array(2).fill('/pages/order/confirm?mode=buy&cartId=901&type=1&seckillId=20'));
    r.hooks.onHide(); assert.equal(r.checkout.prepared.value, null); assert.equal(r.checkout.canBuy.value, false);
  } finally { r.stop(); }
});

test('anonymous navigation in flight blocks duplicate login and selection changes, but current failure allows retry', async () => {
  const r = setup(); try {
    r.auth.clear(); await start(r); const p = r.checkout; p.choose('sale0001');
    const callbacks = [];
    r.uni.navigateTo = opts => { r.navigations.push(opts.url); callbacks.push(opts); };
    await p.purchase(); assert.equal(p.navigating.value, true); assert.equal(p.canBuy.value, false);
    await p.purchase(); p.choose('sale0002'); await p.load();
    assert.equal(p.selected.value, 'sale0001'); assert.equal(reads(r).length, 1);
    assert.deepEqual(r.navigations, ['/pages/auth/login']); assert.equal(adds(r).length, 0);
    callbacks[0].fail({ errMsg: 'Synthetic navigation failure' });
    assert.equal(p.navigating.value, false); assert.equal(p.canBuy.value, true); assert.match(p.error.value, /登录页面打开失败/);
    await p.purchase(); assert.equal(callbacks.length, 2); assert.equal(p.navigating.value, true);
    callbacks[0].fail({ errMsg: 'Repeated obsolete callback' });
    assert.equal(p.navigating.value, true); assert.equal(p.canBuy.value, false);
    callbacks[1].fail({ errMsg: 'Current failure' }); assert.equal(p.navigating.value, false);
  } finally { r.stop(); }
});

test('successful cart creation and prepared retry share the native navigation gate until hide, not promise completion', async () => {
  const r = setup(); try {
    await start(r); const p = r.checkout; p.choose('sale0001');
    const callbacks = [];
    r.uni.navigateTo = opts => { r.navigations.push(opts.url); callbacks.push(opts); };
    await p.purchase(); assert.equal(p.buying.value, false); assert.equal(p.navigating.value, true); assert.equal(p.prepared.value, 901);
    await p.purchase(); assert.equal(adds(r).length, 1); assert.equal(callbacks.length, 1);
    callbacks[0].fail({ errMsg: 'Synthetic navigation failure' });
    assert.equal(p.navigating.value, false); assert.equal(p.prepared.value, 901); assert.equal(p.canBuy.value, true);
    await p.purchase(); assert.equal(adds(r).length, 1); assert.equal(callbacks.length, 2);
    callbacks[0].fail({ errMsg: 'Obsolete failure' }); assert.equal(p.navigating.value, true);
    callbacks[1].success?.({}); callbacks[1].complete?.({});
    await p.purchase(); assert.equal(callbacks.length, 2); assert.equal(p.navigating.value, true);
    assert.deepEqual(r.navigations, Array(2).fill('/pages/order/confirm?mode=buy&cartId=901&type=1&seckillId=20'));
    r.hooks.onHide(); assert.equal(p.navigating.value, false); assert.equal(p.prepared.value, null);
  } finally { r.stop(); }
});

test('old native callbacks cannot unlock or contaminate a new navigation after hide or session replacement', async () => {
  const r = setup(); try {
    r.auth.clear(); await start(r); const p = r.checkout; p.choose('sale0002'); p.quantity.value = 2;
    const callbacks = [];
    r.uni.navigateTo = opts => { r.navigations.push(opts.url); callbacks.push(opts); };
    await p.purchase(); assert.equal(callbacks.length, 1);
    r.hooks.onHide(); assert.equal(p.navigating.value, false);
    r.auth.setLogin('synthetic-login-return', 11); r.hooks.onShow(); await tick();
    assert.equal(p.selected.value, 'sale0002'); await p.purchase(); assert.equal(callbacks.length, 2);
    callbacks[0].fail({ errMsg: 'Old login failure' });
    assert.equal(p.navigating.value, true); assert.equal(p.canBuy.value, false); assert.equal(p.error.value, '');
    r.auth.setLogin(r.auth.token, r.auth.uid); assert.equal(p.navigating.value, false); assert.equal(p.prepared.value, null);
    await p.load(); p.choose('sale0001'); await p.purchase(); assert.equal(callbacks.length, 3);
    callbacks[1].fail({ errMsg: 'Previous identity navigation failed' });
    assert.equal(p.navigating.value, true); assert.equal(p.canBuy.value, false); assert.equal(p.error.value, '');
    callbacks[2].fail({ errMsg: 'Current identity navigation failed' });
    assert.equal(p.navigating.value, false); assert.equal(p.canBuy.value, true); assert.equal(p.prepared.value, 901);
    assert.equal(adds(r).length, 2);
  } finally { r.stop(); }
});

function slotIndex() {
  return { seckillTime: [
    { id: 4, start_time: '09:00', end_time: '12:00', status: 1, state: '正在抢购' },
    { id: 8, start_time: '12:00', end_time: '15:00', status: 0, state: '即将开始' },
  ], seckillTimeIndex: 0 };
}
const listItem = id => ({ id, product_id: 70, title: `Isolated activity ${id}`, image: '', price: 10, ot_price: 12 });
function activitySetup({ index = () => ({ data: slotIndex() }), list = call => ({ data:
  call.url === '/api/seckill/list/4' && call.data.page === 1 ? Array.from({ length: 20 }, (_, i) => listItem(20 + i)) : [listItem(call.url.endsWith('/8') ? 80 : 40)],
}) } = {}) {
  return runtime({ component: 'pages/activity/index.vue', send: call => {
    if (call.url === '/api/seckill/index') return index(call);
    if (['/api/seckill/list/4', '/api/seckill/list/8'].includes(call.url)) return list(call);
    throw new Error(`Unexpected activity-page I/O: ${call.url}`);
  } });
}
const pageReads = r => r.calls.filter(call => call.url.startsWith('/api/seckill/list/'));
const indexReads = r => r.calls.filter(call => call.url === '/api/seckill/index');

test('actual activity page selects the slot ID, pages with limit 20 and navigates only a current activity item', async () => {
  const r = activitySetup(); try {
    await r.start(); const p = r.checkout;
    assert.equal(p.active.value, 'seckill'); assert.equal(p.selectedTime.value, 4); assert.equal(p.seckillPage.value, 1);
    assert.deepEqual(p.slots.value.map(slot => ({ id: slot.id, start: slot.start_time, end: slot.end_time })), [
      { id: 4, start: '09:00', end: '12:00' }, { id: 8, start: '12:00', end: '15:00' },
    ]);
    assert.deepEqual(pageReads(r), [{ url: '/api/seckill/list/4', data: { page: 1, limit: 20 } }]);
    assert.equal(p.seckillList.value.length, 20); assert.equal(p.seckillLoading.value, false); assert.equal(p.seckillError.value, '');
    await p.loadSeckill(p.selectedTime.value, 2);
    assert.equal(p.seckillPage.value, 2); assert.deepEqual(p.seckillList.value.map(item => item.id), [40]);
    assert.deepEqual(pageReads(r).at(-1), { url: '/api/seckill/list/4', data: { page: 2, limit: 20 } });
    await p.loadSeckill(8); assert.equal(p.selectedTime.value, 8); assert.equal(p.seckillPage.value, 1);
    assert.deepEqual(pageReads(r).at(-1), { url: '/api/seckill/list/8', data: { page: 1, limit: 20 } });
    p.goSeckill(40); p.goSeckill(999); assert.equal(r.navigations.length, 0);
    p.goSeckill(80); assert.deepEqual(r.navigations, ['/pages/activity/seckillDetail?id=80']);
    assert.equal(indexReads(r).length, 1); assert.ok(r.calls.every(call => !/cart\/add|order\/|pay/.test(call.url)));
  } finally { r.stop(); }
});

test('late success or failure for a previous time slot cannot replace the newly selected slot', async () => {
  for (const obsolete of [{ data: [listItem(400)] }, { status: 500, msg: 'Obsolete slot failure' }]) {
    const pending = deferred(); const r = activitySetup({ list: call => call.url === '/api/seckill/list/4' && call.data.page === 2
      ? pending.promise : { data: [listItem(call.url.endsWith('/8') ? 80 : 20)] } }); try {
      await r.start(); const p = r.checkout;
      const oldRequest = p.loadSeckill(4, 2); await tick(); assert.equal(pageReads(r).length, 2);
      const currentRequest = p.loadSeckill(8); await currentRequest;
      assert.equal(p.selectedTime.value, 8); assert.equal(p.seckillPage.value, 1);
      assert.deepEqual(p.seckillList.value.map(item => item.id), [80]); assert.equal(p.seckillLoading.value, false);
      pending.resolve(obsolete); await oldRequest;
      assert.equal(p.selectedTime.value, 8); assert.equal(p.seckillPage.value, 1);
      assert.deepEqual(p.seckillList.value.map(item => item.id), [80]); assert.equal(p.seckillError.value, '');
      assert.equal(p.seckillLoading.value, false); p.goSeckill(400); assert.equal(r.navigations.length, 0);
    } finally { r.stop(); }
  }
});

test('list failures remain errors, retain their page for retry and reject the legacy index envelope', async () => {
  for (const failure of [{ transport: 'Synthetic list timeout' }, { data: [{ ...listItem(40), price: -1 }] }]) {
    let failedOnce = false;
    const r = activitySetup({ list: call => {
      if (call.data.page === 2 && !failedOnce) { failedOnce = true; return failure; }
      return { data: [listItem(call.data.page === 2 ? 40 : 20)] };
    } }); try {
      await r.start(); const p = r.checkout; await p.loadSeckill(4, 2);
      assert.equal(p.selectedTime.value, 4); assert.equal(p.seckillPage.value, 2); assert.equal(p.seckillLoading.value, false);
      assert.ok(p.seckillError.value); assert.deepEqual(p.seckillList.value, []); p.goSeckill(20); assert.equal(r.navigations.length, 0);
      await p.loadSeckill(p.selectedTime.value, p.seckillPage.value);
      assert.equal(p.seckillError.value, ''); assert.equal(p.seckillPage.value, 2); assert.deepEqual(p.seckillList.value.map(item => item.id), [40]);
      assert.deepEqual(pageReads(r).map(call => call.data), [{ page: 1, limit: 20 }, { page: 2, limit: 20 }, { page: 2, limit: 20 }]);
    } finally { r.stop(); }
  }
  const invalid = activitySetup({ index: () => ({ data: slotIndex().seckillTime }) }); try {
    await invalid.start(); assert.ok(invalid.checkout.seckillError.value); assert.equal(invalid.checkout.seckillLoading.value, false);
    assert.deepEqual(invalid.checkout.slots.value, []); assert.equal(pageReads(invalid).length, 0);
  } finally { invalid.stop(); }
});

test('hide, tab switch and unload invalidate activity reads and navigation; reentry fetches a new slot index', async () => {
  for (const boundary of ['hide', 'tab', 'unload']) {
    const pending = deferred(); const r = activitySetup({ list: call => call.data.page === 2
      ? pending.promise : { data: [listItem(20)] } }); try {
      await r.start(); const p = r.checkout; const oldRequest = p.loadSeckill(4, 2); await tick();
      assert.equal(pageReads(r).length, 2);
      if (boundary === 'tab') p.switchTab('lottery');
      else if (boundary === 'hide') r.hooks.onHide();
      else r.hooks.onUnload();
      assert.deepEqual(p.seckillList.value, []); assert.equal(p.seckillLoading.value, false);
      pending.resolve({ data: [listItem(400)] }); await oldRequest;
      assert.deepEqual(p.seckillList.value, []); assert.equal(p.seckillLoading.value, false);
      p.goSeckill(20); p.goSeckill(400); assert.equal(r.navigations.length, 0);
      const before = r.calls.length; await p.loadSeckill(4); assert.equal(r.calls.length, before);
      if (boundary === 'unload') continue;
      if (boundary === 'tab') p.switchTab('seckill'); else r.hooks.onShow();
      await tick(); assert.equal(indexReads(r).length, 2); assert.equal(p.selectedTime.value, 4); assert.equal(p.seckillPage.value, 1);
      assert.deepEqual(p.seckillList.value.map(item => item.id), [20]); assert.equal(p.seckillError.value, '');
      p.goSeckill(20); assert.deepEqual(r.navigations, ['/pages/activity/seckillDetail?id=20']);
    } finally { r.stop(); }
  }
});
