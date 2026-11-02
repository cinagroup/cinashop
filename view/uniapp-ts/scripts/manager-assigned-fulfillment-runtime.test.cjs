/** Actual Vue/Pinia page, request adapter, protocol and local journal. These
 * local HTTP fixtures test client behavior; they do not manufacture PG proof. */
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto'), path = require('node:path'), fs = require('node:fs');
const { runtime, tick, deferred, render } = require('./user-center-runtime.cjs');
const root = path.resolve(__dirname, '..'), scope = 'a'.repeat(64), revision = 'b'.repeat(64), sourceHash = 'c'.repeat(64), grantHash = 'd'.repeat(64);
const operation = '11111111-1111-4111-8111-111111111111', journal = actor => 'manager_assigned_whole_express_pending_v1:' + actor;
const clone = v => structuredClone(v);
const canonical = v => v && typeof v === 'object' ? Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']'
  : '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}' : JSON.stringify(v);
const digest = v => crypto.createHash('sha256').update(canonical(v), 'utf8').digest('hex');
const grant = () => ({ operation_id: operation, ordinal: 1, payload_hash: grantHash, source_hash: sourceHash, order_revision: revision });
const item = id => ({ order_id: id, order_no: 'ASSIGNED_' + id, total_num: 2, financial_store_id: 0, grant: grant(), admission: 'requires_review' });
function review(id = 101, store = 3) { return { version: 'merchant-assigned-whole-express-v1', order_id: id, order_no: 'ASSIGNED_' + id,
  store_id: store, fulfillment_store_id: store, financial_store_id: 0, scope_key: scope, order_revision: revision, grant: grant(),
  source: { cart_rows: [{ row_id: 20, cart_id: 'cart-real', product_id: 70, unique: '蓝色😀', quantity: 2 }] },
  recipient: { name: '本机收件人', phone: '12345678901', address: '本机受控地址' }, carriers: [{ name: '本机快递😀', code: 'EXP' }], admission: 'requires_locked_commit' }; }
function context(actor, store = 3) { return { version: 'merchant-management-v1', actor_uid: actor, store_id: store, scope_key: scope,
  consistency_key: 'e'.repeat(64), issues: [], data: { stores: [3,4].map(id => ({ store_id: id, staff_id: 30 + id, name: '门店' + id })),
    selected_store_id: store, capabilities: Object.fromEntries(['remark','change_price','confirm_offline','manual_delivery','split_delivery','electronic_waybill','refund_create','refund_decide','tracking','writeoff'].map(k => [k, false])) } }; }
function receipt(call, actor = 11) { const b = call.data, key = call.header['Idempotency-Key']; return {
  actor_uid: actor, request_key: key, format_version: 1, kind: 'assigned_whole_express', outcome: 'delivery-recorded',
  request_hash: digest({ domain: b.version, actor_uid: actor, request_key: key, intent: b }), target_store_id: b.store_id, staff_id: 33,
  scope_key: b.scope_key, root_order_id: b.order_id, order_id: b.order_id, customer_uid: 21, financial_store_id: 0, supplier_id: 0,
  assignment_operation_id: b.assignment_operation_id, assignment_ordinal: b.assignment_ordinal, assignment_payload_hash: b.assignment_payload_hash,
  assignment_source_hash: b.expected_assignment_source_hash, assignment_order_revision: b.expected_order_revision,
  expected_order_revision: b.expected_order_revision, post_order_revision: 'f'.repeat(64), delivery_outbox_id: 901,
  delivery_event_key: 'order.delivery.notice:' + b.order_id, delivery_payload_hash: '9'.repeat(64), created_at: 1700000000 }; }
function fixture(options = {}) {
  let r; const ledger = new Map();
  const record = call => { const row = receipt(call, r.auth.uid); ledger.set(row.request_key, row); return row; };
  r = runtime({ component: 'pages/merchant/assignedOrders.vue', anonymous: options.anonymous, modal: options.modal ?? true,
    send: async call => {
      const p = new URL(call.url, 'https://local.invalid').pathname.replace(/^\/api/, '');
      if (call.method === 'POST') {
        assert.equal(p, '/store/manager/assigned-order/commit');
        const saved = JSON.parse(r.uni.getStorageSync(journal(r.auth.uid)) || '[]').find(row => row.request_key === call.header['Idempotency-Key']);
        assert.ok(saved, 'the exact original intent must be durable before POST'); assert.deepEqual(saved.input, call.data);
        assert.equal(saved.request_hash, digest({ domain: call.data.version, actor_uid: r.auth.uid, request_key: saved.request_key, intent: call.data }));
      }
      const override = await options.send?.(call, p, r, { ledger, record }); if (override !== undefined) return override;
      if (p === '/store/manager/context') return { data: context(r.auth.uid, Number(call.data.store_id) || 3) };
      if (p.endsWith('/inbox')) return { data: { version: 'merchant-assigned-whole-express-inbox-v1', actor_uid: r.auth.uid,
        store_id: call.data.store_id, scope_key: scope, list: call.data.after ? [] : [item(101)], next_after: null, admission: 'requires_review' } };
      if (p.includes('/review/')) return { data: review(Number(p.split('/').at(-1)), call.data.store_id) };
      if (p.includes('/receipt/')) { const row = ledger.get(p.split('/').at(-1)); return { data: row ? { state: 'recorded', receipt: row } : { state: 'unknown', receipt: null } }; }
      if (p.endsWith('/commit')) { const prior = ledger.get(call.header['Idempotency-Key']); return { data: { receipt: prior || record(call), replayed: !!prior } }; }
      throw Error('Unexpected assigned client request ' + p);
    } });
  r.uni.navigateBack = () => r.navigations.push('BACK'); return Object.assign(r, { ledger });
}
async function start(options = {}, query = {}) { const r = fixture(options); await r.start(query); return r; }
async function ready(r) { await r.page.manager.open(r.page.manager.items.value[0]); r.page.manager.carrierIndex.value = 0; r.page.manager.tracking.value = '真实😀单号'; }
const writes = r => r.calls.filter(c => c.method === 'POST');
const moduleAt = (r, file = 'view/common/managerAssignedFulfillment.ts') => r.load(path.resolve(root, '../..', file));

test('new page is registered once in both actual page and runtime navigation manifests', () => {
  const pages = JSON.parse(fs.readFileSync(path.join(root, 'src/pages.json'))).pages;
  assert.equal(pages.filter(p => p.path === 'pages/merchant/assignedOrders').length, 1);
  const r = fixture(); try {
    const navigation = r.load(path.join(root, 'src/config/navigation.ts'));
    assert.ok(navigation.REGISTERED_PAGE_ROUTES.has('/pages/merchant/assignedOrders'));
  } finally { r.stop(); }
});
for (const state of ['selected-store', 'context-denied', 'anonymous']) test('real old entry has one theme host and remains visible with ' + state, async () => {
  const merchant = require('./merchant-orders-runtime.cjs');
  const r = merchant.runtime({ anonymous: state === 'anonymous', send(_call, endpoint) {
    if (state === 'context-denied' && endpoint === '/store/manager/context') return { status: 403, msg: '门店资格已撤销' };
  } });
  try {
    await r.start(); const html = await merchant.markup(r), tree = require('@vue/compiler-dom').parse(html), entries = [];
    function visit(node, ancestors = []) {
      if (node.type === 1) {
        const attrs = Object.fromEntries(node.props.filter(prop => prop.type === 6).map(prop => [prop.name, prop.value?.content || '']));
        if ((attrs.class || '').split(/\s+/).includes('assigned-entry')) entries.push([...ancestors, attrs]);
        for (const child of node.children) visit(child, [...ancestors, attrs]);
      } else for (const child of node.children || []) visit(child, ancestors);
    }
    visit(tree); assert.equal(entries.length, 1); assert.ok(html.includes('打开后台分配订单'));
    assert.equal(entries[0].filter(attrs => (attrs.class || '').split(/\s+/).includes('theme-page')).length, 1);
    assert.ok(entries[0].every(attrs => !/display\s*:\s*none/.test(attrs.style || '')), 'the actual entry cannot live in a context-hidden slot');
    if (state !== 'selected-store') { assert.equal(r.page.manager.context.value, null); assert.ok(r.page.manager.error.value); }
    r.page.openAssigned(); assert.equal(r.navigations.at(-1), '/pages/merchant/assignedOrders' + (state === 'selected-store' ? '?store_id=3' : ''));
    r.hooks.onHide(); r.page.openAssigned(); assert.equal(r.navigations.length, 1);
  } finally { r.stop(); }
});
test('anonymous sends no authenticated requests and can reach login', async () => {
  const r = await start({ anonymous: true }); try { assert.equal(r.calls.length, 0); r.page.manager.login(); assert.deepEqual(r.navigations, ['/pages/auth/login']); } finally { r.stop(); }
});
test('current store reads dedicated inbox, then current review, with no old operation endpoints or financial reassignment', async () => {
  const r = await start(); try {
    const m = r.page.manager; assert.equal(m.items.value.length, 1); assert.equal(m.items.value[0].admission, 'requires_review');
    assert.equal(m.review.value, null); assert.equal(writes(r).length, 0); await ready(r);
    assert.equal(m.review.value.financial_store_id, 0); assert.equal(m.review.value.fulfillment_store_id, 3);
    assert.equal(m.review.value.recipient.name, '本机收件人'); assert.ok(r.calls.every(c => !c.url.includes('/order/operation')));
    assert.equal(r.calls.find(c => c.url.endsWith('/inbox')).data.after, 0);
    assert.equal(r.calls.find(c => c.url.includes('/review/')).data.store_id, 3);
  } finally { r.stop(); }
});
test('portable request hash matches independent Node UTF8 including astral Chinese carrier and tracking', async () => {
  const r = await start(); try {
    await ready(r); await r.page.manager.submit(); const call = writes(r)[0], row = [...r.ledger.values()][0];
    assert.equal(writes(r).length, 1); assert.equal(call.header['Content-Type'], 'application/json');
    assert.match(call.header['Idempotency-Key'], /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.equal(row.request_hash, digest({ domain: 'merchant-assigned-whole-express-v1', actor_uid: 11, request_key: row.request_key, intent: call.data }));
    assert.equal(call.data.payload.delivery_id, '真实😀单号'); assert.equal(r.page.manager.receipt.value.request_hash, row.request_hash);
    assert.equal(r.page.manager.pending.value.length, 0); assert.equal(r.page.manager.review.value, null);
    const saved = JSON.parse(r.uni.getStorageSync(journal(11))); assert.equal(saved.length, 1); assert.equal(saved[0].receipt.request_hash, row.request_hash);
    assert.ok(!r.uni.getStorageSync(journal(11)).includes('本机受控地址'));
  } finally { r.stop(); }
});
test('strict codecs reject forged discovery admission, duplicate roots and wrong target before showing data', async () => {
  const r = await start(); try {
    const u = moduleAt(r), source = { version: 'merchant-assigned-whole-express-inbox-v1', actor_uid: 11, store_id: 3,
      scope_key: scope, list: [item(101)], next_after: null, admission: 'requires_review' };
    for (const mutate of [x => x.actor_uid = 12, x => x.store_id = 4, x => x.admission = 'ready', x => x.list.push(clone(x.list[0])),
      x => x.list[0].recipient = { name: 'forbidden' }, x => x.next_after = 101]) {
      const x = clone(source); mutate(x); assert.throws(() => u.parseAssignedInbox(x, 11, 3));
    }
    const good = review(); assert.equal(u.parseAssignedReview(good, 101, 3, scope).grant.ordinal, 1);
    for (const mutate of [x => x.financial_store_id = 3, x => x.order_revision = '9'.repeat(64), x => x.carriers.push(clone(x.carriers[0])),
      x => x.source.cart_rows[0].quantity = '2', x => x.recipient.extra = 'forbidden']) {
      const x = clone(good); mutate(x); assert.throws(() => u.parseAssignedReview(x, 101, 3, scope));
    }
  } finally { r.stop(); }
});
test('fixed cursor pagination appends unique current rows and rejects a duplicated second page', async () => {
  for (const duplicate of [false, true]) {
    const r = await start({ send(call, p) { if (!p.endsWith('/inbox')) return;
      const ids = call.data.after ? [duplicate ? 110 : 111] : Array.from({ length: 10 }, (_, n) => 101 + n);
      const list = ids.map(id => ({ ...item(id), grant: { ...grant(), operation_id: '00000000-0000-4000-8000-' + String(id).padStart(12, '0') } }));
      return { data: { version: 'merchant-assigned-whole-express-inbox-v1', actor_uid: 11, store_id: call.data.store_id,
        scope_key: scope, list, next_after: call.data.after ? null : 110, admission: 'requires_review' } };
    } });
    try { assert.equal(r.page.manager.items.value.length, 10); await r.page.manager.more();
      assert.equal(r.calls.filter(c => c.url.endsWith('/inbox')).at(-1).data.after, 110);
      if (duplicate) { assert.equal(r.page.manager.items.value.length, 0); assert.ok(r.page.manager.error.value); }
      else { assert.equal(r.page.manager.items.value.length, 11); assert.equal(r.page.manager.nextAfter.value, null); }
    } finally { r.stop(); }
  }
});
test('H5 without Web Locks closes before journal work or any POST', async () => {
  const r = await start(), previousWindow = globalThis.window, previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    globalThis.window = { addEventListener() {}, removeEventListener() {} };
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
    const u = r.load(path.join(root, 'src/utils/managerAssignedFulfillment.ts')); let ran = false;
    await assert.rejects(u.withAssignedJournalLock(11, async () => { ran = true; }), /跨页面操作支持/);
    assert.equal(ran, false); assert.equal(writes(r).length, 0); assert.equal(r.uni.getStorageSync(journal(11)), undefined);
  } finally {
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator); else delete globalThis.navigator;
    r.stop();
  }
});
test('storage failure prevents any mutation and never replaces the old journal', async () => {
  const r = await start(); try { await ready(r); const write = r.uni.setStorageSync;
    r.uni.setStorageSync = (key, value) => { if (key === journal(11)) throw Error('disk full'); return write(key, value); };
    await r.page.manager.submit(); assert.equal(writes(r).length, 0); assert.equal(r.uni.getStorageSync(journal(11)), undefined);
    assert.match(r.page.manager.error.value, /disk full|保存/);
  } finally { r.stop(); }
});
test('corrupt journal blocks new UUID submissions while keeping original bytes untouched', async () => {
  const r = fixture(); r.uni.setStorageSync(journal(11), '{broken'); await r.start();
  try { await ready(r); assert.equal(r.page.manager.canSubmit.value, false); await r.page.manager.submit();
    assert.equal(writes(r).length, 0); assert.equal(r.uni.getStorageSync(journal(11)), '{broken'); assert.match(r.page.manager.journalError.value, /损坏/);
  } finally { r.stop(); }
});
test('unknown receipt preserves pending and explicit recovery sends exactly the original UUID and body', async () => {
  let lost = true; const r = await start({ send(call, p) { if (p.endsWith('/commit') && lost) { lost = false; return { transport: 'lost request' }; } } });
  try { await ready(r); await r.page.manager.submit(); const m = r.page.manager, original = clone(writes(r)[0]);
    assert.equal(m.pending.value.length, 1); await m.submit(); assert.equal(writes(r).length, 1);
    await m.check(m.pending.value[0]); assert.equal(m.pending.value.length, 1); assert.match(m.notice.value, /不表示发货失败/);
    assert.equal(writes(r).length, 1); await m.restore(m.pending.value[0]); assert.equal(writes(r).length, 2);
    assert.equal(writes(r)[1].header['Idempotency-Key'], original.header['Idempotency-Key']); assert.deepEqual(writes(r)[1].data, original.data);
    assert.equal(m.pending.value.length, 0); assert.ok(m.receipt.value); assert.ok(!r.calls.some(c => /abandon|resolve/.test(c.url)));
  } finally { r.stop(); }
});
test('role loss and failed old context leave owner receipt recovery available without a new POST', async () => {
  let role = true; const r = await start({ send(call, p, current, tools) {
    if (p.endsWith('/commit')) { tools.record(call); return { transport: 'response lost' }; }
    if (p === '/store/manager/context' && !role) return { status: 403, msg: 'role removed' };
  } });
  try { await ready(r); await r.page.manager.submit(); assert.equal(r.page.manager.pending.value.length, 1);
    r.hooks.onHide(); role = false; r.hooks.onShow(); await tick(); const m = r.page.manager;
    assert.match(m.error.value, /role removed/); assert.equal(m.pending.value.length, 1); assert.equal(m.canRestore(m.pending.value[0]), false);
    await m.check(m.pending.value[0]); assert.ok(m.receipt.value); assert.equal(m.pending.value.length, 0); assert.equal(writes(r).length, 1);
  } finally { r.stop(); }
});
test('a forged minimal receipt cannot clear pending or claim delivery', async () => {
  const r = await start({ send(call, p, current, tools) { if (p.endsWith('/commit')) return { data: { receipt: { ...tools.record(call), target_store_id: 4 }, replayed: false } }; } });
  try { await ready(r); await r.page.manager.submit(); assert.equal(r.page.manager.pending.value.length, 1); assert.equal(r.page.manager.receipt.value, null);
    await r.page.manager.check(r.page.manager.pending.value[0]); assert.ok(r.page.manager.receipt.value); assert.equal(writes(r).length, 1);
  } finally { r.stop(); }
});
test('public receipt requires all twenty-five fields and binds the omitted intent through the saved request hash', async () => {
  const r = await start(); try { await ready(r); await r.page.manager.submit();
    const u = moduleAt(r), expected = JSON.parse(r.uni.getStorageSync(journal(11)))[0], good = [...r.ledger.values()][0];
    assert.equal(Object.keys(good).length, 25); assert.equal(u.parseAssignedReceipt(good, expected).order_id, 101);
    for (const mutate of [x => x.actor_uid = 12, x => x.request_key = operation, x => x.request_hash = '0'.repeat(64),
      x => x.root_order_id = 102, x => x.financial_store_id = 3, x => x.staff_id = 0, x => x.assignment_ordinal = 2,
      x => x.expected_order_revision = '0'.repeat(64), x => x.delivery_event_key = 'order.paid:101',
      x => x.delivery_payload_hash = 'unknown', x => x.intent = expected.input, x => delete x.created_at]) {
      const bad = clone(good); mutate(bad); assert.throws(() => u.parseAssignedReceipt(bad, expected));
    }
    let calls = 0; const bad = clone(expected.input); Object.defineProperty(bad, 'payload', { enumerable: true, get() { calls++; return good; } });
    assert.throws(() => u.captureAssignedInput(bad)); assert.equal(calls, 0);
    const symbols = clone(expected.input); symbols[Symbol('unexpected')] = true; assert.throws(() => u.captureAssignedInput(symbols));
  } finally { r.stop(); }
});
test('persisted token replacement blocks submit before confirmation and network even before a focus event', async () => {
  const r = await start(); try { await ready(r); r.uni.setStorageSync('uni_token', 'foreign-token'); r.uni.setStorageSync('uni_uid', 12);
    await r.page.manager.submit(); assert.equal(writes(r).length, 0); assert.equal(r.modals.length, 0);
    assert.equal(r.uni.getStorageSync(journal(11)), undefined);
  } finally { r.stop(); }
});
test('store switch aborts deferred review and clears recipient, carrier and tracking', async () => {
  const d = deferred(); let slow = true; const r = await start({ send(call, p) { if (p.includes('/review/') && slow) return d.promise; } });
  try { const opening = r.page.manager.open(r.page.manager.items.value[0]); await tick(); r.page.manager.chooseStore({ detail: { value: 1 } });
    slow = false; await tick(); d.resolve({ data: review() }); await opening; await tick(); const m = r.page.manager;
    assert.equal(m.selectedStore.value, 4); assert.equal(m.review.value, null); assert.equal(m.tracking.value, ''); assert.equal(m.carrierIndex.value, -1);
    assert.ok(r.aborts.length > 0); assert.ok(r.calls.some(c => c.url.endsWith('/inbox') && c.data.store_id === 4));
  } finally { r.stop(); }
});
test('account ABA and page hide fence late review responses and never restore old private data', async () => {
  for (const event of ['aba','hide']) { const d = deferred(), r = await start({ send(call, p) { if (p.includes('/review/')) return d.promise; } });
    try { const opening = r.page.manager.open(r.page.manager.items.value[0]); await tick();
      if (event === 'hide') r.hooks.onHide(); else { r.auth.setLogin('another', 12); r.auth.setLogin('synthetic-local-token', 11); }
      d.resolve({ data: review() }); await opening; await tick(); assert.equal(r.page.manager.review.value, null); assert.equal(writes(r).length, 0); assert.ok(r.aborts.length > 0);
    } finally { r.stop(); }
  }
});
test('leaving during confirmation sends nothing and clears all review fields', async () => {
  const r = await start(); try { await ready(r); let modal; r.uni.showModal = options => { modal = options; };
    const submitting = r.page.manager.submit(); await tick(); r.hooks.onHide(); modal.success({ confirm: true }); await submitting;
    assert.equal(writes(r).length, 0); assert.equal(r.page.manager.review.value, null); assert.equal(r.page.manager.tracking.value, '');
    assert.equal(r.uni.getStorageSync(journal(11)), undefined);
  } finally { r.stop(); }
});
test('a lost active POST followed by hide retains only durable pending until owner GET confirms it', async () => {
  const d = deferred(); const r = await start({ send(call, p, current, tools) { if (p.endsWith('/commit')) { tools.record(call); return d.promise; } } });
  try { await ready(r); const sending = r.page.manager.submit(); await tick(); assert.equal(writes(r).length, 1); r.hooks.onHide();
    d.resolve({ data: { receipt: [...r.ledger.values()][0], replayed: false } }); await sending;
    assert.equal(r.page.manager.receipt.value, null); assert.equal(r.page.manager.pending.value.length, 0);
    assert.equal(JSON.parse(r.uni.getStorageSync(journal(11)))[0].receipt, null);
    r.hooks.onShow(); await tick(); assert.equal(r.page.manager.pending.value.length, 1); await r.page.manager.check(r.page.manager.pending.value[0]);
    assert.ok(r.page.manager.receipt.value); assert.equal(writes(r).length, 1);
  } finally { r.stop(); }
});
test('actual template places recovery before context errors and renders current recipient and whole-only form', async () => {
  const r = await start(); try { await ready(r); await render(r, 'components/ThemePage.vue');
    const html = await render(r, 'pages/merchant/assignedOrders.vue', r.page);
    for (const s of ['本机受控地址','本机收件人','整单手工快递','订单财务归属：平台','确认整单快递发货']) assert.ok(html.includes(s), s);
    assert.ok(!html.includes('拆单发货')); assert.ok(!html.includes('虚拟发货'));
    const source = fs.readFileSync(path.join(root, 'src/pages/merchant/assignedOrders.vue'), 'utf8');
    assert.ok(source.indexOf('data-assigned="pending"') < source.indexOf('data-assigned="error"'));
  } finally { r.stop(); }
});
