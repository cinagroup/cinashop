const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
const goods = (id = 70, price = '8.00') => ({ id, price: '10.00', stock: 8, isVip: 1, cart_button: 1,
  storeName: `商品${id}`, attr_value: [{ unique: 'red001', suk: '红色', price: '10.00', vip_price: '8.00', stock: 8,
    member_price: price, price_type: price === '10.00' ? '' : 'member', level_name: '' }] });
const bundle = () => ({ id: 5, type: 0, title: '套餐', products: [1, 2].map(id => ({ id, product_id: id + 70, productValue: [{ unique: 'red001', stock: 8, price: '1.00' }] })) });
function setup(override = () => undefined) {
  return runtime({ component: 'pages/goods/detail.vue', send: call => override(call) ?? (
    call.url.includes('/product/detail/') ? { data: goods(Number(call.url.split('/').at(-1))) } :
    call.url.includes('/store_discounts/list/') ? { data: [bundle()] } :
    call.url.includes('/reply/config/') ? { data: { total: 0, avgScore: '0', goodRate: 100 } } :
    call.url.includes('/reply/list/') ? { data: [] } : { data: { id: 91, cartIds: [91, 92] } }) });
}
for (const mode of ['ordinary', 'package']) test(`${mode} known cart survives native navigation failure without another write`, async () => {
  const r = setup(); let refuse = true; const urls = [];
  r.uni.navigateTo = options => { urls.push(options.url); if (refuse) options.fail(); };
  try {
    await r.start({id:'70'}); const p = r.checkout;
    if (mode === 'package') p.openPackage(p.discountPackages.value[0]); else p.openSku('buy');
    const buy = () => mode === 'package' ? p.buyPackage() : p.confirmSku();
    await buy(); refuse = false; await buy();
    assert.equal(r.calls.filter(c => c.url.includes('/cart/add')).length, 1);
    assert.equal(urls.length, 2); assert.equal(urls[0], urls[1]);
  } finally { r.stop(); }
});
test('prepared ordinary retry has one native navigation gate and ignores previous attempt callbacks', async () => {
  const r=setup(), callbacks=[]; r.uni.navigateTo=options=>callbacks.push(options);
  try{await r.start({id:'70'});const p=r.checkout;p.openSku('buy');await p.confirmSku();callbacks[0].fail();
    p.resumeCheckout();p.resumeCheckout();await p.confirmSku();p.restartPurchase();
    callbacks[0].fail();assert.equal(p.navigating.value,true);assert.equal(callbacks.length,2);assert.equal(p.checkoutError.value,'');
    callbacks[1].fail();assert.equal(p.navigating.value,false);assert.match(p.checkoutError.value,/继续结算/);
    assert.equal(r.calls.filter(c=>c.url.includes('/cart/add')).length,1);
  }finally{r.stop();}
});
for(const ending of ['identity','onHide','onUnload','route','reload'])test(`prepared ordinary recovery is discarded after ${ending}`,async()=>{
  const r=setup();r.uni.navigateTo=opts=>opts.fail();
  try{await r.start({id:'70'});const p=r.checkout;p.openSku('buy');await p.confirmSku();assert.ok(p.preparedCart.value);
    if(ending==='identity')r.auth.setLogin('replacement',22);
    else if(ending==='route')r.hooks.onLoad({id:'71'});
    else if(ending==='reload')p.restartPurchase();
    else r.hooks[ending]();
    await tick();assert.equal(p.preparedCart.value,null);const count=r.calls.length;p.resumeCheckout();assert.equal(r.calls.length,count);
  }finally{r.stop();}
});
for(const response of [{data:{id:0}},{transport:'uncertain network'}])test(`unconfirmed ordinary write ${JSON.stringify(response)} needs explicit refresh`,async()=>{
  const r=setup(c=>c.url.includes('/cart/add')?response:undefined);
  try{await r.start({id:'70'});const p=r.checkout;p.openSku('buy');await p.confirmSku();assert.equal(p.preparedCart.value,null);assert.equal(p.purchaseNeedsRefresh.value,true);
    await p.confirmSku();p.openSku('cart');await p.confirmSku();assert.equal(r.calls.filter(c=>c.url.includes('/cart/add')).length,1);assert.deepEqual(r.navigations,[]);
  }finally{r.stop();}
});
test('pending ordinary purchase prevents an overlapping package submission',async()=>{
  const wait=deferred(),r=setup(c=>c.url.includes('/cart/add')?wait.promise:undefined);
  try{await r.start({id:'70'});const p=r.checkout;p.openPackage(p.discountPackages.value[0]);p.openSku('buy');const first=p.confirmSku();await tick();
    await p.buyPackage();assert.equal(r.calls.filter(c=>c.url.includes('/cart/add')).length,1);wait.resolve({data:{id:91}});await first;
  }finally{wait.resolve({data:{id:91}});r.stop();}
});
test('identity renewal synchronously clears price, SKU and open package before fresh final-token request', async () => {
  let slow = false; const gate = deferred(), tokens = [];
  const r = setup(call => { if (call.url.includes('/product/detail/')) {
    tokens.push(call.header['Authori-zation']); return slow ? gate.promise : { data: goods() };
  } });
  try {
    await r.start({ id: '70' }); const p = r.checkout;
    p.openSku('buy'); p.openPackage(p.discountPackages.value[0]); slow = true;
    r.auth.setLogin('new-user', 22);
    assert.equal(p.detail.value, null); assert.equal(p.selectedSku.value, null);
    assert.equal(p.skuVisible.value, false); assert.equal(p.packageVisible.value, false);
    assert.deepEqual(p.discountPackages.value, []); assert.deepEqual(p.packageChoices.value, {});
    await tick(); assert.equal(tokens.at(-1), 'Bearer new-user');
    gate.resolve({ data: goods(70, '10.00') }); await tick(); assert.equal(p.displayPrice.value, '10.00');
    assert.ok(r.calls.every(c => !c.url.includes('/cart/add')));
  } finally { gate.resolve({ data: goods() }); r.stop(); }
});
test('even identical-token login invalidates already loaded membership state', async () => {
  const r = setup(); try { await r.start({ id: '70' }); r.auth.setLogin(r.auth.token, r.auth.uid); assert.equal(r.checkout.detail.value, null); await tick(); assert.ok(r.checkout.detail.value); } finally { r.stop(); }
});
for (const hook of ['onHide', 'onUnload']) test(`${hook} removes loaded details and prevents detached interactions`, async () => {
  const r = setup(); try {
    await r.start({ id: '70' }); const p = r.checkout; p.openSku('buy'); const old = p.discountPackages.value[0];
    r.hooks[hook]?.(); assert.equal(p.detail.value, null); assert.equal(p.skuVisible.value, false);
    const before = r.calls.length; p.openSku('buy'); p.openPackage(old); await p.confirmSku(); await p.buyPackage();
    assert.equal(r.calls.length, before); assert.equal(p.packageVisible.value, false);
  } finally { r.stop(); }
});
test('hide then login then show fetches a new quote without automatically submitting', async () => {
  let price = '8.00'; const r = setup(call => call.url.includes('/product/detail/') ? { data: goods(70, price) } : undefined);
  try { await r.start({ id: '70' }); r.hooks.onHide?.(); price = '10.00'; r.auth.setLogin('new', 22);
    r.hooks.onShow?.(); await tick(); assert.equal(r.checkout.displayPrice.value, '10.00');
    assert.equal(r.checkout.skuVisible.value, false); assert.ok(r.calls.every(c => !c.url.includes('/cart/add')));
  } finally { r.stop(); }
});
test('late old-route detail cannot overwrite the latest product', async () => {
  const gate = deferred(); const r = setup(call => call.url.endsWith('/detail/70') ? gate.promise : undefined);
  const first = r.start({ id: '70' });
  try { await tick(); r.hooks.onLoad({ id: '71' }); await tick(); gate.resolve({ data: goods(70) }); await first; await tick();
    assert.equal(r.checkout.detail.value.id, 71);
  } finally { gate.resolve({ data: goods(70) }); r.stop(); }
});
for (const ending of ['onHide', 'onUnload', 'identity']) test(`late cart result after ${ending} does not navigate or toast`, async () => {
  const gate = deferred(); const r = setup(call => call.url.includes('/cart/add') ? gate.promise : undefined);
  try { await r.start({ id: '70' }); const p = r.checkout; p.openSku('buy'); const pending = p.confirmSku(); await tick();
    if (ending === 'identity') r.auth.setLogin('next', 22); else r.hooks[ending]?.();
    gate.resolve({ data: { id: 91 } }); await pending;
    assert.deepEqual(r.navigations, []); assert.deepEqual(r.toasts, []);
  } finally { gate.resolve({ data: { id: 91 } }); r.stop(); }
});
test('late package result is isolated from a new visible page and new busy flag', async () => {
  const old = deferred(), latest = deferred(); let writes = 0;
  const r = setup(call => call.url.includes('/cart/add') ? (++writes === 1 ? old.promise : latest.promise) : undefined);
  try { await r.start({ id: '70' }); const p = r.checkout; p.openPackage(p.discountPackages.value[0]); const first = p.buyPackage(); await tick();
    r.hooks.onHide?.(); r.hooks.onShow?.(); await tick(); p.openPackage(p.discountPackages.value[0]); const second = p.buyPackage(); await tick();
    old.resolve({ data: { cartIds: [91, 92] } }); await first;
    assert.equal(p.packageBuying.value, true); assert.deepEqual(r.navigations, []);
    latest.resolve({ data: { cartIds: [93, 94] } }); await second; assert.match(r.navigations.at(-1), /cartIds=93,94/);
  } finally { old.resolve({ data: { cartIds: [91] } }); latest.resolve({ data: { cartIds: [93] } }); r.stop(); }
});
test('late review responses never populate a different product', async () => {
  const gate = deferred(); const r = setup(call => call.url.endsWith('/config/70') ? gate.promise : undefined);
  try { await r.start({ id: '70' }); r.hooks.onLoad({ id: '71' }); await tick();
    gate.resolve({ data: { total: 99, avgScore: '5', goodRate: 100 } }); await tick();
    assert.equal(r.checkout.replyStats.value.total, 0);
  } finally { gate.resolve({ data: { total: 99 } }); r.stop(); }
});
test('an old native navigation failure cannot unlock a new owner navigation', async () => {
  const r = setup(), callbacks = [];
  r.uni.navigateTo = opts => callbacks.push(opts);
  try { await r.start({ id: '70' }); const p = r.checkout;
    p.goAllComments(); assert.equal(p.navigating.value, true);
    r.hooks.onHide(); r.auth.setLogin('new-owner', 22); r.hooks.onShow(); await tick();
    p.goAllComments(); callbacks[0].fail();
    assert.equal(p.navigating.value, true); assert.deepEqual(r.toasts, []);
    callbacks[1].fail(); assert.equal(p.navigating.value, false); assert.equal(r.toasts.length, 1);
  } finally { r.stop(); }
});
test('a mismatched detail response is an error, never a purchasable different product', async () => {
  const r = setup(call => call.url.includes('/product/detail/') ? { data: goods(71) } : undefined);
  try { await r.start({ id: '70' }); assert.equal(r.checkout.detail.value, null); assert.match(r.checkout.loadError.value, /不匹配/);
    const count = r.calls.length; await r.checkout.confirmSku(); assert.equal(r.calls.length, count);
  } finally { r.stop(); }
});
test('invalid route identity sends no requests and exposes a retryable error, not stale goods', async () => {
  const r = setup(); try { await r.start({ id: '70' }); const count = r.calls.length;
    r.hooks.onLoad({ id: '1e2' }); await tick(); assert.equal(r.calls.length, count); assert.equal(r.checkout.detail.value, null);
    assert.match(r.checkout.loadError.value, /标识|链接/);
  } finally { r.stop(); }
});
test('H5 query reuse handles new and duplicate IDs, and removes its hash listener on unload', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'window'), listeners = new Map();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { hash: '#/pages/goods/detail?id=70' },
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) } });
  const r = setup(); try {
    await r.start({ id: '70' }); window.location.hash = '#/pages/goods/detail?id=71'; listeners.get('hashchange')?.(); await tick();
    assert.equal(r.checkout.detail.value.id, 71);
    const count = r.calls.length;
    for (const query of ['id=71&id=70', 'id=71?ignored', 'id=1e2', 'id=2147483648', 'id=0', 'id=01', 'id=70.0']) {
      window.location.hash = `#/pages/goods/detail?${query}`; listeners.get('hashchange')?.(); await tick();
      assert.equal(r.checkout.detail.value, null, query); assert.equal(r.calls.length, count, query);
      assert.match(r.checkout.loadError.value, /标识|链接/);
    }
  } finally { r.stop(); assert.equal(listeners.size, 0); if (saved) Object.defineProperty(globalThis, 'window', saved); else delete globalThis.window; }
});
