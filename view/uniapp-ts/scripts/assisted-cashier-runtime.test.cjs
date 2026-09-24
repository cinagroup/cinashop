const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const QRCode = require('qrcode-terminal/vendor/QRCode');
const levels = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');

const root = path.resolve(__dirname, '..');
const detail = (extra = {}) => ({ order_id: 'ORDER_1', uid: 11, paid: 0, pay_price: '12.34', total_num: 2,
  add_time: 1700000000, pay_type: 'weixin', shipping_type: 1, _status: { _title: '待付款' }, split: false,
  items: [{ id: 1, product_id: 7, store_name: '合成商品', suk: '合成规格', cart_num: 2, price: '6.17' }], ...extra });
const status = (paid = false) => ({ order_id: 'ORDER_1', status: paid, time: 0 });
const provider = (method = 'weixin', extra = {}) => ({ status: method === 'weixin' ? 'WECHAT_PC_PAY' : 'ALIPAY_PAY',
  result: { order_id: 'ORDER_1', pay_price: '12.34', jsConfig: {
    invalid: Math.floor(Date.now() / 1000) + 60,
    ...(method === 'weixin' ? { code_url: 'weixin://wxpay/bizpayurl?pr=synthetic' } : { qrCode: 'https://qr.alipay.com/synthetic' }),
  }, ...extra } });
const paidResult = () => ({ status: 'SUCCESS', result: { order_id: 'ORDER_1' } });

async function setup({ send, auth = true, query = { orderId: 'ORDER_1' }, modal = true } = {}) {
  const r = runtime({ component: 'pages/behalf/cashier/index.vue', modal, send: send || (call => {
    if (call.url.includes('/place/detail/')) return { data: detail() };
    if (call.url.includes('/pay/status')) return { data: status() };
    if (call.url.endsWith('/pay/11')) return { data: provider() };
    throw Error(`unexpected ${call.url}`);
  }) });
  r.admin = r.load(path.join(root, 'src/stores/adminSession.ts')).useAdminSession();
  if (auth) r.admin.install({ id: 1, label: '合成管理员', token: 'admin-1', expiresAt: Date.now() + 3600000,
    permissions: ['order.assisted'] });
  await r.start(query);
  return r;
}

test('cashier page loads only actor-scoped detail; onLoad/onShow never starts payment', async () => {
  const r = await setup({ send: call => {
    assert.equal(call.url, '/api/admin/order/place/detail/ORDER_1');
    assert.equal(call.header.Authorization, 'Bearer admin-1');
    return { data: detail() };
  } });
  try {
    assert.equal(r.checkout.detail.value.orderNo, 'ORDER_1');
    assert.equal(r.checkout.canPay.value, true);
    assert.equal(r.calls.length, 1);
    assert.equal(r.modals.length, 0);
    assert.deepEqual([...r.storage.keys()].sort(), ['uni_token', 'uni_uid']);
  } finally { r.stop(); }
});

test('malformed or duplicate direct order IDs and missing Admin permission cannot read or pay', async () => {
  for (const options of [{ auth: false }, { query: { orderId: '../ORDER_1' } }]) {
    const r = await setup(options);
    try { await r.checkout.startPayment(); assert.equal(r.calls.length, 0); } finally { r.stop(); }
  }
  const r = await setup({ auth: false });
  try {
    r.admin.install({ id: 2, label: '无权限', token: 'admin-2', expiresAt: Date.now() + 3600000,
      permissions: ['order.view'] });
    r.hooks.onShow(); await tick();
    assert.equal(r.calls.length, 0);
  } finally { r.stop(); }
});

test('explicit WeChat request checks status and fresh detail before POST, then shows local QR', async () => {
  const r = await setup({ send: call => {
    if (call.url.includes('/place/detail/')) return { data: detail() };
    if (call.url.includes('/pay/status')) return { data: status() };
    if (call.url.endsWith('/pay/11')) {
      assert.equal(call.header.Authorization, 'Bearer admin-1');
      assert.deepEqual(call.data, { uni: 'ORDER_1', paytype: 'weixin', expected_pay_price: '12.34' });
      return { data: provider() };
    }
    throw Error(call.url);
  } });
  try {
    await r.checkout.startPayment();
    assert.deepEqual(r.calls.map(call => call.url), [
      '/api/admin/order/place/detail/ORDER_1', '/api/admin/order/pay/status',
      '/api/admin/order/place/detail/ORDER_1', '/api/admin/order/pay/11',
    ]);
    assert.equal(r.checkout.qr.value.method, 'weixin');
    assert.match(r.checkout.qr.value.code, /^weixin:\/\//);
    assert.equal(r.checkout.uncertain.value, false);
    await r.checkout.startPayment(); assert.equal(r.calls.length, 4);
    assert.equal(r.calls.some(call => /qrserver|image.*code/.test(call.url)), false);
    assert.equal(r.auth.token, 'synthetic-local-token');
  } finally { r.stop(); }
});

test('cash requires an explicit administrator modal and is not settled on cancel', async () => {
  const cancelled = await setup({ modal: false });
  try {
    cancelled.checkout.chooseMethod('cash');
    await cancelled.checkout.startPayment();
    assert.equal(cancelled.modals.length, 1);
    assert.match(cancelled.modals[0].content, /ORDER_1.*12\.34/);
    assert.equal(cancelled.calls.filter(call => call.url.endsWith('/pay/11')).length, 0);
    assert.equal(cancelled.checkout.uncertain.value, false);
  } finally { cancelled.stop(); }
  const accepted = await setup({ send: call => {
    if (call.url.includes('/place/detail/')) return { data: detail() };
    if (call.url.includes('/pay/status')) return { data: status() };
    if (call.url.endsWith('/pay/11')) {
      assert.deepEqual(call.data, { uni: 'ORDER_1', paytype: 'cash', expected_pay_price: '12.34' });
      return { data: paidResult() };
    }
    throw Error(call.url);
  } });
  try {
    accepted.checkout.chooseMethod('cash');
    await accepted.checkout.startPayment();
    assert.equal(accepted.modals.length, 1);
    assert.equal(accepted.checkout.detail.value.paid, true);
    assert.equal(accepted.checkout.qr.value, null);
    await accepted.checkout.startPayment();
    assert.equal(accepted.calls.filter(call => call.url.endsWith('/pay/11')).length, 1);
  } finally { accepted.stop(); }
});

test('zero-due assisted order waits for explicit confirmation and completes without QR', async () => {
  const send = call => {
    if (call.url.includes('/place/detail/')) return { data: detail({ pay_price: '0.00' }) };
    if (call.url.includes('/pay/status')) return { data: status() };
    if (call.url.endsWith('/pay/11')) {
      assert.deepEqual(call.data, { uni: 'ORDER_1', paytype: 'weixin', expected_pay_price: '0.00' });
      return { data: paidResult() };
    }
    throw Error(call.url);
  };
  const cancelled = await setup({ send, modal: false });
  try {
    assert.equal(cancelled.checkout.canPay.value, true);
    assert.equal(cancelled.checkout.isZeroDue.value, true);
    assert.equal(cancelled.calls.length, 1);
    await cancelled.checkout.startPayment();
    assert.match(cancelled.modals[0].content, /ORDER_1.*0\.00/);
    assert.equal(cancelled.calls.filter(call => call.url.endsWith('/pay/11')).length, 0);
    assert.equal(cancelled.checkout.uncertain.value, false);
  } finally { cancelled.stop(); }
  const accepted = await setup({ send });
  try {
    assert.equal(accepted.calls.length, 1);
    await accepted.checkout.startPayment();
    assert.equal(accepted.checkout.detail.value.paid, true);
    assert.equal(accepted.checkout.qr.value, null);
    assert.equal(accepted.calls.filter(call => call.url.endsWith('/pay/11')).length, 1);
  } finally { accepted.stop(); }
});

test('changed amount or already-paid status stops the payment write', async () => {
  let detailReads = 0;
  const changed = await setup({ send: call => {
    if (call.url.includes('/place/detail/')) return { data: detail({ pay_price: ++detailReads === 1 ? '12.34' : '12.35' }) };
    if (call.url.includes('/pay/status')) return { data: status() };
    throw Error('payment write must not happen');
  } });
  try { await changed.checkout.startPayment(); assert.equal(changed.checkout.detail.value.amount, '12.35'); assert.equal(changed.calls.length, 3); }
  finally { changed.stop(); }
  let zeroReads = 0;
  const changedZero = await setup({ send: call => {
    if (call.url.includes('/place/detail/')) return { data: detail({ pay_price: ++zeroReads === 1 ? '0.00' : '0.01' }) };
    if (call.url.includes('/pay/status')) return { data: status() };
    throw Error('payment write must not happen');
  } });
  try {
    await changedZero.checkout.startPayment();
    assert.equal(changedZero.checkout.detail.value.amount, '0.01');
    assert.equal(changedZero.modals.length, 0);
    assert.equal(changedZero.calls.length, 3);
  } finally { changedZero.stop(); }
  const paid = await setup({ send: call => call.url.includes('/pay/status') ? { data: status(true) } : { data: detail() } });
  try { await paid.checkout.startPayment(); assert.equal(paid.checkout.detail.value.paid, true); assert.equal(paid.calls.length, 2); }
  finally { paid.stop(); }
});

test('unknown POST result bars reissue until actor-scoped status check and another explicit click', async () => {
  let posts = 0;
  const r = await setup({ send: call => {
    if (call.url.includes('/place/detail/')) return { data: detail() };
    if (call.url.includes('/pay/status')) return { data: status() };
    if (call.url.endsWith('/pay/11')) return ++posts === 1 ? { transport: 'synthetic connection loss' } : { data: paidResult() };
    throw Error(call.url);
  } });
  try {
    await r.checkout.startPayment(); assert.equal(posts, 1); assert.equal(r.checkout.uncertain.value, true);
    await r.checkout.startPayment(); assert.equal(posts, 1);
    await r.checkout.checkPaid(); assert.equal(r.checkout.uncertain.value, false); assert.equal(posts, 1);
    await r.checkout.startPayment(); assert.equal(posts, 2); assert.equal(r.checkout.detail.value.paid, true);
    assert.equal(r.calls.filter(call => call.url.includes('/pay/status')).length, 3);
  } finally { r.stop(); }
});

test('cash confirmation sends the displayed expected amount; a concurrent server reprice is rejected and held for status check', async () => {
  let serverAmount = '12.34', modal;
  const r = await setup({ modal: options => { modal = options; }, send: call => {
    if (call.url.includes('/place/detail/')) return { data: detail({ pay_price: serverAmount }) };
    if (call.url.includes('/pay/status')) return { data: status() };
    if (call.url.endsWith('/pay/11')) {
      assert.equal(call.data.expected_pay_price, '12.34');
      assert.equal(serverAmount, '12.35');
      return { status: 400, msg: '服务端金额已变化，拒绝入账' };
    }
    throw Error(call.url);
  } });
  try {
    r.checkout.chooseMethod('cash');
    const pending = r.checkout.startPayment();
    await tick();
    assert.ok(modal);
    assert.match(modal.content, /12\.34/);
    assert.equal(r.calls.filter(call => call.url.endsWith('/pay/11')).length, 0);
    serverAmount = '12.35';
    modal.success({ confirm: true });
    await pending;
    assert.equal(r.checkout.uncertain.value, true);
    assert.equal(r.checkout.detail.value.paid, false);
    await r.checkout.startPayment();
    assert.equal(r.calls.filter(call => call.url.endsWith('/pay/11')).length, 1);
    await r.checkout.checkPaid();
    assert.equal(r.checkout.uncertain.value, false);
    await r.checkout.startPayment();
    assert.equal(r.checkout.detail.value.amount, '12.35');
    assert.equal(r.calls.filter(call => call.url.endsWith('/pay/11')).length, 1);
  } finally { r.stop(); }
});

test('QR expiry clears canvas state without automatic payment reissue', async () => {
  const r = await setup();
  try {
    await r.checkout.startPayment();
    const calls = r.calls.length;
    r.checkout.qr.value.expiresAt = Date.now() - 1;
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(r.checkout.qr.value, null);
    assert.equal(r.checkout.uncertain.value, true);
    assert.equal(r.calls.length, calls);
  } finally { r.stop(); }
});

test('hide, Admin expiry and late responses erase QR and cannot revive old identity', async () => {
  const r = await setup();
  try {
    await r.checkout.startPayment(); assert.ok(r.checkout.qr.value);
    r.hooks.onHide(); assert.equal(r.checkout.qr.value, null); assert.equal(r.checkout.detail.value, null);
    r.hooks.onShow(); await tick(); assert.ok(r.checkout.detail.value);
    r.admin.expiresAt = Date.now() + 80; r.admin.ensureFresh();
    await new Promise(resolve => setTimeout(resolve, 160));
    assert.equal(r.checkout.detail.value, null); assert.equal(r.admin.token, '');
  } finally { r.stop(); }
  const pending = deferred();
  const late = await setup({ send: call => call.url.includes('/place/detail/') ? pending.promise : { data: status() } });
  try {
    late.admin.clear();
    pending.resolve({ data: detail() }); await tick();
    assert.equal(late.checkout.detail.value, null);
    assert.equal(late.calls.filter(call => call.url.endsWith('/pay/11')).length, 0);
  } finally { late.stop(); }
});

test('malformed provider result or amount mismatch retains uncertain state and never displays QR', async () => {
  for (const result of [provider('weixin', { pay_price: '12.35' }), provider('weixin', { jsConfig: { code_url: 'bad url', invalid: Math.floor(Date.now() / 1000) + 60 } })]) {
    const r = await setup({ send: call => {
      if (call.url.includes('/place/detail/')) return { data: detail() };
      if (call.url.includes('/pay/status')) return { data: status() };
      return { data: result };
    } });
    try { await r.checkout.startPayment(); assert.equal(r.checkout.qr.value, null); assert.equal(r.checkout.uncertain.value, true); }
    finally { r.stop(); }
  }
});

test('zero-due assisted order never accepts a provider QR response', async () => {
  const r = await setup({ send: call => {
    if (call.url.includes('/place/detail/')) return { data: detail({ pay_price: '0.00' }) };
    if (call.url.includes('/pay/status')) return { data: status() };
    if (call.url.endsWith('/pay/11')) return { data: provider('weixin', { pay_price: '0.00' }) };
    throw Error(call.url);
  } });
  try {
    await r.checkout.startPayment();
    assert.equal(r.checkout.qr.value, null);
    assert.equal(r.checkout.uncertain.value, true);
    assert.match(r.checkout.actionError.value, /核对付款状态/);
  } finally { r.stop(); }
});

test('H5 route replacement and duplicate order IDs clear old cashier state', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'window'), listeners = new Map();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    location: { hash: '#/pages/behalf/cashier/index?orderId=ORDER_1' },
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name),
  } });
  let r;
  try {
    r = await setup(); assert.equal(r.checkout.detail.value.orderNo, 'ORDER_1');
    window.location.hash = '#/pages/behalf/cashier/index?orderId=ORDER_1&orderId=OTHER';
    listeners.get('hashchange')(); await tick();
    assert.equal(r.checkout.detail.value, null); assert.match(r.checkout.error.value, /订单号无效/);
    window.location.hash = '#/pages/behalf/record/index';
    listeners.get('hashchange')(); assert.equal(r.checkout.detail.value, null);
  } finally {
    r?.stop(); assert.equal(listeners.size, 0);
    if (saved) Object.defineProperty(globalThis, 'window', saved); else delete globalThis.window;
  }
});

test('local QR matrix has QR finder patterns, route is registered and no third-party image host exists', () => {
  const value = 'weixin://wxpay/bizpayurl?pr=synthetic';
  const qr = new QRCode(0, levels.M); qr.addData(value); qr.make();
  assert.ok(qr.getModuleCount() >= 21 && qr.getModuleCount() <= 177);
  for (const [row, col] of [[0, 0], [0, 6], [6, 0], [6, 6], [3, 3]]) assert.equal(qr.isDark(row, col), true);
  const manifest = JSON.parse(readFileSync(path.join(root, 'src/pages.json'), 'utf8'));
  assert.ok(manifest.pages.some(page => page.path === 'pages/behalf/cashier/index'));
  const component = readFileSync(path.join(root, 'src/components/AssistedPaymentQr.vue'), 'utf8');
  assert.match(component, /createCanvasContext/);
  assert.doesNotMatch(component, /qrserver|fetch\(|request\(/);
});

test('actual payment QR SFC paints the matrix and quiet zone into a local Uni canvas', async () => {
  const { parse, compileScript } = require('@vue/compiler-sfc');
  const ts = require('typescript');
  const file = path.join(root, 'src/components/AssistedPaymentQr.vue');
  const source = compileScript(parse(readFileSync(file, 'utf8'), { filename: file }).descriptor, { id: 'cashier-qr-test' }).content;
  const output = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText;
  for (const code of ['weixin://wxpay/bizpayurl?pr=synthetic', `https://qr.alipay.com/${'x'.repeat(1700)}`]) {
    const lifecycle = [], operations = [], context = {
      setFillStyle: value => operations.push(['color', value]),
      fillRect: (...args) => operations.push(['rect', ...args]),
      draw: value => operations.push(['draw', value]),
    };
    const fakeVue = { defineComponent: options => options, getCurrentInstance: () => ({ proxy: {} }),
      ref: require('vue').ref, nextTick: () => Promise.resolve(), onMounted: fn => lifecycle.push(fn),
      onUnmounted: () => {}, watch: () => {} };
    const exports = {};
    new Function('require', 'exports', 'uni', output)(id => id === 'vue' ? fakeVue : require(id), exports, {
      createCanvasContext: (id, proxy) => { assert.equal(id, 'assisted-payment-code'); assert.ok(proxy); return context; },
    });
    exports.default.setup({ code }, { expose() {} });
    assert.equal(lifecycle.length, 1);
    lifecycle[0](); await tick();
    const qr = new QRCode(0, levels.M); qr.addData(code); qr.make();
    const count = qr.getModuleCount(), cell = Math.max(2, Math.ceil(256 / (count + 8)));
    const size = (count + 8) * cell;
    assert.deepEqual(operations.slice(0, 3), [['color', '#ffffff'], ['rect', 0, 0, size, size], ['color', '#172a42']]);
    assert.deepEqual(operations.at(-1), ['draw', false]);
    const blackRects = operations.slice(3, -1);
    const blackCells = new Set();
    for (const [kind, x, y, width, height] of blackRects) {
      assert.equal(kind, 'rect');
      assert.ok(Number.isInteger(x) && Number.isInteger(y));
      assert.equal(width, cell); assert.equal(height, cell);
      assert.ok(x >= 4 * cell && y >= 4 * cell && x < size - 4 * cell && y < size - 4 * cell);
      assert.equal(x % cell, 0); assert.equal(y % cell, 0);
      assert.equal(blackCells.has(`${x},${y}`), false, 'black rectangles must not overlap');
      blackCells.add(`${x},${y}`);
    }
    for (let row = 0; row < count; row++) for (let col = 0; col < count; col++) {
      const x = (col + 4) * cell, y = (row + 4) * cell;
      // Integer-aligned rectangles leave every white module centre on white base.
      assert.equal(blackCells.has(`${x},${y}`), qr.isDark(row, col), `module ${row},${col}`);
    }
    assert.ok(blackCells.size > 100);
  }
});
