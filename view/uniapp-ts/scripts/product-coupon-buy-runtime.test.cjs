const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
const buyKey = uid => `cinashop_product_coupon_buy_v1_${uid}`;
const claimKey = uid => `cinashop-product-coupon-claim-v1-${uid}`;
const ordinaryKey = uid => `cinashop_category_purchase_v1_${uid}`;
const issue = (id = 130001, received = false) => ({ id, title: `购买券${id}`, scopeType: 0, benefitType: 1, benefitValue: '2.00', minimum: '0.00',
  validity: { kind: 'relative', days: 7, startTime: null, endTime: null }, receivedCount: received ? 1 : 0, receiveLimit: 1,
  claimable: !received, claimReason: received ? '已领取' : '', isMember: false, rule: '<p>购买券规则</p>' });
function setup(options = {}) {
  const traces = [], records = options.records ?? new Map(), issues = options.issues ?? [issue(130001, options.received)]; let r, cart;
  r = runtime({ component: 'pages/goods/detail.vue', platform: options.platform ?? 'H5', storage: options.storage ?? new Map(), send: c => {
    traces.push({ url: c.url, method: c.method, data: structuredClone(c.data) });
    if (/\/product\/detail\/\d+\/coupons$/u.test(c.url)) {
      const productId = Number(c.url.split('/').at(-2)), page = c.data.page;
      const items = issues.slice((page - 1) * 10, page * 10).map(item => records.has(item.id) ? { ...item, receivedCount: 1, claimable: false } : item);
      return { data: { version: 1, view: 'uni_product_coupons', uid: r.auth.uid, productId, page, limit: 10, total: issues.length, items } };
    }
    if (/\/coupons\/\d+\/receipt$/u.test(c.url)) {
      const parts = c.url.split('/'), couponId = Number(parts.at(-2));
      return options.receipt?.(c) ?? { data: { version: 1, uid: r.auth.uid, productId: Number(parts.at(-4)), couponId,
        receivedCount: records.has(couponId) ? 1 : 0, latestCouponUserId: records.get(couponId) ?? null } };
    }
    if (c.url.endsWith('/coupon/receive')) {
      const saved = JSON.parse(r.storage.get(buyKey(r.auth.uid))), claim = JSON.parse(r.storage.get(claimKey(r.auth.uid)));
      assert.equal(saved.phase, 'claim-unknown'); assert.equal(saved.claimAttempt, claim.attempt); assert.equal(saved.cartId, 91);
      assert.equal(c.data.id, saved.issueId); assert.deepEqual(Object.keys(c.data), ['id']);
      const commit = () => { records.set(c.data.id, 5001); return { data: { couponUserId: 5001 } }; };
      return options.claim?.(c, commit) ?? commit();
    }
    if (c.url.endsWith('/cart/add')) {
      const saved = JSON.parse(r.storage.get(buyKey(r.auth.uid))), ordinary = JSON.parse(r.storage.get(ordinaryKey(r.auth.uid)));
      assert.equal(saved.phase, 'cart-unknown'); assert.equal(ordinary.state, 'unknown'); assert.equal(saved.unique, c.data.unique);
      assert.deepEqual(c.data, { productId: saved.productId, unique: saved.unique, cartNum: saved.quantity, new: 1 });
      cart = { id: 91, productId: saved.productId, unique: saved.unique, cartNum: saved.quantity, type: 0, isNew: 1, isValid: true,
        productInfo: { storeName: '原购买商品', image: '', price: '10.00', stock: 8, otPrice: '', suk: '', systemFormId: 0, productType: 0 }, sumPrice: '10.00' };
      return options.cart?.(c) ?? { data: { id: 91 } };
    }
    if (c.url.endsWith('/cart/list')) { assert.deepEqual(c.data, { scope: 'buy', ids: '91' }); return options.items?.(c, cart) ?? { data: [cart ?? options.savedCart] }; }
    if (/\/product\/detail\/\d+$/u.test(c.url)) return { data: { id: Number(c.url.split('/').at(-1)), price: '10.00', stock: 8, cart_button: 1, storeName: '原商品',
      attr_value: [{ unique: 'red001', suk: '红', price: '10.00', stock: 8 }, { unique: 'blue001', suk: '蓝', price: '12.00', stock: 8 }] } };
    if (c.url.endsWith('/cart/count')) return { data: { count: 0 } };
    return { data: [] };
  } });
  return { ...r, traces, records, async open() { await r.start({ id: '70' }); r.checkout.marketingVisible.value = true; await tick(); },
    async select(index = 0) { const p = r.checkout; p.chooseCouponBuy(p.productCoupons.state.items[index]); await tick(); assert.equal(p.skuVisible.value, true); },
    get cart() { return cart; } };
}
const posts = (r, suffix) => r.traces.filter(c => c.method === 'POST' && c.url.endsWith(suffix));
const receipts = r => r.traces.filter(c => c.url.endsWith('/receipt'));
for (const platform of ['H5', 'MP-WEIXIN', 'APP-PLUS']) for (const received of [false, true]) test(`${platform} ${received ? 'received' : 'unclaimed'} coupon purchase retains exact SKU/cart through failed navigation`, async () => {
  const r = setup({ platform, received }); const urls = []; r.uni.navigateTo = o => { urls.push(o.url); o.fail(); };
  try { await r.open(); await r.select(); const p = r.checkout;
    assert.equal(p.marketingVisible.value, false); assert.ok(p.productCoupons.state.items.length, 'drawer close keeps purchase grant owner alive');
    p.pickSku(p.skuList.value[1]); p.num.value = 2; await p.confirmSku();
    const intent = JSON.parse(r.storage.get(buyKey(11))); assert.equal(intent.phase, 'ready'); assert.equal(intent.unique, 'blue001'); assert.equal(intent.quantity, 2);
    assert.equal(intent.evidence, received ? 'directory' : 'grant'); assert.equal(intent.ownedId, received ? null : 5001);
    assert.equal(r.storage.get(claimKey(11)), undefined); assert.match(urls[0], /^\/pages\/order\/confirm\?mode=buy&cartId=91&couponBuy=/u);
    await p.couponBuy.resume(); await p.couponBuy.resume(); await p.confirmSku();
    assert.equal(posts(r, '/cart/add').length, 1); assert.equal(posts(r, '/coupon/receive').length, received ? 0 : 1);
    assert.equal(urls.length, 4); assert.equal(new Set(urls).size, 1); assert.equal(receipts(r).length, 0);
  } finally { r.stop(); }
});
test('lost grant response restores original receipt after reload, preserving cart and never granting twice', async () => {
  const r = setup({ claim: (_, commit) => { commit(); return { transport: 'grant committed, reply lost' }; } }); r.uni.navigateTo = o => o.fail();
  try { await r.open(); await r.select(); await r.checkout.confirmSku();
    const old = JSON.parse(r.storage.get(buyKey(11))); assert.equal(old.phase, 'claim-unknown'); assert.ok(old.claimAttempt); assert.ok(r.storage.get(claimKey(11)));
    r.hooks.onHide(); r.hooks.onShow(); await tick(); await r.checkout.couponBuy.resume();
    const ready = JSON.parse(r.storage.get(buyKey(11))); assert.equal(ready.attempt, old.attempt); assert.equal(ready.phase, 'ready'); assert.equal(ready.evidence, 'receipt');
    assert.equal(ready.ownedId, null, 'receipt max owned is not asserted usable'); assert.equal(receipts(r).length, 1);
    assert.equal(posts(r, '/cart/add').length, 1); assert.equal(posts(r, '/coupon/receive').length, 1); assert.equal(r.storage.get(claimKey(11)), undefined);
  } finally { r.stop(); }
});
test('zero original receipt stays unknown across repeat checks and unrelated product', async () => {
  const r = setup({ claim: () => ({ transport: 'outcome unknown' }) });
  try { await r.open(); await r.select(); await r.checkout.confirmSku(); const saved = r.storage.get(buyKey(11));
    await r.checkout.couponBuy.resume(); await r.checkout.couponBuy.resume(); assert.equal(r.storage.get(buyKey(11)), saved); assert.equal(receipts(r).length, 2);
    r.hooks.onLoad({ id: '71' }); await tick(); await r.checkout.couponBuy.resume();
    assert.equal(r.storage.get(buyKey(11)), saved); assert.equal(posts(r, '/cart/add').length, 1); assert.equal(posts(r, '/coupon/receive').length, 1); assert.equal(receipts(r).length, 2); assert.deepEqual(r.navigations, []);
  } finally { r.stop(); }
});
test('positive receipt without any owned ID proceeds only to the actual checkout picker', async () => {
  const r = setup({ claim: () => ({ transport: 'unknown' }), receipt: () => ({ data: { version: 1, uid: 11, productId: 70, couponId: 130001, receivedCount: 1, latestCouponUserId: null } }) });
  try { await r.open(); await r.select(); await r.checkout.confirmSku(); await r.checkout.couponBuy.resume();
    const row = JSON.parse(r.storage.get(buyKey(11))); assert.equal(row.phase, 'ready'); assert.equal(row.ownedId, null); assert.equal(row.evidence, 'receipt'); assert.equal(posts(r, '/coupon/receive').length, 1);
  } finally { r.stop(); }
});
for (const ending of ['onHide', 'onUnload', 'identity']) test(`late cart result after ${ending} cannot grant or navigate`, async () => {
  const gate = deferred(), r = setup({ cart: () => gate.promise });
  try { await r.open(); await r.select(); const first = r.checkout.confirmSku(); await tick();
    if (ending === 'identity') r.auth.setLogin('B', 22); else r.hooks[ending]();
    gate.resolve({ data: { id: 91 } }); await first; await tick();
    assert.equal(JSON.parse(r.storage.get(buyKey(11))).phase, 'cart-unknown'); assert.equal(posts(r, '/coupon/receive').length, 0); assert.deepEqual(r.navigations, []);
    if (ending === 'identity') { assert.equal(r.checkout.couponBuy.state.intent, null); assert.equal(r.storage.get(buyKey(22)), undefined); }
  } finally { gate.resolve({ data: { id: 91 } }); r.stop(); }
});
test('a selected later-page coupon survives directory reset before its one bound grant', async () => {
  const r = setup({ issues: Array.from({ length: 23 }, (_, i) => issue(130001 + i)) });
  try { await r.open(); await r.checkout.productCoupons.load(true); await r.checkout.productCoupons.load(true); await r.select(22);
    await r.checkout.productCoupons.load(false); assert.equal(r.checkout.productCoupons.state.items.length, 10);
    await r.checkout.confirmSku(); assert.deepEqual(posts(r, '/coupon/receive').map(c => c.data.id), [130023]);
  } finally { r.stop(); }
});
for (const stage of ['buy', 'ordinary', 'claim-sidecar']) test(`storage readback failure at ${stage} prevents its protected dispatch`, async () => {
  const r = setup();
  try { await r.open(); await r.select(); const set = r.uni.setStorageSync;
    r.uni.setStorageSync = (key, raw) => { if (stage === 'buy' && key === buyKey(11) || stage === 'ordinary' && key === ordinaryKey(11)
      || stage === 'claim-sidecar' && key === buyKey(11) && JSON.parse(raw).phase === 'claim-unknown') return; set(key, raw); };
    await r.checkout.confirmSku(); assert.equal(posts(r, '/cart/add').length, stage === 'claim-sidecar' ? 1 : 0); assert.equal(posts(r, '/coupon/receive').length, 0); assert.deepEqual(r.navigations, []);
  } finally { r.stop(); }
});
test('changed original cart fails before claim or navigation and never silently rebuilds it', async () => {
  const r = setup({ items: (_, cart) => ({ data: [{ ...cart, unique: 'other001' }] }) });
  try { await r.open(); await r.select(); await r.checkout.confirmSku(); await r.checkout.couponBuy.resume();
    assert.equal(posts(r, '/cart/add').length, 1); assert.equal(posts(r, '/coupon/receive').length, 0); assert.deepEqual(r.navigations, []); assert.match(r.checkout.couponBuy.state.error, /规格/u);
  } finally { r.stop(); }
});
test('a claim save that succeeds before failed readback is adopted only for receipt recovery', async () => {
  const r = setup();
  try { await r.open(); await r.select(); const set = r.uni.setStorageSync, get = r.uni.getStorageSync; let fail = false;
    r.uni.setStorageSync = (key, raw) => { set(key, raw); if (key === claimKey(11)) fail = true; };
    r.uni.getStorageSync = key => { if (key === claimKey(11) && fail) { fail = false; return ''; } return get(key); };
    await r.checkout.confirmSku(); assert.equal(posts(r, '/coupon/receive').length, 0); assert.equal(JSON.parse(r.storage.get(buyKey(11))).phase, 'cart-ready');
    const claim = JSON.parse(r.storage.get(claimKey(11))); await r.checkout.couponBuy.resume();
    const unknown = JSON.parse(r.storage.get(buyKey(11))); assert.equal(unknown.phase, 'claim-unknown'); assert.equal(unknown.claimAttempt, claim.attempt);
    assert.equal(receipts(r).length, 1); assert.equal(posts(r, '/coupon/receive').length, 0); assert.deepEqual(r.navigations, []);
    r.records.set(130001, 5001); await r.checkout.couponBuy.resume(); assert.equal(JSON.parse(r.storage.get(buyKey(11))).phase, 'ready');
    assert.equal(posts(r, '/coupon/receive').length, 0); assert.equal(r.storage.get(claimKey(11)), undefined);
  } finally { r.stop(); }
});
test('confirmed purchase save with failed readback retains exact owned ID and finishes its original claim cleanup', async () => {
  const r = setup(); r.uni.navigateTo = o => o.fail();
  try { await r.open(); await r.select(); const set = r.uni.setStorageSync, get = r.uni.getStorageSync; let fail = false;
    r.uni.setStorageSync = (key, raw) => { set(key, raw); if (key === buyKey(11) && JSON.parse(raw).phase === 'ready') fail = true; };
    r.uni.getStorageSync = key => { if (key === buyKey(11) && fail) { fail = false; return ''; } return get(key); };
    await r.checkout.confirmSku(); const ready = JSON.parse(r.storage.get(buyKey(11))); assert.equal(ready.phase, 'ready'); assert.equal(ready.ownedId, 5001);
    assert.ok(r.storage.get(claimKey(11))); await r.checkout.couponBuy.resume();
    assert.equal(JSON.parse(r.storage.get(buyKey(11))).ownedId, 5001); assert.equal(r.storage.get(claimKey(11)), undefined);
    assert.equal(receipts(r).length, 1); assert.equal(posts(r, '/cart/add').length, 1); assert.equal(posts(r, '/coupon/receive').length, 1);
  } finally { r.stop(); }
});
for (const denied of [true, false]) test(`H5 purchase and sole grant use distinct locks, purchase denied=${denied}`, async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'window'), locks = [], events = new Map();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { hash: '' }, navigator: { locks: { request: async (name, options, action) => {
    locks.push([name, options]); return action(denied ? null : {});
  } } }, addEventListener: (name, fn) => events.set(name, fn), removeEventListener: (name, fn) => { if (events.get(name) === fn) events.delete(name); } } });
  const r = setup();
  try { await r.open(); await r.select(); await r.checkout.confirmSku();
    assert.deepEqual(locks.map(row => row[0]), denied ? ['cinashop-product-coupon-buy-11'] : ['cinashop-product-coupon-buy-11', 'cinashop-product-coupons-11']);
    assert.ok(locks.every(row => row[1].mode === 'exclusive' && row[1].ifAvailable === true));
    assert.equal(posts(r, '/cart/add').length, denied ? 0 : 1); assert.equal(posts(r, '/coupon/receive').length, denied ? 0 : 1);
    if (denied) assert.equal(r.storage.get(buyKey(11)), undefined);
  } finally { r.stop(); if (saved) Object.defineProperty(globalThis, 'window', saved); else delete globalThis.window; assert.equal(events.size, 0); }
});
test('cold reconstruction binds the same UID to fresh original-cart reads without automatic writes', async () => {
  const storage = new Map(), first = setup({ storage, received: true }); first.uni.navigateTo = o => o.fail();
  let originalCart;
  try { await first.open(); await first.select(); await first.checkout.confirmSku(); originalCart = first.cart; } finally { first.stop(); }
  const saved = storage.get(buyKey(11)), second = setup({ storage, savedCart: originalCart });
  try { await second.open(); assert.equal(second.auth.sessionVersion, 0); assert.equal(storage.get(buyKey(11)), saved);
    assert.equal(second.traces.some(c => c.url.endsWith('/cart/list')), false); assert.equal(posts(second, '/cart/add').length, 0); assert.equal(posts(second, '/coupon/receive').length, 0);
    await second.checkout.couponBuy.resume(); assert.match(second.navigations[0], /cartId=91&couponBuy=/u);
    assert.equal(second.traces.filter(c => c.url.endsWith('/cart/list')).length, 1); assert.equal(posts(second, '/cart/add').length, 0); assert.equal(posts(second, '/coupon/receive').length, 0);
  } finally { second.stop(); }
});
test('an unknown cart cannot borrow another acknowledged cart with identical product/SKU/quantity', async () => {
  const r = setup({ cart: () => ({ transport: 'cart result unknown' }) });
  try { await r.open(); await r.select(); await r.checkout.confirmSku(); const intent = r.storage.get(buyKey(11));
    const other = JSON.stringify({ version: 1, actor: 11, mode: 'buy', state: 'acknowledged', productId: 70, unique: 'red001', quantity: 1, cartId: 777 });
    r.storage.set(ordinaryKey(11), other); await r.checkout.couponBuy.resume();
    assert.equal(r.storage.get(buyKey(11)), intent); assert.equal(r.storage.get(ordinaryKey(11)), other);
    assert.equal(r.traces.some(c => c.url.endsWith('/cart/list')), false); assert.equal(posts(r, '/cart/add').length, 1); assert.equal(posts(r, '/coupon/receive').length, 0); assert.deepEqual(r.navigations, []);
  } finally { r.stop(); }
});
test('an acknowledged server cart survives failure to update the shared legacy ledger', async () => {
  const r = setup(); r.uni.navigateTo = o => o.fail();
  try { await r.open(); await r.select(); const set = r.uni.setStorageSync;
    r.uni.setStorageSync = (key, raw) => { if (key === ordinaryKey(11) && JSON.parse(raw).state === 'acknowledged') return; set(key, raw); };
    await r.checkout.confirmSku(); assert.equal(JSON.parse(r.storage.get(buyKey(11))).cartId, 91); assert.equal(JSON.parse(r.storage.get(buyKey(11))).phase, 'cart-ready');
    assert.equal(JSON.parse(r.storage.get(ordinaryKey(11))).state, 'unknown'); assert.equal(posts(r, '/coupon/receive').length, 0);
    await r.checkout.couponBuy.resume(); assert.equal(JSON.parse(r.storage.get(buyKey(11))).phase, 'ready'); assert.equal(posts(r, '/cart/add').length, 1); assert.equal(posts(r, '/coupon/receive').length, 1);
    assert.equal(JSON.parse(r.storage.get(ordinaryKey(11))).state, 'unknown', 'do not erase an unassociated unknown legacy write');
  } finally { r.stop(); }
});
test('a foreign ledger changed during cart response cannot replace the acknowledged original server ID', async () => {
  const gate = deferred(), r = setup({ cart: () => gate.promise }); r.uni.navigateTo = o => o.fail();
  try { await r.open(); await r.select(); const first = r.checkout.confirmSku(); await tick();
    const other = JSON.stringify({ version: 1, actor: 11, mode: 'buy', state: 'acknowledged', productId: 70, unique: 'red001', quantity: 1, cartId: 92 });
    r.storage.set(ordinaryKey(11), other); gate.resolve({ data: { id: 91 } }); await first;
    assert.equal(JSON.parse(r.storage.get(buyKey(11))).cartId, 91); assert.equal(r.storage.get(ordinaryKey(11)), other); assert.equal(posts(r, '/coupon/receive').length, 0);
    await r.checkout.couponBuy.resume(); assert.equal(r.storage.get(ordinaryKey(11)), other); assert.equal(posts(r, '/cart/add').length, 1); assert.equal(posts(r, '/coupon/receive').length, 1);
    assert.ok(r.traces.filter(c => c.url.endsWith('/cart/list')).every(c => c.data.ids === '91'));
    assert.match(JSON.parse(r.storage.get(buyKey(11))).phase, /^ready$/u);
  } finally { gate.resolve({ data: { id: 91 } }); r.stop(); }
});
