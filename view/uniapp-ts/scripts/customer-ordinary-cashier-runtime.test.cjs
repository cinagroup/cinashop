const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto'), path = require('node:path');
const vue = require('vue');
const { runtime, deferred, tick } = require('./user-center-runtime.cjs');
const root = path.resolve(__dirname, '..'), scope = 'a'.repeat(64), fingerprint = 'f'.repeat(64);
const clone = value => structuredClone(value);
const canonical = v => Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object'
  ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v);
const digest = v => crypto.createHash('sha256').update(canonical(v), 'utf8').digest('hex');
function fixture(options = {}) {
  const receipts = new Map(), flags = { visible: true, writes: options.writes !== false }, observed = [];
  let currentDraft = null, r;
  const envelope = data => ({ version: 'customer-cashier-ordinary-read-v1', actor_uid: 11, scope_key: scope,
    principal: { kind: 'customer-order-manager', service_id: 19, scope: 'global' }, consistency_key: digest({ scope_key: scope, data }), data: clone(data) });
  const receipt = (key, kind, intent, evidence) => ({ version: 'customer-cashier-ordinary-receipt-v1', actor_uid: 11, request_key: key,
    request_hash: digest(intent), scope_key: scope, kind, intent: clone(intent), evidence: clone(evidence) });
  const result = value => ({ version: 'customer-cashier-ordinary-result-v1', actor_uid: 11, request_key: value.request_key,
    request_hash: value.request_hash, kind: value.kind, replayed: false, receipt: clone(value) });
  const draftBody = () => ({ version: 'customer-cashier-ordinary-v1', scope_key: scope, buyer_uid: 0, tourist_key: 'guest-real',
    rows: [{ product_id: 70, sku_unique: 'sku-a', quantity: 2 }, { product_id: 71, sku_unique: 'sku-b', quantity: 1 }] });
  const creationBody = () => ({ version: currentDraft.version, scope_key: scope, draft_key: currentDraft.draft_key, draft_hash: currentDraft.draft_hash,
    buyer_uid: 0, tourist_key: currentDraft.tourist_key, coupon_id: 0, use_integral: false, shipping_type: 2, store_id: 3, address_id: 0,
    manual_address: null, real_name: '', user_phone: '', mark: '', custom_form: null });
  function commitDraft(call) {
    const key = call.header['Idempotency-Key'];
    currentDraft = { version: call.data.version, actor_uid: 11, draft_key: key, draft_hash: digest(call.data), scope_key: scope,
      buyer_uid: call.data.buyer_uid, tourist_key: call.data.tourist_key,
      rows: call.data.rows.map((row, index) => ({ cart_id: 100 + index, ...row, removed: false, consumed: false })) };
    const value = receipt(key, 'draft', call.data, { outcome: 'draft-created', draft: currentDraft }); receipts.set(key, value); return value;
  }
  async function server(call) {
    const suffix = call.url.split('/ordinary')[1], key = call.header['Idempotency-Key'];
    observed.push({ suffix, method: call.method, key });
    if (call.method === 'POST' && suffix !== '/quote') {
      const saved = r.uni.getStorageSync('customer_cashier_ordinary_pending_v1');
      assert.ok(saved?.some(row => row.request_key === key && row.actor_uid === 11), 'original request must be durable before every write');
      options.beforeWrite?.(call, saved);
    }
    const intercepted = await options.intercept?.(call, { suffix, commitDraft, receipts, envelope, receipt, result });
    if (intercepted !== undefined) return intercepted;
    if (suffix === '/readiness') return { data: envelope({ writes: flags.writes, reason: flags.writes ? 'ready' : 'ordinary_source_not_commissioned', product_types: [0], max_rows: 200,
      payments: { cash: flags.writes, zero: flags.writes, weixin: false, alipay: false } }) };
    if (/^\/operations\/[a-f0-9-]+\/abandon$/u.test(suffix) && call.method === 'POST') {
      const original = suffix.split('/')[2], prior = receipts.get(original);
      if (prior) return { data: result(prior) };
      const terminal = receipt(original, 'abandon', call.data.intent, { outcome: 'operation-abandoned', original_kind: call.data.kind });
      receipts.set(original, terminal); return { data: result(terminal) };
    }
    if (suffix.startsWith('/operations/')) {
      const original = suffix.slice('/operations/'.length);
      return { data: { version: 'customer-cashier-ordinary-receipt-v1', actor_uid: 11, request_key: original, receipt: clone(receipts.get(original) ?? null) } };
    }
    if (suffix === '/drafts' && call.method === 'POST') return { data: result(commitDraft(call)) };
    if (/^\/drafts\/[a-f0-9-]+$/u.test(suffix)) return { data: envelope({ draft: currentDraft, readiness: { writes: flags.writes, reason: flags.writes ? 'ready' : 'closed' } }) };
    if (suffix === '/quote') {
      const body = call.data.intent, quantity = currentDraft.rows.filter(row => !row.removed).reduce((sum, row) => sum + row.quantity, 0);
      return { data: envelope({ request_key: call.data.request_key, request_hash: digest(body), draft_key: body.draft_key, draft_hash: body.draft_hash,
        quote_token: 'b'.repeat(32), quote_fingerprint: fingerprint, expires_at: Math.floor(Date.now() / 1000) + 1800,
        pricing: { currency: 'CNY', amount: '30.00', total: '30.00', raw_total: '30.00', quantity, postage: '0.00', raw_postage: '0.00',
          coupon_discount: '0.00', integral_discount: '0.00', first_order_discount: '0.00', membership_discount: '0.00', promotion_discount: '0.00',
          used_integral: 0, remaining_integral: 0, integral_policy: { enabled: false, ratio: 100 }, gives_integral: 0,
          product_gives_integral: 0, promotion_gives_integral: 0 },
        items: currentDraft.rows.filter(row => !row.removed).map(row => ({ cart_id: row.cart_id, raw_unit_price: '10.00', unit_price: '10.00',
          total_price: `${row.quantity * 10}.00`, discount: '0.00', price_type: 'normal' })), system_form: null,
        coupons: { list: [], next_cursor: null }, promotion_gifts: { integral: 0, coupons: [], products: [], promotions: [] } }) };
    }
    if (suffix === '/orders') {
      const body = call.data.intent, value = receipt(key, 'creation', body, { outcome: 'order-created', order: { order_id: 77, order_no: 'wx-real-77',
        buyer_uid: 0, creator_uid: 11, pay_price: '30.00', paid: 0, pay_type: '', shipping_type: body.shipping_type, store_id: body.store_id, total_num: 3 },
        origin_hash: 'c'.repeat(64), quote_fingerprint: fingerprint }); receipts.set(key, value); return { data: result(value) };
    }
    if (suffix === '/orders/77/cash') {
      const body = call.data, value = receipt(key, 'payment', body, { outcome: body.expected_amount === '0.00' ? 'zero-paid' : 'cash-paid',
        payment: { order_id: 77, order_no: body.order_no, buyer_uid: 0, creator_uid: options.creatorUid ?? 11, payer_uid: 11, paid: 1,
          pay_type: 'cash', pay_time: Math.floor(Date.now() / 1000), amount: body.expected_amount, origin_hash: 'c'.repeat(64), status_id: 90,
          outbox: { id: 91, event_key: 'order.paid:77', event_type: 'order.paid', payload_hash: 'e'.repeat(64) } } });
      receipts.set(key, value); return { data: result(value) };
    }
    throw Error(`Unexpected ordinary request: ${call.method} ${suffix}`);
  }
  r = runtime({ component: 'pages/customer-work/cashierRecords.vue', send: server, modal: options.confirm !== false });
  const manager = { auth: r.auth, context: vue.ref({ actor_uid: 11, scope_key: scope, principal: { kind: 'customer-order-manager', scope: 'global', service_id: 19 },
    data: { capabilities: { cashier_ordinary: flags.writes }, cashier_ordinary_readiness: { writes: flags.writes, reason: flags.writes ? 'ready' : 'closed' } } }),
    current: () => flags.visible, fence: () => () => flags.visible, invalidate: () => { manager.context.value = null; } };
  const protocol = r.load(path.join(root, 'src/utils/customerWorkOrdinaryCashier.ts'));
  const operations = r.load(path.join(root, 'src/composables/useCustomerOrdinaryCashier.ts')).useCustomerOrdinaryCashier(manager);
  return { r, flags, manager, operations, protocol, observed, receipts, draftBody, creationBody, commitDraft,
    stop() { flags.visible = false; operations.clearDomain(); r.stop(); } };
}
test('persists before draft and creation writes, confirms them by the original GET and keeps payment independent', async () => {
  const f = fixture(); try {
    await f.operations.load(); const draft = await f.operations.beginDraft(f.draftBody()); assert.equal(draft.kind, 'draft');
    const quote = await f.operations.prepareQuote(f.creationBody()); assert.equal(quote.kind, 'creation');
    assert.notEqual(quote.request_key, draft.request_key);
    assert.equal(f.protocol.ordinaryCashierPending().length, 1, 'unconfirmed quotation does not create a financial pending write');
    const created = await f.operations.create(); assert.equal(created.evidence.order.paid, 0);
    const source = { order_id: 77, order_no: 'wx-real-77', buyer_uid: 0, creator_uid: 11, amount: '30.00', origin_hash: 'c'.repeat(64), creation_key: created.request_key };
    const paid = await f.operations.pay(source); assert.equal(paid.evidence.payment.paid, 1);
    assert.notEqual(paid.request_key, created.request_key); assert.notEqual(paid.request_key, draft.request_key);
    const writes = f.observed.filter(row => row.method === 'POST' && row.suffix !== '/quote');
    assert.equal(writes.length, 3);
    for (const row of writes) assert.equal(f.observed.filter(next => next.suffix === `/operations/${row.key}` && next.method === 'GET').length, 1);
    assert.equal(f.r.modals.length, 2);
    for (const original of [...f.operations.pending.value]) f.operations.acknowledge(original);
    assert.equal(f.protocol.ordinaryCashierPending().length, 0);
    assert.equal(f.operations.payment.value.evidence.payment.paid, 1, 'closing the local journal keeps the verified paid fact visible');
  } finally { f.stop(); }
});
test('a lost write response with no GET receipt remains UNKNOWN; checking never replaces the UUID or retries POST', async () => {
  const f = fixture({ intercept: (call, s) => s.suffix === '/drafts' && call.method === 'POST' ? { transport: 'connection lost after send' } : undefined });
  try {
    await f.operations.load(); assert.equal(await f.operations.beginDraft(f.draftBody()), null);
    const [original] = f.operations.pending.value; assert.ok(original); assert.equal(f.operations.unresolved.value, true);
    await f.operations.check(original); await f.operations.check(original);
    assert.equal(f.observed.filter(row => row.method === 'POST').length, 1);
    assert.ok(f.observed.filter(row => row.suffix.startsWith('/operations/')).every(row => row.suffix === `/operations/${original.request_key}`));
    await assert.rejects(f.operations.beginDraft(f.draftBody()), /先核对/);
    assert.throws(() => f.operations.acknowledge(original), /不能关闭/);
    assert.equal(f.protocol.ordinaryCashierPending().length, 1);
  } finally { f.stop(); }
});
test('recovers a committed original receipt after transport loss without a second write', async () => {
  const f = fixture({ intercept: (call, s) => {
    if (s.suffix === '/drafts' && call.method === 'POST') { s.commitDraft(call); return { transport: 'response lost' }; }
  } });
  try {
    await f.operations.load(); const receipt = await f.operations.beginDraft(f.draftBody());
    assert.equal(receipt.kind, 'draft'); assert.equal(f.operations.draft.value.rows.length, 2);
    assert.equal(f.observed.filter(row => row.method === 'POST').length, 1);
    assert.equal(f.operations.states.value[receipt.request_key].receipt.request_key, receipt.request_key);
    f.operations.acknowledge(f.operations.pending.value[0]); assert.equal(f.protocol.ordinaryCashierPending().length, 0);
  } finally { f.stop(); }
});
test('storage failure stops the operation before HTTP; a foreign scope is rejected before sending', async () => {
  const f = fixture(); try {
    await f.operations.load(); const originalSet = f.r.uni.setStorageSync; f.r.uni.setStorageSync = () => {};
    assert.equal(await f.operations.beginDraft(f.draftBody()), null);
    assert.match(f.operations.error.value, /保存未确认/);
    assert.equal(f.observed.filter(row => row.method === 'POST').length, 0);
    f.r.uni.setStorageSync = originalSet;
    assert.equal(await f.operations.beginDraft({ ...f.draftBody(), scope_key: 'b'.repeat(64) }), null);
    assert.equal(f.observed.filter(row => row.method === 'POST').length, 0);
  } finally { f.stop(); }
});
test('an account change rejects late private callbacks and keeps the original actor durable record', async () => {
  const delayed = deferred();
  const f = fixture({ intercept: (call, s) => s.suffix === '/drafts' && call.method === 'POST' ? delayed.promise : undefined });
  try {
    await f.operations.load(); const sending = f.operations.beginDraft(f.draftBody()); await tick();
    const original = f.protocol.ordinaryCashierPending()[0]; assert.equal(original.actor_uid, 11);
    f.r.auth.setLogin('new-account-token', 12); f.operations.clearDomain();
    delayed.resolve({ data: { order_id: 999, private_buyer: 'old account' } });
    assert.equal(await sending, null); assert.equal(f.operations.draft.value, null); assert.equal(f.operations.created.value, null);
    assert.equal(f.operations.pending.value.length, 0); assert.equal(f.protocol.ordinaryCashierPending()[0].actor_uid, 11);
    assert.equal(f.observed.filter(row => row.suffix.startsWith('/operations/')).length, 0);
  } finally { f.stop(); }
});
test('original receipt recovery works after manager authority is removed while new writes remain closed', async () => {
  const f = fixture(); try {
    await f.operations.load(); const receipt = await f.operations.beginDraft(f.draftBody()), original = f.operations.pending.value[0];
    f.operations.clearDomain(); f.manager.context.value = null;
    const recovered = await f.operations.check(original); assert.equal(recovered.request_key, receipt.request_key);
    assert.equal(f.operations.canWrite.value, false); f.operations.acknowledge(original);
    assert.equal(f.protocol.ordinaryCashierPending().length, 0);
    await assert.rejects(f.operations.beginDraft(f.draftBody()), /暂不可提交/);
  } finally { f.stop(); }
});
test('a closed source gate stops all writes and cancelling confirmation creates no financial pending request', async () => {
  const closed = fixture({ writes: false }); try {
    await closed.operations.load(); await assert.rejects(closed.operations.beginDraft(closed.draftBody()), /暂不可提交/);
    assert.equal(closed.observed.filter(row => row.method === 'POST').length, 0);
  } finally { closed.stop(); }
  const f = fixture({ confirm: false }); try {
    await f.operations.load(); await f.operations.beginDraft(f.draftBody()); await f.operations.prepareQuote(f.creationBody());
    assert.equal(await f.operations.create(), null);
    assert.equal(f.observed.filter(row => row.suffix === '/orders').length, 0);
    assert.equal(f.protocol.ordinaryCashierPending().length, 1);
    assert.equal(f.operations.pending.value[0].kind, 'draft');
  } finally { f.stop(); }
});
test('cash and zero confirmations preserve a different creator and the guest buyer', async () => {
  for (const amount of ['30.00', '0.00']) {
    const f = fixture({ creatorUid: 23 }); try {
      await f.operations.load(); const source = { order_id: 77, order_no: 'wx-real-77', buyer_uid: 0, creator_uid: 23, amount,
        origin_hash: 'c'.repeat(64), creation_key: '22222222-2222-4222-8222-222222222222' };
      const paid = await f.operations.pay(source); assert.equal(paid.evidence.payment.creator_uid, 23);
      assert.equal(paid.evidence.payment.payer_uid, 11); assert.equal(paid.evidence.payment.buyer_uid, 0);
      assert.equal(paid.evidence.payment.amount, amount); assert.equal(f.r.modals.length, 1);
      assert.equal(f.r.calls.find(call => call.method === 'POST').header['Authori-zation'], 'Bearer synthetic-local-token');
    } finally { f.stop(); }
  }
});
test('corrupted storage after switching accounts clears private visible recovery data without deleting the original storage', async () => {
  const f = fixture(); try {
    await f.operations.load(); await f.operations.beginDraft(f.draftBody()); assert.equal(f.operations.pending.value.length, 1);
    const key = f.protocol.ORDINARY_CASHIER_PENDING_STORAGE, damaged = clone(f.r.uni.getStorageSync(key)); damaged[0].request_hash = '0'.repeat(64);
    f.r.uni.setStorageSync(key, damaged); f.r.auth.setLogin('other-account-token', 12); f.operations.clearDomain();
    assert.equal(f.operations.pending.value.length, 0); assert.equal(f.operations.created.value, null); assert.equal(f.operations.draft.value, null);
    assert.match(f.operations.error.value, /记录损坏/); assert.deepEqual(f.r.uni.getStorageSync(key), damaged);
  } finally { f.stop(); }
});
test('permanent closure after NULL recovery uses the same UUID and only its verified terminal receipt releases the journal', async () => {
  const f = fixture({ intercept: (call, s) => s.suffix === '/drafts' && call.method === 'POST' ? { transport: 'unknown draft' } : undefined });
  try {
    await f.operations.load(); await f.operations.beginDraft(f.draftBody()); const [original] = f.operations.pending.value;
    const terminal = await f.operations.abandon(original); assert.equal(terminal.kind, 'abandon');
    const closures = f.r.calls.filter(call => call.url.endsWith('/abandon'));
    assert.equal(closures.length, 1); assert.equal(closures[0].header['Idempotency-Key'], original.request_key);
    assert.ok(closures[0].url.endsWith(`/operations/${original.request_key}/abandon`));
    assert.deepEqual(closures[0].data, { kind: original.kind, intent: original.body });
    assert.equal(f.protocol.ordinaryCashierPending().length, 1);
    f.operations.acknowledge(original); assert.equal(f.protocol.ordinaryCashierPending().length, 0);
    assert.equal(f.r.modals.length, 1);
  } finally { f.stop(); }
});
test('closure returns an already committed fact without sending a permanent abandonment write', async () => {
  const f = fixture(); try {
    await f.operations.load(); const draft = await f.operations.beginDraft(f.draftBody()), original = f.operations.pending.value[0];
    assert.equal((await f.operations.abandon(original)).kind, 'draft');
    assert.equal(f.r.calls.filter(call => call.url.endsWith('/abandon')).length, 0);
    assert.equal(f.r.modals.length, 0); assert.equal(f.receipts.get(draft.request_key).kind, 'draft');
  } finally { f.stop(); }
});
test('the original owner can permanently close an UNKNOWN request after manager role removal', async () => {
  const f = fixture({ intercept: (call, s) => s.suffix === '/drafts' && call.method === 'POST' ? { transport: 'unknown draft' } : undefined });
  try {
    await f.operations.load(); await f.operations.beginDraft(f.draftBody()); const [original] = f.operations.pending.value;
    f.operations.clearDomain(); f.manager.context.value = null;
    assert.equal((await f.operations.abandon(original)).kind, 'abandon');
    assert.equal(f.operations.canWrite.value, false);
    f.operations.acknowledge(original); assert.equal(f.protocol.ordinaryCashierPending().length, 0);
    const closure = f.r.calls.find(call => call.url.endsWith('/abandon'));
    assert.equal(closure.header['Authori-zation'], 'Bearer synthetic-local-token');
  } finally { f.stop(); }
});
