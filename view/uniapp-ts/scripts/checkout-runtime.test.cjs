const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vue = require('vue');
const pinia = require('pinia');
const root = path.resolve(__dirname, '..');
const tick = async () => { for (let i = 0; i < 8; i++) { await vue.nextTick(); await new Promise(setImmediate); } };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

// Real Vue reactivity, Pinia stores, request layer, API adapters and checkout composable.
// Only native lifecycle/I/O is replaced. Platform preprocessing is covered by the three builds, not this loader.
function runtime({ storage = new Map(), send, navigationFails = false } = {}) {
  const hooks = {}, calls = [], navigations = [], cache = new Map();
  const uni = {
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key),
    navigateTo: opts => navigations.push(opts.url), redirectTo: opts => { navigations.push(opts.url); if (navigationFails) opts.fail(new Error('navigation failed')); else opts.success(); },
    request: call => { calls.push(structuredClone({ url: call.url, data: call.data })); Promise.resolve().then(() => send(call)).then(result => {
      if (result?.transport) call.fail({ errMsg: result.transport });
      else call.success({ statusCode: result?.httpStatus ?? 200, header: result?.headers ?? {}, data: { status: result?.status ?? 200, msg: result?.msg ?? 'ok', data: result?.data } });
    }).catch(error => call.fail({ errMsg: error.message })); },
  };
  const lifecycle = Object.fromEntries(['onLoad', 'onShow', 'onHide', 'onUnload'].map(name => [name, fn => { hooks[name] = fn; }]));
  function load(file) {
    file = path.resolve(file); if (!path.extname(file)) file += '.ts';
    if (cache.has(file)) return cache.get(file);
    assert.ok(existsSync(file), file);
    const exports = {}; cache.set(file, exports);
    const output = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    new Function('require', 'exports', 'uni', output)(id => {
      if (id === 'vue') return vue; if (id === 'pinia') return pinia; if (id === '@dcloudio/uni-app') return lifecycle;
      if (id.startsWith('@/')) return load(path.join(root, 'src', id.slice(2)));
      if (id.startsWith('.')) return load(path.resolve(path.dirname(file), id));
      throw new Error(`Unreplaced dependency: ${id}`);
    }, exports, uni);
    return exports;
  }
  pinia.setActivePinia(pinia.createPinia());
  const auth = load(path.join(root, 'src/stores/auth.ts')).useAuthStore();
  if (!auth.isLoggedIn) auth.setLogin('synthetic-local-token', 11);
  const scope = vue.effectScope();
  const checkout = scope.run(() => load(path.join(root, 'src/composables/useCheckout.ts')).useCheckout());
  return { checkout, auth, storage, calls, navigations, hooks, load, uni,
    async start(query = { mode: 'buy', cartId: '1' }) { hooks.onLoad(query); hooks.onShow(); await tick(); },
    stop() { hooks.onUnload(); scope.stop(); },
  };
}
const item = { id: 1, productId: 70, unique: 'realSku', cartNum: 2, type: 0, isNew: 1, isValid: true,
  productInfo: { price: '999.99', storeName: 'local', image: '', stock: 5, otPrice: '', suk: 'red', systemFormId: 0, productType: 0 }, sumPrice: '1999.98' };
function server(overrides = {}) {
  return async call => {
    if (overrides[call.url]) return overrides[call.url](call);
    if (call.url === '/api/cart/list') return { data: [item] };
    if (call.url === '/api/address/list') return { data: [{ id: 11, real_name: 'local', phone: '00000000000', is_default: 1 }] };
    if (call.url === '/api/store/list') return { data: [{ id: 1, name: 'local' }] };
    if (call.url.startsWith('/api/coupons/order/')) return { data: [], headers: {} };
    if (call.url === '/api/order/confirm' || call.url.startsWith('/api/order/computed/')) return { data: {
      orderKey: 'checkout_key1', addressInfo: { id: call.data.addressId },
      cartInfo: [{ ...item, truePrice: '9.00', sumPrice: '20.00', productInfo: { ...item.productInfo, price: '10.00' } }],
      priceGroup: { sumPrice: '20.00', totalPrice: '18.00', pay_price: call.data.shippingType === 2 ? '18.00' : '21.00',
        total_postage: '6.00', storePostageDiscount: '3.00', pay_postage: '3.00', vipPrice: '2.00', levelPrice: '0.00', memberPrice: '2.00',
        couponPrice: '0.00', deduction_price: '0.00', firstOrderPrice: '0.00', usedIntegral: 0, SurplusIntegral: 100, pay_integral: 0 },
    } };
    throw new Error(`No fixture: ${call.url}`);
  };
}
const key = 'cinashop_checkout_pending_v1_11';
test('actual checkout gates on server quote, requotes delivery and blocks while uploading', async () => {
  const r = runtime({ send: server() }); await r.start();
  assert.equal(r.checkout.ready.value, true); assert.equal(r.checkout.quote.value.result.prices.payable, '21.00');
  assert.equal(r.checkout.displayItems.value[0].sumPrice, '20.00');
  assert.deepEqual(r.calls.find(c => c.url === '/api/cart/list').data, { scope: 'buy', ids: '1' });
  r.checkout.uploads.value = 1; assert.equal(r.checkout.canSubmit.value, false);
  r.hooks.onHide(); assert.equal(r.checkout.formLocked.value, false); assert.equal(r.checkout.canSubmit.value, false);
  r.hooks.onShow(); await tick(); assert.equal(r.checkout.uploads.value, 1);
  r.checkout.uploads.value = 0; r.checkout.setShipping(2); assert.equal(r.checkout.canSubmit.value, false); await tick();
  assert.equal(r.checkout.quote.value.result.prices.payable, '18.00'); assert.equal(r.checkout.canSubmit.value, true); r.stop();
});
test('unknown result survives reload with identical key/body and does not load another cart or pay', async () => {
  const storage = new Map(); const send = server({ '/api/order/create/checkout_key1': () => ({ transport: 'timeout' }) });
  const first = runtime({ storage, send }); await first.start(); first.checkout.mark.value = 'frozen'; await first.checkout.submit();
  const captured = first.calls.find(c => c.url.includes('/create/'));
  assert.equal(first.checkout.pending.value.key, 'checkout_key1'); assert.equal(first.checkout.locked.value, true); first.stop();
  const second = runtime({ storage, send }); await second.start({ mode: 'buy', cartId: '999' });
  assert.equal(second.calls.length, 0); await second.checkout.submit();
  assert.deepEqual(second.calls, [captured]); assert.equal(JSON.parse(storage.get(key)).payload.mark, 'frozen');
  assert.equal(second.navigations.length, 0); second.stop();
});
test('a known result navigates without payment and clears only after successful navigation', async () => {
  const send = server({ '/api/order/create/checkout_key1': () => ({ data: { key: 'checkout_key1', orderId: 'order_local_1' } }) });
  const r = runtime({ send, navigationFails: true }); await r.start(); await r.checkout.submit();
  assert.equal(r.checkout.pending.value.orderId, 'order_local_1'); await r.checkout.submit();
  assert.equal(r.calls.filter(c => c.url.includes('/create/')).length, 1); assert.ok(r.storage.has(key)); r.stop();
  const restored = runtime({ send, storage: r.storage }); await restored.start(); await restored.checkout.submit();
  assert.equal(restored.calls.length, 0); assert.deepEqual(restored.navigations, ['/pages/order/detail?orderId=order_local_1']);
  assert.equal(restored.storage.has(key), false); restored.stop();
});
test('first-attempt definitive form rejection unlocks; same error after uncertainty never clears', async () => {
  const rejection = { status: 400, msg: 'form required', data: { errorCode: 'ORDER_FORM_REJECTED', orderKey: 'checkout_key1' } };
  let uncertain = false;
  const r = runtime({ send: server({ '/api/order/create/checkout_key1': () => uncertain ? { transport: 'timeout' } : rejection }) });
  await r.start(); await r.checkout.submit(); assert.equal(r.checkout.pending.value, null); assert.equal(r.storage.has(key), false);
  uncertain = true; await r.checkout.submit(); uncertain = false; await r.checkout.submit();
  assert.ok(r.checkout.pending.value); assert.ok(r.storage.has(key)); r.stop();
});
test('account switch or page hide while submission is pending does not publish a late old result', async () => {
  const pending = deferred(); const r = runtime({ send: server({ '/api/order/create/checkout_key1': () => pending.promise }) });
  await r.start(); const submission = r.checkout.submit(); await tick(); r.auth.setLogin('other-token', 22); await tick();
  pending.resolve({ data: { key: 'checkout_key1', orderId: 'old_order' } }); await submission;
  assert.equal(r.checkout.pending.value, null); assert.equal(r.checkout.canSubmit.value, false);
  assert.deepEqual(r.checkout.contact.value, { realName: '', userPhone: '' }); assert.equal(r.checkout.mark.value, '');
  assert.ok(r.storage.has(key)); assert.equal(r.navigations.length, 0); r.stop();
});
test('double click produces one network call; hide/show resumes original pending intent', async () => {
  const pending = deferred(); const r = runtime({ send: server({ '/api/order/create/checkout_key1': () => pending.promise }) });
  await r.start(); const submission = r.checkout.submit(); await r.checkout.submit(); await tick();
  assert.equal(r.calls.filter(c => c.url.includes('/create/')).length, 1);
  r.hooks.onHide(); r.hooks.onShow(); pending.resolve({ transport: 'timeout' }); await submission; await tick();
  assert.equal(r.checkout.pending.value.key, 'checkout_key1'); assert.equal(r.checkout.canSubmit.value, true); r.stop();
});
test('write/read-back failure sends nothing and recovers a saved intent instead of creating another', async () => {
  const r = runtime({ send: server() }); await r.start(); const original = r.uni.setStorageSync;
  r.uni.setStorageSync = (k, v) => { original(k, v); throw new Error('storage uncertain'); };
  await r.checkout.submit(); assert.equal(r.calls.filter(c => c.url.includes('/create/')).length, 0);
  assert.equal(r.checkout.pending.value.key, 'checkout_key1'); assert.equal(r.checkout.locked.value, true); r.stop();
});
test('corrupt saved intent blocks fresh checkout and exact selection never silently falls back', async () => {
  const r = runtime({ send: server(), storage: new Map([[key, '{broken']]) }); await r.start();
  assert.match(r.checkout.error.value, /待确认/); assert.equal(r.calls.length, 0); assert.equal(r.checkout.canSubmit.value, false); r.stop();
  const invalid = runtime({ send: server() }); await invalid.start({ mode: 'buy', cartId: '1,x' });
  assert.equal(invalid.calls.length, 0); assert.match(invalid.checkout.error.value, /参数无效/); invalid.stop();
});
test('journal snapshots payload, rejects foreign identity/prices/result keys, and guards overwrites', () => {
  const r = runtime({ send: server() }); const { CheckoutIntentJournal, decodeCheckoutIntent } = r.load(path.join(root, '../common/checkoutIntent.ts'));
  const journal = new CheckoutIntentJournal({ get: k => r.storage.get(k), set: (k, v) => r.storage.set(k, v), remove: k => r.storage.delete(k) });
  const payload = { cartIds: [1], addressId: 11, shippingType: 1, storeId: 0, couponId: 0, useIntegral: false, type: 0, mark: '', customForm: [] };
  const intent = journal.begin(11, 'checkout_key1', payload); payload.cartIds.push(2); assert.deepEqual(intent.payload.cartIds, [1]);
  assert.throws(() => journal.begin(11, 'checkout_key2', payload)); assert.throws(() => journal.settled(intent, { key: 'other_key', orderId: 'order1' }));
  assert.throws(() => decodeCheckoutIntent(r.storage.get(key), 22));
  assert.throws(() => decodeCheckoutIntent(JSON.stringify({ ...intent, payload: { ...intent.payload, payType: 'yue' } }), 11)); r.stop();
});
test('mobile product normalization preserves real SKU and rejects missing/duplicate/fabricated selection data', () => {
  const r = runtime({ send: server() }); const { normalizeMobileGoods } = r.load(path.join(root, 'src/api/productDetail.ts'));
  const raw = { id: 70, stock: 3, price: '10.00', storeName: 'real', skus: [{ unique: 'actual001', suk: 'red', price: '8.00', stock: 3 }] };
  assert.equal(normalizeMobileGoods(raw).skus[0].unique, 'actual001'); assert.equal(normalizeMobileGoods(raw).store_name, 'real');
  assert.deepEqual(normalizeMobileGoods({ ...raw, skus: [] }).skus, []);
  assert.throws(() => normalizeMobileGoods({ ...raw, skus: [raw.skus[0], raw.skus[0]] }));
  assert.throws(() => normalizeMobileGoods({ ...raw, skus: [{ ...raw.skus[0], unique: '' }] })); r.stop();
});
test('required system form prevents submission, and load errors are not treated as an optional empty form', async () => {
  const formItem = { ...item, productInfo: { ...item.productInfo, systemFormId: 9 } };
  let fail = false;
  const r = runtime({ send: server({ '/api/cart/list': () => ({ data: [formItem] }), '/api/order/system_form/9': () => fail
    ? { transport: 'form unavailable' } : { data: { name: 'local form', value: [{ id: 1, name: 'texts', titleShow: { val: 1 }, titleConfig: { value: '联系人' }, value: '' }] } } }) });
  await r.start(); assert.equal(r.checkout.canSubmit.value, false); assert.match(r.checkout.formValidation.value, /联系人/);
  r.checkout.customForm.value[0].value = 'local'; assert.equal(r.checkout.canSubmit.value, true);
  fail = true; await r.checkout.load(); assert.equal(r.checkout.canSubmit.value, false); assert.equal(r.checkout.ready.value, false);
  assert.match(r.checkout.formValidation.value, /form unavailable/); r.stop();
});
