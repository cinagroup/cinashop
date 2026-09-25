const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');

const profile = () => ({ can_writeoff: true, staff_stores: [{ store_id: 1, store_name: '甲店' }],
  delivery: { nickname: '配送员' }, delivery_identity_conflict: false });
const summary = { id: 301, order_id: 'pickup-301', status: 0, _status: 11,
  total_num: 1, pay_price: '10.00', add_time: '2026-09-25 12:00:00', product_type: 0, image: '' };
const detail = (role = 'staff') => ({ id: 301, order_id: 'pickup-301', actor_kind: role,
  real_name: '私有客户', user_phone: '138****8000', cart_info: [{ id: 401, write_surplus_times: 1,
    write_times: 1, cart_info: { productInfo: { storeName: '商品' } } }] });
function setup(send, modal = true) {
  return runtime({ component: 'pages/operator/writeoff.vue', modal, send: call => {
    if (call.url.endsWith('/store/operator/profile')) return { data: profile() };
    return send(call);
  } });
}

test('member-code operator flow selects one order, previews it, and executes only that order', async () => {
  const r = setup(call => {
    if (call.url.endsWith('/member_lookup')) return { data: { data: [summary] } };
    if (call.url.endsWith('/member_info')) return { data: detail() };
    if (call.url.endsWith('/member_writeoff')) return { data: { order_id: 'pickup-301', completed: true, status: 2 } };
    throw Error(`unexpected ${call.url}`);
  });
  try {
    await r.start({ code: '/pages/admin/order_cancellation/index?code=123456789&auth=3' });
    assert.equal(r.checkout.role.value, 'staff');
    assert.deepEqual(r.checkout.memberCandidates.value.map(row => row.id), [301]);
    await r.checkout.previewMember(r.checkout.memberCandidates.value[0]);
    assert.equal(r.checkout.previewOrder.value.id, 301);
    await r.checkout.execute();
    const writes = r.calls.filter(call => call.url.endsWith('/member_writeoff'));
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].data, { member_code: '123456789', order_id: 301,
      items: [{ order_cart_id: 401, quantity: 1 }] });
    assert.equal(r.checkout.code.value, '');
    assert.equal(r.checkout.previewOrder.value, null);
  } finally { r.stop(); }
});

test('legacy URL auth=3 never grants a missing operator role', async () => {
  const r = runtime({ component: 'pages/operator/writeoff.vue', send: call => {
    if (call.url.endsWith('/store/operator/profile')) return { data: { can_writeoff: false,
      staff_stores: [], delivery: null, delivery_identity_conflict: false } };
    throw Error(`unexpected ${call.url}`);
  } });
  try {
    await r.start({ code: '/pages/admin/order_cancellation/index?auth=3&code=123456789' });
    assert.equal(r.checkout.profile.value.can_writeoff, false);
    assert.equal(r.calls.length, 1);
    assert.equal(r.checkout.previewOrder.value, null);
  } finally { r.stop(); }
});

test('native scan accepts the inherited member QR path but reads only the authenticated role', async () => {
  const r = setup(call => call.url.endsWith('/store/order/member_lookup')
    ? { data: { data: [summary] } } : (() => { throw Error(`unexpected ${call.url}`); })());
  let scanOptions;
  r.uni.scanCode = options => { scanOptions = options; };
  try {
    await r.start();
    r.checkout.scan();
    assert.deepEqual(scanOptions.scanType, ['qrCode', 'barCode']);
    scanOptions.success({ path: 'pages/admin/order_cancellation/index?auth=3&code=123456789', result: 'fallback' });
    await tick();
    assert.equal(r.checkout.role.value, 'staff');
    assert.deepEqual(r.checkout.memberCandidates.value.map(row => row.id), [301]);
    assert.deepEqual(r.calls.at(-1).data, { member_code: '123456789' });
  } finally { r.stop(); }
});

test('same-path URLs from another H5 origin never become operator scan codes', () => {
  const r = setup(call => { throw Error(`unexpected ${call.url}`); });
  try {
    const parser = r.load(path.resolve(__dirname, '../src/utils/operatorScanCode.ts'));
    const allowed = ['https://shop.example.test'];
    assert.deepEqual(parser.parseOperatorScanCode(
      'https://shop.example.test/pages/operator/writeoff?auth=3&code=123456789', allowed),
    { kind: 'member', code: '123456789' });
    assert.equal(parser.parseOperatorScanCode(
      'https://evil.example.test/pages/operator/writeoff?auth=3&code=123456789', allowed), null);
    assert.equal(parser.parseOperatorScanCode(
      'https://shop.example.test.evil.invalid/pages/operator/writeoff?code=123456789', allowed), null);
    assert.equal(parser.parseOperatorScanCode(
      'https://user@shop.example.test/pages/operator/writeoff?code=123456789', allowed), null);
  } finally { r.stop(); }
});

test('known operator paths accept one legacy scene but reject mixed or duplicate identifiers', () => {
  const r = setup(call => { throw Error(`unexpected ${call.url}`); });
  try {
    const { parseOperatorScanCode } = r.load(path.resolve(__dirname, '../src/utils/operatorScanCode.ts'));
    const base = '/pages/admin/order_cancellation/index?';
    assert.deepEqual(parseOperatorScanCode(`${base}scene=auth%3D3%26code%3D123456789`),
      { kind: 'member', code: '123456789' });
    for (const query of [
      'code=123456789&scene=auth%3D3%26code%3D123456789',
      'scene=auth%3D3%26code%3D123456789&scene=auth%3D3%26code%3D123456789',
      'scene=auth%253D3%2526code%253D123456789',
      'scene=auth%3D3%26code%3D%ZZ',
    ]) assert.equal(parseOperatorScanCode(base + query), null);
  } finally { r.stop(); }
});

test('native scanCode path decodes the published legacy scene and ignores auth=3 authority', async () => {
  const r = setup(call => call.url.endsWith('/store/order/member_lookup')
    ? { data: { data: [summary] } } : (() => { throw Error(`unexpected ${call.url}`); })());
  let scanOptions;
  r.uni.scanCode = options => { scanOptions = options; };
  try {
    await r.start();
    r.checkout.scan();
    scanOptions.success({
      path: 'pages/admin/order_cancellation/index?scene=auth%3D3%26code%3D123456789',
      result: 'invalid-fallback',
    });
    await tick();
    assert.equal(r.checkout.role.value, 'staff');
    assert.deepEqual(r.checkout.memberCandidates.value.map(row => row.id), [301]);
    assert.deepEqual(r.calls.at(-1).data, { member_code: '123456789' });
  } finally { r.stop(); }
});

test('one encoded legacy mini-program scene decodes without treating auth=3 as a grant', async () => {
  const r = setup(call => call.url.endsWith('/store/order/member_lookup')
    ? { data: { data: [summary] } } : (() => { throw Error(`unexpected ${call.url}`); })());
  try {
    await r.start({ scene: 'auth%3D3%26code%3D123456789' });
    assert.equal(r.checkout.role.value, 'staff');
    assert.deepEqual(r.checkout.memberCandidates.value.map(row => row.id), [301]);
    assert.deepEqual(r.calls.at(-1).data, { member_code: '123456789' });
  } finally { r.stop(); }
});

for (const scene of ['auth%3D3%26code%3D123456789%26code%3D987654321',
  'auth%3D3%26code%3D%ZZ', 'auth%253D3%2526code%253D123456789']) {
  test(`malformed or duplicated scene never queries a member: ${scene}`, async () => {
    const r = setup(call => { throw Error(`unexpected ${call.url}`); });
    try { await r.start({ scene }); assert.equal(r.calls.length, 1); }
    finally { r.stop(); }
  });
}

test('a stale profile response cannot clear a newer profile loading state', async () => {
  const first = deferred(), second = deferred(); let reads = 0;
  const r = runtime({ component: 'pages/operator/writeoff.vue', send: call => {
    if (!call.url.endsWith('/store/operator/profile')) throw Error(`unexpected ${call.url}`);
    return ++reads === 1 ? first.promise : second.promise;
  } });
  try {
    await r.start();
    r.hooks.onHide(); r.hooks.onShow(); await tick();
    assert.equal(reads, 2);
    first.resolve({ data: profile() }); await tick();
    assert.equal(r.checkout.loadingProfile.value, true);
    assert.equal(r.checkout.profile.value, null);
    second.resolve({ data: profile() }); await tick();
    assert.equal(r.checkout.loadingProfile.value, false);
    assert.equal(r.checkout.profile.value.can_writeoff, true);
  } finally { first.resolve({ status: 400 }); second.resolve({ status: 400 }); r.stop(); }
});

test('a denied deep link from account A never auto-previews when account B gains the role', async () => {
  let profileReads = 0;
  const r = runtime({ component: 'pages/operator/writeoff.vue', send: call => {
    if (call.url.endsWith('/store/operator/profile')) return { data: ++profileReads === 1
      ? { can_writeoff: false, staff_stores: [], delivery: null, delivery_identity_conflict: false }
      : profile() };
    throw Error(`stale deep link queried ${call.url}`);
  } });
  try {
    await r.start({ scene: 'auth%3D3%26code%3D123456789' });
    assert.equal(r.checkout.profile.value.can_writeoff, false);
    r.hooks.onHide();
    r.auth.setLogin('account-b', 22);
    r.hooks.onShow(); await tick();
    assert.equal(r.checkout.profile.value?.can_writeoff, true,
      JSON.stringify({ profileReads, calls: r.calls, loading: r.checkout.loadingProfile.value }));
    assert.equal(r.checkout.code.value, '');
    assert.equal(r.calls.length, 2);
  } finally { r.stop(); }
});

test('hide and show clear a pending deep link even when the first profile response arrives late', async () => {
  const first = deferred(); let profileReads = 0;
  const r = runtime({ component: 'pages/operator/writeoff.vue', send: call => {
    if (!call.url.endsWith('/store/operator/profile')) throw Error(`stale deep link queried ${call.url}`);
    return ++profileReads === 1 ? first.promise : { data: profile() };
  } });
  try {
    await r.start({ scene: 'auth%3D3%26code%3D123456789' });
    r.hooks.onHide(); r.hooks.onShow(); await tick();
    first.resolve({ data: profile() }); await tick();
    assert.equal(r.checkout.profile.value.can_writeoff, true);
    assert.equal(r.checkout.code.value, '');
    assert.equal(r.calls.length, 2);
  } finally { first.resolve({ status: 400 }); r.stop(); }
});

test('empty member lookup shows one no-result state and cannot issue a write', async () => {
  const r = setup(call => call.url.endsWith('/member_lookup') ? { data: { data: [] } } : (() => { throw Error('unexpected route'); })());
  try {
    await r.start(); r.checkout.code.value = '123456789'; await r.checkout.preview();
    assert.deepEqual(r.checkout.memberCandidates.value, []);
    assert.equal(r.checkout.previewOrder.value, null);
    await r.checkout.execute();
    assert.equal(r.calls.filter(call => call.url.endsWith('/member_writeoff')).length, 0);
    assert.match(r.toasts.at(-1).title, /暂无可核销订单/);
  } finally { r.stop(); }
});

test('late member lookup after role switch cannot repopulate the prior role and URL auth cannot force it', async () => {
  const waiting = deferred();
  const r = setup(call => call.url.endsWith('/store/order/member_lookup') ? waiting.promise
    : call.url.endsWith('/delivery/order/member_lookup') ? { data: { data: [] } }
      : (() => { throw Error(`unexpected ${call.url}`); })());
  try {
    await r.start(); r.checkout.code.value = '123456789'; const pending = r.checkout.preview(); await tick();
    r.checkout.selectRole('delivery');
    assert.equal(r.checkout.code.value, '');
    waiting.resolve({ data: { data: [summary] } }); await pending;
    assert.equal(r.checkout.role.value, 'delivery');
    assert.deepEqual(r.checkout.memberCandidates.value, []);
    assert.equal(r.checkout.previewOrder.value, null);
  } finally { waiting.resolve({ status: 400 }); r.stop(); }
});

test('late preview after account switch cannot expose private order or write', async () => {
  const waiting = deferred();
  const r = setup(call => call.url.endsWith('/member_lookup') ? { data: { data: [summary] } }
    : call.url.endsWith('/member_info') ? waiting.promise : (() => { throw Error(`unexpected ${call.url}`); })());
  try {
    await r.start(); r.checkout.code.value = '123456789'; await r.checkout.preview();
    const pending = r.checkout.previewMember(r.checkout.memberCandidates.value[0]); await tick();
    r.auth.setLogin('other-user', 22);
    waiting.resolve({ data: detail() }); await pending;
    assert.equal(r.checkout.previewOrder.value, null);
    assert.deepEqual(r.checkout.memberCandidates.value, []);
    await r.checkout.execute();
    assert.equal(r.calls.filter(call => call.url.endsWith('/member_writeoff')).length, 0);
  } finally { waiting.resolve({ status: 400 }); r.stop(); }
});

test('twelve-digit order code keeps the original preview and write endpoints', async () => {
  const r = setup(call => {
    if (call.url.endsWith('/writeoff_info')) return { data: detail() };
    if (call.url.endsWith('/writeoff')) return { data: { order_id: 'pickup-301', completed: true, status: 2 } };
    throw Error(`unexpected ${call.url}`);
  });
  try {
    await r.start(); r.checkout.code.value = '112233445566'; await r.checkout.preview();
    assert.equal(r.checkout.previewKind.value, 'order');
    await r.checkout.execute();
    assert.deepEqual(r.calls.map(call => call.url.split('/').at(-1)),
      ['profile', 'writeoff_info', 'writeoff']);
  } finally { r.stop(); }
});

test('one in-flight member confirmation cannot issue duplicate writes or publish after hide', async () => {
  const waiting = deferred();
  const r = setup(call => call.url.endsWith('/member_lookup') ? { data: { data: [summary] } }
    : call.url.endsWith('/member_info') ? { data: detail() }
      : call.url.endsWith('/member_writeoff') ? waiting.promise
        : (() => { throw Error(`unexpected ${call.url}`); })());
  try {
    await r.start(); r.checkout.code.value = '123456789'; await r.checkout.preview();
    await r.checkout.previewMember(r.checkout.memberCandidates.value[0]);
    const first = r.checkout.execute(); await tick();
    await r.checkout.execute();
    assert.equal(r.calls.filter(call => call.url.endsWith('/member_writeoff')).length, 1);
    r.hooks.onHide();
    waiting.resolve({ data: { order_id: 'pickup-301', completed: true, status: 2 } });
    await first;
    assert.equal(r.checkout.previewOrder.value, null);
    assert.deepEqual(r.checkout.memberCandidates.value, []);
    assert.equal(r.toasts.filter(toast => toast.icon === 'success').length, 0);
  } finally { waiting.resolve({ status: 400 }); r.stop(); }
});
