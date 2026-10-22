const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
const entryFile = path.resolve(__dirname, '../../common/communityRoute.ts');
// The Page independently refreshes its public global footer; community validation
// must still prevent every other request, including private cart/account I/O.
function assertOnlyPublicFooterReads(calls) {
  for (const call of calls) {
    assert.ok(call.url === '/api/diy/diy_version/0' || call.url === '/api/navigation', `unexpected business I/O: ${call.url}`);
    assert.deepEqual(call.data, {});
  }
}
const post = (id = 31, uid = 11) => ({ id, type: 2, relationId: uid, is_self: 1, contentType: 1,
  title: `原帖${uid}`, content: '原内容', status: 1, is_verify: 1, isLike: 0, likeNum: 0, commentNum: 0, playNum: 0, shareNum: 0, image: '/api/assets/71?signature=preview', image_reference: '/api/assets/71',
  sliderImage: ['/api/assets/71?signature=preview'], slider_image_references: ['/api/assets/71'],
  topic_id: [9], product_id: [111], topic: [{ id: 9, name: '九' }], product: [{ id: 111, store_name: '杯', image: '', price: '1.00' }] });
const setup = send => runtime({ feature: 'useCommunityPublish', send });
const uploaded = { url: '/api/assets/72', src: '/api/assets/72?signature=preview', name: '新媒体' };
const uploadSuccess = options => options.success({ statusCode: 200, data: JSON.stringify({ status: 200, data: uploaded }) });

test('workspace modes validate all identities, give edit priority and retain feed/detail namespace', () => {
  const r = setup();
  try {
    const { parseCommunityWorkspaceEntry: parse, resolveCommunityPageRoute: resolve } = r.load(entryFile);
    assert.deepEqual(parse({}), { kind: 'feed' }); assert.deepEqual(parse({ id: '31' }), { kind: 'feed' });
    assert.deepEqual(parse({ author_id: '0' }), { kind: 'author', authorId: 0 });
    assert.deepEqual(parse({ author_id: 'self' }), { kind: 'author', authorId: 'self' });
    assert.deepEqual(parse({ publish: '1', topic_id: '2147483647' }), { kind: 'publish', editId: 0, topicId: 2147483647 });
    assert.deepEqual(parse({ publish: '1', edit_id: '31', topic_id: '10' }), { kind: 'publish', editId: 31, topicId: 0 });
    for (const query of [null, [], { publish: ['1'] }, { publish: '' }, { publish: 'true' }, { publish: '1', author_id: '11' },
      { publish: '1', id: '31' }, { author_id: 'self', post_type: '2' }, { edit_id: '31' }, { topic_id: '9' },
      { publish: '1', edit_id: '0' }, { publish: '1', topic_id: '01' }, { publish: '1', topic_id: '2147483648' },
      { publish: '1', edit_id: '31', topic_id: 'NaN' }, { author_id: '-1' }, { author_id: '2147483648' }]) assert.throws(() => parse(query));
    // A shared community parser must not consume unrelated routes' query grammar.
    for (const query of ['id=1&id=2', '%wrong', 'q=' + 'a'.repeat(3000)]) assert.equal(resolve('/pages/goods/detail', query), null);
  } finally { r.stop(); }
});

test('all real raw page roots route locally, strip credentials and preserve legacy numeric meanings', async () => {
  for (const [page, query, target] of [
    ['discoverUser', {}, 'workspace?author_id=self'], ['discoverUser', { id: '0', token: 'discard' }, 'workspace?author_id=0'],
    ['discoverUser', { id: '22' }, 'workspace?author_id=22'],
    ['discoverFollow', { type: '0', uid: '999', token: 'discard' }, 'people?tab=follow'],
    ['discoverFollow', { type: '1' }, 'people?tab=friend'], ['discoverFollow', { type: '2' }, 'people?tab=fans'],
    ['discoverFollow', {}, 'people?tab=friend'], ['discoverCreate', {}, 'workspace?publish=1'],
    ['discoverCreate', { topic_id: '9' }, 'workspace?publish=1&topic_id=9'],
    ['discoverCreate', { id: '31', topic_id: '10' }, 'workspace?publish=1&edit_id=31'],
  ]) {
    const r = runtime({ component: `pages/discover/${page}/index.vue`, send: () => { throw Error('Bridge business I/O'); } });
    try {
      await r.start(query); assert.deepEqual(r.navigations, ['/pages/discover/' + target]);
      assert.deepEqual(r.calls, []); assert.deepEqual(r.modals, []);
    } finally { r.stop(); }
  }
});

test('invalid raw native values and duplicated original H5 queries never navigate or start business I/O', async () => {
  for (const [page, query] of [['discoverUser', { id: '00' }], ['discoverUser', { id: '-1' }],
    ['discoverFollow', { type: '3' }], ['discoverFollow', { type: '0', tab: 'follow' }],
    ['discoverCreate', { id: '31', topic_id: '0' }], ['discoverCreate', { id: ['31', '32'] }]]) {
    const r = runtime({ component: `pages/discover/${page}/index.vue` });
    try { await r.start(query); assert.match(r.checkout.error.value, /无效/); assert.deepEqual(r.navigations, []); assert.deepEqual(r.calls, []); }
    finally { r.stop(); }
  }
  const previous = global.window;
  global.window = { location: { hash: '#/pages/discover/discoverCreate/index?id=31&id=32' } };
  const r = runtime({ component: 'pages/discover/discoverCreate/index.vue' });
  try { await r.start({ id: '32' }); assert.match(r.checkout.error.value, /重复/); assert.deepEqual(r.navigations, []); }
  finally { r.stop(); if (previous === undefined) delete global.window; else global.window = previous; }
});

test('legacy redirect retry is local, and an unloaded bridge ignores stale failure callbacks', async () => {
  const r = runtime({ component: 'pages/discover/discoverCreate/index.vue' }); const requests = [];
  r.uni.redirectTo = options => requests.push(options);
  try {
    await r.start({ topic_id: '9' }); r.checkout.open(); requests[0].fail();
    assert.equal(r.checkout.error.value, ''); requests[1].fail(); assert.match(r.checkout.error.value, /重试/);
    r.hooks.onUnload(); r.checkout.open(); assert.equal(requests.length, 2); requests[1].fail(); assert.deepEqual(r.calls, []);
  } finally { r.stop(); }
});

test('canonical invalid publisher/author modes fail before referrals, feed reads and account refreshes', async () => {
  for (const query of [{ publish: '0' }, { publish: '1', topic_id: '2147483648' }, { publish: '1', edit_id: '31', topic_id: '0' },
    { publish: '1', author_id: '11' }, { author_id: 'self', id: '31' }, { edit_id: '31' }]) {
    const r = runtime({ component: 'pages/discover/index.vue', send: () => { throw Error('Invalid route I/O'); } });
    try {
      await r.start(query); assert.match(r.checkout.routeError.value, /无效|冲突/);
      assert.equal(r.checkout.showPublish.value, false); r.checkout.openPublish(); await r.checkout.load();
      r.auth.setLogin('next-session', 22); await tick(); assertOnlyPublicFooterReads(r.calls); assert.deepEqual(r.navigations, []);
    } finally { r.stop(); }
  }
});

test('canonical edit wins over seeded topic and hydrates through state without a deliberate visit', async () => {
  const r = runtime({ component: 'pages/discover/index.vue', send: call => ({ data:
    call.url === '/api/community/state/31' ? post() : call.url.endsWith('/topic') ? [{ id: 10, name: '十' }] : [] }) });
  try {
    await r.start({ publish: '1', edit_id: '31', topic_id: '10' });
    assert.equal(r.checkout.publishEditId.value, 31); assert.equal(r.checkout.publishTitle.value, '原帖11');
    assert.deepEqual(r.checkout.selectedTopics.value.map(row => row.id), [9]);
    assert.deepEqual(r.checkout.selectedProducts.value.map(row => row.product_id), [111]);
    assert.equal(r.calls.filter(row => row.url === '/api/community/state/31').length, 1);
    assert.equal(r.calls.some(row => /\/detail\/|community_save|community_update/.test(row.url)), false);
  } finally { r.stop(); }
});

test('actual topic CTA enters the full publisher, respects visibility/guest gates and never saves directly', async () => {
  const r = runtime({ component: 'components/community/CommunityDeepLinkFeed.vue', props: { mode: 'topic', query: { id: '9' } },
    send: call => ({ data: call.url.endsWith('/topic') ? [{ id: 9, name: '九' }] : [] }) });
  try {
    r.checkout.openPublish(); assert.deepEqual(r.navigations, []);
    await r.checkout.feed.initialize({ id: '9' }); r.checkout.openPublish();
    assert.deepEqual(r.navigations, ['/pages/discover/workspace?publish=1&topic_id=9']);
    r.hooks.onHide(); r.checkout.openPublish(); assert.equal(r.navigations.length, 1);
    r.hooks.onShow(); r.auth.clear(); await tick(); r.checkout.openPublish(); assert.equal(r.navigations.at(-1), '/pages/auth/login');
    assert.equal(r.calls.some(row => row.url.includes('community_save')), false); assert.deepEqual(r.modals, []);
  } finally { r.stop(); }
});

for (const media of ['image', 'video']) test(`native ${media} terminal callbacks cannot upload twice or cancel a later chooser`, async () => {
  const r = setup(); const choices = [], uploads = [];
  r.uni[media === 'image' ? 'chooseImage' : 'chooseVideo'] = options => choices.push(options);
  r.uni.uploadFile = options => uploads.push(options);
  const selection = media === 'image' ? { tempFiles: [{ size: 32 }], tempFilePaths: ['/photo'] } : { size: 32, tempFilePath: '/clip' };
  const choose = () => r.checkout[media === 'image' ? 'chooseImages' : 'chooseVideo']();
  try {
    await r.start(); choose(); const first = choices[0].success(selection); await tick();
    await choices[0].success(selection); choices[0].fail({ errMsg: 'old failure' }); assert.equal(uploads.length, 1);
    assert.equal(r.checkout.busy.value, true); uploadSuccess(uploads[0]); await first;
    r.checkout.reset(); choose(); choices[0].fail({ errMsg: 'cancel' }); assert.equal(r.checkout.choosing.value, true);
    choices[1].fail({ errMsg: 'cancel' }); await choices[1].success(selection); assert.equal(uploads.length, 1);
    assert.equal(r.checkout.choosing.value, false); assert.equal(r.checkout.error.value, '');
  } finally { r.stop(); }
});

for (const boundary of ['account', 'token', 'session']) for (const operation of ['save', 'edit', 'image', 'video']) for (const late of ['success', 'failure']) {
  test(`${operation}: old ${boundary} ${late}/finally cannot mutate or unlock the new owner's pending operation`, async () => {
    const old = deferred(), fresh = deferred(), choices = [], uploads = []; let reads = 0;
    const r = setup(() => (++reads === 1 ? old.promise : fresh.promise));
    r.uni.chooseImage = r.uni.chooseVideo = options => choices.push(options); r.uni.uploadFile = options => uploads.push(options);
    const start = async () => {
      if (operation === 'save') { r.checkout.content.value = '当前草稿'; return { promise: r.checkout.publish() }; }
      if (operation === 'edit') return { promise: r.checkout.loadForEdit(31) };
      if (operation === 'image') { r.checkout.chooseImages(); return { promise: choices.at(-1).success({ tempFiles: [{ size: 32 }], tempFilePaths: ['/photo'] }) }; }
      r.checkout.chooseVideo(); return { promise: choices.at(-1).success({ size: 32, tempFilePath: '/clip' }) };
    };
    try {
      await r.start(); const first = await start(); await tick();
      r.auth.setLogin(boundary === 'session' ? r.auth.token : 'new-token', boundary === 'account' ? 22 : 11);
      assert.equal(r.checkout.busy.value, false); assert.equal(r.checkout.loadingEdit.value, false);
      assert.equal(r.checkout.content.value, ''); assert.deepEqual(r.checkout.relations.selectedTopics.value, []);
      const second = await start(); await tick();
      if (operation === 'image' || operation === 'video') {
        assert.equal(uploads.length, 2); if (late === 'success') uploadSuccess(uploads[0]); else uploads[0].fail({ errMsg: 'old failure' });
      } else old.resolve(late === 'success' ? { data: operation === 'edit' ? post() : { id: 31 } } : { transport: 'old failure' });
      await first.promise; assert.equal(r.checkout[operation === 'edit' ? 'loadingEdit' : 'busy'].value, true);
      assert.equal(r.checkout.locked.value, true); assert.equal(r.checkout.unknown.value, false); assert.equal(r.checkout.error.value, '');
      assert.equal(r.checkout.publishedId.value, 0); assert.equal(r.checkout.editId.value, 0);
      if (operation === 'image' || operation === 'video') uploadSuccess(uploads[1]);
      else fresh.resolve({ data: operation === 'edit' ? post(31, r.auth.uid) : { id: 32 } });
      await second.promise; assert.equal(r.checkout[operation === 'edit' ? 'loadingEdit' : 'busy'].value, false);
      if (operation === 'save') assert.equal(r.checkout.publishedId.value, 32);
      if (operation === 'edit') { assert.equal(r.checkout.editId.value, 31); assert.equal(r.checkout.title.value, `原帖${r.auth.uid}`); }
      if (operation === 'image') assert.deepEqual(r.checkout.images.value.map(row => row.url), [uploaded.url]);
      if (operation === 'video') assert.equal(r.checkout.video.value.url, uploaded.url);
    } finally { old.resolve({ data: null }); fresh.resolve({ data: null }); r.stop(); }
  });
}

test('same-owner hide releases the finished busy flag but requires explicit draft end before replay', async () => {
  const waiting = deferred(), r = setup(() => waiting.promise);
  try {
    await r.start(); r.checkout.content.value = '隐藏前发布'; const work = r.checkout.publish(); await tick();
    r.hooks.onHide(); r.hooks.onShow(); waiting.resolve({ data: { id: 31 } }); assert.equal(await work, null);
    assert.equal(r.checkout.busy.value, false); assert.equal(r.checkout.unknown.value, true);
    await r.checkout.publish(); assert.equal(r.calls.length, 1); assert.equal(r.checkout.reset(), true);
  } finally { waiting.resolve({ data: null }); r.stop(); }
});

test('edit receipts must identify the original post; invalid/foreign receipts lock without navigating or replaying', async () => {
  for (const id of [32, 2147483648, 0, '31', undefined]) {
    const r = setup(call => ({ data: call.url.includes('/state/') ? post() : { id } }));
    try {
      await r.start(); assert.equal(await r.checkout.loadForEdit(31), true); assert.equal(await r.checkout.publish(), null);
      assert.equal(r.checkout.unknown.value, true); assert.equal(r.checkout.publishedId.value, 0);
      await r.checkout.publish(); assert.equal(r.calls.length, 2); assert.deepEqual(r.navigations, []);
      assert.equal(r.calls.at(-1).url, '/api/community/community_update/31');
    } finally { r.stop(); }
  }
});

for (const boundary of ['account', 'hide', 'unload']) test(`actual page rechecks ${boundary} after the publisher receipt before clearing or opening a draft`, async () => {
  const r = runtime({ component: 'pages/discover/index.vue', send: call => ({ data:
    call.url === '/api/community_save' ? { id: 31 } : [] }) });
  try {
    await r.start({ publish: '1' }); r.checkout.publishContent.value = '旧草稿';
    const original = r.checkout.publisher.publish;
    r.checkout.publisher.publish = async (...args) => {
      const id = await original(...args);
      if (boundary === 'account') { r.auth.setLogin('new-token', 22); r.checkout.publishContent.value = '新账号草稿'; r.checkout.showPublish.value = true; }
      else r.hooks[boundary === 'hide' ? 'onHide' : 'onUnload']();
      return id;
    };
    await r.checkout.publish(); assert.deepEqual(r.toasts, []); assert.equal(r.checkout.detail.value, null);
    assert.equal(r.calls.some(row => row.url === '/api/community/detail/31'), false);
    if (boundary === 'account') { assert.equal(r.checkout.publishContent.value, '新账号草稿'); assert.equal(r.checkout.showPublish.value, true); }
  } finally { r.stop(); }
});

// Exercise the real request adapter and pager through the server's maximum
// offset. Repeated product IDs keep the synthetic catalogue small and verify
// that pagination follows receipts, rather than the deduplicated list length.
test('product selector reaches allowed page1001 and stops before the rejected offset10010', async () => {
  const rows = Array.from({length:10}, (_, i) => ({product_id:i+1,store_name:`商品${i+1}`,image:'',price:'1.00'}));
  const r = setup(call => {
    assert.equal(call.url,'/api/community/product_list'); assert.ok(call.data.page <=1001);
    return {data:rows};
  });
  try {
    await r.start(); const relation = r.checkout.relations; await relation.openProducts();
    for(let page=2;page<=1001;page++) await relation.loadProducts();
    assert.equal(relation.hasMore.value,false); assert.equal(relation.products.value.length,10);
    assert.deepEqual(r.calls.slice(-2).map(row=>row.data.page),[1000,1001]);
    await relation.loadProducts(); assert.equal(r.calls.length,1001);
  } finally {r.stop();}
});
