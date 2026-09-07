const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
const product = { id: 70, store_name: '范围商品', image: '/api/qa/image.svg', catalog_price: '10.00' };
const page = (id = 42, list = [product], next_cursor = null) => ({ coupon_id: id, coupon_title: '测试券', scope_type: 2, scope_only: true, list, next_cursor });
const start = async send => { const r = runtime({ feature: 'useCouponProducts', send }); await r.start({ couponId: '42' }); return r; };
const entry = (id = 222) => ({ id, name: '范围<script>literal</script>', ancestors: [], hierarchy_complete: true });
const scope = (entries = [entry()], next_cursor = null, total_count = 1) => ({ coupon_id: 42, coupon_title: '测试券', scope_type: 2, scope_only: true, entries, next_cursor, total_count, scope_version: 'a'.repeat(64) });

test('configuration pagination is independent, on demand and retryable with literal names and exact cursors', async () => {
  let fail = true;
  const r = await start(call => {
    if (!call.data.view) return { data: page(42, [], 100) };
    assert.equal(call.data.view, 'scope');
    if (call.data.before && fail) { fail = false; return { transport: 'scope offline' }; }
    return { data: call.data.before ? scope([entry(221)], null, 2) : scope([entry()], 222, 2) };
  });
  assert.equal(r.calls.length, 1); await r.checkout.loadScope(); assert.equal(r.checkout.scopeState.value.entries[0].name, '范围<script>literal</script>');
  await r.checkout.loadScope(true); assert.match(r.checkout.scopeState.value.error, /offline/); assert.equal(r.checkout.blocked.value, true);
  await r.checkout.loadScope(true); assert.deepEqual(r.calls.map(call => call.data.before), [undefined, undefined, 222, 222]);
  assert.equal(r.checkout.scopeState.value.entries.length, 2); assert.equal(r.checkout.state.value.nextCursor, 100);
  await r.checkout.load(); assert.equal(r.checkout.scopeState.value.loaded, false); r.stop();
});
test('scope failures and changed configuration totals never silently mix pages', async () => {
  let data = scope([entry()], 222, 2);
  const r = await start(call => ({ data: call.data.view ? data : page() })); await r.checkout.loadScope();
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
    const r = await start(call => call.data.view && hold ? late.promise : { data: call.data.view ? scope() : page() });
    const pending = r.checkout.loadScope(); await tick();
    if (action === 'renew') r.auth.setLogin(r.auth.token, r.auth.uid);
    else if (action === 'refresh') await r.checkout.load(); else r.hooks[action]();
    late.resolve({ data: scope() }); await pending; assert.deepEqual(r.checkout.scopeState.value.entries, []);
    assert.equal(r.checkout.scopeState.value.error, ''); r.stop();
  }
});
test('scope adapter validates IDs and auth before I/O and malformed names cannot become navigation targets', async () => {
  const r = await start(call => ({ data: call.data.view ? scope([{ ...entry(), name: null, hierarchy_complete: false }]) : page() }));
  await r.checkout.loadScope(); assert.equal(r.checkout.scopeState.value.entries[0].name, null); assert.deepEqual(r.navigations, []);
  const api = r.load(path.resolve(__dirname, '../src/api/couponProducts.ts')).apiCouponScopeDescription, count = r.calls.length;
  await assert.rejects(api(0)); await assert.rejects(api(42, -1)); r.auth.clear(); await assert.rejects(api(42), /请先登录/);
  assert.equal(r.calls.length, count); r.stop();
});

test('scope products use the owned coupon ID and continue an empty scanned page, retrying the identical cursor', async () => {
  let fail = true;
  const r = await start(call => {
    assert.equal(call.url, '/api/coupons/user/42/products'); assert.equal(call.data.limit, 20);
    if (!call.data.before) return { data: page(42, [], 100) };
    if (fail) { fail = false; return { transport: 'offline' }; }
    return { data: page() };
  });
  assert.equal(r.checkout.state.value.loaded, true); assert.deepEqual(r.checkout.state.value.list, []); assert.equal(r.checkout.state.value.nextCursor, 100);
  await r.checkout.load(true); assert.match(r.checkout.error.value, /offline/); assert.equal(r.checkout.state.value.nextCursor, 100);
  await r.checkout.load(true); assert.deepEqual(r.calls.map(c => c.data.before), [undefined, 100, 100]);
  assert.equal(r.checkout.state.value.list[0].catalogPrice, '10.00'); r.checkout.openProduct(999); assert.deepEqual(r.navigations, []);
  r.checkout.openProduct(70); assert.deepEqual(r.navigations, ['/pages/goods/detail?id=70']); r.stop();
});
test('double append is bounded and refresh invalidates late success or failure without preserving old rows', async () => {
  const late = deferred(); let hold = false, fail = false;
  const r = await start(call => hold && call.data.before ? late.promise : fail ? { transport: 'refresh offline' } : { data: page(42, [product], 70) });
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
