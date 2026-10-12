const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vue = require('vue');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
const product = (id = 70, extra = {}) => ({ id: 1000 + id, product_id: id, store_name: `浏览商品${id}`,
  image: '/api/qa/product.svg', product_price: '10.00', stock: 2, is_show: 1, time_key: '09月21日', ...extra });
const page = (number = 1, list = [product()], count = list.length) => ({ page: number, limit: 20, list, count, time: ['09月21日'] });
const fullPage = () => Array.from({ length: 20 }, (_, i) => product(70 + i));
const recommended = (id = 170, extra = {}) => ({ id, store_name: `推荐商品${id}`, image: '', price: '12.30', stock: 2,
  is_presale_product: 0, activity: '', brand_name: '', store_label: [], vip_price: '0', price_type: '', is_vip: 0, ...extra });
async function start(send) { const r = runtime({ feature: 'useVisitHistory', send }); await r.start(); r.uni.showModal = o => o.success({ confirm: true }); return r; }

test('history uses real adapter/request/store, groups server dates and only navigates displayed visible products', async () => {
  const r = await start(call => { assert.equal(call.method, 'GET'); assert.equal(call.url, '/api/user/visit_list');
    assert.deepEqual(call.data, { page: 1, limit: 20 }); return { data: page(1, [product(), product(71, { time_key: '2025年12月31日', is_show: 0 })]) }; });
  assert.equal(r.checkout.groups.value.length, 2); assert.equal(r.checkout.items.value[0].logId, 1070);
  r.checkout.openProduct(1070); r.checkout.openProduct(71); assert.deepEqual(r.navigations, []);
  r.checkout.openProduct(70); assert.deepEqual(r.navigations, ['/pages/goods/detail?id=70']); r.stop();
});
test('paging retries exactly the same page after failure and ignores reported count for an empty terminal page', async () => {
  let fail = true;
  const r = await start(call => call.data.page === 1 ? { data: page(1, fullPage(), 21) }
    : fail ? (fail = false, { transport: 'offline' }) : { data: page(2, [], 21) });
  await r.checkout.load(true); assert.equal(r.checkout.items.value.length, 20); assert.match(r.checkout.error.value, /offline/);
  await r.checkout.load(true); assert.deepEqual(r.calls.map(c => c.data.page), [1, 2, 2]); assert.equal(r.checkout.hasMore.value, false); r.stop();
});
test('changed totals or overlapping offset pages cannot become a mixed history', async () => {
  for (const second of [page(2, [product(90)], 22), page(2, [product(70)], 21)]) {
    const r = await start(call => ({ data: call.data.page === 1 ? page(1, fullPage(), 21) : second }));
    await r.checkout.load(true); assert.match(r.checkout.error.value, /已变化/); assert.equal(r.checkout.items.value.length, 20);
    r.checkout.toggleManage(); assert.equal(r.checkout.managing.value, false); r.stop();
  }
});
test('batch deletion submits PRODUCT IDs only after explicit confirmation and restarts offset paging', async () => {
  let deleted = false, deletes = 0;
  const r = await start(call => {
    if (call.method === 'DELETE') { deletes++; assert.equal(call.url, '/api/user/visit'); assert.deepEqual(call.data.ids, [70, 71]); deleted = true; return { data: { deleted: 8 } }; }
    return { data: deleted ? page() : page(1, [product(), product(71)]) };
  });
  r.checkout.toggleManage(); r.checkout.toggleAll(); await r.checkout.removeSelected();
  assert.equal(deletes, 1); assert.deepEqual(r.calls.at(-1).data, { page: 1, limit: 20 });
  assert.deepEqual(r.checkout.selected.value, []); assert.equal(r.checkout.managing.value, false); r.stop();
});
test('cancelled confirmation and unknown IDs never delete', async () => {
  const r = await start(() => ({ data: page() })); r.checkout.toggleManage(); r.checkout.toggle(1070);
  await r.checkout.removeSelected(); assert.equal(r.calls.length, 1);
  r.checkout.toggle(70); r.uni.showModal = o => o.success({ confirm: false }); await r.checkout.removeSelected(); assert.equal(r.calls.length, 1); r.stop();
});

test('unavailable confirmation UI fails closed without leaving management blocked', async () => {
  const r = await start(() => ({ data: page() })); r.checkout.toggleManage(); r.checkout.toggle(70);
  for (const fail of [o => o.fail(), () => { throw Error('modal unavailable'); }]) {
    r.uni.showModal = fail; await r.checkout.removeSelected();
    assert.equal(r.calls.length, 1); assert.equal(r.checkout.confirming.value, false); assert.equal(r.checkout.blocked.value, false);
  }
  r.stop();
});
test('unknown or malformed deletion results block retry until an explicit refresh; no optimistic row removal', async () => {
  for (const failure of [{ transport: 'timeout' }, { data: { deleted: '1' } }, { status: 400, msg: 'denied' }]) {
    let deletes = 0;
    const r = await start(call => call.method === 'DELETE' ? (deletes++, failure) : { data: page() });
    r.checkout.toggleManage(); r.checkout.toggle(70); await r.checkout.removeSelected();
    assert.match(r.checkout.error.value, /可能已经生效/); assert.equal(r.checkout.items.value.length, 1); assert.equal(r.checkout.uncertain.value, true);
    await r.checkout.removeSelected(); await r.checkout.load(true); assert.equal(deletes, 1);
    await r.checkout.load(); assert.equal(r.checkout.uncertain.value, false); assert.equal(r.checkout.error.value, ''); r.stop();
  }
});
test('duplicate clicks while the modal or deletion is pending produce at most one mutation', async () => {
  const late = deferred(); let modal, deletes = 0;
  const r = await start(call => call.method === 'DELETE' ? (deletes++, late.promise) : { data: page() });
  r.uni.showModal = o => { modal = o; }; r.checkout.toggleManage(); r.checkout.toggle(70);
  const pending = r.checkout.removeSelected(); await r.checkout.removeSelected(); assert.equal(deletes, 0);
  modal.success({ confirm: true }); await tick(); await r.checkout.removeSelected(); await r.checkout.load(); assert.equal(deletes, 1);
  late.resolve({ data: { deleted: 1 } }); await pending; r.stop();
});
for (const action of ['onHide', 'onUnload', 'renew', 'switch']) test(`confirmation is invalidated by ${action} before any mutation`, async () => {
  let modal;
  const r = await start(() => ({ data: page() })); r.uni.showModal = o => { modal = o; };
  r.checkout.toggleManage(); r.checkout.toggle(70); const pending = r.checkout.removeSelected();
  if (action === 'renew') r.auth.setLogin(r.auth.token, r.auth.uid);
  else if (action === 'switch') r.auth.setLogin('other-token', 22); else r.hooks[action]();
  modal.success({ confirm: true }); await pending;
  assert.equal(r.calls.length, 1); assert.deepEqual(r.checkout.items.value, []); r.stop();
});
for (const action of ['onHide', 'onUnload', 'renew', 'refresh']) test(`late page data cannot restore history after ${action}`, async () => {
  const late = deferred(); let hold = false;
  const r = await start(() => hold ? late.promise : { data: page() }); hold = true;
  const old = r.checkout.load(); await tick();
  if (action === 'renew') r.auth.setLogin(r.auth.token, r.auth.uid);
  else if (action === 'refresh') { hold = false; await r.checkout.load(); } else r.hooks[action]();
  late.resolve({ data: page(1, [product(99)]) }); await old;
  assert.deepEqual(r.checkout.items.value.map(p => p.productId), action === 'refresh' ? [70] : []); r.stop();
});
test('late delete completion after logout does not reload or mutate the next owner UI', async () => {
  const late = deferred(); const r = await start(call => call.method === 'DELETE' ? late.promise : { data: page() });
  r.checkout.toggleManage(); r.checkout.toggle(70); const pending = r.checkout.removeSelected(); await tick();
  r.auth.setLogin('next-user', 22); late.resolve({ data: { deleted: 1 } }); await pending;
  assert.equal(r.calls.length, 2); assert.deepEqual(r.checkout.items.value, []); assert.deepEqual(r.toasts, []); r.stop();
});
test('unauthenticated page performs no history request and provides login navigation', async () => {
  const r = runtime({ feature: 'useVisitHistory', send: () => { throw Error('no IO'); } }); r.auth.clear(); await r.start();
  assert.equal(r.calls.length, 0); r.checkout.login(); assert.deepEqual(r.navigations, ['/pages/auth/login']); r.stop();
});
test('response validation rejects invalid identity/page/price/date/duplicates before rendering', async () => {
  let data = page(); const r = await start(() => ({ data }));
  for (const invalid of [page(2), { ...page(), limit: 100 }, { ...page(), count: -1 }, page(1, [product(), product()]),
    page(1, [product(0)]), page(1, [product(70, { id: 0 })]), page(1, [product(70, { product_price: '-1' })]),
    page(1, [product(70, { time_key: '<script>' })]), page(1, [product(70, { is_show: true })]),
    page(1, [product(70, { stock: -1 })]), page(1, [product(70, { store_name: {} })])]) {
    data = invalid; await r.checkout.load(); assert.ok(r.checkout.error.value); assert.deepEqual(r.checkout.items.value, []);
  }
  r.stop();
});
test('adapters reject invalid inputs before IO and remove unsafe image URLs without HTML interpretation', async () => {
  const r = await start(() => ({ data: page(1, [product(70, { image: 'javascript:alert(1)', store_name: '<script>literal</script>' })]) }));
  assert.equal(r.checkout.items.value[0].image, ''); assert.equal(r.checkout.items.value[0].name, '<script>literal</script>');
  const api = r.load(path.resolve(__dirname, '../src/api/visitHistory.ts')), n = r.calls.length;
  for (const ids of [[], [0], [70, 70], [1.5], Array.from({ length: 201 }, (_, i) => i + 1)]) await assert.rejects(api.apiDeleteVisitHistory(ids));
  for (const value of [0, -1, 1.5, '1']) await assert.rejects(api.apiVisitHistory(value));
  r.auth.clear(); await assert.rejects(api.apiVisitHistory(1), /请先登录/); await assert.rejects(api.apiDeleteVisitHistory([70]), /请先登录/);
  assert.equal(r.calls.length, n); r.stop();
});

test('adding selected products to favourites keeps history and never calls delete', async () => {
  const r = await start(call => {
    if (call.method === 'POST') { assert.equal(call.url, '/api/collect/add'); assert.deepEqual(call.data, { id: [70, 71], category: 'product' }); return { data: { count: 1 } }; }
    assert.equal(call.method, 'GET'); return { data: page(1, [product(), product(71)]) };
  });
  r.checkout.toggleManage(); r.checkout.toggleAll(); await r.checkout.collectSelected();
  assert.equal(r.checkout.items.value.length, 2); assert.deepEqual(r.checkout.selected.value, []); assert.equal(r.calls.length, 2); r.stop();
});

test('favourites enforce the Worker 100-ID boundary before IO and allow correcting the selection', async () => {
  const rows = Array.from({ length: 101 }, (_, i) => product(i + 1));
  const r = await start(call => call.method === 'POST' ? { data: { count: call.data.id.length } }
    : { data: page(call.data.page, rows.slice((call.data.page - 1) * 20, call.data.page * 20), 101) });
  for (let p = 2; p <= 6; p++) await r.checkout.load(true);
  r.checkout.toggleManage(); r.checkout.toggleAll();
  await r.checkout.collectSelected();
  assert.equal(r.calls.length, 6); assert.equal(r.checkout.selected.value.length, 101);
  assert.equal(r.checkout.uncertain.value, false); assert.equal(r.checkout.error.value, '');
  assert.match(r.toasts.at(-1).title, /最多收藏 100/);
  const api = r.load(path.resolve(__dirname, '../src/api/visitHistory.ts'));
  await assert.rejects(api.apiCollectVisitProducts(rows.map(p => p.product_id)), /1 至 100/);
  assert.equal(r.calls.length, 6);
  r.checkout.toggle(101); await r.checkout.collectSelected();
  assert.equal(r.calls.length, 7); assert.equal(r.calls.at(-1).data.id.length, 100);
  assert.equal(r.checkout.items.value.length, 101); r.stop();
});
test('uncertain favourite results do not auto-retry or delete history', async () => {
  const r = await start(call => call.method === 'POST' ? { transport: 'offline' } : { data: page() });
  r.checkout.toggleManage(); r.checkout.toggle(70); await r.checkout.collectSelected();
  assert.match(r.checkout.error.value, /我的收藏核对/); assert.equal(r.checkout.items.value.length, 1);
  await r.checkout.collectSelected(); await r.checkout.removeSelected(); assert.equal(r.calls.length, 2); r.stop();
});
test('late favourite writes cannot display success across identities or overlap other writes', async () => {
  const late = deferred(); const r = await start(call => call.method === 'POST' ? late.promise : { data: page() });
  r.checkout.toggleManage(); r.checkout.toggle(70); const pending = r.checkout.collectSelected(); await tick();
  await r.checkout.collectSelected(); await r.checkout.removeSelected(); await r.checkout.load(); assert.equal(r.calls.length, 2);
  r.auth.setLogin('other-token', 22); late.resolve({ data: { count: 1 } }); await pending;
  assert.deepEqual(r.checkout.items.value, []); assert.deepEqual(r.toasts, []); r.stop();
});

test('only a successful empty history loads real hot recommendations; scrolling paginates without private history writes', async () => {
  const rows = Array.from({ length: 11 }, (_, i) => recommended(170 + i));
  const r = await start(call => {
    assert.equal(call.method, 'GET');
    if (call.url === '/api/user/visit_list') return { data: page(1, [], 0) };
    assert.equal(call.url, '/api/product/hot'); assert.equal(call.data.limit, 10);
    return { data: rows.slice((call.data.page - 1) * 10, call.data.page * 10) };
  });
  assert.equal(r.checkout.recommendations.value.length, 10);
  r.hooks.onReachBottom(); await tick(); assert.equal(r.checkout.recommendations.value.length, 11);
  r.hooks.onReachBottom(); await tick(); assert.equal(r.calls.length, 3);
  r.checkout.openRecommendation(999); r.checkout.openRecommendation(170);
  assert.deepEqual(r.navigations, ['/pages/goods/detail?id=170']); r.stop();
});

test('history errors and nonempty history never masquerade as recommendation empty states', async () => {
  for (const result of [{ transport: 'offline' }, { data: page() }]) {
    const r = await start(() => result); await r.checkout.loadRecommendations(); r.hooks.onReachBottom(); await tick();
    assert.equal(r.calls.length, 1); assert.deepEqual(r.checkout.recommendations.value, []); r.stop();
  }
});

test('recommendation failures require explicit same-page retry and keep the confirmed history empty state', async () => {
  let fail = true;
  const r = await start(call => call.url === '/api/user/visit_list' ? { data: page(1, []) }
    : fail ? { transport: 'recommendation offline' } : { data: [recommended()] });
  assert.equal(r.checkout.error.value, ''); assert.equal(r.checkout.loaded.value, true);
  assert.match(r.checkout.recommendationError.value, /offline/);
  r.hooks.onReachBottom(); await tick(); assert.equal(r.calls.length, 2);
  fail = false; await r.checkout.loadRecommendations(); assert.equal(r.calls.at(-1).data.page, 1);
  assert.equal(r.checkout.recommendations.value.length, 1); assert.equal(r.checkout.recommendationHasMore.value, false); r.stop();
});

test('recommendation append failures and duplicates do not advance or duplicate the feed', async () => {
  let duplicate = true;
  const r = await start(call => call.url === '/api/user/visit_list' ? { data: page(1, []) }
    : { data: call.data.page === 1 ? Array.from({ length: 10 }, (_, i) => recommended(170 + i)) : [recommended(duplicate ? 170 : 180)] });
  await r.checkout.loadRecommendations(); assert.match(r.checkout.recommendationError.value, /已变化/);
  assert.equal(r.checkout.recommendations.value.length, 10); r.checkout.openRecommendation(170); assert.deepEqual(r.navigations, []);
  duplicate = false; await r.checkout.loadRecommendations(); assert.equal(r.calls.at(-1).data.page, 2);
  assert.equal(r.checkout.recommendations.value.length, 11); r.stop();
});

for (const action of ['onHide', 'onUnload', 'renew', 'switch', 'refresh']) test(`late recommendation results cannot restore the feed after ${action}`, async () => {
  const late = deferred(); let empty = true;
  const r = await start(call => call.url === '/api/user/visit_list' ? { data: empty ? page(1, []) : page() } : late.promise);
  assert.equal(r.checkout.recommendationLoading.value, true);
  await r.checkout.loadRecommendations(); assert.equal(r.calls.length, 2);
  if (action === 'renew') r.auth.setLogin(r.auth.token, r.auth.uid);
  else if (action === 'switch') r.auth.setLogin('next-owner', 22);
  else if (action === 'refresh') { empty = false; await r.checkout.load(); }
  else r.hooks[action]();
  late.resolve({ data: [recommended()] }); await tick();
  assert.deepEqual(r.checkout.recommendations.value, []); r.checkout.openRecommendation(170); assert.deepEqual(r.navigations, []); r.stop();
});

test('deleting the final history record loads recommendations but never deletes or selects the recommended products', async () => {
  let deleted = false, deletes = 0;
  const r = await start(call => {
    if (call.method === 'DELETE') { deleted = true; deletes++; return { data: { deleted: 1 } }; }
    return { data: call.url === '/api/product/hot' ? [recommended()] : deleted ? page(1, []) : page() };
  });
  r.checkout.toggleManage(); r.checkout.toggle(70); await r.checkout.removeSelected();
  assert.equal(r.checkout.recommendations.value.length, 1); r.checkout.toggleManage(); r.checkout.toggleAll();
  await r.checkout.removeSelected(); assert.deepEqual(r.checkout.selected.value, []);
  assert.equal(deletes, 1); r.stop();
});

test('recommendation adapter rejects malformed arrays/prices/ids/stock and unowned reads before rendering', async () => {
  let rows = [recommended()];
  const r = await start(call => ({ data: call.url === '/api/product/hot' ? rows : page(1, []) }));
  for (const invalid of [{ list: [] }, Array.from({ length: 11 }, () => recommended()), [recommended(), recommended()],
    [recommended(0)], [recommended(170, { price: 10 })], [recommended(170, { stock: -1 })], [recommended(170, { store_name: {} })]]) {
    rows = invalid; await r.checkout.load(); assert.ok(r.checkout.recommendationError.value); assert.deepEqual(r.checkout.recommendations.value, []);
  }
  rows = [recommended(170, { image: 'javascript:alert(1)', store_name: '<literal>' })]; await r.checkout.load();
  assert.equal(r.checkout.recommendations.value[0].image, ''); assert.equal(r.checkout.recommendations.value[0].name, '<literal>');
  const api = r.load(path.resolve(__dirname, '../src/api/visitHistory.ts')), before = r.calls.length;
  await assert.rejects(api.apiVisitRecommendations(0)); r.auth.clear(); await assert.rejects(api.apiVisitRecommendations(1), /请先登录/);
  assert.equal(r.calls.length, before); r.stop();
});

test('recommendation branding and labels are optional, bounded text with safe images and hex-only styles', async () => {
  const r = await start(call => ({ data: call.url === '/api/product/hot' ? [recommended(170, {
    brand_name: '<b>品牌原文</b>', store_label: [null, { id: 0, label_name: 'invalid' },
      { id: 1, label_name: '<em>标签原文</em>', icon: 'javascript:alert(1)', color: 'red;background:url(https://bad.invalid)', bg_color: '#fff', border_color: '#ABCDEF' },
      { id: 1, label_name: 'duplicate' }, { id: 2, label_name: '精选', icon: '/api/qa/label.svg', color: '#123' }],
  })] : page(1, []) }));
  const row = r.checkout.recommendations.value[0]; assert.equal(row.brand, '<b>品牌原文</b>');
  assert.deepEqual(row.labels, [
    { id: 1, name: '<em>标签原文</em>', icon: '', color: '#855224', background: '#fff', border: '#ABCDEF' },
    { id: 2, name: '精选', icon: '/api/qa/label.svg', color: '#123', background: '#fff7ec', border: '#eed7b8' },
  ]); r.stop();
});

test('invalid optional decoration cannot break the feed; excessive labels and text stay bounded', async () => {
  let extra = { brand_name: {}, store_label: { label_name: 'bad' }, vip_price: {} };
  const r = await start(call => ({ data: call.url === '/api/product/hot' ? [recommended(170, extra)] : page(1, []) }));
  assert.equal(r.checkout.recommendationError.value, ''); assert.equal(r.checkout.recommendations.value[0].brand, '');
  assert.deepEqual(r.checkout.recommendations.value[0].labels, []); assert.equal(r.checkout.recommendations.value[0].offer, null);
  extra = { brand_name: 'x'.repeat(129), store_label: Array.from({ length: 99 }, (_, i) => ({ id: i + 1, label_name: '标签', icon: 'https://user:password@example.invalid/a.png' })) };
  await r.checkout.load(); const row = r.checkout.recommendations.value[0];
  assert.equal(row.brand, ''); assert.equal(row.labels.length, 8); assert.ok(row.labels.every(label => label.icon === '')); r.stop();
});

test('advertised SVIP and level prices use the server price_type and never replace base price or claim eligibility', async () => {
  let extra = {};
  const r = await start(call => ({ data: call.url === '/api/product/hot' ? [recommended(170, extra)] : page(1, []) }));
  for (const [fields, offer] of [
    [{ is_vip: 1, price_type: 'member', vip_price: '9.90' }, { label: 'SVIP参考价', price: '9.90' }],
    [{ is_vip: 1, price_type: 'level', vip_price: '8.80' }, { label: '等级参考价', price: '8.80' }],
    [{ is_vip: 0, price_type: 'level', vip_price: '7.70' }, { label: '等级参考价', price: '7.70' }],
    [{ is_vip: 0, price_type: 'member', vip_price: '9.90' }, null],
    [{ is_vip: 1, price_type: 'unknown', vip_price: '9.90' }, null],
    ...['0', '0.00', '-9.90', '12.30', '13.00', '1e1', 9.90, '9.999'].map(vip_price => [{ is_vip: 1, price_type: 'member', vip_price }, null]),
  ]) {
    extra = fields; await r.checkout.load(); const row = r.checkout.recommendations.value[0];
    assert.deepEqual(row.offer, offer); assert.equal(row.price, '12.30'); assert.equal(r.checkout.recommendationError.value, '');
  }
  assert.ok(r.calls.every(c => ['/api/product/hot', '/api/user/visit_list'].includes(c.url))); r.stop();
});

test('only explicit ordinary-first priority opens a product; raw activity priority never becomes an activity ID', async () => {
  let activity = '';
  const r = await start(call => ({ data: call.url === '/api/product/hot' ? [recommended(170, { activity })] : page(1, []) }));
  for (const value of ['', '0', '0,1,2,3', '0,3,2,1']) {
    activity = value; await r.checkout.load(); r.checkout.openRecommendation(170);
    assert.equal(r.navigations.at(-1), '/pages/goods/detail?id=170');
  }
  for (const value of ['1,2,3,0', '2,1,3,0', '3,0,2,1', '1', '2', '3']) {
    activity = value; await r.checkout.load(); r.checkout.openRecommendation(170);
    assert.equal(r.navigations.at(-1), '/pages/activity/index');
    assert.match(r.checkout.recommendations.value[0].navigationHint, /待确认/);
  }
  assert.equal(r.navigations.length, 10); r.stop();
});

test('presale, missing flags and unverified resolved activity objects fail closed without an ordinary purchase link', async () => {
  let extra = {};
  const r = await start(call => ({ data: call.url === '/api/product/hot' ? [recommended(170, extra)] : page(1, []) }));
  for (const fields of [{ is_presale_product: 1 }, { is_presale_product: '0' }, { is_presale_product: undefined },
    { activity: null }, { activity: undefined }, { activity: [] }, { activity: { type: 1, id: 900, time: 1234567890 } },
    { activity: '4' }, { activity: '0,0' }, { activity: '0,https://bad.invalid' }, { activity: '0'.repeat(256) }]) {
    extra = fields; await r.checkout.load(); r.checkout.openRecommendation(170);
    assert.equal(r.checkout.recommendationError.value, ''); assert.equal(r.checkout.recommendations.value[0].destination, null);
    assert.ok(r.toasts.at(-1).title); assert.deepEqual(r.navigations, []);
  }
  r.stop();
});

test('failed recommendation navigation is visible only to the same page owner', async () => {
  const r = await start(call => ({ data: call.url === '/api/product/hot' ? [recommended()] : page(1, []) }));
  r.uni.navigateTo = () => { throw Error('navigation unavailable'); }; r.checkout.openRecommendation(170);
  assert.match(r.toasts.at(-1).title, /打开失败/);
  let pending; r.uni.navigateTo = options => { pending = options; }; r.checkout.openRecommendation(170);
  const before = r.toasts.length; r.auth.setLogin('other-user', 22); pending.fail();
  assert.equal(r.toasts.length, before); r.stop();
});

test('versioned recommendation targets open exact activity namespaces and never substitute product or parent IDs', async () => {
  let target = { version: 1, product_id: 170, kind: 'seckill', id: 900, ends_at: '2099-01-01T00:00:00.000Z' };
  const r = await start(call => ({ data: call.url === '/api/product/hot' ? [recommended(170, { activity: '1,2,3,0', recommendation_target: target })] : page(1, []) }));
  for (const [kind, id, route] of [['seckill', 900, 'seckillDetail'], ['bargain', 1000, 'bargainDetail'], ['combination', 1100, 'detail']]) {
    target = { ...target, kind, id }; await r.checkout.load(); r.checkout.openRecommendation(170);
    assert.equal(r.navigations.at(-1), `/pages/activity/${route}?id=${id}`);
  }
  target = { ...target, kind: 'product', id: 170, ends_at: null }; await r.checkout.load(); r.checkout.openRecommendation(170);
  assert.equal(r.navigations.at(-1), '/pages/goods/detail?id=170');
  assert.equal(r.navigations.length, 4); r.stop();
});

test('a malformed additive target fails closed even when raw priority would permit an ordinary fallback', async () => {
  const good = { version: 1, product_id: 170, kind: 'seckill', id: 900, ends_at: '2099-01-01T00:00:00.000Z' };
  let target = good;
  const r = await start(call => ({ data: call.url === '/api/product/hot' ? [recommended(170, { recommendation_target: target })] : page(1, []) }));
  for (const invalid of [null, [], '1', {}, { ...good, version: 2 }, { ...good, product_id: 171 }, { ...good, id: '900' },
    { ...good, id: 0 }, { ...good, id: 2147483648 }, { ...good, kind: 'https://bad.invalid' }, { ...good, kind: '__proto__' },
    { ...good, kind: 'product' }, { ...good, kind: 'unavailable', id: null }, { ...good, kind: 'presale' },
    { ...good, ends_at: null }, { ...good, ends_at: '2099-02-31T00:00:00.000Z' }, { ...good, ends_at: 1234567890 },
    { ...good, ends_at: '2099-01-01T00:00:00Z' }]) {
    target = invalid; await r.checkout.load(); r.checkout.openRecommendation(170);
    assert.deepEqual(r.navigations, []); assert.equal(r.checkout.recommendations.value[0].destination, null);
    assert.equal(r.checkout.recommendationError.value, '');
  }
  r.stop();
});

test('expired activity snapshots demand an explicit refresh and never silently open ordinary goods', async () => {
  let deadline = new Date(Date.now() - 1).toISOString();
  const r = await start(call => ({ data: call.url === '/api/product/hot' ? [recommended(170, {
    recommendation_target: { version: 1, product_id: 170, kind: 'seckill', id: 900, ends_at: deadline },
  })] : page(1, []) }));
  const before = r.calls.length; r.checkout.openRecommendation(170);
  assert.deepEqual(r.navigations, []); assert.match(r.toasts.at(-1).title, /已过期/); assert.equal(r.calls.length, before);
  deadline = '2099-01-01T00:00:00.000Z'; await r.checkout.load(); r.checkout.openRecommendation(170);
  assert.deepEqual(r.navigations, ['/pages/activity/seckillDetail?id=900']); r.stop();
});

test('versioned presale recommendations require matching base product, flag and nullable deadline, never cart writes', async () => {
  let extra = { is_presale_product: 1, activity: null, recommendation_target: { version: 1, product_id: 170, kind: 'presale', id: 170, ends_at: null } };
  const good = structuredClone(extra);
  const r = await start(call => ({ data: call.url === '/api/product/hot' ? [recommended(170, extra)] : page(1, []) }));
  try {
    r.checkout.openRecommendation(170); assert.deepEqual(r.navigations, ['/pages/activity/presaleDetail?id=170']);
    for (const patch of [{ id: 900 }, { product_id: 171 }, { ends_at: '2099-01-01T00:00:00.000Z' }, { kind: 'product' }, { version: 2 }]) {
      extra = { ...good, recommendation_target: { ...good.recommendation_target, ...patch } }; await r.checkout.load(); r.checkout.openRecommendation(170);
      assert.equal(r.navigations.length, 1); assert.equal(r.checkout.recommendations.value[0].destination, null);
    }
    extra = { ...good, is_presale_product: 0, activity: '' }; await r.checkout.load(); r.checkout.openRecommendation(170); assert.equal(r.navigations.length, 1);
    assert.ok(r.calls.every(c => ['/api/product/hot', '/api/user/visit_list'].includes(c.url)));
  } finally { r.stop(); }
});

test('nullable unlimited activity ends and presale precedence retain the existing detail contracts', async () => {
  let extra = { recommendation_target: { version: 1, product_id: 170, kind: 'bargain', id: 1000, ends_at: null } };
  const r = await start(call => ({ data: call.url === '/api/product/hot' ? [recommended(170, extra)] : page(1, []) }));
  r.checkout.openRecommendation(170); assert.deepEqual(r.navigations, ['/pages/activity/bargainDetail?id=1000']);
  extra = { ...extra, is_presale_product: 1 }; await r.checkout.load(); r.checkout.openRecommendation(170);
  assert.equal(r.navigations.length, 1); assert.match(r.toasts.at(-1).title, /预售/);
  r.hooks.onHide(); r.checkout.openRecommendation(170); assert.equal(r.navigations.length, 1); r.stop();
});

const promotionFrame = (extra = {}) => ({ id: 9, name: '秋日好物', image: '/api/qa/frame.svg', ...extra });

test('optional promotion frames preserve the real hot feed, price and destination, including older servers and malformed decoration', async () => {
  let frame = promotionFrame();
  const r = runtime({ component: 'pages/user/visitHistory.vue', send: call => ({ data: call.url === '/api/product/hot'
    ? [recommended(170, { image: '/api/qa/product.svg', activity_frame: frame })] : page(1, []) }) });
  try {
    await r.start();
    assert.deepEqual(r.checkout.recommendations.value[0].activityFrame, promotionFrame());
    frame = promotionFrame({ name: 'x'.repeat(255) }); await r.checkout.load();
    assert.deepEqual(r.checkout.recommendations.value[0].activityFrame, frame);
    for (const invalid of [undefined, null, false, [], 'frame', {}, promotionFrame({ id: '9' }), promotionFrame({ id: 0 }),
      promotionFrame({ id: 2147483648 }), promotionFrame({ id: 1.5 }), promotionFrame({ name: '' }), promotionFrame({ name: {} }),
      promotionFrame({ name: 'x'.repeat(256) }), promotionFrame({ image: {} }), promotionFrame({ image: '' }),
      promotionFrame({ image: '/'.repeat(2049) })]) {
      frame = invalid; await r.checkout.load();
      assert.equal(r.checkout.recommendationError.value, '');
      const row = r.checkout.recommendations.value[0];
      assert.equal(row.activityFrame, null); assert.equal(row.price, '12.30');
      assert.equal(row.destination, '/pages/goods/detail?id=170');
    }
    r.checkout.openRecommendation(170); assert.deepEqual(r.navigations, ['/pages/goods/detail?id=170']);
  } finally { r.stop(); }
});

test('promotion frames reuse safe image URLs and bounded literal text without turning decoration into navigation', async () => {
  let frame = promotionFrame();
  const r = await start(call => ({ data: call.url === '/api/product/hot' ? [recommended(170, { activity_frame: frame })] : page(1, []) }));
  try {
    for (const image of ['javascript:alert(1)', 'data:image/svg+xml,abc', 'http://example.invalid/frame.png', '//example.invalid/frame.png',
      'https://user:secret@example.invalid/frame.png', 'https://example.invalid/a b.png', '/frame\u0000.png', '/frame\\other.png']) {
      frame = promotionFrame({ image }); await r.checkout.load();
      assert.equal(r.checkout.recommendations.value[0].activityFrame, null);
      assert.equal(r.checkout.recommendationError.value, '');
    }
    for (const image of ['/api/qa/frame.svg?v=2', 'https://cdn.example.invalid/frame.png']) {
      frame = promotionFrame({ name: ' <b>活动原文</b> ', image }); await r.checkout.load();
      assert.deepEqual(r.checkout.recommendations.value[0].activityFrame, { ...frame, name: '<b>活动原文</b>' });
      assert.equal(r.checkout.recommendations.value[0].destination, '/pages/goods/detail?id=170');
    }
  } finally { r.stop(); }
});

function recommendationImage(item) {
  const props = vue.reactive({ item });
  const r = runtime({ component: 'components/VisitRecommendationImage.vue', props });
  return { ...r, props, state: r.checkout };
}

test('recommendation image requires a successful product image before showing the frame and isolates both failure modes', () => {
  const r = recommendationImage({ image: '/api/qa/product.svg', activityFrame: promotionFrame() });
  try {
    const state = r.state;
    assert.equal(state.showImage.value, true); assert.equal(state.showFrame.value, false);
    state.media.value.onLoad(); assert.equal(state.showFrame.value, true);
    state.media.value.onFrameError(); assert.equal(state.showImage.value, true); assert.equal(state.showFrame.value, false);
    r.props.item = { ...r.props.item }; // An explicit refresh can retry the same URLs.
    state.media.value.onLoad(); assert.equal(state.showFrame.value, true);
    state.media.value.onError(); assert.equal(state.showImage.value, false); assert.equal(state.showFrame.value, false);
    state.media.value.onLoad(); assert.equal(state.showFrame.value, false); // A late load cannot undo a terminal error.
    r.props.item = { ...r.props.item, image: '' };
    state.media.value.onLoad(); assert.equal(state.showImage.value, false); assert.equal(state.showFrame.value, false);
    r.props.item = { image: '/api/qa/product.svg', activityFrame: null };
    state.media.value.onLoad(); assert.equal(state.showImage.value, true); assert.equal(state.showFrame.value, false);
  } finally { r.stop(); }
});

test('image URL and frame URL changes reject all late events from older native image nodes', () => {
  const r = recommendationImage({ image: '/api/qa/product.svg', activityFrame: promotionFrame() });
  try {
    const state = r.state, oldImage = state.media.value;
    oldImage.onLoad(); assert.equal(state.showFrame.value, true);
    r.props.item.image = '/api/qa/product-2.svg';
    assert.notEqual(state.media.value.key, oldImage.key); assert.equal(state.showFrame.value, false);
    oldImage.onLoad(); oldImage.onError(); oldImage.onFrameError();
    assert.equal(state.showImage.value, true); assert.equal(state.showFrame.value, false);
    state.media.value.onLoad(); assert.equal(state.showFrame.value, true);
    const oldFrame = state.media.value;
    r.props.item.activityFrame.image = '/api/qa/frame-2.svg';
    assert.notEqual(state.media.value.key, oldFrame.key); assert.equal(state.showFrame.value, false);
    oldFrame.onError(); oldFrame.onFrameError(); oldFrame.onLoad();
    assert.equal(state.showImage.value, true); assert.equal(state.showFrame.value, false);
    state.media.value.onLoad(); assert.equal(state.showFrame.value, true);
  } finally { r.stop(); }
});

test('compiled image event handlers retain their original snapshot even with Vue handler caching enabled', () => {
  const { readFileSync } = require('node:fs'), { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc');
  const ts = require('typescript'), filename = path.resolve(__dirname, '../src/components/VisitRecommendationImage.vue');
  const descriptor = parse(readFileSync(filename, 'utf8'), { filename }).descriptor;
  const script = compileScript(descriptor, { id: 'visit-frame-events' });
  const compiled = compileTemplate({ source: descriptor.template.content, filename, id: 'visit-frame-events',
    compilerOptions: { bindingMetadata: script.bindings, cacheHandlers: true } });
  assert.deepEqual(compiled.errors, []);
  const output = ts.transpileModule(compiled.code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {}; new Function('require', 'exports', output)(require, exports);
  const r = recommendationImage({ image: '/api/qa/product.svg', activityFrame: promotionFrame() });
  const cache = [], render = () => exports.render({}, cache, {}, vue.proxyRefs(r.state));
  function find(node, name) {
    if (!node || typeof node !== 'object') return;
    if (node.props?.class === name) return node;
    for (const child of Array.isArray(node.children) ? node.children : []) { const found = find(child, name); if (found) return found; }
  }
  try {
    const main = find(render(), 'recommendation-main-image');
    main.props.onLoad(); assert.equal(r.state.showFrame.value, true);
    const frame = find(render(), 'promotion-frame');
    r.props.item = { ...r.props.item }; render();
    main.props.onLoad(); main.props.onError(); frame.props.onError();
    assert.equal(r.state.showImage.value, true); assert.equal(r.state.showFrame.value, false);
    find(render(), 'recommendation-main-image').props.onLoad();
    assert.equal(r.state.showFrame.value, true);
  } finally { r.stop(); }
});

test('actual history page refresh and identity changes cannot carry failed frame state or stale image callbacks into a new recommendation', async () => {
  const r = runtime({ component: 'pages/user/visitHistory.vue', send: call => ({ data: call.url === '/api/product/hot'
    ? [recommended(170, { image: '/api/qa/product.svg', activity_frame: promotionFrame() })] : page(1, []) }) });
  const scope = vue.effectScope();
  try {
    await r.start();
    const props = vue.reactive({ item: r.checkout.recommendations.value[0] });
    const state = scope.run(() => {
      vue.watch(() => r.checkout.recommendations.value[0], item => { if (item) props.item = item; }, { flush: 'sync' });
      return r.checkout.VisitRecommendationImage.setup(props, { expose() {} });
    });
    const first = state.media.value; first.onLoad(); first.onFrameError(); assert.equal(state.showFrame.value, false);
    await r.checkout.load();
    assert.notEqual(state.media.value.key, first.key); assert.equal(state.showFrame.value, false);
    first.onLoad(); first.onError(); first.onFrameError();
    assert.equal(state.showImage.value, true); assert.equal(state.showFrame.value, false);
    state.media.value.onLoad(); assert.equal(state.showFrame.value, true);
    const previousOwner = state.media.value;
    r.auth.setLogin('other-owner', 22); assert.deepEqual(r.checkout.recommendations.value, []);
    await r.checkout.load();
    previousOwner.onLoad(); previousOwner.onError(); previousOwner.onFrameError();
    assert.equal(state.showImage.value, true); assert.equal(state.showFrame.value, false);
    state.media.value.onLoad(); assert.equal(state.showFrame.value, true);
    r.checkout.openRecommendation(170); assert.deepEqual(r.navigations, ['/pages/goods/detail?id=170']);
    const disposed = state.media.value; scope.stop(); disposed.onError(); disposed.onFrameError();
    assert.equal(state.showFrame.value, true);
  } finally { scope.stop(); r.stop(); }
});
