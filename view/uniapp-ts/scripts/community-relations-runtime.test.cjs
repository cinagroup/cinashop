const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
const topics = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, name: `话题${i + 1}` }));
const product = id => ({ product_id: id, store_name: `商品${id}`, image: '', price: '9.90' });
const setup = send => runtime({ feature: 'useCommunityPublish', send: send ?? (call =>
  ({ data: call.url.endsWith('/topic') ? topics : call.url.endsWith('/product_list') ? Array.from({ length: 6 }, (_, i) => product(i + 1)) : { id: 31 } })) });
test('topics and products each enforce five selections, allow removal, and publish exact IDs without a modal', async () => {
  const r = setup(); try {
    await r.start(); const s = r.checkout.relations;
    await s.openTopics(); topics.forEach(s.toggleTopic);
    assert.deepEqual(s.selectedTopics.value.map(x => x.id), [1,2,3,4,5]); assert.match(s.error.value, /5/);
    s.toggleTopic(topics[0]); s.toggleTopic(topics[5]);
    await s.openProducts(); s.products.value.forEach(s.toggleProduct);
    assert.deepEqual(s.selectedProducts.value.map(x => x.product_id), [1,2,3,4,5]);
    s.removeProduct(1); s.toggleProduct(product(6)); s.close();
    r.checkout.content.value = '带有关联的分享'; await r.checkout.publish();
    const payload = r.calls.at(-1).data;
    assert.deepEqual(payload.topic_id, [2,3,4,5,6]); assert.deepEqual(payload.product_id, [2,3,4,5,6]);
    assert.deepEqual(r.modals, []); r.checkout.reset();
    assert.deepEqual(s.selectedTopics.value, []); assert.deepEqual(s.selectedProducts.value, []);
  } finally { r.stop(); }
});
test('source changes retain selections, while keyword pagination retries the exact failed page and deduplicates', async () => {
  let failed = false;
  const r = setup(call => {
    if (call.data.type === 'collect') return { data: [product(20)] };
    if (call.data.page === 2 && !failed) { failed = true; return { transport: 'offline' }; }
    return { data: call.data.page === 1 ? Array.from({ length: 10 }, (_, i) => product(i + 1)) : [product(10), product(11), product(11)] };
  });
  try {
    await r.start(); const s = r.checkout.relations;
    await s.openProducts(); s.toggleProduct(product(1));
    s.keyword.value = ' 花 '; await s.loadProducts(true); s.keyword.value = '未提交';
    await s.loadProducts(); assert.match(s.error.value, /offline/); assert.equal(s.products.value.length, 10);
    await s.loadProducts(); assert.equal(s.products.value.length, 11); assert.equal(s.hasMore.value, false);
    assert.deepEqual(r.calls.slice(-2).map(c => c.data), [1,2].map(() => ({ type: 'pay', keyword: '花', page: 2, limit: 10 })));
    await s.changeSource('collect'); s.toggleProduct(product(20));
    assert.deepEqual(s.selectedProducts.value.map(x => x.product_id), [1,20]);
  } finally { r.stop(); }
});
test('late source results cannot repaint a newer source', async () => {
  const old = deferred(), r = setup(call => call.data.type === 'pay' ? old.promise : { data: [product(20)] });
  try {
    await r.start(); const s = r.checkout.relations;
    const work = s.openProducts(); await tick(); await s.changeSource('collect');
    old.resolve({ data: [product(1)] }); await work;
    assert.deepEqual(s.products.value.map(x => x.product_id), [20]); assert.equal(s.source.value, 'collect');
  } finally { r.stop(); }
});
test('account, hide, unload and close boundaries reject late catalog results', async () => {
  for (const boundary of ['account','hide','unload','close']) {
    const old = deferred(), r = setup(() => old.promise);
    try {
      await r.start(); const s = r.checkout.relations, work = s.openProducts(); await tick();
      if (boundary === 'account') r.auth.setLogin('other', 22);
      else if (boundary === 'close') s.close();
      else r.hooks[boundary === 'hide' ? 'onHide' : 'onUnload']();
      old.resolve({ data: [product(1)] }); await work;
      assert.deepEqual(s.products.value, []); assert.equal(s.loading.value, false); assert.equal(s.panel.value, '');
    } finally { r.stop(); }
  }
});
test('legacy topic entry must resolve an active topic or explicitly discard it before publishing', async () => {
  const r = setup(); try {
    await r.start(); const s = r.checkout.relations;
    await s.seedTopic(99); assert.match(s.error.value, /停用/);
    r.checkout.content.value = '原话题已下线'; await r.checkout.publish();
    assert.equal(r.calls.filter(c => c.url.endsWith('/community_save')).length, 0);
    s.discardPendingTopic(); await s.seedTopic(2);
    assert.deepEqual(s.selectedTopics.value.map(x => x.id), [2]);
    s.close(); await r.checkout.publish(); assert.deepEqual(r.calls.at(-1).data.topic_id, [2]);
  } finally { r.stop(); }
});
test('malformed product receipts fail closed and do not remove already selected products', async () => {
  for (const invalid of [{ ...product(2), product_id: -2 }, { ...product(2), price: 'NaN' }, null, ...[Array(11).fill(product(2))]]) {
    let first = true; const r = setup(() => ({ data: first ? (first = false, [product(1)]) : Array.isArray(invalid) ? invalid : [invalid] }));
    try {
      await r.start(); const s = r.checkout.relations; await s.openProducts(); s.toggleProduct(product(1));
      await s.changeSource('visit'); assert.match(s.error.value, /格式/);
      assert.deepEqual(s.products.value, []); assert.deepEqual(s.selectedProducts.value.map(x => x.product_id), [1]);
    } finally { r.stop(); }
  }
});
test('publishing is blocked during selection loading, and unknown publish outcomes lock relation changes', async () => {
  const old = deferred(); let catalog = true;
  const r = setup(call => call.url.endsWith('/community_save') ? { transport: 'offline' }
    : catalog ? old.promise : { data: topics });
  try {
    await r.start(); const s = r.checkout.relations;
    const loading = s.openTopics(); await tick(); r.checkout.content.value = '关联锁定';
    await r.checkout.publish(); assert.equal(r.calls.length, 1);
    old.resolve({ data: topics }); await loading; catalog = false;
    s.toggleTopic(topics[0]); s.close(); await r.checkout.publish();
    assert.equal(r.checkout.unknown.value, true);
    s.removeTopic(1); await s.openProducts(); await s.openTopics();
    assert.deepEqual(s.selectedTopics.value.map(x => x.id), [1]); assert.equal(r.calls.length, 2);
  } finally { r.stop(); }
});
test('actual page publishes selected IDs, displays associations and navigates only displayed products', async () => {
  const post = { id: 31, contentType: 1, content: '关联分享', topic: [topics[0]],
    product: [{ id: 1, store_name: '商品1', image: '', price: '9.90' }] };
  const r = runtime({ component: 'pages/discover/index.vue', send: call => ({ data:
    call.url.endsWith('/topic') ? topics : call.url.endsWith('/product_list') ? [product(1)]
      : call.url.endsWith('/community_save') ? { id: 31 } : call.url.endsWith('/detail/31') ? post : [] }) });
  try {
    await r.start({ publish: '1', topic_id: '1' }); const s = r.checkout.relations;
    assert.equal(r.checkout.showPublish.value, true);
    await s.openProducts(); s.toggleProduct(product(1)); s.close();
    r.checkout.publishContent.value = '关联分享'; await r.checkout.publish();
    assert.deepEqual(r.calls.find(c => c.url.endsWith('/community_save')).data.product_id, [1]);
    assert.deepEqual(r.checkout.detail.value.product, post.product);
    r.checkout.openRelatedProduct(999); assert.deepEqual(r.navigations, []);
    r.checkout.openRelatedProduct(1); r.checkout.openTopic(1);
    assert.deepEqual(r.navigations, ['/pages/goods/detail?id=1', '/pages/discover/discoverTopic/index?id=1']);
    r.hooks.onHide(); r.checkout.openRelatedProduct(1); assert.equal(r.navigations.length, 2);
  } finally { r.stop(); }
});
