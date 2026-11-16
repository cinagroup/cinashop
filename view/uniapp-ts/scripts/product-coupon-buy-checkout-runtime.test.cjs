const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const invoiceFixture = require('../../common/test/buyerInvoiceFixture.cjs');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
const common = path.resolve(__dirname, '../../common');
const attempt = '1763170000000:1:0123456789abcdef';
const buyKey = 'cinashop_product_coupon_buy_v1_11';
const orderKey = 'cinashop_checkout_pending_v1_11';
const ordinaryKey = 'cinashop_category_purchase_v1_11';
const query = { mode: 'buy', cartId: '1', couponBuy: attempt };
const item = { id: 1, productId: 70, unique: 'realSku', cartNum: 2, type: 0, isNew: 1, isValid: true,
  productInfo: { price: '999.99', storeName: 'local', image: '', stock: 5, otPrice: '', suk: 'red', systemFormId: 0, productType: 0 }, sumPrice: '1999.98' };
const intent = changes => ({ version: 1, uid: 11, attempt, productId: 70, unique: 'realSku', quantity: 2, issueId: 55, title: '原商品券',
  phase: 'ready', cartId: 1, ownedId: 900, claimAttempt: '1763170000000:2', evidence: 'grant', decision: 'apply', ...changes });
const coupon = changes => ({ id: 900, cid: 55, coupon_price: '3.00', use_min_price: '0.00', coupon_type: 1, applicable_type: 2,
  coupon_title: '原商品券', availability: 'available', availability_message: '', start_time: null, end_time: null,
  estimated_discount: '3.00', eligible_subtotal: '20.00', ...changes });
const storage = (changes = {}) => new Map([[buyKey, JSON.stringify(intent(changes))]]);
const writes = r => r.calls.filter(call => call.url.includes('/order/create/'));
const grantWrites = r => r.calls.filter(call => call.url.includes('/coupon/receive') || call.url.includes('/cart/add'));
function server(overrides = {}) {
  return async call => {
    if (overrides[call.url]) return overrides[call.url](call);
    if (call.url === '/api/invoice') return { data: invoiceFixture.page({ kind: 'titles', cursor: call.data.cursor ?? null, limit: call.data.limit ?? 20 }) };
    if (call.url === '/api/cart/list') return { data: [item] };
    if (call.url === '/api/address/list') return { data: [{ id: 11, real_name: 'local', phone: '00000000000', is_default: 1 }] };
    if (call.url === '/api/store/list') return { data: [{ id: 1, name: 'local' }] };
    if (call.url === '/api/coupons/order/0') return { data: [coupon()], headers: {} };
    if (call.url === '/api/order/confirm' || call.url.startsWith('/api/order/computed/')) {
      const applied = call.data.couponId !== 0;
      return { data: {
        ...(call.data.invoiceId === undefined ? {} : { invoiceSelection: { id: call.data.invoiceId, revision: call.data.invoiceRevision } }),
        orderKey: 'checkout_key1', quoteToken: 'a'.repeat(32), addressInfo: { id: call.data.addressId },
        cartInfo: [{ ...item, truePrice: '9.00', sumPrice: '20.00', productInfo: { ...item.productInfo, price: '10.00' } }],
        priceGroup: { sumPrice: '20.00', totalPrice: '18.00', pay_price: applied ? '18.00' : '21.00',
          total_postage: '6.00', storePostageDiscount: '3.00', pay_postage: '3.00', vipPrice: '2.00', levelPrice: '0.00', memberPrice: '2.00',
          couponPrice: applied ? '3.00' : '0.00', deduction_price: '0.00', firstOrderPrice: '0.00', usedIntegral: 0, SurplusIntegral: 100, pay_integral: 0 },
      } };
    }
    if (call.url === '/api/order/create/checkout_key1') return { data: { key: 'checkout_key1', orderId: 'order_coupon_buy' } };
    throw Error(`No fixture: ${call.url}`);
  };
}
function modules(r) {
  const order = r.load(path.join(common, 'orderCoupons.ts'));
  const buy = r.load(path.join(common, 'productCouponBuyPreselection.ts'));
  const journal = r.load(path.join(common, 'productCouponBuyIntent.ts'));
  return { ...order, ...buy, ...journal };
}
function pureFixture(changes = {}) {
  const saved = storage(changes), r = runtime({ storage: saved, send: server() }), m = modules(r);
  const journal = new m.ProductCouponBuyJournal({ get: key => saved.get(key), set: (key, value) => saved.set(key, value), remove: key => saved.delete(key) });
  const owner = { uid: 11, version: r.auth.sessionVersion }, scope = m.orderCouponScope([item], 1, 0);
  const flow = new m.ProductCouponBuyPreselection(m.parseProductCouponBuySelection(query), journal, owner);
  const page = (rows, nextCursor = null) => ({ ...m.normalizeOrderCouponPage(rows, nextCursor === null ? '' : String(nextCursor)), fingerprint: scope.fingerprint, loading: false, error: '' });
  return { r, m, journal, owner, scope, flow, page };
}

test('order picker projects actual cid, preserves absent legacy cid, and rejects every present malformed identity', () => {
  const r = runtime({ send: server() });
  try {
    const { normalizeOrderCouponPage } = modules(r);
    assert.equal(normalizeOrderCouponPage([coupon()], '').list[0].issueId, 55);
    const legacy = coupon(); delete legacy.cid;
    assert.equal(Object.hasOwn(normalizeOrderCouponPage([legacy], '').list[0], 'issueId'), false);
    for (const cid of [undefined, null, '55', 0, -1, 1.2, NaN, Infinity, 2147483648]) {
      assert.throws(() => normalizeOrderCouponPage([coupon({ cid })], ''), /发行标识/);
    }
  } finally { r.stop(); }
});

test('buy route accepts only the opaque attempt and one original cart, without changing legacy routes', () => {
  const r = runtime({ send: server() });
  try {
    const { parseProductCouponBuySelection: parse } = modules(r);
    assert.equal(parse({ mode: 'buy', cartId: '1' }), null);
    assert.deepEqual(parse(query), { attempt, cartId: 1 });
    for (const changed of [{ couponBuy: undefined }, { couponBuy: 123 }, { couponBuy: '55' }, { mode: 'cart' },
      { mode: undefined }, { cartId: '1,2' }, { cartId: '01' }, { cartId: '2147483648' }, { cartId: 1 },
      { cartIds: '1' }, { couponId: '900' }, { couponId: undefined }]) assert.throws(() => parse({ ...query, ...changed }), /不匹配/);
  } finally { r.stop(); }
});

test('preselection requires exact current owner, new1 ordinary row, SKU, quantity, cart and delivery fingerprint', () => {
  const f = pureFixture();
  try {
    for (const changes of [{ id: 2 }, { productId: 71 }, { unique: 'otherSku' }, { cartNum: 1 }, { type: 1 }, { isNew: 0 }, { isValid: false }, { productInfo: null }]) {
      assert.throws(() => f.flow.bind(f.scope, f.owner, [{ ...item, ...changes }]), /不匹配/);
    }
    assert.throws(() => f.flow.bind(f.scope, { ...f.owner, uid: 22 }, [item]), /不匹配/);
    assert.throws(() => f.flow.bind(f.scope, { ...f.owner, version: f.owner.version + 1 }, [item]), /不匹配/);
    assert.throws(() => f.flow.bind({ ...f.scope, fingerprint: 'forged' }, f.owner, [item]), /不匹配/);
    assert.throws(() => f.flow.bind(f.scope, f.owner, [item, { ...item, id: 2 }]), /不匹配/);
    f.flow.bind(f.scope, f.owner, [item]);
    assert.deepEqual(f.flow.accept(f.page([coupon()]), f.owner), { couponId: 900, loadMore: false, declined: false });
  } finally { f.r.stop(); }
});

test('known owned ID cannot silently switch to another owned copy or a different issue', () => {
  const f = pureFixture();
  try {
    f.flow.bind(f.scope, f.owner, [item]);
    for (const rows of [[coupon({ id: 901 })], [coupon({ cid: 56 })], [coupon({ cid: undefined })]]) {
      if (rows[0].cid === undefined) delete rows[0].cid;
      assert.throws(() => f.flow.accept(f.page(rows), f.owner), /不适用/);
    }
    assert.equal(f.journal.read(11).ownedId, 900);
  } finally { f.r.stop(); }
});

test('ready receipt with no owned ID resolves and persists only the actual picker row for that issue', () => {
  const f = pureFixture({ ownedId: null, evidence: 'receipt' });
  try {
    f.flow.bind(f.scope, f.owner, [item]);
    assert.equal(f.flow.accept(f.page([coupon({ id: 901, cid: 56 }), coupon({ id: 900 })]), f.owner).couponId, 900);
    assert.equal(f.journal.read(11).ownedId, 900);
    f.flow.assertSelection(f.owner, f.scope, f.page([coupon()]), 900);
    assert.throws(() => f.flow.assertSelection(f.owner, f.scope, f.page([coupon()]), 0), /尚未核实/);
  } finally { f.r.stop(); }
});

test('unknown grant evidence remains blocked, with no attempt to receive or create another cart', () => {
  const f = pureFixture({ phase: 'claim-unknown', ownedId: null, evidence: 'none' });
  try {
    assert.throws(() => f.flow.bind(f.scope, f.owner, [item]), /不匹配/);
    assert.equal(grantWrites(f.r).length, 0);
  } finally { f.r.stop(); }
});

test('preselection validates live journal bytes and cannot revive a suspended or owner-changed lease', () => {
  const f = pureFixture();
  try {
    f.flow.bind(f.scope, f.owner, [item]);
    const page = f.page([coupon()]);
    f.r.storage.set(buyKey, JSON.stringify(intent({ attempt: '1763170000000:3:0123456789abcdef' })));
    assert.throws(() => f.flow.accept(page, f.owner), /记录已变化/);
    f.r.storage.set(buyKey, JSON.stringify(intent())); f.flow.bind(f.scope, f.owner, [item]);
    assert.throws(() => f.flow.accept(page, { ...f.owner, version: f.owner.version + 1 }), /不匹配/);
    f.flow.invalidate(); assert.throws(() => f.flow.accept(page, f.owner), /不匹配/);
  } finally { f.r.stop(); }
});

test('picker scan is bounded and empty scanned pages do not invent a coupon identity', () => {
  const f = pureFixture();
  try {
    f.flow.bind(f.scope, f.owner, [item]);
    for (let index = 0; index < 49; index++) assert.equal(f.flow.accept(f.page([], 1000 - index), f.owner).loadMore, true);
    assert.throws(() => f.flow.accept(f.page([], 900), f.owner), /不适用/);
    assert.equal(f.journal.read(11).ownedId, 900);
  } finally { f.r.stop(); }
});

test('explicit decline is durable and does not depend on a failing original coupon picker', () => {
  const f = pureFixture();
  try {
    f.flow.bind(f.scope, f.owner, [item]); f.flow.decline(f.owner);
    assert.equal(f.journal.read(11).decision, 'declined');
    const failed = { ...f.page([]), error: 'offline' };
    f.flow.assertSelection(f.owner, f.scope, failed, 0);
    f.flow.bind(f.scope, f.owner, [item]);
    assert.equal(f.flow.accept(failed, f.owner).declined, true);
    assert.throws(() => f.flow.assertSelection(f.owner, f.scope, failed, 900), /先核对/);
  } finally { f.r.stop(); }
});

test('checkout locks from query presence until current picker and coupon quote both finish', async () => {
  const picker = deferred(), quote = deferred();
  const base = server();
  const r = runtime({ storage: storage(), send: async call => {
    if (call.url === '/api/coupons/order/0') await picker.promise;
    if ((call.url === '/api/order/confirm' || call.url.includes('/computed/')) && call.data.couponId === 900) await quote.promise;
    return base(call);
  } });
  try {
    await r.start(query);
    assert.equal(r.checkout.ready.value, true); assert.equal(r.checkout.canSubmit.value, false);
    await r.checkout.submit(); assert.equal(writes(r).length, 0);
    picker.resolve(); await tick();
    assert.equal(r.checkout.couponId.value, 900); assert.equal(r.checkout.canSubmit.value, false);
    quote.resolve(); await tick();
    assert.equal(r.checkout.canSubmit.value, true); assert.equal(r.checkout.quote.value.result.prices.couponDiscount, '3.00');
    assert.equal(grantWrites(r).length, 0);
  } finally { picker.resolve(); quote.resolve(); r.stop(); }
});

for (const changed of [{ cartNum: 3 }, { productId: 71 }, { unique: 'otherSku' }, { type: 1 }, { isNew: 0 }]) {
  test(`checkout rejects actual cart identity change ${JSON.stringify(changed)}`, async () => {
    const r = runtime({ storage: storage(), send: server({ '/api/cart/list': () => ({ data: [{ ...item, ...changed }] }) }) });
    try {
      await r.start(query); assert.equal(r.checkout.canSubmit.value, false);
      assert.ok(r.checkout.error.value); await r.checkout.submit(); assert.equal(writes(r).length, 0);
    } finally { r.stop(); }
  });
}

test('missing or malformed buy journal blocks instead of falling back to a coupon-free purchase', async () => {
  for (const saved of [new Map(), new Map([[buyKey, '{broken']]), storage({ phase: 'claim-unknown', ownedId: null, evidence: 'none' })]) {
    const r = runtime({ storage: saved, send: server() });
    try { await r.start(query); assert.equal(r.checkout.canSubmit.value, false); assert.ok(r.checkout.error.value); assert.equal(grantWrites(r).length, 0); }
    finally { r.stop(); }
  }
});

test('unavailable requested coupon blocks, while an explicit no-coupon choice survives hide/show and cold remount', async () => {
  const saved = storage(), send = server({ '/api/coupons/order/0': () => ({ data: [coupon({ id: 899, cid: 56 })], headers: {} }) });
  const r = runtime({ storage: saved, send });
  try {
    await r.start(query); assert.equal(r.checkout.canSubmit.value, false); assert.match(r.checkout.couponBuyError.value, /不适用/);
    r.checkout.declineCouponBuy(); await tick();
    assert.equal(r.checkout.canSubmit.value, true); assert.equal(r.checkout.couponId.value, 0);
    assert.equal(JSON.parse(saved.get(buyKey)).decision, 'declined');
    r.hooks.onHide(); r.hooks.onShow(); await tick();
    assert.equal(r.checkout.canSubmit.value, true); assert.equal(r.checkout.couponId.value, 0);
  } finally { r.stop(); }
  const cold = runtime({ storage: saved, send });
  try { await cold.start(query); assert.equal(cold.checkout.canSubmit.value, true); assert.equal(cold.checkout.couponId.value, 0); }
  finally { cold.stop(); }
});

test('manual alternative coupon selection persists override and cannot auto-reapply the original on resume', async () => {
  const r = runtime({ storage: storage(), send: server({ '/api/coupons/order/0': () => ({ data: [coupon(), coupon({ id: 899, cid: 56 })], headers: {} }) }) });
  try {
    await r.start(query); assert.equal(r.checkout.couponId.value, 900);
    r.checkout.selectCoupon(899); await tick();
    assert.equal(r.checkout.couponId.value, 899); assert.equal(r.checkout.canSubmit.value, true);
    assert.equal(JSON.parse(r.storage.get(buyKey)).decision, 'declined');
    r.hooks.onHide(); r.hooks.onShow(); await tick();
    assert.equal(r.checkout.couponId.value, 0); assert.equal(r.checkout.canSubmit.value, true);
  } finally { r.stop(); }
});

test('receipt-owned null is not sent as zero and becomes the real issue-matched picker ID', async () => {
  const r = runtime({ storage: storage({ ownedId: null, evidence: 'receipt' }), send: server() });
  try {
    await r.start(query); assert.equal(r.checkout.couponId.value, 900); assert.equal(r.checkout.canSubmit.value, true);
    assert.equal(JSON.parse(r.storage.get(buyKey)).ownedId, 900);
    await r.checkout.submit(); assert.equal(writes(r)[0].data.couponId, 900); assert.equal(grantWrites(r).length, 0);
  } finally { r.stop(); }
});

test('delivery change rereads its picker and delayed prior delivery cannot unlock a new selection', async () => {
  const pickup = deferred();
  const r = runtime({ storage: storage(), send: server({ '/api/coupons/order/0': async call => {
    if (call.data.shipping_type === 2) { await pickup.promise; return { data: [], headers: {} }; }
    return { data: [coupon()], headers: {} };
  } }) });
  try {
    await r.start(query); assert.equal(r.checkout.canSubmit.value, true);
    r.checkout.setShipping(2); assert.equal(r.checkout.canSubmit.value, false); await tick();
    r.checkout.setShipping(1); await tick(); assert.equal(r.checkout.canSubmit.value, true);
    pickup.resolve(); await tick(); assert.equal(r.checkout.couponId.value, 900); assert.equal(r.checkout.canSubmit.value, true);
  } finally { pickup.resolve(); r.stop(); }
});

test('late previous-owner picker cannot select or submit a coupon for a new login', async () => {
  const wait = deferred();
  const r = runtime({ storage: storage(), send: server({ '/api/coupons/order/0': async () => { await wait.promise; return { data: [coupon()], headers: {} }; } }) });
  try {
    await r.start(query); r.auth.setLogin('other-owner-token', 22); wait.resolve(); await tick();
    assert.equal(r.checkout.couponId.value, 0); assert.equal(r.checkout.canSubmit.value, false);
    await r.checkout.submit(); assert.equal(writes(r).length, 0); assert.equal(grantWrites(r).length, 0);
  } finally { wait.resolve(); r.stop(); }
});

test('live journal replacement is checked again before the first order POST', async () => {
  const r = runtime({ storage: storage(), send: server() });
  try {
    await r.start(query); assert.equal(r.checkout.canSubmit.value, true);
    r.storage.set(buyKey, JSON.stringify(intent({ ownedId: 901 })));
    await r.checkout.submit(); assert.equal(writes(r).length, 0); assert.match(r.checkout.submissionError.value, /记录已变化/);
  } finally { r.stop(); }
});

test('storage failure while recording a manual override keeps checkout blocked', async () => {
  const saved = storage(), originalSet = saved.set.bind(saved);
  let fail = false;
  saved.set = (key, value) => { if (fail && key === buyKey) throw Error('native storage full'); return originalSet(key, value); };
  const r = runtime({ storage: saved, send: server() });
  try {
    await r.start(query); fail = true;
    r.checkout.declineCouponBuy(); await tick();
    assert.equal(r.checkout.canSubmit.value, false); assert.match(r.checkout.couponBuyError.value, /storage full/);
    assert.equal(JSON.parse(saved.get(buyKey)).decision, 'apply');
    await r.checkout.submit(); assert.equal(writes(r).length, 0);
  } finally { r.stop(); }
});

test('native upload return retains the form while revalidating actual buy cart and picker', async () => {
  const r = runtime({ storage: storage(), send: server() });
  try {
    await r.start(query);
    const form = [{ id: 1, name: 'texts', value: '未保存表单' }];
    r.checkout.customForm.value = form; r.checkout.uploads.value = 1;
    const cartsBefore = r.calls.filter(call => call.url === '/api/cart/list').length;
    const pickersBefore = r.calls.filter(call => call.url === '/api/coupons/order/0').length;
    r.hooks.onHide(); r.hooks.onShow();
    assert.equal(r.checkout.canSubmit.value, false); await tick();
    assert.equal(r.checkout.customForm.value[0].value, '未保存表单'); assert.equal(r.checkout.uploads.value, 1);
    assert.equal(r.calls.filter(call => call.url === '/api/cart/list').length, cartsBefore + 1);
    assert.equal(r.calls.filter(call => call.url === '/api/coupons/order/0').length, pickersBefore + 1);
    assert.equal(r.checkout.couponId.value, 900); assert.equal(grantWrites(r).length, 0);
  } finally { r.stop(); }
});

test('unknown order retains its original coupon payload and clears matching ledgers only after known navigation', async () => {
  let calls = 0;
  const saved = storage();
  saved.set(ordinaryKey, JSON.stringify({ version: 1, actor: 11, state: 'acknowledged', mode: 'buy', productId: 70, unique: 'realSku', quantity: 2, cartId: 1 }));
  const send = server({ '/api/order/create/checkout_key1': () => ++calls === 1 ? { transport: 'timeout' } : { data: { key: 'checkout_key1', orderId: 'order_coupon_buy' } } });
  const r = runtime({ storage: saved, send }); let original;
  try {
    await r.start(query); await r.checkout.submit();
    original = writes(r)[0].data;
    assert.ok(saved.has(buyKey)); assert.ok(saved.has(ordinaryKey)); assert.ok(saved.has(orderKey));
  } finally { r.stop(); }
  const restored = runtime({ storage: saved, send });
  try {
    await restored.start(query); assert.ok(restored.checkout.pending.value); assert.equal(restored.calls.length, 0);
    await restored.checkout.submit();
    assert.deepEqual(writes(restored)[0].data, original);
    assert.equal(saved.has(buyKey), false); assert.equal(saved.has(ordinaryKey), false); assert.equal(saved.has(orderKey), false);
    assert.match(restored.navigations.at(-1), /order_coupon_buy/); assert.equal(grantWrites(restored).length, 0);
  } finally { restored.stop(); }
});

test('known order with failed navigation retains both buy ledgers and never resends creation on view retry', async () => {
  const saved = storage();
  saved.set(ordinaryKey, JSON.stringify({ version: 1, actor: 11, state: 'acknowledged', mode: 'buy', productId: 70, unique: 'realSku', quantity: 2, cartId: 1 }));
  const r = runtime({ storage: saved, send: server(), navigationFails: true });
  try {
    await r.start(query); await r.checkout.submit(); assert.equal(r.checkout.pending.value.orderId, 'order_coupon_buy');
    assert.ok(saved.has(buyKey)); assert.ok(saved.has(ordinaryKey));
    await r.checkout.submit(); assert.equal(writes(r).length, 1); assert.ok(saved.has(orderKey));
  } finally { r.stop(); }
});

test('successful purchase does not clear an unrelated ordinary recovery', async () => {
  const saved = storage();
  const unrelated = JSON.stringify({ version: 1, actor: 11, state: 'acknowledged', mode: 'buy', productId: 71, unique: 'otherSku', quantity: 1, cartId: 2 });
  saved.set(ordinaryKey, unrelated);
  const r = runtime({ storage: saved, send: server() });
  try {
    await r.start(query); await r.checkout.submit(); assert.equal(saved.has(buyKey), false); assert.equal(saved.get(ordinaryKey), unrelated);
  } finally { r.stop(); }
});

test('a malformed unrelated buy sidecar cannot block a legacy known order result', async () => {
  const saved = new Map([[buyKey, '{broken']]);
  const r = runtime({ storage: saved, send: server() });
  try {
    await r.start({ mode: 'buy', cartId: '1' }); await r.checkout.submit();
    assert.equal(writes(r).length, 1); assert.match(r.navigations.at(-1), /order_coupon_buy/);
    assert.equal(saved.has(orderKey), false); assert.equal(saved.get(buyKey), '{broken');
  } finally { r.stop(); }
});

test('query cannot mix old cart couponId into immediate buy, and old buy guard remains', async () => {
  for (const route of [{ ...query, couponId: '900' }, { mode: 'buy', cartId: '1', couponId: '900' }]) {
    const r = runtime({ storage: storage(), send: server() });
    try { await r.start(route); assert.equal(r.checkout.canSubmit.value, false); assert.ok(r.checkout.error.value); await r.checkout.submit(); assert.equal(writes(r).length, 0); }
    finally { r.stop(); }
  }
});
