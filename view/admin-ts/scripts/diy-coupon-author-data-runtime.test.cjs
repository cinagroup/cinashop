const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const file = path.resolve(__dirname, '../src/api/diyCouponAuthor.ts');
const coupon = (patch = {}) => ({ id: 7, type: 0, coupon_type: 1, coupon_title: '真实公开券', coupon_price: '5', use_min_price: '0.0', is_use: false, remain_count: 9, receive_limit: 1, ...patch });
const data = (list = [coupon()], count = [1, 0, 0, 0]) => ({ list, count });
const envelope = (value = data(), patch = {}) => ({ status: 200, msg: 'ok', data: value, ...patch });
const response = (body = envelope(), status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function setup(send = () => response()) {
  const calls = [], forbidden = [];
  const fail = name => { forbidden.push(name); throw Error('Anonymous coupon preview must not access ' + name); };
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  // Real API implementation runs; only the browser transport is replaced.
  // localhost preview=1 must never substitute hardcoded coupon fixtures.
  new Function('exports', 'fetch', 'window', 'localStorage', 'uni', 'require', output)(exports, async (url, init) => { const call = { url, init }; calls.push(call); return send(call); },
    { location: { hostname: 'localhost', search: '?preview=1&token=ADMIN' } },
    { getItem: () => fail('admin storage read'), setItem: () => fail('admin storage write'), removeItem: () => fail('admin storage delete') },
    { getStorageSync: () => fail('claim journal read'), setStorageSync: () => fail('claim journal write'), removeStorageSync: () => fail('claim journal delete'), navigateTo: () => fail('navigation') },
    name => fail('application import ' + name));
  return { ...exports, calls, forbidden };
}

test('guest DTO validates the entire envelope and returns only current Uni coupon fields without mutating the input', () => {
  const u = setup(), raw = data([coupon({ ignored: { image: '/api/assets/8?expires=1&signature=old', token: 'ADMIN' }, products: [{ image: '/private.png' }] })]), before = structuredClone(raw);
  assert.deepEqual(u.checkedDiyCouponPublicRows(raw, 1), [{ id: 7, type: 0, coupon_type: 1, coupon_title: '真实公开券', coupon_price: '5.00', use_min_price: '0.00', is_use: false, remain_count: 9, receive_limit: 1 }]);
  assert.deepEqual(raw, before); assert.deepEqual(u.calls, []); assert.deepEqual(u.forbidden, []);
});

test('all four scope kinds retain distinct cash/discount meaning and expired2 is not treated as a claim', () => {
  const u = setup();
  const raw = data(Array.from({ length: 4 }, (_, type) => coupon({ id: type + 1, type, coupon_type: type % 2 + 1, coupon_price: type ? 85.5 : 0, is_use: type === 3 ? 2 : false })), [1, 1, 1, 1]);
  const rows = u.checkedDiyCouponPublicRows(raw, 4);
  assert.deepEqual(rows.map(row => [row.type, row.coupon_type, row.coupon_price, row.is_use]), [[0, 1, '0.00', false], [1, 2, '85.50', false], [2, 1, '85.50', false], [3, 2, '85.50', 2]]);
});

test('guest cannot adopt owned true even with a claimed foreign or zero-owner used receipt', () => {
  const u = setup();
  for (const used of [undefined, null, {}, { id: 1, cid: 7, uid: 0 }, { id: 1, cid: 7, uid: 22 }]) assert.throws(() => u.checkedDiyCouponPublicRows(data([coupon({ is_use: true, used })]), 1), /游客|已领取/);
  for (const is_use of [undefined, null, 0, 1, 'false', '2', 3, {}]) assert.throws(() => u.checkedDiyCouponPublicRows(data([coupon({ is_use })]), 1), /格式错误/);
});

test('full list validation rejects an invalid tail and duplicate IDs without truncation deduplication or a partial result', () => {
  const u = setup();
  for (const list of [[coupon(), coupon({ id: 8, type: 99 })], [coupon(), coupon({ coupon_title: 'later duplicate' })], [coupon(), null], [coupon(), false], Array(1)]) {
    const raw = data(list), before = structuredClone(raw); assert.throws(() => u.checkedDiyCouponPublicRows(raw, 2), /格式错误|重复/); assert.deepEqual(raw, before);
  }
  assert.throws(() => u.checkedDiyCouponPublicRows(data([coupon(), coupon({ id: 8 })]), 1), /列表/);
});

test('four counts are required nonnegative int32 values including dense array shape', () => {
  const u = setup();
  for (const count of [undefined, null, {}, [], [1, 0, 0], [1, 0, 0, 0, 0], [1, -1, 0, 0], [1, '0', 0, 0], [1, false, 0, 0], [1, 0, NaN, 0], [1, 0, 0, 2147483648], Array(4)]) assert.throws(() => u.checkedDiyCouponPublicRows({ list: [coupon()], count }, 1), /数量格式错误/);
  assert.deepEqual(u.checkedDiyCouponPublicRows(data([], [0, 7, 2147483647, 0]), 1), []);
});

test('identity scope discount and stock fields require real integers rather than coercible input', () => {
  const u = setup();
  for (const patch of [{ id: 0 }, { id: -1 }, { id: '7' }, { id: 2147483648 }, { id: 1.1 }, { type: -1 }, { type: 4 }, { type: '0' }, { type: false }, { coupon_type: 0 }, { coupon_type: 3 }, { coupon_type: '1' }, { remain_count: -1 }, { remain_count: '9' }, { receive_limit: false }, { receive_limit: 2147483648 }]) assert.throws(() => u.checkedDiyCouponPublicRows(data([coupon(patch)]), 1), /格式错误/);
});

test('money normalization matches the public two-decimal contract without guessing a different discount range', () => {
  const u = setup();
  for (const [raw, normalized] of [[0, '0.00'], ['0', '0.00'], [8.5, '8.50'], ['0.01', '0.01'], ['100', '100.00'], ['9999999999.99', '9999999999.99']]) {
    const row = u.checkedDiyCouponPublicRows(data([coupon({ coupon_price: raw, use_min_price: raw })]), 1)[0]; assert.equal(row.coupon_price, normalized); assert.equal(row.use_min_price, normalized);
  }
  for (const raw of [undefined, null, false, '', ' 5 ', '00', '1e2', '.5', '-1', '-0.00', '1.001', '10000000000', NaN, Infinity]) {
    for (const key of ['coupon_price', 'use_min_price']) assert.throws(() => u.checkedDiyCouponPublicRows(data([coupon({ [key]: raw })]), 1), /金额格式错误/);
  }
});

test('title strings have the same1024 and control-character boundary as the public consumer', () => {
  const u = setup();
  assert.equal(u.checkedDiyCouponPublicRows(data([coupon({ coupon_title: '' })]), 1)[0].coupon_title, '');
  assert.equal(u.checkedDiyCouponPublicRows(data([coupon({ coupon_title: '券'.repeat(1024) })]), 1)[0].coupon_title.length, 1024);
  for (const title of [undefined, null, 7, {}, '券'.repeat(1025), '控制\n字符', '\u0000', '\u007f']) assert.throws(() => u.checkedDiyCouponPublicRows(data([coupon({ coupon_title: title })]), 1), /格式错误/);
});

test('root and list shape are strict and an empty live directory remains empty', () => {
  const u = setup();
  for (const raw of [undefined, null, false, [], '[]', { count: [0, 0, 0, 0] }, data(null), data({}), data('[]')]) assert.throws(() => u.checkedDiyCouponPublicRows(raw, 1), /格式错误/);
  assert.deepEqual(u.checkedDiyCouponPublicRows(data([], [0, 0, 0, 0]), 10), []);
});

test('strict1..10 I/O limit rejects every bad input before transport or payload inspection', async () => {
  const u = setup();
  for (const limit of [undefined, null, false, '3', 0, -1, 1.5, 11, 100, NaN, Infinity]) {
    assert.throws(() => u.checkedDiyCouponPublicRows(data(), limit), /整数/); await assert.rejects(u.apiDiyCouponPreview(limit), /整数/);
  }
  assert.deepEqual(u.calls, []); assert.deepEqual(u.forbidden, []);
});

test('actual guest API sends one exact GET with original signal Accept only omit and no-store even in localhost preview mode', async () => {
  const u = setup(), controller = new AbortController(), rows = await u.apiDiyCouponPreview(3, controller.signal);
  assert.equal(rows[0].id, 7); assert.equal(u.calls.length, 1); const { url, init } = u.calls[0];
  assert.equal(url, '/api/v2/coupons?page=1&limit=3'); assert.deepEqual(Object.keys(init).sort(), ['cache', 'credentials', 'headers', 'method', 'signal']);
  assert.equal(init.method, 'GET'); assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store'); assert.deepEqual(init.headers, { Accept: 'application/json' }); assert.strictEqual(init.signal, controller.signal);
  assert.equal(Object.hasOwn(init, 'body'), false); assert.deepEqual(u.forbidden, []);
});

test('signal is optional without adding credentials pagination filters selected IDs or fixture reads', async () => {
  const u = setup(() => response(envelope(data([], [0, 0, 0, 0])))); assert.deepEqual(await u.apiDiyCouponPreview(10), []);
  assert.equal(u.calls[0].url, '/api/v2/coupons?page=1&limit=10'); assert.equal(u.calls[0].init.signal, undefined); assert.deepEqual(u.forbidden, []);
});

test('network HTTP business and malformed JSON failures stay explicit read errors and never create fixture rows', async () => {
  for (const send of [() => { throw Error('owned network failure'); }, () => response(envelope(data()), 503), () => response(envelope(null, { status: 400, msg: '真实错误' })), () => ({ ok: true, status: 200, json: async () => { throw Error('bad JSON'); } })]) {
    const u = setup(send); await assert.rejects(u.apiDiyCouponPreview(1)); assert.equal(u.calls.length, 1); assert.deepEqual(u.forbidden, []);
  }
});

test('all envelope fields are required before a successful HTTP receipt may expose data', async () => {
  for (const body of [null, [], false, {}, { status: '200', msg: 'ok', data: data() }, { status: 200, data: data() }, { status: 200, msg: null, data: data() }, { status: 200, msg: 'ok' }, envelope(null)]) {
    const u = setup(() => response(body)); await assert.rejects(u.apiDiyCouponPreview(1), /格式错误/); assert.equal(u.calls.length, 1);
  }
});

test('the API checks the complete real DTO and can explicitly retry after failure without POST or journal mutation', async () => {
  let invalid = true; const u = setup(() => response(envelope(data(invalid ? [coupon(), coupon({ id: 8, remain_count: -1 })] : [coupon()], [2, 0, 0, 0]))));
  await assert.rejects(u.apiDiyCouponPreview(2), /格式错误/); invalid = false; assert.equal((await u.apiDiyCouponPreview(2))[0].id, 7);
  assert.equal(u.calls.length, 2); assert.ok(u.calls.every(call => call.init.method === 'GET' && call.url === '/api/v2/coupons?page=1&limit=2')); assert.deepEqual(u.forbidden, []);
});

test('a signal already cancelled forbids all coupon I/O and preserves its exact reason', async () => {
  const u = setup(), controller = new AbortController(), reason = new Error('owned cancellation'); controller.abort(reason);
  await assert.rejects(u.apiDiyCouponPreview(1, controller.signal), error => error === reason); assert.deepEqual(u.calls, []);
});

test('a late transport receipt cannot be adopted after cancellation even if the fake/native transport ignores abort', async () => {
  const wait = deferred(), u = setup(() => wait.promise), controller = new AbortController(), reason = new Error('owner changed');
  const job = u.apiDiyCouponPreview(1, controller.signal), rejected = assert.rejects(job, error => error === reason); controller.abort(reason); wait.resolve(response()); await rejected;
  assert.equal(u.calls.length, 1); assert.deepEqual(u.forbidden, []);
});

test('cancellation while reading response JSON also prevents row adoption and second transport work', async () => {
  const wait = deferred(), u = setup(() => ({ ok: true, status: 200, json: () => wait.promise })), controller = new AbortController(), reason = new Error('page changed');
  const job = u.apiDiyCouponPreview(1, controller.signal), rejected = assert.rejects(job, error => error === reason); await Promise.resolve(); await Promise.resolve(); controller.abort(reason); wait.resolve(envelope()); await rejected;
  assert.equal(u.calls.length, 1); assert.deepEqual(u.forbidden, []);
});
