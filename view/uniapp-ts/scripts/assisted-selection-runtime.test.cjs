const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
const root = path.resolve(__dirname, '..');
const permissions = ['order.assisted', 'product.view', 'user.view'];
const loginData = (id = 1, grants = permissions) => ({ token: 'local-admin-' + id, expires_time: Math.floor(Date.now() / 1000) + 3600,
  user_info: { id, account: 'admin', real_name: '本地合成管理员' }, unique_auth: grants });
const buyer = (uid = 11, extra = {}) => ({ uid, nickname: '合成买家', phone: '13000000000', avatar: '', now_money: '10.00', integral: 30, status: 1, ...extra });
const product = (id = 7, extra = {}) => ({ id, store_name: '合成商品', image: '', price: '10.00', stock: 9, is_presale_product: 0, ...extra });
const sku = (id = 1, productId = 7, extra = {}) => ({ id, product_id: productId, unique: 'sku' + id, suk: '合成规格' + id, image: '', price: '10.00', stock: 9, ...extra });
const cartRow = (id = 21, extra = {}) => ({ id, uid: 11, staff_id: 1, type: 0, activity_id: 0, store_id: 0,
  is_new: 0, is_del: 0, is_pay: 0, status: 1, product_id: 7, product_attr_unique: 'sku1', cart_num: 1, is_valid: 1,
  truePrice: 9, trueStock: 9, productInfo: { id: 7, product_type: 0, store_name: '合成商品', image: '', is_presale_product: 0, attrInfo: sku() }, ...extra });
const envelopeList = (call, list) => ({ data: { page: call.data.page, limit: call.data.limit, list } });
function defaultSend(call) {
  if (call.url.endsWith('/login')) return { data: loginData() };
  if (call.url.endsWith('/user/list')) return envelopeList(call, [buyer()]);
  if (call.url.endsWith('/product/list')) return envelopeList(call, [product()]);
  if (call.url.includes('/get_attr/')) return { data: [sku(1, Number(call.url.split('/').at(-1)))] };
  if (call.method === 'GET' && call.url.includes('/order/cart/')) return { data: [cartRow()] };
  if (call.url.includes('/cart/add/')) return { data: { cartId: 21 } };
  return { data: 'success' };
}
async function buyers(send = defaultSend, options = {}) {
  const r = runtime({ feature: 'useAssistedBuyers', send, ...options });
  await r.start({ uid: '999' }); return r;
}
async function login(r) { r.checkout.account.value = ' admin '; r.checkout.password.value = 'local-only'; await r.checkout.login(); await tick(); }
async function shopping(send = defaultSend, { uid = 11, query, component = false, select = true } = {}) {
  const r = runtime({ feature: 'useAssistedShopping', send, ...(component ? { component: 'pages/behalf/goods_list/index.vue' } : {}) });
  const admin = r.load(path.join(root, 'src/stores/adminSession.ts')).useAdminSession();
  admin.install({ id: 1, label: '管理员', token: 'local-admin-1', expiresAt: Date.now() + 3600000, permissions });
  if (select) r.checkout.draft.choose(uid, uid === 0 ? 'guest-local-1' : '');
  await r.start(query ?? { uid: String(uid) }); return r;
}
async function choose(r, id = 7, key = 'sku1') { await r.checkout.selectProduct(id); r.checkout.selectSku(key); }
function writes(r) { return r.calls.filter(c => /\/cart\/(add|num|del)\//.test(c.url)); }

test('shopping routes only a valid complete cart to confirm and offers original-intent recovery',async()=>{
  const r=await shopping();try{assert.equal(r.checkout.canCheckout.value,true);r.checkout.checkout();
    assert.equal(r.navigations[0],'/pages/behalf/order_confirm/index?uid=11');
    r.storage.set('cinashop_assisted_pending_v1_1','corrupt');r.checkout.checkout();
    assert.equal(r.navigations[1],'/pages/behalf/order_confirm/index?resume=1');assert.equal(r.checkout.canCheckout.value,false);
  }finally{r.stop();}
});
test('journal appearing after shopping loads blocks additive, quantity and confirmed-delete writes',async()=>{
  const r=await shopping();try{await choose(r);r.storage.set('cinashop_assisted_pending_v1_1','corrupt');
    await r.checkout.add();await r.checkout.changeQuantity(21,1);r.uni.showModal=o=>o.success({confirm:true});r.checkout.remove(21);await tick();
    assert.equal(writes(r).length,0);assert.equal(r.checkout.draft.checkoutLock,true);
  }finally{r.stop();}
});
test('buyer login discovers an unresolved journal, prohibits reselection, and retains the original data',async()=>{
  const r=await buyers();try{r.storage.set('cinashop_assisted_pending_v1_1','corrupt');await login(r);
    assert.equal(r.checkout.draft.checkoutLock,true);await r.checkout.select(11);assert.equal(r.navigations.length,0);assert.match(r.checkout.selectionError.value,/恢复/);
    r.checkout.logout();assert.equal(r.storage.get('cinashop_assisted_pending_v1_1'),'corrupt');
  }finally{r.stop();}
});

test('buyer page uses independent Admin login and bounded minimum-field directory, never shopper credentials', async () => {
  const r = await buyers(call => {
    assert.equal(call.header['Authori-zation'], undefined);
    if (!call.url.endsWith('/login')) { assert.equal(call.header.Authorization, 'Bearer local-admin-1'); assert.deepEqual(call.data, { page: 1, limit: 20, nickname: '' }); }
    return defaultSend(call);
  });
  assert.equal(r.calls.length, 0); await login(r); assert.equal(r.checkout.items.value[0].uid, 11);
  assert.equal(r.auth.uid, 11); assert.equal(r.checkout.password.value, '');
  assert.deepEqual([...r.storage.keys()].sort(), ['uni_token', 'uni_uid']); r.stop();
});
test('natural Admin expiry removes visible buyer profile and shopping cart without another request',async()=>{
  const b=await buyers();try{
    await login(b);assert.equal(b.checkout.items.value[0].phone,'13000000000');
    const admin=b.load(path.join(root,'src/stores/adminSession.ts')).useAdminSession(),calls=b.calls.length;
    admin.expiresAt=Date.now()+80;admin.ensureFresh();await new Promise(resolve=>setTimeout(resolve,160));
    assert.equal(admin.token,'');assert.deepEqual(b.checkout.items.value,[]);assert.equal(b.calls.length,calls);
  }finally{b.stop();}
  const s=await shopping();try{
    assert.equal(s.checkout.cart.value.length,1);const admin=s.load(path.join(root,'src/stores/adminSession.ts')).useAdminSession();
    const calls=s.calls.length;admin.expiresAt=Date.now()+80;admin.ensureFresh();await new Promise(resolve=>setTimeout(resolve,160));
    assert.equal(admin.token,'');assert.deepEqual(s.checkout.cart.value,[]);assert.deepEqual(s.checkout.products.value,[]);
    assert.equal(s.checkout.draft.scope,null);assert.equal(s.calls.length,calls);
  }finally{s.stop();}
});
test('real buyer SFC setup selects only a displayed active member and duplicate taps cannot create duplicate pages', async () => {
  const r = await buyers(defaultSend, { component: 'pages/behalf/user_list/index.vue' }); await login(r);
  await r.checkout.select(999); assert.equal(r.navigations.length, 0); await r.checkout.select(11); await r.checkout.select(11);
  assert.deepEqual(r.navigations, ['/pages/behalf/goods_list/index?uid=11']);
  assert.deepEqual(r.checkout.draft.scope, { adminId: 1, uid: 11, touristUid: '' }); r.stop();
});
test('disabled customers cannot be selected', async () => {
  const r = await buyers(c => c.url.endsWith('/user/list') ? envelopeList(c, [buyer(11, { status: 0 })]) : defaultSend(c));
  await login(r); await r.checkout.select(11); assert.equal(r.checkout.draft.scope, null); r.stop();
});
test('directory permission is separate: authorized guest-only operator never reads customer profiles', async () => {
  const r = await buyers(c => c.url.endsWith('/login') ? { data: loginData(1, ['order.assisted', 'product.view']) } : defaultSend(c));
  r.uni.getRandomValues = opts => opts.success({ randomValues: new Uint8Array(16).fill(7).buffer });
  await login(r); assert.equal(r.checkout.canRead.value, false); assert.equal(r.calls.length, 1);
  await r.checkout.select(11); assert.equal(r.navigations.length, 0); await r.checkout.select(0);
  assert.equal(r.checkout.draft.scope.uid, 0); assert.match(r.checkout.draft.scope.touristUid, /^[a-f0-9-]{36}$/);
  assert.deepEqual([...r.storage.keys()].sort(), ['uni_token', 'uni_uid']); r.stop();
});
test('missing secure guest randomness fails closed; no timestamp or Math.random substitute', async () => {
  const r = await buyers(); await login(r); await r.checkout.select(0);
  assert.equal(r.checkout.draft.scope, null); assert.match(r.checkout.selectionError.value, /安全随机/); r.stop();
});
test('late guest randomness cannot install a draft after hide or a new Admin session', async () => {
  const r = await buyers(); let resolve; r.uni.getRandomValues = opts => { resolve = opts.success; };
  await login(r); const pending = r.checkout.select(0); r.hooks.onHide(); resolve({ randomValues: new Uint8Array(16).buffer }); await pending;
  assert.equal(r.checkout.draft.scope, null); assert.equal(r.navigations.length, 0); r.stop();
});
test('navigation failure retains only IDs and offers same-cart retry', async () => {
  const r = await buyers(defaultSend, { navigationFails: true }); await login(r); await r.checkout.select(11);
  assert.match(r.checkout.selectionError.value, /打开失败/); assert.equal(r.checkout.selecting.value, false);
  r.checkout.openCart(); assert.equal(r.navigations.length, 2); assert.equal(r.checkout.draft.scope.uid, 11); r.stop();
});
test('buyer pagination retries the same page and preserves submitted query', async () => {
  let fail = true;
  const r = await buyers(c => !c.url.endsWith('/user/list') ? defaultSend(c) : c.data.page === 1
    ? envelopeList(c, Array.from({ length: 20 }, (_, i) => buyer(i + 1))) : fail ? (fail = false, { transport: 'offline' }) : envelopeList(c, [buyer(21)]));
  await login(r); r.checkout.keyword.value = 'not submitted'; await r.checkout.load(true); assert.equal(r.checkout.nextPage.value, 2);
  await r.checkout.load(true); assert.equal(r.checkout.items.value.length, 21);
  assert.deepEqual(r.calls.filter(c => c.url.endsWith('/user/list')).map(c => [c.data.page, c.data.nickname]), [[1, ''], [2, ''], [2, '']]); r.stop();
});
test('buyer pagination rejects overlapping offsets', async () => {
  const r = await buyers(c => c.url.endsWith('/user/list') ? envelopeList(c, c.data.page === 1 ? Array.from({ length: 20 }, (_, i) => buyer(i + 1)) : [buyer(1)]) : defaultSend(c));
  await login(r); await r.checkout.load(true); assert.match(r.checkout.error.value, /已变化/); assert.equal(r.checkout.items.value.length, 20); r.stop();
});
test('hide clears buyer PII and search text; late result cannot refill it', async () => {
  const waiting = deferred(); const r = await buyers(c => c.url.endsWith('/user/list') ? waiting.promise : defaultSend(c));
  const pending = login(r); await tick(); r.checkout.keyword.value = '13000000000'; r.hooks.onHide(); waiting.resolve(envelopeList({ data: { page: 1, limit: 20 } }, [buyer()])); await pending;
  assert.deepEqual(r.checkout.items.value, []); assert.equal(r.checkout.keyword.value, ''); r.stop();
});
test('late old login cannot unlock a newer login', async () => {
  const first = deferred(), second = deferred(); let calls = 0;
  const r = await buyers(c => c.url.endsWith('/login') ? (++calls === 1 ? first.promise : second.promise) : defaultSend(c));
  const a = login(r); await tick(); r.checkout.logout(); const b = login(r); await tick();
  first.resolve({ data: loginData() }); await a; assert.equal(r.checkout.loginBusy.value, true);
  second.resolve({ data: loginData(2) }); await b; assert.equal(r.checkout.session.id, 2); r.stop();
});
test('buyer selection cannot abandon an unresolved previous cart write', async () => {
  const r = await buyers(); await login(r); r.checkout.draft.choose(11); r.checkout.draft.needsReview = true;
  await r.checkout.select(11); assert.equal(r.navigations.length, 0); assert.throws(() => r.checkout.draft.choose(12), /核对/);
  r.checkout.openCart(); assert.equal(r.navigations[0], '/pages/behalf/goods_list/index?uid=11'); r.stop();
});
for (const bad of [{ uid: 0 }, { status: 2 }, { now_money: 'NaN' }, { integral: -1 }]) {
  test('malformed buyer contract rejects ' + Object.keys(bad)[0], async () => {
    const r = await buyers(c => c.url.endsWith('/user/list') ? envelopeList(c, [buyer(11, bad)]) : defaultSend(c));
    await login(r); assert.equal(r.checkout.items.value.length, 0); assert.ok(r.checkout.error.value); r.stop();
  });
}
test('buyer images reject unsafe schemes and credentials without dropping the valid row', async () => {
  const r = await buyers(c => c.url.endsWith('/user/list') ? envelopeList(c, [buyer(11, { avatar: 'https://user:password@example.com/x.png' })]) : defaultSend(c));
  await login(r); assert.equal(r.checkout.items.value[0].avatar, ''); r.stop();
});

test('real shopping SFC sends exact actor-free scope, uses actual SKU, and rereads cart after acknowledged add', async () => {
  let quantity = 1;
  const r = await shopping(c => {
    assert.equal(c.header['Authori-zation'], undefined); assert.equal(c.header.Authorization, 'Bearer local-admin-1');
    assert.equal(c.data.staff_id, undefined); assert.equal(c.data.adminId, undefined);
    if (c.url.includes('/cart/add/')) { assert.deepEqual(c.data, { tourist_uid: '', new: 0, productId: 7, uniqueId: 'sku1', cartNum: 2 }); quantity += 2; return { data: { cartId: 21 } }; }
    if (c.url === '/api/admin/order/cart/11') { assert.deepEqual(c.data, { tourist_uid: '', new: 0 }); return { data: [cartRow(21, { cart_num: quantity })] }; }
    return defaultSend(c);
  }, { component: true });
  await choose(r); r.checkout.quantity.value = 2; await r.checkout.add();
  assert.equal(r.checkout.cart.value[0].quantity, 3); assert.equal(r.checkout.draft.needsReview, false); assert.equal(writes(r).length, 1);
  assert.equal(r.auth.token, 'synthetic-local-token'); r.stop();
});
for (const options of [{ select: false }, { query: { uid: '999', staff_id: '1' } }, { query: { uid: '-1' } }, { query: {} }]) {
  test('untrusted or missing buyer context never reads or writes shopping data ' + JSON.stringify(options), async () => {
    const r = await shopping(defaultSend, options); assert.equal(r.checkout.canUse.value, false); await choose(r); await r.checkout.add(); assert.equal(r.calls.length, 0); r.stop();
  });
}
test('guest cart reads and writes preserve its random label and uid zero', async () => {
  const r = await shopping(c => {
    if (c.url.includes('/order/cart/')) { assert.equal(c.data.tourist_uid, 'guest-local-1'); assert.ok(c.url.endsWith('/0')); }
    return c.url === '/api/admin/order/cart/0' ? { data: [cartRow(21, { uid: 0 })] } : defaultSend(c);
  }, { uid: 0 });
  await choose(r); await r.checkout.add(); assert.equal(writes(r).length, 1); r.stop();
});
test('catalog reference prices never override server member cart price', async () => {
  const r = await shopping(); assert.equal(r.checkout.products.value[0].price, '10.00'); assert.equal(r.checkout.cart.value[0].price, '9.00'); r.stop();
});
test('presale and sold-out products cannot open normal-cart SKU selection', async () => {
  const r = await shopping(c => c.url.endsWith('/product/list') ? envelopeList(c, [product(7, { is_presale_product: 1 }), product(8, { stock: 0 })]) : defaultSend(c));
  const before = r.calls.length; await r.checkout.selectProduct(7); await r.checkout.selectProduct(8); await r.checkout.selectProduct(999);
  assert.equal(r.calls.length, before); assert.equal(r.checkout.selected.value, null); r.stop();
});
test('SKU selection is explicit; malformed quantities never cause writes', async () => {
  const r = await shopping(); await r.checkout.selectProduct(7); await r.checkout.add(); assert.equal(writes(r).length, 0);
  r.checkout.selectSku('foreign'); assert.equal(r.checkout.chosenSku.value, undefined); r.checkout.selectSku('sku1');
  for (const amount of [0, -1, 1.5, 10, NaN, '2']) { r.checkout.quantity.value = amount; await r.checkout.add(); }
  assert.equal(writes(r).length, 0); assert.match(r.checkout.skuError.value, /数量/); r.stop();
});
test('a late SKU response cannot replace a newer selected product', async () => {
  const waiting = deferred();
  const r = await shopping(c => c.url.endsWith('/product/list') ? envelopeList(c, [product(), product(8)]) : c.url.endsWith('/get_attr/7') ? waiting.promise : defaultSend(c));
  const pending = r.checkout.selectProduct(7); await r.checkout.selectProduct(8); waiting.resolve({ data: [sku()] }); await pending;
  assert.equal(r.checkout.selected.value.id, 8); assert.equal(r.checkout.skus.value[0].productId, 8); r.stop();
});
test('product paging retries original page and rejects duplicate offsets', async () => {
  let fail = true;
  const r = await shopping(c => !c.url.endsWith('/product/list') ? defaultSend(c) : c.data.page === 1
    ? envelopeList(c, Array.from({ length: 20 }, (_, i) => product(i + 1))) : fail ? (fail = false, { transport: 'offline' }) : envelopeList(c, [product(1)]));
  r.checkout.keyword.value = 'unsent'; await r.checkout.load(true); assert.equal(r.checkout.nextPage.value, 2);
  await r.checkout.load(true); assert.match(r.checkout.error.value, /已变化/);
  assert.deepEqual(r.calls.filter(c => c.url.endsWith('/product/list')).map(c => [c.data.page, c.data.store_name]), [[1, ''], [2, ''], [2, '']]); r.stop();
});
test('an additive request is single-flight; pending state survives hiding the page', async () => {
  const waiting = deferred(); const r = await shopping(c => c.url.includes('/cart/add/') ? waiting.promise : defaultSend(c));
  await choose(r); const pending = r.checkout.add(); await r.checkout.add(); assert.equal(r.checkout.draft.pending, true); assert.equal(writes(r).length, 1);
  r.hooks.onHide(); assert.equal(r.checkout.draft.pending, true); assert.deepEqual(r.checkout.cart.value, []);
  waiting.resolve({ data: { cartId: 21 } }); await pending; assert.equal(r.checkout.draft.pending, false); assert.equal(r.checkout.draft.needsReview, true);
  r.hooks.onShow(); await tick(); assert.equal(r.checkout.reviewRead.value, true); assert.equal(r.checkout.blocked.value, true);
  r.checkout.acknowledgeReview(); assert.equal(r.checkout.draft.needsReview, false); r.stop();
});
for (const result of [{ transport: 'timeout' }, { status: 500, httpStatus: 500, msg: 'unknown' }, { data: { cartId: 0 } }, { status: 400, msg: '库存不足' }]) {
  test('unconfirmed add is never auto-retried and requires read plus explicit acknowledgement ' + JSON.stringify(result), async () => {
    const r = await shopping(c => c.url.includes('/cart/add/') ? result : defaultSend(c)); await choose(r); await r.checkout.add();
    assert.equal(r.checkout.draft.needsReview, true); r.checkout.acknowledgeReview(); assert.equal(r.checkout.draft.needsReview, true);
    await r.checkout.add(); assert.equal(writes(r).length, 1); await r.checkout.refreshCart(); assert.equal(r.checkout.draft.needsReview, true);
    r.checkout.acknowledgeReview(); assert.equal(r.checkout.draft.needsReview, false); assert.equal(r.checkout.chosenSku.value, undefined); r.stop();
  });
}
test('successful write with failed follow-up read remains locked, not optimistically applied', async () => {
  let reads = 0;
  const r = await shopping(c => c.url === '/api/admin/order/cart/11' && ++reads > 1 ? { transport: 'offline' } : defaultSend(c));
  await choose(r); await r.checkout.add(); assert.equal(r.checkout.draft.needsReview, true); assert.equal(r.checkout.cartLoaded.value, false);
  assert.deepEqual(r.checkout.cart.value, []); assert.ok(r.checkout.cartError.value); r.stop();
});
test('quantity changes use only displayed rows and fresh server absolute quantities', async () => {
  const r = await shopping(); await r.checkout.changeQuantity(999, 1); await r.checkout.changeQuantity(21, -1); await r.checkout.changeQuantity(21, 2);
  assert.equal(writes(r).length, 0); await r.checkout.changeQuantity(21, 1);
  assert.deepEqual(writes(r)[0], { url: '/api/admin/order/cart/num/11', data: { tourist_uid: '', new: 0, id: 21, number: 2 } }); r.stop();
});
test('deletion requires native confirmation and is limited to displayed rows', async () => {
  const r = await shopping(); let modal; r.uni.showModal = options => { modal = options; };
  r.checkout.remove(999); assert.equal(modal, undefined); r.checkout.remove(21); assert.equal(r.checkout.confirming.value, true);
  modal.success({ confirm: false }); assert.equal(writes(r).length, 0); r.checkout.remove(21); modal.success({ confirm: true }); await tick();
  assert.deepEqual(writes(r)[0], { url: '/api/admin/order/cart/del/11', data: { tourist_uid: '', new: 0, ids: [21] } }); r.stop();
});
test('late delete confirmation after hide cannot mutate a new view', async () => {
  const r = await shopping(); let modal; r.uni.showModal = options => { modal = options; };
  r.checkout.remove(21); r.hooks.onHide(); r.hooks.onShow(); await tick(); modal.success({ confirm: true }); await tick(); assert.equal(writes(r).length, 0); r.stop();
});
for (const mode of ['missing', 'failure']) {
  test('unavailable native confirmation fails closed and releases its local lock ' + mode, async () => {
    const r = await shopping(); if (mode === 'failure') r.uni.showModal = options => options.fail();
    r.checkout.remove(21); assert.equal(writes(r).length, 0); assert.equal(r.checkout.confirming.value, false);
    assert.match(r.checkout.note.value, /确认窗口打开失败/); r.stop();
  });
}
test('invalid cart rows can be removed but never incremented', async () => {
  const r = await shopping(c => c.url === '/api/admin/order/cart/11' ? { data: [cartRow(21, { is_valid: 0 })] } : defaultSend(c));
  r.uni.showModal = options => options.success({ confirm: true }); await r.checkout.changeQuantity(21, 1); assert.equal(writes(r).length, 0);
  r.checkout.remove(21); await tick(); assert.equal(writes(r).length, 1); r.stop();
});
test('old mutation completion cannot clear a new Admin draft recovery state', async () => {
  const waiting = deferred(); const r = await shopping(c => c.url.includes('/cart/add/') ? waiting.promise : defaultSend(c));
  await choose(r); const pending = r.checkout.add();
  r.checkout.session.install({ id: 2, label: '新管理员', token: 'local-admin-2', expiresAt: Date.now() + 3600000, permissions });
  r.checkout.draft.choose(12); r.checkout.draft.pending = true; r.checkout.draft.needsReview = true;
  waiting.resolve({ status: 410001, msg: 'old expired' }); await pending;
  assert.equal(r.checkout.session.id, 2); assert.equal(r.checkout.draft.pending, true); assert.equal(r.checkout.draft.scope.uid, 12);
  assert.equal(r.auth.uid, 11); assert.equal(r.checkout.canUse.value, false); assert.deepEqual(r.checkout.cart.value, []); r.stop();
});
test('current Admin expiry clears only privileged state and prohibits remaining writes', async () => {
  const r = await shopping(); await choose(r); r.checkout.session.expiresAt = 1; await r.checkout.add();
  assert.equal(r.checkout.session.authenticated, false); assert.equal(r.checkout.draft.scope, null); assert.equal(writes(r).length, 0);
  assert.equal(r.auth.uid, 11); assert.equal(r.navigations.length, 0); r.stop();
});
for (const field of [{ staff_id: 2 }, { uid: 12 }, { is_new: 1 }, { type: 8 }, { activity_id: 8 }, { is_pay: 1 }, { truePrice: 1.005 }]) {
  test('cart parser rejects foreign or malformed scope ' + Object.keys(field)[0], async () => {
    const r = await shopping(c => c.url === '/api/admin/order/cart/11' ? { data: [cartRow(21, field)] } : defaultSend(c));
    assert.equal(r.checkout.cartLoaded.value, false); assert.ok(r.checkout.cartError.value); await choose(r); await r.checkout.add(); assert.equal(writes(r).length, 0); r.stop();
  });
}
test('SKU parser rejects wrong product ownership before enabling add', async () => {
  const r = await shopping(c => c.url.includes('/get_attr/') ? { data: [sku(1, 999)] } : defaultSend(c)); await choose(r);
  assert.ok(r.checkout.skuError.value); assert.deepEqual(r.checkout.skus.value, []); await r.checkout.add(); assert.equal(writes(r).length, 0); r.stop();
});
test('product parser rejects duplicate rows and bad envelope paging', async () => {
  for (const response of [{ list: [product(), product()], page: 1, limit: 20 }, { list: [product()], page: 2, limit: 20 }]) {
    const r = await shopping(c => c.url.endsWith('/product/list') ? { data: response } : defaultSend(c));
    assert.ok(r.checkout.error.value); assert.deepEqual(r.checkout.products.value, []); r.stop();
  }
});
test('direct API calls cannot submit a mismatched current Admin scope', async () => {
  const r = await shopping(); const api = r.load(path.join(root, 'src/api/assistedSelection.ts')), before = r.calls.length;
  await assert.rejects(api.apiAssistedCart({ adminId: 2, uid: 11, touristUid: '' }), /身份已变化/); assert.equal(r.calls.length, before); r.stop();
});
