const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vue = require('vue');
const ts = require('typescript');
const { parse, compileScript } = require('@vue/compiler-sfc');
const QRCode = require('qrcode-terminal/vendor/QRCode');
const levels = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
const root = path.resolve(__dirname, '..');
const newCode = '1234567890123456';
const response = code => ({ data: { bar_code: code } });
const setup = send => runtime({ feature: 'useMemberCode', send });

test('display is explicit, uses the authenticated POST, and preserves a stable code across displays', async () => {
  const transport = [];
  const r = setup(call => { transport.push(call); return response(newCode); });
  try {
    await r.start();
    assert.equal(r.calls.length, 0);
    assert.equal(r.checkout.code.value, '');
    await r.checkout.showCode();
    assert.equal(r.checkout.code.value, newCode);
    assert.equal(transport[0].method, 'POST');
    assert.equal(transport[0].header['Authori-zation'], 'Bearer synthetic-local-token');
    assert.deepEqual(r.calls, [{ url: '/api/user/bar_code', data: {} }]);
    await r.checkout.showCode();
    assert.equal(r.calls.length, 1, 'a visible code does not allocate/read again');
    r.checkout.hideCode();
    assert.equal(r.checkout.code.value, '');
    await r.checkout.showCode();
    assert.equal(r.checkout.code.value, newCode);
    assert.equal(r.calls.length, 2);
    assert.ok(r.calls.every(call => call.url === '/api/user/bar_code'));
  } finally { r.stop(); }
});

test('valid legacy strings remain byte-for-byte identities and parse as bare member codes', async () => {
  const r = setup(() => response(newCode));
  try {
    const { apiMemberCode } = r.load(path.join(root, 'src/api/memberCode.ts'));
    const { parseOperatorScanCode } = r.load(path.join(root, 'src/utils/operatorScanCode.ts'));
    for (const code of ['012345678', 'legacy-Code_07', 'legacy CODE', '会员012345', '00000000000000001']) {
      r.uni.request = call => call.success({ statusCode: 200, data: { status: 200, data: { bar_code: code } } });
      assert.equal(await apiMemberCode(), code);
      assert.deepEqual(parseOperatorScanCode(code), { kind: 'member', code });
    }
  } finally { r.stop(); }
});

test('malformed responses, order codes and ambiguous URL content never become a member QR', async () => {
  const invalid = [null, [], '123456789', {}, { bar_code: 123456789 }, { bar_code: '' },
    { bar_code: 'undefined' }, { bar_code: '123456789012' }, { bar_code: 'x'.repeat(33) },
    { bar_code: ' legacy' }, { bar_code: 'legacy ' }, { bar_code: 'legacy\u0000code' },
    { bar_code: 'https://shop.test/pages/operator/writeoff?code=123456789' },
    { bar_code: '/pages/operator/writeoff?code=123456789' }, { bar_code: 'code=abc&auth=3' },
    { bar_code: 'https:shop.test' }, { bar_code: 'javascript:alert(1)' }];
  for (const data of invalid) {
    const r = setup(() => ({ data }));
    try {
      await r.start();
      await r.checkout.showCode();
      assert.equal(r.checkout.code.value, '', JSON.stringify(data));
      assert.equal(r.checkout.loading.value, false);
      assert.equal(r.checkout.error.value, '会员码响应格式无效，请重试');
    } finally { r.stop(); }
  }
});

test('anonymous display has no request and login only navigates after a deliberate tap', async () => {
  const r = setup(() => { throw Error('anonymous request'); });
  try {
    r.auth.clear();
    await r.start();
    await r.checkout.showCode();
    assert.equal(r.checkout.loggedIn.value, false);
    assert.equal(r.calls.length, 0);
    assert.match(r.checkout.error.value, /请先登录/);
    r.checkout.login();
    assert.deepEqual(r.navigations, ['/pages/auth/login']);
    assert.equal(r.checkout.code.value, '');
  } finally { r.stop(); }
});

test('duplicate taps share one pending read and a failure permits an explicit retry', async () => {
  const first = deferred(); let reads = 0;
  const r = setup(() => ++reads === 1 ? first.promise : response(newCode));
  try {
    await r.start();
    const pending = r.checkout.showCode();
    await r.checkout.showCode();
    await tick();
    assert.equal(r.calls.length, 1);
    assert.equal(r.checkout.loading.value, true);
    first.resolve({ transport: 'offline' });
    await pending;
    assert.equal(r.checkout.code.value, '');
    assert.match(r.checkout.error.value, /offline/);
    assert.equal(r.checkout.loading.value, false);
    assert.equal(r.calls.length, 1);
    await r.checkout.showCode();
    assert.equal(r.checkout.code.value, newCode);
    assert.equal(r.checkout.error.value, '');
    assert.equal(r.calls.length, 2);
  } finally { first.resolve({ status: 400 }); r.stop(); }
});

test('hide/show clears displayed identity and never automatically reads the stable code', async () => {
  const r = setup(() => response(newCode));
  try {
    await r.start(); await r.checkout.showCode();
    r.hooks.onHide();
    assert.equal(r.checkout.code.value, '');
    assert.equal(r.checkout.loading.value, false);
    r.hooks.onShow(); await tick();
    assert.equal(r.checkout.code.value, '');
    assert.equal(r.calls.length, 1);
    await r.checkout.showCode();
    assert.equal(r.checkout.code.value, newCode);
  } finally { r.stop(); }
});

test('an older hidden response cannot publish or clear a newer display loading state', async () => {
  const first = deferred(), second = deferred(); let reads = 0;
  const r = setup(() => ++reads === 1 ? first.promise : second.promise);
  try {
    await r.start();
    const old = r.checkout.showCode(); await tick();
    r.hooks.onHide(); r.hooks.onShow();
    const fresh = r.checkout.showCode(); await tick();
    first.resolve(response('987654321')); await old;
    assert.equal(r.checkout.code.value, '');
    assert.equal(r.checkout.loading.value, true);
    second.resolve(response(newCode)); await fresh;
    assert.equal(r.checkout.code.value, newCode);
    assert.equal(r.checkout.loading.value, false);
  } finally { first.resolve({ status: 400 }); second.resolve({ status: 400 }); r.stop(); }
});

test('unload invalidates a pending read and prevents future display requests', async () => {
  const waiting = deferred();
  const r = setup(() => waiting.promise);
  try {
    await r.start(); const pending = r.checkout.showCode(); await tick();
    r.hooks.onUnload();
    assert.equal(r.checkout.code.value, '');
    assert.equal(r.checkout.loading.value, false);
    waiting.resolve(response(newCode)); await pending;
    r.hooks.onShow(); await r.checkout.showCode();
    assert.equal(r.checkout.code.value, '');
    assert.equal(r.calls.length, 1);
  } finally { waiting.resolve({ status: 400 }); r.stop(); }
});

test('session epoch changes immediately clear an existing code even with reused uid and token', async () => {
  const r = setup(() => response(newCode));
  try {
    await r.start(); await r.checkout.showCode();
    r.auth.setLogin(r.auth.token, r.auth.uid);
    assert.equal(r.checkout.code.value, '');
    assert.equal(r.checkout.loading.value, false);
    assert.match(r.checkout.error.value, /登录状态已变化/);
    await tick(); assert.equal(r.calls.length, 1);
    await r.checkout.showCode();
    assert.equal(r.checkout.code.value, newCode);
    r.auth.clear();
    assert.equal(r.checkout.code.value, '');
    assert.equal(r.checkout.loggedIn.value, false);
  } finally { r.stop(); }
});

test('an expired or replaced shopper request cannot expose its late member code', async () => {
  for (const replace of [auth => auth.setLogin('account-b', 22), auth => auth.setLogin(auth.token, auth.uid), auth => auth.clear()]) {
    const waiting = deferred();
    const r = setup(() => waiting.promise);
    try {
      await r.start(); const pending = r.checkout.showCode(); await tick();
      replace(r.auth);
      assert.equal(r.checkout.loading.value, false);
      waiting.resolve(response(newCode)); await pending;
      assert.equal(r.checkout.code.value, '');
      assert.equal(r.calls.length, 1);
    } finally { waiting.resolve({ status: 400 }); r.stop(); }
  }
});

test('authenticated API failure revokes the session through the real request layer', async () => {
  const r = setup(() => ({ status: 410001, msg: '登录已失效' }));
  try {
    await r.start(); await r.checkout.showCode();
    assert.equal(r.checkout.code.value, '');
    assert.equal(r.checkout.loading.value, false);
    assert.equal(r.auth.token, '');
    assert.deepEqual(r.navigations, ['/pages/auth/login']);
  } finally { r.stop(); }
});

test('draw failures clear only their own current code and permit another explicit display', async () => {
  const r = setup(() => response(newCode));
  try {
    await r.start(); await r.checkout.showCode();
    r.checkout.drawFailed('old-member-code');
    assert.equal(r.checkout.code.value, newCode);
    r.checkout.drawFailed(newCode);
    assert.equal(r.checkout.code.value, '');
    assert.match(r.checkout.error.value, /绘制失败/);
    await r.checkout.showCode(); assert.equal(r.checkout.code.value, newCode);
    r.hooks.onHide(); r.checkout.drawFailed(newCode);
    assert.equal(r.checkout.error.value, '');
  } finally { r.stop(); }
});

let componentUid = 500;
function qrRuntime(code, options = {}) {
  const file = path.join(root, 'src/components/MemberCodeQr.vue');
  const source = compileScript(parse(readFileSync(file, 'utf8'), { filename: file }).descriptor, { id: 'actual-member-qr' }).content;
  const output = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText;
  const mounted = [], unmounted = [], entries = [], emitted = [], timers = new Map();
  let timerId = 0;
  const props = vue.reactive({ code });
  const r = setup(() => { throw Error('canvas must not request'); });
  const fakeVue = { ...vue, defineComponent: value => value,
    getCurrentInstance: () => ({ uid: ++componentUid, proxy: {} }),
    onMounted: fn => mounted.push(fn), onUnmounted: fn => unmounted.push(fn),
    nextTick: options.nextTick ?? vue.nextTick };
  const native = { createCanvasContext(id, proxy) {
    assert.ok(proxy);
    if (options.fail === 'create') throw Error('native create failed');
    const entry = { id, operations: [], completion: null }; entries.push(entry);
    return {
      setFillStyle: color => entry.operations.push(['color', color]),
      fillRect: (...args) => {
        if (options.fail === 'paint') throw Error('native paint failed');
        entry.operations.push(['rect', ...args]);
      },
      draw(reserve, callback) {
        if (options.fail === 'draw') throw Error('native draw failed');
        entry.operations.push(['draw', reserve]); entry.completion = callback;
        if (!options.pending) callback();
      },
    };
  } };
  const exports = {};
  new Function('require', 'exports', 'uni', 'setTimeout', 'clearTimeout', output)(id => {
    if (id === 'vue') return fakeVue;
    if (id.startsWith('@/')) return r.load(path.join(root, 'src', id.slice(2)));
    return require(id);
  }, exports, native, (callback, ms) => { assert.equal(ms, 8000); const id = ++timerId; timers.set(id, callback); return id; }, id => timers.delete(id));
  const scope = vue.effectScope();
  const state = scope.run(() => exports.default.setup(props, { expose() {}, emit: (...args) => emitted.push(args) }));
  return { state, props, entries, emitted, timers,
    mount() { mounted.forEach(fn => fn()); },
    stop() { unmounted.forEach(fn => fn()); scope.stop(); r.stop(); },
  };
}

test('actual QR paints the exact UTF-8 member identity with four quiet modules and integer cells', async () => {
  for (const code of [newCode, '000123456', 'legacy-Code_07', '会员012345', '会员'.repeat(16)]) {
    const r = qrRuntime(code);
    try {
      r.mount(); await tick();
      assert.equal(r.entries.length, 1);
      assert.equal(r.state.ready.value, true);
      assert.equal(r.state.canvasVisible.value, true);
      assert.equal(r.timers.size, 0);
      const expected = new QRCode(0, levels.M);
      expected.addData(Buffer.from(code, 'utf8').toString('latin1')); expected.make();
      const count = expected.getModuleCount(), cell = Math.floor(256 / (count + 8));
      const size = (count + 8) * cell;
      assert.equal(r.state.canvasSize.value, size);
      assert.equal(r.state.displaySize.value, size);
      assert.ok(size <= 256 && cell >= 2);
      const ops = r.entries[0].operations;
      assert.deepEqual(ops.slice(0, 3), [['color', '#ffffff'], ['rect', 0, 0, size, size], ['color', '#172a42']]);
      assert.deepEqual(ops.at(-1), ['draw', false]);
      const blackCells = new Set();
      for (const [kind, x, y, width, height] of ops.slice(3, -1)) {
        assert.equal(kind, 'rect');
        assert.ok(Number.isInteger(x) && Number.isInteger(y));
        assert.equal(width, cell); assert.equal(height, cell);
        assert.ok(x >= 4 * cell && y >= 4 * cell && x < size - 4 * cell && y < size - 4 * cell);
        assert.equal(x % cell, 0); assert.equal(y % cell, 0);
        assert.equal(blackCells.has(`${x},${y}`), false);
        blackCells.add(`${x},${y}`);
      }
      for (let row = 0; row < count; row++) for (let col = 0; col < count; col++) {
        assert.equal(blackCells.has(`${(col + 4) * cell},${(row + 4) * cell}`), expected.isDark(row, col), `${code}: ${row},${col}`);
      }
    } finally { r.stop(); }
  }
});

test('empty code and unmount synchronously detach the canvas and invalidate late native draws', async () => {
  const r = qrRuntime(newCode, { pending: true });
  try {
    r.mount(); await tick();
    const old = r.entries[0];
    assert.equal(r.state.ready.value, false);
    r.props.code = '';
    assert.equal(r.state.canvasVisible.value, false);
    assert.equal(r.timers.size, 0);
    old.completion(); await tick();
    assert.equal(r.state.ready.value, false);
    assert.equal(r.state.canvasVisible.value, false);
    r.props.code = '987654321'; await tick();
    const fresh = r.entries[1];
    assert.notEqual(old.id, fresh.id);
    old.completion();
    assert.equal(r.state.ready.value, false);
    r.stop(); fresh.completion();
    assert.equal(r.state.canvasVisible.value, false);
    assert.equal(r.state.ready.value, false);
    assert.equal(r.emitted.length, 0);
  } finally { r.stop(); }
});

test('replacement codes and separate QR components use distinct canvas destinations', async () => {
  const first = qrRuntime(newCode), second = qrRuntime(newCode);
  try {
    first.mount(); second.mount(); await tick();
    assert.notEqual(first.entries[0].id, second.entries[0].id);
    first.props.code = '987654321';
    assert.equal(first.state.canvasVisible.value, false);
    await tick();
    assert.notEqual(first.entries[0].id, first.entries[1].id);
    assert.equal(first.state.ready.value, true);
  } finally { first.stop(); second.stop(); }
});

test('late preparation cannot create a canvas after the code is hidden', async () => {
  const waiting = deferred();
  const r = qrRuntime(newCode, { nextTick: () => waiting.promise });
  try {
    r.mount();
    r.props.code = '';
    waiting.resolve(); await tick();
    assert.equal(r.entries.length, 0);
    assert.equal(r.state.canvasVisible.value, false);
    assert.equal(r.emitted.length, 0);
  } finally { waiting.resolve(); r.stop(); }
});

test('native create, paint or draw errors remove the canvas before emitting a retryable failure', async () => {
  for (const fail of ['create', 'paint', 'draw']) {
    const r = qrRuntime(newCode, { fail });
    try {
      r.mount(); await tick();
      assert.equal(r.state.canvasVisible.value, false, fail);
      assert.equal(r.state.ready.value, false, fail);
      assert.equal(r.timers.size, 0, fail);
      assert.deepEqual(r.emitted, [['error', newCode]], fail);
    } finally { r.stop(); }
  }
});

test('a missing native draw callback times out and its eventual callback cannot restore content', async () => {
  const r = qrRuntime(newCode, { pending: true });
  try {
    r.mount(); await tick();
    assert.equal(r.timers.size, 1);
    r.timers.values().next().value();
    assert.equal(r.state.canvasVisible.value, false);
    assert.deepEqual(r.emitted, [['error', newCode]]);
    r.entries[0].completion();
    assert.equal(r.state.ready.value, false);
    assert.equal(r.state.canvasVisible.value, false);
  } finally { r.stop(); }
});

test('the actual legacy page delegates display state to the protected composable', async () => {
  const r = runtime({ component: 'pages/users/user_member_code/index.vue', send: () => response(newCode) });
  try {
    await r.start();
    assert.equal(r.calls.length, 0);
    await r.checkout.showCode();
    assert.equal(r.checkout.code.value, newCode);
    r.hooks.onHide();
    assert.equal(r.checkout.code.value, '');
    const page = readFileSync(path.join(root, 'src/pages/users/user_member_code/index.vue'), 'utf8');
    assert.match(page, /v-if="code"/);
    assert.match(page, /@error="drawFailed"/);
    assert.match(page, /显示会员核销码/);
    assert.doesNotMatch(page, /rand_code|user\/pay_code|<image|qrserver/);
  } finally { r.stop(); }
});
