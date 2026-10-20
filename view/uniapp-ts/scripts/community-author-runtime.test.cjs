const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
const profile = (id = 11, extra = {}) => ({ type: 2, relation_id: id, is_self: id === 11 ? 1 : 0,
  desc: '原简介', author: `作者${id}`, is_follow: 0, ...extra });
const post = (id = 31, extra = {}) => ({ id, type: 2, relationId: 11, is_self: 1, title: '原帖', content: '原内容',
  contentType: 1, image: '/api/assets/71?signature=preview', image_reference: '/api/assets/71',
  sliderImage: ['/api/assets/71?signature=preview'], slider_image_references: ['/api/assets/71'],
  topic_id: [9], product_id: [111], topic: [{ id: 9, name: '生活' }],
  product: [{ id: 111, store_name: '茶杯', image: '', price: '19.90' }], ...extra });
const setup = send => runtime({ feature: 'useCommunityAuthor', send: send ?? (call =>
  ({ data: call.url.includes('/user_info/') ? profile(Number(call.url.split('/').at(-1))) : [post()] })) });
test('author works include an explicit author type; likes are scoped to self and search retries exact pages', async () => {
  let fail = true;
  const r = setup(call => call.url.includes('/user_info/') ? { data: profile() }
    : call.url.includes('/like_list') ? { data: { list: [post(90)], count: 1 } }
      : call.data.page === 2 && fail ? (fail = false, { transport: 'offline' })
        : { data: call.data.page === 1 ? Array.from({ length: 10 }, (_, i) => post(i + 1)) : [post(11)] });
  try {
    await r.start(); const a = r.checkout; a.keyword.value = ' 茶 '; await a.initialize(11);
    a.keyword.value = '茶'; await a.refresh(); a.keyword.value = '未提交';
    await a.loadMore(); assert.match(a.error.value, /offline/); await a.loadMore();
    assert.deepEqual(r.calls.slice(-2).map(x => x.data), [1,2].map(() => ({ page: 2, limit: 10, relation_id: 11, author_type: 2, keyword: '茶', order: 1 })));
    await a.changeTab('liked'); assert.equal(a.posts.value[0].id, 90);
    await a.initialize(22); await a.changeTab('liked'); assert.equal(a.tab.value, 'works');
  } finally { r.stop(); }
});
test('old profile, pagination and account responses cannot restore private author state', async () => {
  for (const boundary of ['account','hide','unload','route']) {
    const old = deferred(); const r = setup(call => call.url.endsWith('/user_info/11') ? old.promise
      : call.url.includes('/user_info/') ? { data: profile(22) } : { data: [] });
    try {
      await r.start(); const a = r.checkout, work = a.initialize(11); await tick();
      if (boundary === 'account') r.auth.setLogin('other', 22);
      else if (boundary === 'route') await a.initialize(22);
      else r.hooks[boundary === 'hide' ? 'onHide' : 'onUnload']();
      old.resolve({ data: profile() }); await work;
      assert.notEqual(a.profile.value?.relation_id, 11); assert.equal(a.isSelf.value, false);
    } finally { r.stop(); }
  }
});
test('delete requires a current explicit inline intent, preserves cancellation and prevents duplicate pending requests', async () => {
  const pending = deferred(); const r = setup(call => call.url.includes('/user_info/') ? { data: profile() }
    : call.url.includes('/community_delete/') ? pending.promise : { data: [post()] });
  try {
    await r.start(); const a = r.checkout; await a.initialize(11);
    a.requestDelete(a.posts.value[0]); a.cancelDelete(); await a.confirmDelete();
    assert.equal(r.calls.filter(x => x.url.includes('community_delete')).length, 0);
    a.requestDelete(a.posts.value[0]); const work = a.confirmDelete(); await tick(); await a.confirmDelete();
    assert.equal(r.calls.filter(x => x.url.includes('community_delete')).length, 1);
    pending.resolve({ data: null }); await work; assert.equal(a.deleteId.value, 0); assert.deepEqual(r.modals, []);
    a.requestDelete(a.posts.value[0]); r.auth.setLogin('other', 22); await a.confirmDelete();
    assert.equal(r.calls.filter(x => x.url.includes('community_delete')).length, 1);
  } finally { pending.resolve({ data: null }); r.stop(); }
});
test('unknown description write clears private state and requires a successful read before another write', async () => {
  const r = setup(call => call.url.includes('/user_info/') ? { data: profile() }
    : call.url.endsWith('/update_desc') ? { httpStatus: 503, status: 503 } : { data: [post()] });
  try {
    await r.start(); const a = r.checkout; await a.initialize(11); a.beginDescription();
    a.description.value = '修订简介'; await a.saveDescription();
    assert.equal(a.unknown.value, true); assert.equal(a.profile.value, null); assert.deepEqual(a.posts.value, []);
    await a.saveDescription(); assert.equal(r.calls.filter(x => x.url.endsWith('/update_desc')).length, 1);
    await a.refresh(); assert.equal(a.unknown.value, false);
  } finally { r.stop(); }
});
test('profile editing bounds text, follow cancellation is inline, and foreign delete calls are refused', async () => {
  let followed = true;
  const r = setup(call => call.url.includes('/user_info/') ? { data: profile(Number(call.url.split('/').at(-1)), { is_follow: followed ? 1 : 0 }) }
    : call.url.includes('/set_interest/') ? (followed = false, { data: { is_follow: 0 } }) : { data: [post()] });
  try {
    await r.start(); const a = r.checkout; await a.initialize(11); a.beginDescription();
    a.description.value = '字'.repeat(51); await a.saveDescription(); assert.match(a.error.value, /50/);
    await a.initialize(22); a.requestDelete(post()); assert.equal(a.deleteId.value, 0);
    await a.toggleFollow(); assert.equal(a.unfollow.value, true);
    assert.equal(r.calls.filter(x => x.url.includes('/set_interest/')).length, 0);
    await a.toggleFollow(); assert.equal(r.calls.find(x => x.url.includes('/set_interest/')).data.status, 0);
  } finally { r.stop(); }
});
test('edit hydrates canonical gallery and associations, then sends explicit empty arrays to remove all associations', async () => {
  const r = runtime({ feature: 'useCommunityPublish', send: call => ({ data: call.url.includes('/detail/') ? post() : { id: 31 } }) });
  try {
    await r.start(); const p = r.checkout; assert.equal(await p.loadForEdit(31), true);
    assert.equal(p.images.value[0].url, '/api/assets/71'); assert.match(p.images.value[0].src, /signature/);
    p.relations.removeTopic(9); p.relations.removeProduct(111); p.title.value = ''; p.content.value = '修改内容';
    await p.publish(); const write = r.calls.at(-1);
    assert.equal(write.url, '/api/community/community_update/31');
    assert.deepEqual(write.data, { title: '', content: '修改内容', content_type: 1, image: '/api/assets/71',
      video_url: '', slider_image: ['/api/assets/71'], topic_id: [], product_id: [] });
    assert.equal(r.calls.some(x => x.url === '/api/community_save'), false);
  } finally { r.stop(); }
});
test('video edits preserve canonical clip and cover; removing the video explicitly clears both', async () => {
  const clip = post(31, { contentType: 2, videoUrl: '/api/assets/72?signature=preview', video_reference: '/api/assets/72',
    sliderImage: [], slider_image_references: [] });
  const r = runtime({ feature: 'useCommunityPublish', send: call => ({ data: call.url.includes('/detail/') ? clip : { id: 31 } }) });
  try {
    await r.start(); const p = r.checkout; await p.loadForEdit(31); await p.publish();
    assert.equal(r.calls.at(-1).data.video_url, '/api/assets/72'); assert.equal(r.calls.at(-1).data.image, '/api/assets/71');
    p.reset(); await p.loadForEdit(31); p.removeVideo(); await p.publish();
    assert.equal(r.calls.at(-1).data.content_type, 1); assert.equal(r.calls.at(-1).data.video_url, ''); assert.equal(r.calls.at(-1).data.image, '');
  } finally { r.stop(); }
});
test('hidden associations are retained until explicit removal and signed stored media cannot be resaved', async () => {
  const r = runtime({ feature: 'useCommunityPublish', send: () => ({ data: post(31, { topic: [], product: [],
    slider_image_references: ['/api/assets/71?signature=bad'] }) }) });
  try {
    await r.start(); const p = r.checkout; await p.loadForEdit(31);
    assert.match(p.relations.selectedTopics.value[0].name, /不可用/);
    assert.equal(p.relations.selectedProducts.value[0].product_id, 111);
    await p.publish(); assert.equal(r.calls.length, 1); assert.match(p.error.value, /原媒体/);
  } finally { r.stop(); }
});
test('foreign, missing and stale edit receipts cannot silently create a new post', async () => {
  for (const payload of [post(31, { relationId: 22, is_self: 0 }), { id: 31 }, null]) {
    const r = runtime({ feature: 'useCommunityPublish', send: () => ({ data: payload }) });
    try {
      await r.start(); const p = r.checkout; assert.equal(await p.loadForEdit(31), false);
      p.content.value = '不可新增'; await p.publish(); assert.equal(r.calls.length, 1); assert.equal(p.editId.value, 0);
    } finally { r.stop(); }
  }
  const old = deferred(), r = runtime({ feature: 'useCommunityPublish', send: () => old.promise });
  try {
    await r.start(); const work = r.checkout.loadForEdit(31); await tick(); r.hooks.onHide();
    old.resolve({ data: post() }); assert.equal(await work, false); assert.equal(r.checkout.editId.value, 0);
  } finally { r.stop(); }
});
test('unknown edit blocks automatic replay and cannot use the create endpoint', async () => {
  const r = runtime({ feature: 'useCommunityPublish', send: call => call.url.includes('/detail/')
    ? { data: post() } : { httpStatus: 503, status: 503 } });
  try {
    await r.start(); const p = r.checkout; await p.loadForEdit(31); await p.publish(); await p.publish();
    assert.equal(p.unknown.value, true); assert.equal(r.calls.length, 2);
    assert.equal(r.calls.at(-1).url, '/api/community/community_update/31');
  } finally { r.stop(); }
});
test('actual page opens the author view, edits an exact own post and refreshes author works after saving', async () => {
  const r = runtime({ component: 'pages/discover/workspace.vue', send: call => ({ data: call.url.includes('/user_info/') ? profile()
    : call.url.includes('/detail/') ? post() : call.url.includes('/community_update/') ? { id: 31 }
      : call.url.endsWith('/community/list') ? [post()] : [] }) });
  try {
    await r.start({ author_id: '11' }); assert.equal(r.checkout.authorMode.value, true);
    r.checkout.openAuthor(11); assert.equal(r.navigations.at(-1), '/pages/discover/workspace?author_id=11');
    assert.equal(r.checkout.authorIsSelf.value, true); await r.checkout.editPost(31);
    assert.equal(r.checkout.publishEditId.value, 31); r.checkout.publishContent.value = '实际页面修改';
    await r.checkout.publish(); assert.equal(r.checkout.showPublish.value, false);
    assert.equal(r.calls.filter(x => x.url.includes('/community_update/')).length, 1);
    assert.equal(r.checkout.authorPosts.value.length, 1);
  } finally { r.stop(); }
});
