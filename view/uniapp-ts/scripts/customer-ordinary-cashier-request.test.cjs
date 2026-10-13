const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runtime, deferred, tick } = require('./user-center-runtime.cjs');
const root = path.resolve(__dirname, '..');
const base = '/mobile/work/cashier/ordinary';
const creation = '12345678-1234-4123-8123-123456789abc';
const payment = '87654321-4321-4321-8321-cba987654321';
function fixture(send = () => ({ data: { accepted: true } }), deadline = 12000) {
  const r = runtime({ component: 'pages/customer-work/cashierRecords.vue', send });
  const api = r.load(path.join(root, 'src/api/customerWorkOrdinaryCashier.ts'));
  const frame = { current: true };
  const requests = api.createOrdinaryCashierRequests(() => frame.current, deadline);
  return { r, api, frame, requests, stop() { requests.abort(); r.stop(); } };
}
test('preserves a two-SKU guest draft, its buyer identity and its original operation', async () => {
  const f = fixture();
  try {
    const body = { version: f.api.CUSTOMER_ORDINARY_CASHIER_VERSION, scope_key: 'a'.repeat(64), buyer_uid: 0,
      tourist_key: 'guest-a', rows: [{ product_id: 70, sku_unique: 'physical-a', quantity: 2 },
        { product_id: 71, sku_unique: 'physical-b', quantity: 1 }] };
    const pending = f.requests.request(`${base}/drafts`, 'POST', body, creation);
    body.rows[0].quantity = 999;
    await pending;
    assert.equal(f.r.calls.length, 1);
    assert.equal(f.r.calls[0].data.buyer_uid, 0);
    assert.deepEqual(f.r.calls[0].data.rows.map(row => row.quantity), [2, 1]);
    assert.equal(f.r.calls[0].header['Idempotency-Key'], creation);
    assert.equal(f.r.calls[0].header['Authori-zation'], 'Bearer synthetic-local-token');
    assert.ok(f.r.calls[0].url.endsWith(`/api${base}/drafts`));
  } finally { f.stop(); }
});
test('keeps quotation, creation and cash payment operation identities separate', async () => {
  const f = fixture();
  try {
    await f.requests.request(`${base}/quote`, 'POST', { request_key: creation, intent: { buyer_uid: 0 } });
    await f.requests.request(`${base}/orders`, 'POST', { intent: { buyer_uid: 0 }, quote_token: 'server-token' }, creation);
    await f.requests.request(`${base}/orders/7/cash`, 'POST', {
      version: f.api.CUSTOMER_ORDINARY_CASHIER_PAYMENT_VERSION, scope_key: 'a'.repeat(64),
      order_id: 7, order_no: 'ORDINARY_7', expected_amount: '0.00',
    }, payment);
    assert.equal(f.r.calls[0].header['Idempotency-Key'], undefined);
    assert.equal(f.r.calls[0].data.request_key, creation);
    assert.equal(f.r.calls[1].header['Idempotency-Key'], creation);
    assert.equal(f.r.calls[2].header['Idempotency-Key'], payment);
    assert.equal(f.r.calls[2].data.expected_amount, '0.00');
  } finally { f.stop(); }
});
test('adds further SKU rows only through the original owner draft and a distinct operation UUID', async () => {
  const f = fixture();
  try {
    const body = { version: f.api.CUSTOMER_ORDINARY_CASHIER_VERSION, scope_key: 'a'.repeat(64),
      draft_key: creation, draft_hash: 'b'.repeat(64), rows: [{ product_id: 71, sku_unique: 'physical-b', quantity: 3 }] };
    await f.requests.request(`${base}/drafts/${creation}/rows`, 'POST', body, payment);
    assert.equal(f.r.calls[0].header['Idempotency-Key'], payment);
    assert.equal(f.r.calls[0].data.draft_key, creation);
    assert.equal(f.r.calls[0].data.draft_hash, body.draft_hash);
    await assert.rejects(f.requests.request(`${base}/drafts/not-a-uuid/rows`, 'POST', body, payment), /尚未提交/);
    assert.equal(f.r.calls.length, 1);
  } finally { f.stop(); }
});
test('uses only bounded read identities and the server-issued coupon quote token without write headers', async () => {
  const f = fixture();
  try {
    for (const url of [`${base}/readiness`, `${base}/catalog`, `${base}/catalog/70`, `${base}/users`,
      `${base}/users/21/addresses`, `${base}/quotes/${'c'.repeat(32)}/coupons`]) {
      await f.requests.request(url, 'GET', { scope_key: 'a'.repeat(64) });
      assert.equal(f.r.calls.at(-1).header['Idempotency-Key'], undefined);
    }
    for (const url of [`${base}/catalog/0`, `${base}/users/0/addresses`, `${base}/users/2147483648/addresses`,
      `${base}/quotes/${'C'.repeat(32)}/coupons`, `${base}/quotes/${creation}/coupons`]) {
      await assert.rejects(f.requests.request(url), /尚未提交/);
    }
    assert.equal(f.r.calls.length, 6);
  } finally { f.stop(); }
});
test('does not dispatch foreign authority, unsafe identifiers, or a write without an original UUID', async () => {
  const f = fixture();
  try {
    for (const [url, method, key] of [
      ['/admin/order/create', 'POST', creation], [`${base}/orders/0/cash`, 'POST', payment],
      [`${base}/orders/2147483648/cash`, 'POST', payment], [`${base}/orders/7/cash?override=1`, 'POST', payment],
      [`${base}/drafts`, 'POST', undefined], [`${base}/drafts`, 'POST', 'new-key'],
      [`${base}/operations/${creation}`, 'POST', creation], [`${base}/operations/${creation}`, 'GET', creation],
    ]) await assert.rejects(f.requests.request(url, method, {}, key), /尚未提交/);
    await assert.rejects(f.requests.request(`${base}/orders`, 'POST', { amount: BigInt(1) }, creation), /尚未提交/);
    assert.equal(f.r.calls.length, 0);
  } finally { f.stop(); }
});
test('recovers an ambiguous write only by reading the caller supplied original UUID', async () => {
  const f = fixture(call => call.method === 'POST' ? { transport: 'connection lost after submission' } : { data: { state: 'UNKNOWN' } });
  try {
    await assert.rejects(f.requests.request(`${base}/orders`, 'POST', { quote_token: 'original-token' }, creation));
    assert.equal(f.r.calls.length, 1);
    assert.deepEqual(await f.requests.request(`${base}/operations/${creation}`), { state: 'UNKNOWN' });
    assert.equal(f.r.calls.length, 2);
    assert.equal(f.r.calls[1].method, 'GET');
    assert.ok(f.r.calls[1].url.endsWith(`/operations/${creation}`));
    assert.equal(f.r.calls[1].header['Idempotency-Key'], undefined);
    assert.equal(f.r.calls.filter(call => call.method === 'POST').length, 1);
  } finally { f.stop(); }
});
test('rejects a late response after the actual account generation changes', async () => {
  const response = deferred(), f = fixture(() => response.promise);
  try {
    const pending = f.requests.request(`${base}/operations/${creation}`);
    const rejected = assert.rejects(pending, /页面或账号已变化/);
    f.r.auth.setLogin('new-owner-token', 12);
    response.resolve({ data: { private_old_owner_receipt: true } });
    await rejected;
    assert.equal(f.requests.active(), false);
    await assert.rejects(f.requests.request(`${base}/operations/${creation}`), /原经营账号/);
    assert.equal(f.r.calls.length, 1);
    assert.equal(f.r.aborts.length, 1);
  } finally { f.stop(); }
});
test('aborts an ambiguous timed out write and ignores its late success without resubmitting', async () => {
  const response = deferred(), f = fixture(() => response.promise, 2);
  try {
    await assert.rejects(f.requests.request(`${base}/orders`, 'POST', { quote_token: 'original' }, creation), /超时/);
    response.resolve({ data: { order_id: 7 } });
    await tick();
    assert.equal(f.r.calls.length, 1);
    assert.equal(f.r.aborts.length, 1);
  } finally { f.stop(); }
});
test('releases outstanding requests on disposal and treats an HTTP error as unconfirmed', async () => {
  const response = deferred(), f = fixture(() => response.promise);
  try {
    const pending = f.requests.request(`${base}/drafts/${creation}`);
    const rejected = assert.rejects(pending, /页面或账号已变化/);
    f.requests.abort();
    response.resolve({ data: { draft_hash: 'old-private-content' } });
    await rejected;
    assert.equal(f.r.aborts.length, 1);
  } finally { f.stop(); }
  const rejectedHttp = fixture(() => ({ httpStatus: 503, status: 200, data: { order_id: 7 } }));
  try {
    await assert.rejects(rejectedHttp.requests.request(`${base}/orders`, 'POST', {}, creation), /未确认/);
    assert.equal(rejectedHttp.r.calls.length, 1);
  } finally { rejectedHttp.stop(); }
});
test('permanent closure binds the exact original URI and header UUID', async () => {
  const f = fixture(); try {
    const path = `${base}/operations/${creation}/abandon`, body = { kind: 'draft', intent: { buyer_uid: 0 } };
    await f.requests.request(path, 'POST', body, creation);
    assert.equal(f.r.calls[0].header['Idempotency-Key'], creation);
    assert.ok(f.r.calls[0].url.endsWith(`/api${path}`));
    await assert.rejects(f.requests.request(path, 'POST', body, payment), /同一原请求编号/);
    await assert.rejects(f.requests.request(path, 'GET'), /地址或原请求编号/);
    assert.equal(f.r.calls.length, 1);
  } finally { f.stop(); }
});
