const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
const item = (id, type = 2) => ({ id, store_name: `预售${id}`, image: '/safe.svg', price: '80.25', is_presale_product: 1,
  presale_pay_status: type, presale_start_time: 1000, presale_end_time: 2000, presale_day: 7, brand_name: '品牌', store_label: [] });
const response = (page, type = 2, count = 9) => ({ data: { list: Array.from({ length: Math.min(8, Math.max(0, count - (page - 1) * 8)) }, (_, i) => item(70 + (page - 1) * 8 + i, type)), count } });
function setup(send = c => response(c.data.page, c.data.time_type), component) {
  return runtime({ feature: 'usePresaleCatalog', component, send: c => { assert.equal(c.url, '/api/presale/list'); return send(c); } });
}
test('actual SFC uses the private catalogue adapter, defaults active, appends once, and opens only base-product detail', async () => {
  const r = setup(undefined, 'pages/activity/presale.vue'); try {
    await r.start(); const p = r.checkout;
    assert.equal(p.state.list.length, 8); assert.deepEqual(r.calls[0].data, { time_type: 2, page: 1, limit: 8 });
    r.hooks.onReachBottom(); r.hooks.onReachBottom(); await tick();
    assert.equal(p.state.list.length, 9); assert.equal(p.state.page, 2); assert.equal(r.calls.length, 2);
    r.hooks.onReachBottom(); await tick(); assert.equal(r.calls.length, 2);
    p.openProduct(999); p.openProduct(78); p.openProduct(70);
    assert.deepEqual(r.navigations, ['/pages/activity/presaleDetail?id=78']); assert.equal(r.calls.length, 2);
  } finally { r.stop(); }
});
test('all three source time filters reset page; future and ended rows remain browseable', async () => {
  const r = setup(); try { await r.start(); const p = r.checkout;
    for (const type of [1, 3, 2]) {
      await p.select(type); assert.equal(p.state.page, 1); assert.equal(p.state.type, type); assert.equal(p.state.list.length, 8);
      assert.deepEqual(r.calls.at(-1).data, { time_type: type, page: 1, limit: 8 });
    }
    await p.select(3); p.openProduct(70); assert.equal(r.navigations[0], '/pages/activity/presaleDetail?id=70');
  } finally { r.stop(); }
});
test('append failure retains rows/page, bottom does not loop and explicit retry uses the same page', async () => {
  let failed = true; const r = setup(c => c.data.page === 2 && failed ? { transport: 'synthetic network failure' } : response(c.data.page));
  try { await r.start(); const p = r.checkout; await p.load(true); assert.equal(p.state.page, 1); assert.equal(p.state.list.length, 8); assert.ok(p.state.error);
    r.hooks.onReachBottom(); await tick(); assert.equal(r.calls.length, 2);
    failed = false; await p.load(true); assert.equal(p.state.page, 2); assert.equal(p.state.error, '');
    assert.deepEqual(r.calls.map(c => c.data.page), [1, 2, 2]);
  } finally { r.stop(); }
});
for (const boundary of ['onHide', 'onUnload', 'identity', 'filter', 'refresh']) test(`late first-page responses cannot repopulate across ${boundary}`, async () => {
  const gate = deferred(); let first = true;
  const r = setup(c => first ? (first = false, gate.promise) : response(c.data.page, c.data.time_type));
  try { await r.start(); const p = r.checkout;
    if (boundary === 'identity') r.auth.setLogin('new-owner', 22);
    else if (boundary === 'filter') await p.select(3);
    else if (boundary === 'refresh') await p.load();
    else r.hooks[boundary]();
    gate.resolve(response(1)); await tick();
    assert.equal(p.state.loading, false);
    if (boundary === 'filter') assert.equal(p.state.type, 3);
    else if (boundary !== 'refresh') assert.deepEqual(p.state.list, []);
    assert.deepEqual(r.navigations, []);
  } finally { gate.resolve(response(1)); r.stop(); }
});
test('account replacement clears visible member rows synchronously and requires explicit refresh', async () => {
  const r = setup(); try { await r.start(); const p = r.checkout;
    r.auth.clear(); assert.deepEqual(p.state.list, []); p.openProduct(70); assert.deepEqual(r.navigations, []);
    await tick(); assert.equal(r.calls.length, 1); await p.load(); assert.equal(r.calls.length, 2); assert.equal(p.state.list.length, 8);
    r.hooks.onHide(); assert.deepEqual(p.state.list, []); r.hooks.onShow(); await tick(); assert.equal(r.calls.length, 3);
  } finally { r.stop(); }
});
test('late failed navigation cannot unlock a newer native navigation and hidden page cannot open old rows', async () => {
  const r = setup(), callbacks = []; r.uni.navigateTo = o => callbacks.push(o);
  try { await r.start(); const p = r.checkout; p.openProduct(70); callbacks[0].fail(); assert.equal(p.navigating.value, false);
    p.openProduct(71); callbacks[0].fail(); assert.equal(p.navigating.value, true);
    r.hooks.onHide(); callbacks[1].fail(); assert.equal(r.toasts.length, 1); p.openProduct(70); assert.equal(callbacks.length, 2);
  } finally { r.stop(); }
});
test('duplicate or shifted append snapshots demand refresh without changing committed page', async () => {
  for (const change of [d => { d.data.list[0].id = 70; }, d => { d.data.count = 10; d.data.list.push(item(79)); }]) {
    const r = setup(c => { const d = response(c.data.page); if (c.data.page === 2) change(d); return d; });
    try { await r.start(); await r.checkout.load(true); assert.equal(r.checkout.state.page, 1); assert.equal(r.checkout.state.list.length, 8); assert.match(r.checkout.state.error, /已变化/); }
    finally { r.stop(); }
  }
});
test('shared parser bounds shape, identity, schedule and decoration without trusting URLs or HTML', () => {
  const r = setup(); try {
    const { parsePresaleCatalog, presaleCatalogQuery, presaleBeijingTime } = r.load(path.resolve(__dirname, '../../common/presaleCatalog.ts'));
    for (const change of [d => { d.count = -1; }, d => { d.list.push(item(71)); }, d => { d.list[0].id = '70'; }, d => { d.list[0].price = 80.25; },
      d => { d.list[0].presale_pay_status = 1; }, d => { d.list[0].is_presale_product = 0; }, d => { d.list[0].presale_end_time = 1; }, d => { d.list[0].presale_day = -1; }]) {
      const d = response(1, 2, 1).data; change(d); assert.throws(() => parsePresaleCatalog(d, 2, 1));
    }
    for (const type of [0, 4, '2', NaN]) assert.throws(() => presaleCatalogQuery(type, 1));
    for (const page of [0, 0.5, '1', 2147483647]) assert.throws(() => presaleCatalogQuery(2, page));
    const d = response(1, 2, 1).data; d.list[0].image = 'javascript:alert(1)';
    d.list[0].store_label = [{ id: 1, label_name: '<b>文本</b>', icon: '//unsafe.invalid/a', color: 'url(https://unsafe.invalid/a)', bg_color: '#abc', border_color: '#AABBCC' }];
    const parsed = parsePresaleCatalog(d, 2, 1).list[0]; assert.equal(parsed.image, ''); assert.equal(parsed.labels[0].name, '<b>文本</b>');
    assert.deepEqual(parsed.labels[0], { id: 1, name: '<b>文本</b>', icon: '', color: '#855224', background: '#abc', border: '#AABBCC' });
    assert.equal(presaleBeijingTime(0), '1970-01-01 08:00');
  } finally { r.stop(); }
});
