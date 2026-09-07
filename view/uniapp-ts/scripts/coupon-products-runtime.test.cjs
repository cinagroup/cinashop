const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
const product = { id: 70, store_name: '范围商品', image: '/api/qa/image.svg', catalog_price: '10.00' };
const page = (id = 42, list = [product], cursor = null, options = {}) => ({ coupon_id: id, coupon_title: '测试券', scope_type: 2, scope_only: true, list,
  next_cursor: cursor === null ? null : `cursor${cursor}`, keyword: '', sort: 'recommended', scanned_count: cursor && !list.length ? 500 : list.length,
  scan_limit_reached: !!cursor && !list.length, ...options });
const start = async send => { const r = runtime({ feature: 'useCouponProducts', send }); await r.start({ couponId: '42' }); return r; };
const entry = (id = 222) => ({ id, name: '范围<script>literal</script>', ancestors: [], hierarchy_complete: true });
const scope = (entries = [entry()], next_cursor = null, total_count = 1) => ({ coupon_id: 42, coupon_title: '测试券', scope_type: 2, scope_only: true, entries, next_cursor, total_count, scope_version: 'a'.repeat(64) });

test('configuration pagination is independent, on demand and retryable with literal names and exact cursors', async () => {
  let fail = true;
  const r = await start(call => {
    if (call.data.view === 'search') return { data: page(42, [], 100) };
    assert.equal(call.data.view, 'scope');
    if (call.data.before && fail) { fail = false; return { transport: 'scope offline' }; }
    return { data: call.data.before ? scope([entry(221)], null, 2) : scope([entry()], 222, 2) };
  });
  assert.equal(r.calls.length, 1); await r.checkout.loadScope(); assert.equal(r.checkout.scopeState.value.entries[0].name, '范围<script>literal</script>');
  await r.checkout.loadScope(true); assert.match(r.checkout.scopeState.value.error, /offline/); assert.equal(r.checkout.blocked.value, true);
  await r.checkout.loadScope(true); assert.deepEqual(r.calls.map(call => call.data.before), [undefined, undefined, 222, 222]);
  assert.equal(r.checkout.scopeState.value.entries.length, 2); assert.equal(r.checkout.state.value.nextCursor, 'cursor100');
  await r.checkout.load(); assert.equal(r.checkout.scopeState.value.loaded, false); r.stop();
});
test('scope failures and changed configuration totals never silently mix pages', async () => {
  let data = scope([entry()], 222, 2);
  const r = await start(call => ({ data: call.data.view === 'scope' ? data : page() })); await r.checkout.loadScope();
  data = scope([entry(221)], null, 3); await r.checkout.loadScope(true); assert.match(r.checkout.scopeState.value.error, /已变化/);
  assert.equal(r.checkout.scopeState.value.entries.length, 1);
  data = { ...scope([entry(221)], null, 2), scope_version: 'b'.repeat(64) }; await r.checkout.loadScope(true); assert.match(r.checkout.scopeState.value.error, /已变化/);
  assert.equal(r.checkout.scopeState.value.entries.length, 1);
  for (const bad of [{ ...scope(), coupon_id: 22 }, { ...scope(), coupon_title: '其他券' }, { ...scope(), scope_type: 3 }, scope([entry(), entry()], null, 2),
    scope([{ ...entry(), ancestors: [{ id: 1, name: 'unexpected product ancestor' }] }]), scope([{ ...entry(), name: 123 }]), scope([], 222, 1)]) {
    data = bad; await r.checkout.loadScope(); assert.ok(r.checkout.scopeState.value.error); assert.deepEqual(r.checkout.scopeState.value.entries, []);
  }
  r.stop();
});
test('scope metadata is discarded after hide, unload, same-token renewal and refresh even when old responses arrive later', async () => {
  for (const action of ['onHide', 'onUnload', 'renew', 'refresh']) {
    const late = deferred(); let hold = true;
    const r = await start(call => call.data.view === 'scope' && hold ? late.promise : { data: call.data.view === 'scope' ? scope() : page() });
    const pending = r.checkout.loadScope(); await tick();
    if (action === 'renew') r.auth.setLogin(r.auth.token, r.auth.uid);
    else if (action === 'refresh') await r.checkout.load(); else r.hooks[action]();
    late.resolve({ data: scope() }); await pending; assert.deepEqual(r.checkout.scopeState.value.entries, []);
    assert.equal(r.checkout.scopeState.value.error, ''); r.stop();
  }
});
test('scope adapter validates IDs and auth before I/O and malformed names cannot become navigation targets', async () => {
  const r = await start(call => ({ data: call.data.view === 'scope' ? scope([{ ...entry(), name: null, hierarchy_complete: false }]) : page() }));
  await r.checkout.loadScope(); assert.equal(r.checkout.scopeState.value.entries[0].name, null); assert.deepEqual(r.navigations, []);
  const api = r.load(path.resolve(__dirname, '../src/api/couponProducts.ts')).apiCouponScopeDescription, count = r.calls.length;
  await assert.rejects(api(0)); await assert.rejects(api(42, -1)); r.auth.clear(); await assert.rejects(api(42), /请先登录/);
  assert.equal(r.calls.length, count); r.stop();
});

test('scope products use the owned coupon ID and continue an empty scanned page, retrying the identical cursor', async () => {
  let fail = true;
  const r = await start(call => {
    assert.equal(call.url, '/api/coupons/user/42/products'); assert.equal(call.data.limit, 20);
    assert.equal(call.data.view, 'search'); assert.equal(call.data.before, undefined);
    if (!call.data.cursor) return { data: page(42, [], 100) };
    if (fail) { fail = false; return { transport: 'offline' }; }
    return { data: page() };
  });
  assert.equal(r.checkout.state.value.loaded, true); assert.deepEqual(r.checkout.state.value.list, []); assert.equal(r.checkout.state.value.nextCursor, 'cursor100');
  assert.equal(r.checkout.state.value.scanLimitReached, true); assert.equal(r.checkout.state.value.totalScanned, 500);
  await r.checkout.load(true); assert.match(r.checkout.error.value, /offline/); assert.equal(r.checkout.state.value.nextCursor, 'cursor100');
  await r.checkout.load(true); assert.deepEqual(r.calls.map(c => c.data.cursor), [undefined, 'cursor100', 'cursor100']);
  assert.equal(r.checkout.state.value.totalScanned, 501);
  assert.equal(r.checkout.state.value.list[0].catalogPrice, '10.00'); r.checkout.openProduct(999); assert.deepEqual(r.navigations, []);
  r.checkout.openProduct(70); assert.deepEqual(r.navigations, ['/pages/goods/detail?id=70']); r.stop();
});
test('double append is bounded and refresh invalidates late success or failure without preserving old rows', async () => {
  const late = deferred(); let hold = false, fail = false;
  const r = await start(call => hold && call.data.cursor ? late.promise : fail ? { transport: 'refresh offline' } : { data: page(42, [product], 70) });
  hold = true; const old = r.checkout.load(true); await tick(); await r.checkout.load(true); assert.equal(r.calls.length, 2);
  fail = true; await r.checkout.load(); assert.deepEqual(r.checkout.state.value.list, []); assert.equal(r.checkout.state.value.nextCursor, null);
  late.resolve({ data: page(42, [{ ...product, id: 60 }]) }); await old; assert.deepEqual(r.checkout.state.value.list, []); assert.match(r.checkout.error.value, /refresh offline/); r.stop();
});
for (const hook of ['onHide', 'onUnload']) test(`${hook} clears scope rows and prevents late responses or stale product navigation`, async () => {
  const late = deferred(); let hold = false;
  const r = await start(() => hold ? late.promise : { data: page() }); hold = true; const old = r.checkout.load(); await tick();
  r.hooks[hook](); late.resolve({ data: page() }); await old;
  assert.deepEqual(r.checkout.state.value.list, []); r.checkout.openProduct(70); assert.deepEqual(r.navigations, []); r.stop();
});
test('an identity change removes scope state synchronously, including a renewed identical token', async () => {
  const late = deferred(); let hold = false;
  const r = await start(() => hold ? late.promise : { data: page() }); hold = true; const old = r.checkout.load(); await tick();
  r.auth.setLogin(r.auth.token, r.auth.uid); assert.deepEqual(r.checkout.state.value.list, []); assert.match(r.checkout.error.value, /登录状态已变化/);
  late.resolve({ data: page() }); await old; assert.deepEqual(r.checkout.state.value.list, []); r.checkout.openProduct(70); assert.deepEqual(r.navigations, []); r.stop();
});
test('missing, repeated or malformed coupon IDs fail closed without a catalogue fallback or any I/O', async () => {
  for (const couponId of [undefined, '', '0', '-1', '1.0', '9007199254740992', ['42', '43']]) {
    const r = runtime({ feature: 'useCouponProducts', send: () => { throw Error('must not request'); } });
    await r.start({ couponId }); assert.match(r.checkout.error.value, /标识无效/); assert.equal(r.calls.length, 0); r.stop();
  }
});
test('bad scope metadata, duplicate rows and non-progressing cursors never become visible goods', async () => {
  let data = page(); const r = await start(() => ({ data }));
  for (const bad of [{ ...page(), coupon_id: 99 }, { ...page(), scope_only: false }, { ...page(), next_cursor: 71 },
    { ...page(), scope_type: 4 }, page(42, [product, product]), page(42, [{ ...product, catalog_price: '-1' }])]) {
    data = bad; await r.checkout.load(); assert.ok(r.checkout.error.value); assert.deepEqual(r.checkout.state.value.list, []);
  }
  data = page(42, [], 100); await r.checkout.load(); data = page(42, [], 100); await r.checkout.load(true); assert.ok(r.checkout.error.value);
  r.stop();
});
test('direct adapter rejects unauthenticated and invalid requests before I/O and removes unsafe image URLs', async () => {
  const r = await start(() => ({ data: page(42, [{ ...product, image: 'javascript:alert(1)' }]) }));
  assert.equal(r.checkout.state.value.list[0].image, ''); const api = r.load(path.resolve(__dirname, '../src/api/couponProducts.ts')).apiCouponProducts;
  const count = r.calls.length; await assert.rejects(api(-1)); await assert.rejects(api(42, -1));
  r.auth.clear(); await assert.rejects(api(42), /请先登录/); assert.equal(r.calls.length, count); r.stop();
});

test('search submits normalized keywords and all seven sorts, preserving server order and clearing scope metadata', async () => {
  const r = await start(call => ({ data: call.data.view === 'scope' ? scope() : page(42, [product, { ...product, id: 90 }], null, { keyword: call.data.keyword, sort: call.data.sort }) }));
  await r.checkout.loadScope(); r.checkout.keyword.value = '  中文%_\\  ';
  for (const option of r.checkout.sorts) {
    await r.checkout.applySearch(option.value); assert.equal(r.checkout.error.value, '');
    assert.deepEqual(r.calls.at(-1).data, { view: 'search', limit: 20, keyword: '中文%_\\', sort: option.value });
    assert.deepEqual(r.checkout.state.value.list.map(row => row.id), [70, 90]); assert.equal(r.checkout.scopeState.value.loaded, false);
  }
  await r.checkout.clearSearch(); assert.equal(r.checkout.state.value.keyword, ''); assert.equal(r.checkout.filters.value.sort, 'sales_asc'); r.stop();
});
test('search replacement ignores late success and failure while new results stay navigable', async () => {
  for (const outcome of ['success', 'failure']) {
    const late = deferred();
    const r = await start(call => call.data.keyword === 'old' ? late.promise : { data: page(42, [{ ...product, id: 90 }], null, { keyword: call.data.keyword, sort: call.data.sort }) });
    r.checkout.keyword.value = 'old'; const pending = r.checkout.applySearch(); await tick();
    r.checkout.keyword.value = 'new'; await r.checkout.applySearch('price_asc');
    late.resolve(outcome === 'success' ? { data: page(42, [product], null, { keyword: 'old' }) } : { transport: 'old offline' });
    await pending; assert.equal(r.checkout.state.value.keyword, 'new'); assert.equal(r.checkout.error.value, '');
    assert.deepEqual(r.checkout.state.value.list.map(row => row.id), [90]); r.checkout.openProduct(90); assert.deepEqual(r.navigations, ['/pages/goods/detail?id=90']);
    r.auth.setLogin(r.auth.token, r.auth.uid); assert.equal(r.checkout.keyword.value, ''); assert.deepEqual(r.checkout.filters.value, { keyword: '', sort: 'recommended' }); r.stop();
  }
});
test('search pagination retries applied filters unchanged and rejects repeated catalogue rows', async () => {
  let fail = true, duplicate = false;
  const r = await start(call => {
    if (call.data.cursor && fail) { fail = false; return { transport: 'offline search' }; }
    return { data: page(42, [call.data.cursor && !duplicate ? { ...product, id: 90 } : product], call.data.cursor ? null : 'A', { keyword: call.data.keyword, sort: call.data.sort }) };
  });
  r.checkout.keyword.value = 'applied'; await r.checkout.applySearch('price_desc'); r.checkout.keyword.value = 'draft';
  await r.checkout.load(true); assert.match(r.checkout.error.value, /offline/); assert.equal(r.checkout.blocked.value, true);
  await r.checkout.load(true); assert.deepEqual(r.calls.at(-1).data, r.calls.at(-2).data); assert.equal(r.calls.at(-1).data.keyword, 'applied');
  assert.deepEqual(r.checkout.state.value.list.map(row => row.id), [70, 90]); duplicate = true;
  await r.checkout.load(); await r.checkout.load(true); assert.match(r.checkout.error.value, /已变化/); assert.deepEqual(r.checkout.state.value.list.map(row => row.id), [70]);
  r.checkout.openProduct(70); assert.deepEqual(r.navigations, []); r.stop();
});
test('search rejects invalid requests before I/O, bad response echoes and impossible scan counts', async () => {
  let change = {};
  const r = await start(call => ({ data: page(42, [product], null, { keyword: call.data.keyword, sort: call.data.sort, ...change }) }));
  const api = r.load(path.resolve(__dirname, '../src/api/couponProducts.ts')).apiCouponProductSearch, count = r.calls.length;
  for (const options of [{ keyword: 'x'.repeat(101), sort: 'newest' }, { keyword: '\n', sort: 'newest' }, { keyword: '', sort: 'wrong' }]) await assert.rejects(api(42, options));
  for (const cursor of [1, '', 'x'.repeat(513), '+/']) await assert.rejects(api(42, { keyword: '', sort: 'recommended' }, cursor));
  assert.equal(r.calls.length, count);
  for (const bad of [{ keyword: 'wrong' }, { sort: 'newest' }, { scanned_count: -1 }, { scanned_count: 501 }, { scanned_count: 0 }, { scan_limit_reached: true }]) {
    change = bad; await r.checkout.load(); assert.ok(r.checkout.error.value); assert.deepEqual(r.checkout.state.value.list, []);
  }
  r.auth.clear(); await assert.rejects(api(42, { keyword: '', sort: 'recommended' }), /请先登录/); r.stop();
});
