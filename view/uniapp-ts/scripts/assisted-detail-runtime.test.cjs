const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
const root = path.resolve(__dirname, '..');
const row = (extra = {}) => ({ order_id: 'ORDER_1', uid: 11, paid: 0, pay_price: '12.34', total_num: 2,
  add_time: 1700000000, pay_type: 'cash', shipping_type: 1, _status: { _title: '待付款' }, split: false,
  items: [{ id: 1, product_id: 7, store_name: '合成商品', suk: '合成规格', cart_num: 2, price: '6.17' }], ...extra });
async function setup({ send = () => ({ data: row() }), auth = true, query = { orderId: 'ORDER_1' }, component = true } = {}) {
  const r = runtime({ feature: 'useAssistedDetail', ...(component ? { component: 'pages/behalf/order_detail/index.vue' } : {}), send });
  r.admin = r.load(path.join(root, 'src/stores/adminSession.ts')).useAdminSession();
  if (auth) r.admin.install({ id: 1, label: '合成管理员', token: 'admin-1', expiresAt: Date.now() + 3600000, permissions: ['order.assisted'] });
  await r.start(query); return r;
}

test('actual detail SFC uses separate Admin auth and only read-only actor-scoped route', async () => {
  const r = await setup({ send: call => {
    assert.equal(call.url, '/api/admin/order/place/detail/ORDER_1');
    assert.equal(call.header.Authorization, 'Bearer admin-1');
    assert.equal(call.header['Authori-zation'], undefined);
    return { data: row() };
  } });
  try {
    assert.equal(r.checkout.detail.value.orderNo, 'ORDER_1');
    assert.equal(r.checkout.detail.value.items[0].name, '合成商品');
    assert.equal(r.checkout.detail.value.amount, '12.34');
    assert.equal(r.auth.token, 'synthetic-local-token');
    assert.ok(r.calls.every(call => call.url.startsWith('/api/admin/order/place/detail/')));
    assert.deepEqual([...r.storage.keys()].sort(), ['uni_token', 'uni_uid']);
  } finally { r.stop(); }
});

test('no Admin permission or malformed URL cannot perform detail read', async () => {
  const cases = [{ auth: false }, { query: { orderId: '../ORDER_1' } }, { query: { orderId: 'ORDER_1', adminId: 999, uid: 999 } }];
  for (const options of cases) {
    const r = await setup(options);
    try {
      if (options.query?.orderId === 'ORDER_1') assert.equal(r.checkout.detail.value?.orderNo, 'ORDER_1');
      else { assert.equal(r.calls.length, 0); assert.equal(r.checkout.detail.value, null); }
      assert.equal(r.auth.uid, 11);
    } finally { r.stop(); }
  }
  const r = await setup({ auth: false });
  try {
    r.admin.install({ id: 2, label: '无权限', token: 'admin-2', expiresAt: Date.now() + 3600000, permissions: ['order.view'] });
    r.hooks.onShow(); await tick(); assert.equal(r.calls.length, 0);
  } finally { r.stop(); }
});

test('different actor, deleted order and server denial never display a previous detail', async () => {
  let denied = false;
  const r = await setup({ send: () => denied ? { status: 404, msg: '订单不存在' } : { data: row() } });
  try {
    assert.ok(r.checkout.detail.value);
    denied = true; await r.checkout.load();
    assert.equal(r.checkout.detail.value, null); assert.match(r.checkout.error.value, /订单不存在/);
    assert.equal(r.auth.uid, 11);
  } finally { r.stop(); }
});
test('detail snapshot clears at natural Admin expiry without navigation or another request', async () => {
  const r = await setup();
  try {
    assert.equal(r.checkout.detail.value.orderNo, 'ORDER_1');
    const calls = r.calls.length;
    r.admin.expiresAt = Date.now() + 80; r.admin.ensureFresh();
    await new Promise(resolve => setTimeout(resolve, 160));
    assert.equal(r.admin.token, ''); assert.equal(r.checkout.detail.value, null);
    assert.equal(r.calls.length, calls); assert.equal(r.auth.uid, 11);
  } finally { r.stop(); }
});

test('hide/unload and identity replacement clear details immediately; late responses cannot revive them', async () => {
  const pending = deferred();
  const r = await setup({ send: () => pending.promise });
  try {
    assert.equal(r.checkout.loading.value, true);
    r.hooks.onHide(); assert.equal(r.checkout.detail.value, null);
    pending.resolve({ data: row() }); await tick(); assert.equal(r.checkout.detail.value, null);
    r.hooks.onShow(); await tick(); assert.equal(r.checkout.detail.value.orderNo, 'ORDER_1');
    r.admin.clear(); assert.equal(r.checkout.detail.value, null);
    r.admin.install({ id: 2, label: '另一管理员', token: 'admin-2', expiresAt: Date.now() + 3600000, permissions: ['order.assisted'] });
    assert.equal(r.checkout.detail.value, null);
    r.hooks.onUnload(); assert.equal(r.checkout.detail.value, null);
  } finally { r.stop(); }
});

test('stale response after administrator switch cannot overwrite the new administrator detail', async () => {
  const old = deferred(); let calls = 0;
  const r = await setup({ send: () => ++calls === 1 ? old.promise : { data: row({ paid: 1, _status: { _title: '已支付' } }) } });
  try {
    r.admin.clear();
    r.admin.install({ id: 2, label: '另一管理员', token: 'admin-2', expiresAt: Date.now() + 3600000, permissions: ['order.assisted'] });
    await r.checkout.load(); assert.equal(r.checkout.detail.value.paid, true);
    old.resolve({ data: row() }); await tick(); assert.equal(r.checkout.detail.value.paid, true);
    assert.equal(r.admin.id, 2); assert.equal(r.auth.uid, 11);
  } finally { r.stop(); }
});

test('split root displays read-only original purchase snapshot, without child actions', async () => {
  const r = await setup({ send: () => ({ data: row({ paid: 1, split: true, _status: { _title: '已拆分' } }) }) });
  try {
    assert.equal(r.checkout.detail.value.split, true);
    assert.equal(r.checkout.detail.value.statusTitle, '已拆分');
    assert.equal(r.checkout.detail.value.items.length, 1);
    assert.ok(r.calls.every(call => !/\/pay\b|\/cancel\b|\/refund\b/.test(call.url)));
  } finally { r.stop(); }
});

for (const patch of [
  { order_id: 'OTHER' }, { paid: '1' }, { pay_price: 'NaN' }, { items: null },
  { items: [row().items[0], row().items[0]] }, { items: [{ ...row().items[0], cart_num: -1 }] },
  { split: 'true' }, { _status: null },
]) test(`invalid detail projection ${Object.keys(patch)[0]} fails closed`, async () => {
  const r = await setup({ send: () => ({ data: row(patch) }) });
  try { assert.equal(r.checkout.detail.value, null); assert.ok(r.checkout.error.value); } finally { r.stop(); }
});

test('detail route is registered while shopper home remains first', () => {
  const manifest = JSON.parse(readFileSync(path.join(root, 'src/pages.json'), 'utf8'));
  assert.equal(manifest.pages[0].path, 'pages/index/index');
  assert.ok(manifest.pages.some(page => page.path === 'pages/behalf/order_detail/index'));
});

test('H5 same-page hash replacement clears old detail, rejects duplicate IDs and removes listener', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'window'), listeners = new Map();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    location: { hash: '#/pages/behalf/order_detail/index?orderId=ORDER_1' },
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: name => listeners.delete(name),
  } });
  let r;
  try {
    r = await setup({ send: call => ({ data: row({ order_id: call.url.endsWith('ORDER_2') ? 'ORDER_2' : 'ORDER_1' }) }) });
    assert.equal(r.checkout.detail.value.orderNo, 'ORDER_1');
    window.location.hash = '#/pages/behalf/order_detail/index?orderId=ORDER_2';
    listeners.get('hashchange')(); assert.equal(r.checkout.detail.value, null);
    await tick(); assert.equal(r.checkout.detail.value.orderNo, 'ORDER_2');
    window.location.hash = '#/pages/behalf/order_detail/index?orderId=ORDER_1&orderId=ORDER_2';
    listeners.get('hashchange')(); assert.equal(r.checkout.detail.value, null);
    await tick(); assert.match(r.checkout.error.value, /订单号无效/);
    window.location.hash = '#/pages/behalf/record/index';
    listeners.get('hashchange')(); assert.equal(r.checkout.detail.value, null);
    assert.equal(r.checkout.loading.value, false);
  } finally {
    r?.stop(); assert.equal(listeners.size, 0);
    if (saved) Object.defineProperty(globalThis, 'window', saved); else delete globalThis.window;
  }
});
