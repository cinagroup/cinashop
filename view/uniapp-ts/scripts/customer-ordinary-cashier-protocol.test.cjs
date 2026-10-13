const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { runtime } = require('./user-center-runtime.cjs');
const root = path.resolve(__dirname, '..');
const scope = 'a'.repeat(64), fingerprint = 'f'.repeat(64);
const draftKey = '11111111-1111-4111-8111-111111111111';
const creationKey = '22222222-2222-4222-8222-222222222222';
const paymentKey = '33333333-3333-4333-8333-333333333333';
const changeKey = '44444444-4444-4444-8444-444444444444';
const clone = value => structuredClone(value);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const digest = value => crypto.createHash('sha256').update(canonical(value), 'utf8').digest('hex');
function fixture() {
  const r = runtime({ component: 'pages/customer-work/cashierRecords.vue', send: () => ({ data: {} }) });
  const api = r.load(path.join(root, 'src/utils/customerWorkOrdinaryCashier.ts'));
  const rows = [{ cart_id: 7, product_id: 70, sku_unique: 'sku-a', quantity: 2, removed: false, consumed: false },
    { cart_id: 8, product_id: 71, sku_unique: 'sku-b', quantity: 1, removed: false, consumed: false }];
  const draft = { version: 'customer-cashier-ordinary-v1', actor_uid: 11, draft_key: draftKey, draft_hash: 'd'.repeat(64),
    scope_key: scope, buyer_uid: 0, tourist_key: 'guest-a', rows };
  const draftBody = { version: draft.version, scope_key: scope, buyer_uid: 0, tourist_key: 'guest-a',
    rows: rows.map(({ product_id, sku_unique, quantity }) => ({ product_id, sku_unique, quantity })) };
  const body = { version: draft.version, scope_key: scope, draft_key: draftKey, draft_hash: draft.draft_hash,
    buyer_uid: 0, tourist_key: 'guest-a', coupon_id: 0, use_integral: false, shipping_type: 2, store_id: 3, address_id: 0,
    manual_address: null, real_name: '', user_phone: '', mark: '原备注', custom_form: null };
  const authority = { scope_key: scope, principal: { service_id: 19 } };
  const envelope = data => ({ version: 'customer-cashier-ordinary-read-v1', actor_uid: 11,
    principal: { kind: 'customer-order-manager', service_id: 19, scope: 'global' }, scope_key: scope,
    consistency_key: digest({ scope_key: scope, data }), data: clone(data) });
  const quotation = () => envelope({ request_key: creationKey, request_hash: digest(body), draft_key: draftKey,
    draft_hash: draft.draft_hash, quote_token: 'b'.repeat(32), quote_fingerprint: fingerprint, expires_at: 1700001800,
    pricing: { currency: 'CNY', amount: '32.00', quantity: 3, gives_integral: 0, used_integral: 0, coupon_discount: '0.00', integral_discount: '0.00' },
    items: rows.map(row => ({ cart_id: row.cart_id, raw_unit_price: '10.00', unit_price: '10.00', total_price: `${row.quantity * 10}.00`, discount: '0.00', price_type: 'normal' })),
    system_form: null, coupons: { list: [], next_cursor: null }, promotion_gifts: { integral: 0, coupons: [], products: [], promotions: [] } });
  const pending = (kind, input, key = changeKey, originalDraft = draft, source = null, quote = null) => api.makeOrdinaryCashierPending(
    11, 19, key, kind, input, originalDraft, source, quote, 1700000000);
  const receipt = (intent, evidence) => ({ version: 'customer-cashier-ordinary-receipt-v1', actor_uid: intent.actor_uid,
    request_key: intent.request_key, request_hash: digest(intent.body), scope_key: scope, kind: intent.kind, intent: clone(intent.body), evidence: clone(evidence) });
  const creation = () => pending('creation', body, creationKey, draft, null, api.makeOrdinaryCreationQuote(quotation(), 11, 19, creationKey, body, draft));
  const createdEvidence = () => ({ outcome: 'order-created', order: { order_id: 77, order_no: 'wx-original-77', buyer_uid: 0, creator_uid: 11,
    pay_price: '32.00', paid: 0, pay_type: '', shipping_type: 2, store_id: 3, total_num: 3 }, origin_hash: 'c'.repeat(64), quote_fingerprint: fingerprint });
  return { r, api, draft, draftBody, body, authority, envelope, quotation, pending, receipt, creation, createdEvidence, stop() { r.stop(); } };
}
test('matches the independent SHA-256 wire digest, including Unicode and reordered JSON keys', () => {
  const f = fixture(); try {
    const input = { 用户: '游客😀', rows: [{ z: 1, a: true }], other: null };
    assert.equal(f.api.ordinaryCashierDigest(input), digest(input));
    assert.equal(f.api.ordinaryCashierDigest({ other: null, rows: [{ a: true, z: 1 }], 用户: '游客😀' }), digest(input));
  } finally { f.stop(); }
});
test('admits complete member delivery and guest pickup while rejecting mixed identity and number coercion', () => {
  const f = fixture(); try {
    assert.equal(f.api.isOrdinaryCashierBody('creation', f.body), true);
    const delivered = { ...f.body, shipping_type: 1, store_id: 0, manual_address: { realName: '真实收件人', phone: '12345678',
      province: '省', city: '市', district: '区', street: '', detail: '完整地址', cityId: 3 } };
    assert.equal(f.api.isOrdinaryCashierBody('creation', delivered), true);
    assert.equal(f.api.isOrdinaryCashierBody('creation', { ...delivered, buyer_uid: 42, tourist_key: '', address_id: 7, manual_address: null }), true);
    for (const changed of [{ buyer_uid: 0, coupon_id: 3 }, { use_integral: true }, { address_id: 7 }, { buyer_uid: '0' },
      { store_id: 1.5 }, { shipping_type: '2' }, { tourist_key: '' }, { buyer_uid: 42, tourist_key: 'guest-a' }]) {
      assert.equal(f.api.isOrdinaryCashierBody('creation', { ...f.body, ...changed }), false);
    }
    assert.equal(f.api.isOrdinaryCashierBody('draft', { ...f.draftBody, rows: [f.draftBody.rows[0], f.draftBody.rows[0]] }), false);
    assert.equal(f.api.isOrdinaryCashierBody('draft', { ...f.draftBody, rows: [{ ...f.draftBody.rows[0], quantity: 32768 }] }), false);
  } finally { f.stop(); }
});
test('durably saves the complete immutable original draft and rejects replacing the same actor request', () => {
  const f = fixture(); try {
    const input = clone(f.draftBody), pending = f.pending('draft', input, draftKey, null);
    input.rows[0].quantity = 900;
    f.api.retainOrdinaryCashierPending(pending);
    assert.equal(f.api.ordinaryCashierPending()[0].body.rows[0].quantity, 2);
    const copy = f.api.ordinaryCashierPending(); copy[0].body.rows[0].quantity = 901;
    assert.equal(f.api.ordinaryCashierPending()[0].body.rows[0].quantity, 2);
    const replacement = f.pending('draft', { ...f.draftBody, rows: [{ ...f.draftBody.rows[0], quantity: 3 }] }, draftKey, null);
    assert.throws(() => f.api.retainOrdinaryCashierPending(replacement), /不能替换/);
    const otherActor = clone(pending); otherActor.actor_uid = 12;
    f.api.retainOrdinaryCashierPending(otherActor);
    assert.equal(f.api.ordinaryCashierPending().length, 2);
    assert.deepEqual(f.api.ordinaryCashierPending().map(row => row.actor_uid), [11, 12]);
  } finally { f.stop(); }
});
test('storage failure or corrupted original records prevent new submissions and preserve the damaged record', () => {
  const f = fixture(); try {
    const pending = f.pending('draft', f.draftBody, draftKey, null);
    const originalSet = f.r.uni.setStorageSync; f.r.uni.setStorageSync = () => {};
    assert.throws(() => f.api.retainOrdinaryCashierPending(pending), /保存未确认/);
    f.r.uni.setStorageSync = originalSet;
    const damaged = [{ ...pending, request_hash: '0'.repeat(64) }];
    originalSet(f.api.ORDINARY_CASHIER_PENDING_STORAGE, damaged);
    assert.throws(() => f.api.ordinaryCashierPending(), /记录损坏/);
    assert.throws(() => f.api.retainOrdinaryCashierPending(pending), /记录损坏/);
    assert.deepEqual(f.r.uni.getStorageSync(f.api.ORDINARY_CASHIER_PENDING_STORAGE), damaged);
  } finally { f.stop(); }
});
test('checks all rows when changing quantity or removing one row; another SKU cannot disappear or change', () => {
  const f = fixture(); try {
    const body = { version: f.body.version, scope_key: scope, draft_key: draftKey, draft_hash: f.draft.draft_hash, cart_id: 7, quantity: 3 };
    const pending = f.pending('quantity', body), after = clone(f.draft); after.rows[0].quantity = 3; after.draft_hash = 'e'.repeat(64);
    const receipt = f.receipt(pending, { outcome: 'quantity-changed', draft: after });
    assert.equal(f.api.parseOrdinaryCashierReceipt(receipt, pending).evidence.draft.rows[0].quantity, 3);
    for (const mutate of [r => r.evidence.draft.rows.pop(), r => { r.evidence.draft.rows[1].quantity = 9; }, r => { r.evidence.draft.rows[0].product_id = 700; }]) {
      const bad = clone(receipt); mutate(bad); assert.throws(() => f.api.parseOrdinaryCashierReceipt(bad, pending), /购物行/);
    }
    const removed = f.pending('remove', { version: body.version, scope_key: scope, draft_key: draftKey, draft_hash: body.draft_hash, cart_ids: [7] });
    const removedDraft = clone(f.draft); removedDraft.rows[0].removed = true;
    assert.equal(f.api.parseOrdinaryCashierReceipt(f.receipt(removed, { outcome: 'rows-removed', draft: removedDraft }), removed).evidence.draft.rows[1].removed, false);
  } finally { f.stop(); }
});
test('verifies append, merge and restoration of a removed SKU against the complete original draft', () => {
  const f = fixture(); try {
    f.draft.rows[1].removed = true;
    const body = { version: f.body.version, scope_key: scope, draft_key: draftKey, draft_hash: f.draft.draft_hash,
      rows: [{ product_id: 70, sku_unique: 'sku-a', quantity: 1 }, { product_id: 71, sku_unique: 'sku-b', quantity: 2 }, { product_id: 72, sku_unique: 'sku-c', quantity: 4 }] };
    const pending = f.pending('append', body), after = clone(f.draft);
    after.rows[0].quantity = 3; after.rows[1].quantity = 2; after.rows[1].removed = false;
    after.rows.push({ cart_id: 9, product_id: 72, sku_unique: 'sku-c', quantity: 4, removed: false, consumed: false });
    const receipt = f.receipt(pending, { outcome: 'rows-appended', draft: after });
    assert.equal(f.api.parseOrdinaryCashierReceipt(receipt, pending).evidence.draft.rows.length, 3);
    const bad = clone(receipt); bad.evidence.draft.rows[1].quantity = 3;
    assert.throws(() => f.api.parseOrdinaryCashierReceipt(bad, pending), /变更不匹配/);
    assert.throws(() => f.pending('append', { ...body, rows: [{ product_id: 70, sku_unique: 'sku-a', quantity: 32767 }] }), /来源无效/);
  } finally { f.stop(); }
});
test('binds quotation to the actual actor, scope, service, full draft and independent response digest', () => {
  const f = fixture(); try {
    const read = f.quotation(), quote = f.api.makeOrdinaryCreationQuote(read, 11, 19, creationKey, f.body, f.draft);
    assert.equal(quote.amount, '32.00'); assert.equal(quote.quantity, 3);
    const changed = clone(read); changed.data.pricing.amount = '0.00';
    assert.throws(() => f.api.makeOrdinaryCreationQuote(changed, 11, 19, creationKey, f.body, f.draft), /摘要不匹配/);
    for (const mutate of [r => { r.actor_uid = 12; }, r => { r.principal.service_id = 20; }, r => { r.scope_key = 'b'.repeat(64); }]) {
      const bad = clone(read); mutate(bad); assert.throws(() => f.api.makeOrdinaryCreationQuote(bad, 11, 19, creationKey, f.body, f.draft), /身份或响应摘要/);
    }
    const missingRow = clone(read.data); missingRow.items.pop();
    assert.throws(() => f.api.makeOrdinaryCreationQuote(f.envelope(missingRow), 11, 19, creationKey, f.body, f.draft), /全部规格/);
  } finally { f.stop(); }
});
test('preserves real member gift quantity and rejects a hidden gift or any guest benefit', () => {
  const f = fixture(); try {
    f.body.buyer_uid = 42; f.body.tourist_key = ''; f.body.real_name = '实际自提人'; f.body.user_phone = '12345678';
    f.draft.buyer_uid = 42; f.draft.tourist_key = '';
    const q = f.quotation().data; q.pricing.quantity = 5;
    q.promotion_gifts.products = [{ cart_id: 'gift-real-90', product_id: 90, sku_unique: 'gift-sku', quantity: 2, promotion_id: 2 }];
    assert.equal(f.api.makeOrdinaryCreationQuote(f.envelope(q), 11, 19, creationKey, f.body, f.draft).quantity, 5);
    const hidden = clone(q); hidden.promotion_gifts.products = [];
    assert.throws(() => f.api.makeOrdinaryCreationQuote(f.envelope(hidden), 11, 19, creationKey, f.body, f.draft), /赠品数量/);
    f.body.buyer_uid = 0; f.body.tourist_key = 'guest-a'; f.draft.buyer_uid = 0; f.draft.tourist_key = 'guest-a'; q.request_hash = digest(f.body);
    assert.throws(() => f.api.makeOrdinaryCreationQuote(f.envelope(q), 11, 19, creationKey, f.body, f.draft), /游客报价/);
  } finally { f.stop(); }
});
test('checks creation against the durably saved quote amount, fingerprint, gift quantity and original unpaid order', () => {
  const f = fixture(); try {
    const pending = f.creation(); f.api.retainOrdinaryCashierPending(pending);
    const receipt = f.receipt(pending, f.createdEvidence());
    assert.equal(f.api.parseOrdinaryCashierReceipt(receipt, f.api.ordinaryCashierPending()[0]).evidence.order.paid, 0);
    for (const mutate of [r => { r.evidence.order.pay_price = '0.00'; }, r => { r.evidence.order.total_num = 2; },
      r => { r.evidence.quote_fingerprint = '0'.repeat(64); }, r => { r.evidence.order.buyer_uid = 11; }, r => { r.evidence.order.paid = 1; }]) {
      const bad = clone(receipt); mutate(bad); assert.throws(() => f.api.parseOrdinaryCashierReceipt(bad, pending), /实际创建订单/);
    }
    // The historical quote is expired now. Recovery still verifies its saved facts.
    assert.equal(f.api.isOrdinaryCashierPending(f.api.ordinaryCashierPending()[0]), true);
    assert.equal(f.r.calls.length, 0);
  } finally { f.stop(); }
});
test('verifies actual cash and zero payment for a different creator without conflating payer and guest buyer', () => {
  const f = fixture(); try {
    for (const amount of ['32.00', '0.00']) {
      const source = { order_id: 77, order_no: 'wx-original-77', buyer_uid: 0, creator_uid: 23, amount, origin_hash: 'c'.repeat(64), creation_key: creationKey };
      const body = { version: 'customer-cashier-ordinary-payment-v1', scope_key: scope, order_id: 77, order_no: source.order_no, expected_amount: amount };
      const pending = f.pending('payment', body, paymentKey, null, source);
      const receipt = f.receipt(pending, { outcome: amount === '0.00' ? 'zero-paid' : 'cash-paid', payment: { order_id: 77, order_no: source.order_no,
        buyer_uid: 0, creator_uid: 23, payer_uid: 11, paid: 1, pay_type: 'cash', pay_time: 1700000001, amount, origin_hash: source.origin_hash,
        status_id: 90, outbox: { id: 91, event_key: 'order.paid:77', event_type: 'order.paid', payload_hash: 'e'.repeat(64) } } });
      assert.equal(f.api.parseOrdinaryCashierReceipt(receipt, pending).evidence.payment.creator_uid, 23);
      for (const mutate of [r => { r.evidence.payment.payer_uid = 23; }, r => { r.evidence.payment.buyer_uid = 11; },
        r => { r.evidence.payment.origin_hash = '0'.repeat(64); }, r => { r.evidence.payment.outbox.event_key = 'order.paid:78'; },
        r => { r.evidence.payment.paid = 0; }, r => { delete r.evidence.payment.outbox; }]) {
        const bad = clone(receipt); mutate(bad); assert.throws(() => f.api.parseOrdinaryCashierReceipt(bad, pending), /真实付款/);
      }
    }
  } finally { f.stop(); }
});
test('a missing original GET receipt remains UNKNOWN and cannot close the durable original request', () => {
  const f = fixture(); try {
    const pending = f.pending('draft', f.draftBody, draftKey, null); f.api.retainOrdinaryCashierPending(pending);
    const wrapper = { version: 'customer-cashier-ordinary-receipt-v1', actor_uid: 11, request_key: draftKey, receipt: null };
    assert.equal(f.api.parseOrdinaryCashierOperation(wrapper, pending), null);
    assert.throws(() => f.api.releaseOrdinaryCashierPending(pending, null), /回执身份/);
    assert.equal(f.api.ordinaryCashierPending().length, 1);
    const receipt = f.receipt(pending, { outcome: 'draft-created', draft: f.draft });
    f.api.releaseOrdinaryCashierPending(pending, receipt);
    assert.equal(f.api.ordinaryCashierPending().length, 0); assert.equal(f.r.calls.length, 0);
  } finally { f.stop(); }
});
test('a successful transport envelope cannot replace a correlated receipt or the original intent', () => {
  const f = fixture(); try {
    const pending = f.creation(), receipt = f.receipt(pending, f.createdEvidence());
    const result = { version: 'customer-cashier-ordinary-result-v1', actor_uid: 11, request_key: creationKey,
      request_hash: pending.request_hash, kind: 'creation', replayed: true, receipt };
    assert.equal(f.api.parseOrdinaryCashierResult(result, pending).request_key, creationKey);
    assert.throws(() => f.api.parseOrdinaryCashierResult({ ...result, receipt: null }, pending), /回执身份/);
    const changed = clone(result); changed.receipt.intent.mark = '改过的备注';
    assert.throws(() => f.api.parseOrdinaryCashierResult(changed, pending), /完整内容不匹配/);
    assert.throws(() => f.api.parseOrdinaryCashierOperation({ version: receipt.version, actor_uid: 12, request_key: creationKey, receipt }, pending), /原经营账号/);
  } finally { f.stop(); }
});
test('keeps original draft, creation, mutation and payment identities independent', () => {
  const f = fixture(); try {
    const pending = f.creation();
    assert.throws(() => f.pending('creation', f.body, draftKey, f.draft, null, pending.quote), /来源无效/);
    assert.throws(() => f.pending('quantity', { version: f.body.version, scope_key: scope, draft_key: draftKey, draft_hash: f.draft.draft_hash, cart_id: 7, quantity: 2 }, draftKey), /来源无效/);
    const source = { order_id: 77, order_no: 'wx-original-77', buyer_uid: 0, creator_uid: 11, amount: '32.00', origin_hash: 'c'.repeat(64), creation_key: creationKey };
    assert.throws(() => f.pending('payment', { version: 'customer-cashier-ordinary-payment-v1', scope_key: scope, order_id: 77, order_no: source.order_no, expected_amount: '32.00' }, creationKey, null, source), /来源无效/);
  } finally { f.stop(); }
});
test('only a correlated immutable permanent abandonment can close a previously UNKNOWN original request', () => {
  const f = fixture(); try {
    const pending = f.pending('draft', f.draftBody, draftKey, null); f.api.retainOrdinaryCashierPending(pending);
    const receipt = { ...f.receipt(pending, { outcome: 'operation-abandoned', original_kind: 'draft' }), kind: 'abandon' };
    assert.equal(f.api.parseOrdinaryCashierReceipt(receipt, pending).kind, 'abandon');
    for (const mutate of [r => { r.evidence.original_kind = 'payment'; }, r => { r.request_hash = '0'.repeat(64); },
      r => { r.intent.buyer_uid = 11; }, r => { r.evidence.outcome = 'cash-paid'; }]) {
      const bad = clone(receipt); mutate(bad); assert.throws(() => f.api.releaseOrdinaryCashierPending(pending, bad), /放弃回执|回执身份/);
      assert.equal(f.api.ordinaryCashierPending().length, 1);
    }
    const result = { version: 'customer-cashier-ordinary-result-v1', actor_uid: 11, request_key: draftKey,
      request_hash: pending.request_hash, kind: 'abandon', replayed: true, receipt };
    assert.equal(f.api.parseOrdinaryCashierResult(result, pending).kind, 'abandon');
    f.api.releaseOrdinaryCashierPending(pending, receipt); assert.equal(f.api.ordinaryCashierPending().length, 0);
  } finally { f.stop(); }
});
