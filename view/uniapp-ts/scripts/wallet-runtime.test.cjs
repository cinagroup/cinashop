const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
const coupon = { id: 42, coupon_title: '八五折', coupon_price: '85.00', use_min_price: '0.00', coupon_type: 2, applicable_type: 0,
  start_time: null, end_time: null, availability: 'available', availability_message: '未使用，适用范围以结算报价为准' };
const walletRuntime = options => runtime({ feature: 'useCouponWallet', ...options });

test('real request adapter retains page cursor, formats coupon types, retries the same failed next page', async () => {
  let fail = true;
  const r = walletRuntime({ send: call => {
    assert.equal(call.url, '/api/coupons/user/0'); assert.equal(call.data.limit, 20);
    if (!call.data.before) return { data: [coupon], headers: { 'X-Coupon-Next-Cursor': '42' } };
    assert.equal(call.data.before, 42);
    if (fail) { fail = false; return { transport: 'offline' }; }
    return { data: [{ ...coupon, id: 41, coupon_type: 1, coupon_price: '5.00' }] };
  } });
  await r.start(); const w = r.checkout;
  assert.equal(w.state.value.list[0].benefit, '8.5折'); assert.equal(w.state.value.list[0].validity, '不限 至 不限');
  await w.load(true); assert.equal(w.state.value.list.length, 1); assert.match(w.error.value, /offline/); assert.equal(w.state.value.nextCursor, 42);
  await w.load(true); assert.deepEqual(w.state.value.list.map(c => c.benefit), ['8.5折', '¥5.00']); assert.equal(w.state.value.nextCursor, null);
  assert.deepEqual(r.calls.map(c => c.data.before), [undefined, 42, 42]); r.stop();
});
test('changing wallet state closes detail and rejects late old-tab success', async () => {
  const old = deferred();
  const r = walletRuntime({ send: call => call.url.endsWith('/0') ? old.promise : { data: [{ ...coupon, availability: 'used', availability_message: '已使用' }] } });
  r.hooks.onShow(); await tick(); r.checkout.switchTab(1); await tick();
  assert.equal(r.checkout.state.value.list[0].availability, 'used');
  old.resolve({ data: [coupon] }); await tick(); assert.equal(r.checkout.state.value.list[0].availability, 'used');
  r.checkout.openDetail(42); assert.ok(r.checkout.detail.value); r.checkout.switchTab(3); assert.equal(r.checkout.detail.value, null); r.stop();
});
test('future, used, expired and reserved coupons cannot trigger browsing from either list or detail', async () => {
  const rows = ['future', 'used', 'expired', 'reserved'].map((availability, i) => ({ ...coupon, id: 10 + i, availability }));
  const r = walletRuntime({ send: () => ({ data: rows }) }); await r.start();
  for (const row of rows) { r.checkout.openDetail(row.id); assert.equal(r.checkout.detail.value.availability, row.availability); r.checkout.browseGoods(row.id); }
  assert.deepEqual(r.navigations, []); r.checkout.browseGoods(999); assert.deepEqual(r.navigations, []); r.stop();
});
test('available coupon browsing does not redeem, pay or forward an assumed coupon entitlement', async () => {
  const r = walletRuntime({ send: () => ({ data: [coupon] }) }); await r.start(); r.checkout.openDetail(42); r.checkout.browseGoods(42);
  assert.equal(r.checkout.detail.value, null); assert.deepEqual(r.navigations, ['/pages/goods/list']); assert.equal(r.calls.length, 1); r.stop();
});
test('initial failure differs from empty state and refresh never leaves a stale modal or prior list', async () => {
  let fail = false; const r = walletRuntime({ send: () => fail ? { status: 400, msg: 'unavailable' } : { data: [coupon] } });
  await r.start(); r.checkout.openDetail(42); fail = true; await r.checkout.load();
  assert.equal(r.checkout.detail.value, null); assert.deepEqual(r.checkout.state.value.list, []); assert.match(r.checkout.error.value, /unavailable/);
  fail = false; await r.checkout.load(); assert.equal(r.checkout.error.value, ''); r.stop();
});
test('account changes remove rows and details before late responses can cross identities', async () => {
  const late = deferred(); let hold = false;
  const r = walletRuntime({ send: () => hold ? late.promise : { data: [coupon] } }); await r.start(); r.checkout.openDetail(42);
  hold = true; const read = r.checkout.load(true); // no cursor: no I/O
  await read; const refreshing = r.checkout.load(); await tick(); r.auth.setLogin('new-token', 22);
  assert.deepEqual(r.checkout.state.value.list, []); assert.equal(r.checkout.detail.value, null);
  late.resolve({ data: [coupon] }); await refreshing; assert.deepEqual(r.checkout.state.value.list, []);
  assert.match(r.checkout.error.value, /登录状态已变化/); r.hooks.onHide(); r.checkout.browseGoods(42); assert.deepEqual(r.navigations, []); r.stop();
});
test('late old-tab failure cannot replace the selected tab', async () => {
  const old = deferred();
  const r = walletRuntime({ send: call => call.url.endsWith('/0') ? old.promise : { data: [] } });
  r.hooks.onShow(); await tick(); r.checkout.switchTab(1); await tick();
  old.resolve({ transport: 'old tab offline' }); await tick();
  assert.equal(r.checkout.activeType.value, 1); assert.equal(r.checkout.error.value, '');
  assert.deepEqual(r.checkout.state.value.list, []); r.stop();
});
for (const hook of ['onHide', 'onUnload']) test(`${hook} drops pending reads and detail actions`, async () => {
  const late = deferred(); let hold = false;
  const r = walletRuntime({ send: () => hold ? late.promise : { data: [coupon] } });
  await r.start(); r.checkout.openDetail(42); assert.ok(r.checkout.detail.value);
  r.hooks[hook](); assert.equal(r.checkout.detail.value, null); assert.deepEqual(r.checkout.state.value.list, []);
  hold = true; r.hooks.onShow(); await tick(); r.hooks[hook]();
  late.resolve({ data: [coupon] }); await tick();
  assert.deepEqual(r.checkout.state.value.list, []); r.checkout.browseGoods(42); assert.deepEqual(r.navigations, []); r.stop();
});
test('invalid wallet inputs, unauthenticated reads and mismatched cursors fail closed', async () => {
  const r = walletRuntime({ send: () => ({ data: [coupon], headers: { 'x-coupon-next-cursor': '99' } }) });
  await r.start(); assert.match(r.checkout.error.value, /分页标识不匹配/); assert.deepEqual(r.checkout.state.value.list, []);
  const api = r.load(path.resolve(__dirname, '../src/api/couponWallet.ts')).apiCouponWallet;
  const count = r.calls.length;
  await assert.rejects(api(4)); await assert.rejects(api(0, -1)); assert.equal(r.calls.length, count);
  r.auth.clear(); await assert.rejects(api(0), /请先登录/); assert.equal(r.calls.length, count); r.stop();
});
