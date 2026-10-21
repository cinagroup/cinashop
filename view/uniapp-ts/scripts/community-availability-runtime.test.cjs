const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vue = require('vue');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
const root = path.resolve(__dirname, '..');
const post = (id = 31, extra = {}) => ({ id, type: 2, relationId: 11, is_self: 1, contentType: 1,
  title: '可见原帖', content: '旧内容', image: '', sliderImage: null, likeNum: 7, commentNum: 2,
  playNum: 8, shareNum: 9, isLike: 0, status: 1, is_verify: 1, addTime: 100,
  site_url: 'https://shop.example.test', ...extra });
const config = open => ({ community_status: open, community_comment_status: 1, community_comment_add: 1 });
const closed = { status: 410010, msg: '社区暂未开放' };
const api = r => r.load(path.join(root, 'src/api/community.ts'));
const availability = r => r.load(path.join(root, 'src/utils/communityAvailability.ts')).communityAvailability();
const count = (r, pattern) => r.calls.filter(row => pattern.test(row.url)).length;
const topic = { id: 9, name: '九', isRecommend: 1 };
const person = { id: 22, type: 2, relation_id: 22, author: '作者', author_image: '', desc: '旧简介', community_num: 1,
  fans_num: 2, follow_num: 3, friend_num: 0, friend_count: 0, like_num: 7, is_follow: 0, is_fans: 0, is_self: 0 };

function normal(call) {
  if (call.url.endsWith('/config')) return { data: config(1) };
  if (call.url.endsWith('/topic')) return { data: [topic] };
  if (/\/(?:detail|state)\//.test(call.url)) return { data: post(Number(call.url.split('/').at(-1))) };
  if (call.url.includes('/user_info/')) return { data: person };
  if (/follow_list|user_friend|recommend_list/.test(call.url)) return { data: [person] };
  if (call.url.endsWith('/comment/list')) return { data: { list: [], count: 0, post_comment_num: 2 } };
  if (call.url.endsWith('/list')) return { data: [post()] };
  return { data: [] };
}
async function closeThroughHttp(r) {
  await assert.rejects(api(r).apiCommunityTopics(), /暂未开放|站点升级/);
  assert.equal(availability(r).closed.value, true);
}

test('only real RequestError 410010 without a server failure closes community and counts as certain', () => {
  const r = runtime({ feature: 'useCommunityHomeFeed', send: normal });
  try {
    const { RequestError } = r.load(path.join(root, 'src/utils/request.ts'));
    const { isCommunityClosed, isCommunityRejected } = r.load(path.join(root, 'src/utils/communityAvailability.ts'));
    for (const httpStatus of [undefined, 200, 400]) {
      const error = new RequestError('closed', 410010, null, httpStatus);
      assert.equal(isCommunityClosed(error), true); assert.equal(isCommunityRejected(error), true);
    }
    for (const value of [new RequestError('uncertain', 410010, null, 503), new RequestError('uncertain', 503),
      Error('社区暂未开放'), { status: 410010, httpStatus: 200 }]) assert.equal(isCommunityClosed(value), false);
    assert.equal(isCommunityRejected(new RequestError('uncertain', 410010, null, 503)), false);
    assert.equal(r.auth.isLoggedIn, true); assert.deepEqual(r.navigations, []);
  } finally { r.stop(); }
});

test('a station refusal clears main feed and blocks every new community request while config remains readable', async () => {
  let refuse = false;
  const r = runtime({ feature: 'useCommunityHomeFeed', send: call => refuse && !call.url.endsWith('/config')
    ? { ...closed, msg: '站点升级中，请稍候访问' } : normal(call) });
  try {
    await r.checkout.load(); assert.equal(r.checkout.posts.value.length, 1);
    refuse = true; await r.checkout.load(); assert.deepEqual(r.checkout.posts.value, []);
    assert.deepEqual(r.checkout.topics.value, []); assert.deepEqual(r.checkout.highlights.value, []);
    assert.equal(availability(r).message.value, '站点升级中，请稍候访问');
    const before = r.calls.length;
    for (const work of [() => api(r).apiCommunityList(), () => api(r).apiCommunityState(31),
      () => api(r).apiCommunityLike(31, 1), () => api(r).apiCommunitySave({ content: '不能发布' }),
      () => api(r).apiCommunityTrackShare(31), () => api(r).apiCommunityDelete(31),
      () => api(r).apiCommunityCommentPage(31), () => api(r).apiCommunitySetInterest(22, 1)]) await assert.rejects(work());
    assert.equal(r.calls.length, before);
    await api(r).apiCommunityCommentConfig(); assert.equal(r.calls.length, before + 1);
    assert.equal(availability(r).closed.value, true); // An ordinary config read cannot reopen a stopped session.
    assert.equal(r.auth.uid, 11); assert.equal(r.auth.isLoggedIn, true); assert.deepEqual(r.navigations, []);
  } finally { r.stop(); }
});

test('a late successful feed read cannot restore content after another request observes closure', async () => {
  const waiting = deferred(); let hold = false;
  const r = runtime({ feature: 'useCommunityHomeFeed', send: call => call.url.endsWith('/config') ? { data: config(0) }
    : hold && call.url.endsWith('/list') ? waiting.promise : normal(call) });
  try {
    await r.checkout.load(); hold = true; const old = r.checkout.load(); await tick();
    await api(r).apiCommunityCommentConfig(); waiting.resolve({ data: [post(99)] }); await old;
    assert.deepEqual(r.checkout.posts.value, []); assert.deepEqual(r.checkout.highlights.value, []); assert.equal(r.checkout.loading.value, false);
  } finally { waiting.resolve({ data: [] }); r.stop(); }
});

test('manual recovery is single flight, keeps closed on bad config and never automatically reloads or writes', async () => {
  let valid = false, reads = 0;
  const r = runtime({ feature: 'useCommunityHomeFeed', send: call => call.url.endsWith('/config')
    ? { data: valid ? config(1) : {} } : closed });
  try {
    await r.checkout.load(); const before = r.calls.length;
    assert.equal(await availability(r).refresh(), false); assert.equal(availability(r).closed.value, true);
    valid = true; assert.equal(await availability(r).refresh(), true);
    reads = r.calls.length; await tick(); assert.equal(r.calls.length, reads); assert.equal(reads, before + 2);
    assert.deepEqual(r.checkout.posts.value, []); assert.equal(availability(r).closed.value, false);
    assert.equal(count(r, /community_save|\/like\/|\/share\//), 0);
  } finally { r.stop(); }
});

test('old closure replies cannot close a newer recovered epoch or another account', async () => {
  for (const boundary of ['recover', 'owner']) {
    const waiting = deferred(); let requests = 0;
    const r = runtime({ feature: 'useCommunityHomeFeed', send: call => call.url.endsWith('/config') ? { data: config(1) }
      : ++requests === 1 ? waiting.promise : boundary === 'recover' && call.url.endsWith('/topic') ? closed : normal(call) });
    try {
      const old = api(r).apiCommunityTopics().catch(() => {}); await tick();
      if (boundary === 'owner') r.auth.setLogin('different', 22);
      else { await closeThroughHttp(r); assert.equal(await availability(r).refresh(), true); }
      waiting.resolve(closed); await old;
      assert.equal(availability(r).closed.value, false); assert.equal(r.auth.isLoggedIn, true);
      if (boundary === 'owner') { await tick(); assert.equal(r.checkout.posts.value[0].id, 31); }
    } finally { waiting.resolve(closed); r.stop(); }
  }
});

test('a 503 carrying 410010 remains an unknown like and does not close or log out', async () => {
  const r = runtime({ feature: 'useCommunityEngagement', send: () => ({ ...closed, httpStatus: 503 }) });
  try {
    await r.checkout.toggleLike(post()); assert.equal(r.checkout.unknown(31), true);
    assert.equal(availability(r).closed.value, false); assert.equal(r.auth.isLoggedIn, true);
    await r.checkout.toggleLike(post()); assert.equal(count(r, /\/like\//), 1); assert.equal(count(r, /\/detail\//), 0);
  } finally { r.stop(); }
});

test('a true closure rejection settles only its own pending like without leaving an unknown marker', async () => {
  const r = runtime({ feature: 'useCommunityEngagement', send: () => closed });
  try {
    await r.checkout.toggleLike(post()); assert.equal(availability(r).closed.value, true);
    assert.equal(r.checkout.unknown(31), false); assert.equal(r.checkout.busy.value, false);
    assert.equal(count(r, /\/like\//), 1);
  } finally { r.stop(); }
});

test('an admitted like success after closure stays unknown until explicit read-only state reconciliation', async () => {
  const waiting = deferred();
  const r = runtime({ feature: 'useCommunityEngagement', send: call => call.url.includes('/like/') ? waiting.promise
    : call.url.endsWith('/topic') ? closed : call.url.endsWith('/config') ? { data: config(1) }
    : { data: post(31, { isLike: 1, likeNum: 99 }) } });
  try {
    const pending = r.checkout.toggleLike(post()); await tick(); await closeThroughHttp(r);
    waiting.resolve({ data: { status: 1, likeNum: 99 } }); await pending;
    assert.equal(r.checkout.unknown(31), true); assert.equal(r.checkout.view(post()).likeNum, 7);
    await availability(r).refresh(); await r.checkout.toggleLike(post()); assert.equal(count(r, /\/like\//), 1);
    await r.checkout.reconcile(31); assert.equal(r.checkout.unknown(31), false); assert.equal(r.checkout.view(post()).likeNum, 99);
    assert.equal(count(r, /\/state\/31/), 1); assert.equal(count(r, /\/detail\//), 0);
  } finally { waiting.resolve({ data: { status: 1, likeNum: 99 } }); r.stop(); }
});

test('an existing unknown share survives closure, composable replacement and recovery without replay', async () => {
  const r = runtime({ feature: 'useCommunityEngagement', send: call => call.url.endsWith('/topic') ? closed
    : call.url.includes('/share/') ? { httpStatus: 503, status: 503 } : normal(call) }); let scope;
  try {
    let copied = '';
    r.uni.setClipboardData = input => { copied = input.data; input.success(); }; await r.checkout.openShare(post()); await r.checkout.copyShare();
    assert.equal(copied, 'https://shop.example.test/#/pages/discover/workspace?id=31&spid=11');
    assert.equal(count(r, /\/share\//), 1);
    assert.equal(r.checkout.unknown(31), true); await closeThroughHttp(r); r.checkout.dispose();
    scope = vue.effectScope(); const fresh = scope.run(() => r.load(path.join(root, 'src/composables/useCommunityEngagement.ts')).useCommunityEngagement());
    assert.equal(fresh.unknown(31), true); await availability(r).refresh();
    await fresh.openShare(post()); await fresh.copyShare(); assert.equal(count(r, /\/share\//), 1); assert.equal(fresh.unknown(31), true);
    assert.equal(count(r, /\/detail\//), 0); await fresh.reconcile(31); assert.equal(fresh.unknown(31), false);
  } finally { scope?.stop(); r.stop(); }
});

test('clipboard and provider callbacks after closure cannot issue a share or invoke the native provider', async () => {
  for (const kind of ['copy', 'provider']) {
    let callback, native = 0;
    const r = runtime({ feature: 'useCommunityEngagement', send: call => call.url.endsWith('/topic') ? closed : normal(call) });
    try {
      r.uni.setClipboardData = value => { callback = value; };
      r.uni.getProvider = value => { callback = value; }; r.uni.share = () => { native++; };
      await r.checkout.openShare(post()); const pending = kind === 'copy' ? r.checkout.copyShare() : r.checkout.appShare('WXSceneSession');
      await tick(); assert.ok(callback); await closeThroughHttp(r); callback.success({ provider: ['weixin'] }); await pending;
      assert.equal(native, 0); assert.equal(count(r, /\/share\//), 0); assert.equal(r.checkout.sharePost.value, null);
    } finally { callback?.fail?.(); r.stop(); }
  }
});

for (const kind of ['new', 'edit']) test(`${kind} publisher closure rejection is certain and does not replay after recovery`, async () => {
  const r = runtime({ feature: 'useCommunityPublish', send: call => /community_save|community_update/.test(call.url) ? closed : normal(call) });
  try {
    if (kind === 'edit') await r.checkout.loadForEdit(31);
    r.checkout.content.value = '只提交一次'; await r.checkout.publish();
    assert.equal(r.checkout.unknown.value, false); assert.equal(availability(r).closed.value, true);
    assert.equal(r.checkout.content.value, ''); assert.equal(r.checkout.busy.value, false);
    await availability(r).refresh(); await tick(); assert.equal(count(r, /community_save|community_update/), 1);
  } finally { r.stop(); }
});

test('an admitted publisher success and a 503 after separate closure both retain unknown and clear the draft', async () => {
  for (const receipt of [{ data: { id: 31 } }, { ...closed, httpStatus: 503 }]) {
    const waiting = deferred();
    const r = runtime({ feature: 'useCommunityPublish', send: call => call.url.includes('community_save') ? waiting.promise
      : call.url.endsWith('/topic') ? closed : normal(call) });
    try {
      r.checkout.content.value = '草稿'; const pending = r.checkout.publish(); await tick(); await closeThroughHttp(r);
      waiting.resolve(receipt); assert.equal(await pending, null); assert.equal(r.checkout.unknown.value, true);
      assert.equal(r.checkout.content.value, ''); await availability(r).refresh(); await r.checkout.publish();
      assert.equal(count(r, /community_save/), 1);
    } finally { waiting.resolve(receipt); r.stop(); }
  }
});

test('late native selectors and uploaded batch receipts stop at closure and never resume their next file', async () => {
  for (const boundary of ['chooser', 'upload']) {
    const choices = [], uploads = [];
    const r = runtime({ feature: 'useCommunityPublish', send: () => closed });
    try {
      r.uni.chooseImage = input => choices.push(input); r.uni.uploadFile = input => uploads.push(input);
      r.checkout.chooseImages();
      const input = { tempFiles: [{ size: 3 }, { size: 3 }], tempFilePaths: ['/one', '/two'] };
      const pending = boundary === 'upload' ? choices[0].success(input) : null; await tick(); await closeThroughHttp(r);
      if (boundary === 'chooser') await choices[0].success(input);
      else { uploads[0].success({ statusCode: 200, data: JSON.stringify({ status: 200, data: { url: '/api/assets/71', src: '/api/assets/71?preview=1', name: 'one' } }) }); await pending; }
      assert.equal(uploads.length, boundary === 'upload' ? 1 : 0); assert.deepEqual(r.checkout.images.value, []);
      assert.equal(r.checkout.choosing.value, false);
    } finally { r.stop(); }
  }
});

test('comments config closure stops reads, and a refused pending comment releases only its current nonce', async () => {
  const waiting = deferred(); let refuseConfig = true;
  const r = runtime({ feature: 'useCommunityComments', send: call => call.url.endsWith('/config') ? { data: config(refuseConfig ? 0 : 1) }
    : call.url.endsWith('/topic') ? closed : call.url.endsWith('/comment/save') ? waiting.promise : normal(call) });
  try {
    await r.checkout.setContext(31); assert.equal(count(r, /comment\/list/), 0); assert.equal(r.checkout.enabled.value, false);
    refuseConfig = false; await availability(r).refresh(); await r.checkout.refresh();
    r.checkout.text.value = '不重放'; const pending = r.checkout.submit(); await tick();
    waiting.resolve(closed); await pending; assert.equal(r.checkout.unknown.value, false); assert.equal(r.checkout.busy.value, false);
    assert.equal(r.checkout.roots.rows.length, 0); assert.equal(r.checkout.text.value, ''); assert.equal(count(r, /comment\/save/), 1);
  } finally { waiting.resolve(closed); r.stop(); }
});

test('comments unknown remains fenced through total closure and explicit reopen until its manual refresh', async () => {
  const r = runtime({ feature: 'useCommunityComments', send: call => call.url.endsWith('/comment/save') ? { httpStatus: 503, status: 503 }
    : call.url.endsWith('/topic') ? closed : normal(call) });
  try {
    await r.checkout.setContext(31); r.checkout.text.value = '未知'; await r.checkout.submit();
    assert.equal(r.checkout.unknown.value, true); await closeThroughHttp(r); await availability(r).refresh();
    await r.checkout.setContext(31); await r.checkout.submit(); assert.equal(count(r, /comment\/save/), 1);
    assert.equal(r.checkout.unknown.value, true); await r.checkout.refresh(); assert.equal(r.checkout.unknown.value, false);
  } finally { r.stop(); }
});

test('author profiles and social lists clear on closure and their rejected writes remain certain', async () => {
  for (const feature of ['useCommunityAuthor', 'useCommunityPeople']) {
    let refuse = false;
    const r = runtime({ feature, send: call => call.url.includes('/set_interest/') ? closed : refuse ? closed : normal(call) });
    try {
      if (feature === 'useCommunityAuthor') {
        await r.checkout.initialize(22); assert.ok(r.checkout.profile.value); await r.checkout.toggleFollow();
        assert.equal(r.checkout.profile.value, null); assert.deepEqual(r.checkout.posts.value, []);
      } else {
        await r.checkout.initialize({ tab: 'recommend' }); assert.equal(r.checkout.users.value.length, 1);
        await r.checkout.toggleFollow(r.checkout.users.value[0]); assert.deepEqual(r.checkout.users.value, []);
      }
      assert.equal(r.checkout.unknown.value, false); assert.equal(availability(r).closed.value, true);
      assert.equal(count(r, /set_interest/), 1); refuse = true;
    } finally { r.stop(); }
  }
});

for (const mode of ['topic', 'search', 'video']) test(`${mode} entry clears stale content and resumes with reads without a new detail exposure`, async () => {
  let refuse = false;
  const r = runtime({ feature: 'useCommunityDeepLink', send: call => refuse && !call.url.endsWith('/config') ? closed
    : call.url.endsWith('/config') ? { data: config(1) } : call.url.endsWith('/topic') ? { data: [topic] }
    : call.url.endsWith('/list') ? { data: [post(31, { contentType: mode === 'video' ? 2 : 1 })] }
    : { data: post(31, { contentType: 2 }) } }); let scope;
  try {
    scope = vue.effectScope(); const feed = scope.run(() => r.load(path.join(root, 'src/composables/useCommunityDeepLink.ts')).useCommunityDeepLink(mode));
    const query = mode === 'topic' ? { id: '9' } : mode === 'video' ? { id: '31' } : { keyword: '九' };
    await feed.initialize(query); assert.equal(feed.posts.value.length, 1);
    const visits = count(r, /\/detail\//); refuse = true; await api(r).apiCommunityTopics().catch(() => {});
    assert.deepEqual(feed.posts.value, []); assert.equal(feed.activeVideo.value, null);
    refuse = false; await availability(r).refresh(); await feed.recover();
    assert.equal(feed.posts.value.length, 1); assert.equal(count(r, /\/detail\//), visits);
    if (mode === 'video') assert.ok(count(r, /\/state\/31/) >= 2);
  } finally { scope?.stop(); r.stop(); }
});

test('a no-id video recovery reads the first listed video state instead of recording another visit', async () => {
  let refuse = false; const r = runtime({ feature: 'useCommunityDeepLink', send: call => refuse && !call.url.endsWith('/config') ? closed
    : call.url.endsWith('/config') ? { data: config(1) } : { data: call.url.endsWith('/list') ? [post(31, { contentType: 2 })] : post(31, { contentType: 2 }) } }); let scope;
  try {
    scope = vue.effectScope(); const feed = scope.run(() => r.load(path.join(root, 'src/composables/useCommunityDeepLink.ts')).useCommunityDeepLink('video'));
    await feed.initialize({}); assert.equal(count(r, /\/detail\/31/), 1);
    refuse = true; await api(r).apiCommunityTopics().catch(() => {}); refuse = false;
    await availability(r).refresh(); await feed.recover(); assert.equal(count(r, /\/detail\/31/), 1); assert.equal(count(r, /\/state\/31/), 1);
  } finally { scope?.stop(); r.stop(); }
});

test('actual main page recovers its selected detail through state and never visits it again', async () => {
  let refuse = false;
  const r = runtime({ component: 'pages/discover/index.vue', send: call => refuse && !call.url.endsWith('/config') ? closed : normal(call) });
  try {
    await r.start({ id: '31' }); assert.equal(r.checkout.detail.value.id, 31); assert.equal(count(r, /\/detail\/31/), 1);
    refuse = true; await api(r).apiCommunityTopics().catch(() => {}); assert.equal(r.checkout.detail.value, null);
    assert.equal(r.checkout.showPublish.value, false); refuse = false; await r.checkout.recoverCommunity();
    assert.equal(r.checkout.detail.value.id, 31); assert.equal(count(r, /\/detail\/31/), 1); assert.equal(count(r, /\/state\/31/), 1);
  } finally { r.stop(); }
});

test('invalid canonical routes remain local even when availability was already closed', async () => {
  const r = runtime({ component: 'pages/discover/index.vue', send: () => { throw Error('Invalid route I/O'); } });
  try {
    availability(r).close(); await r.start({ publish: '1', topic_id: '00' });
    await r.checkout.recoverCommunity(); assert.deepEqual(r.calls, []); assert.match(r.checkout.routeError.value, /无效/);
  } finally { r.stop(); }
});

test('invalid deep routes and raw bridges cannot use availability recovery to trigger config I/O', async () => {
  const r = runtime({ feature: 'useCommunityDeepLink', send: () => { throw Error('Invalid route I/O'); } });
  try {
    availability(r).close(); await r.checkout.initialize({ id: '00' });
    assert.equal(r.checkout.routeValid.value, false); assert.deepEqual(r.calls, []);
  } finally { r.stop(); }
  const raw = runtime({ component: 'pages/discover/discoverCreate/index.vue', send: () => { throw Error('Bridge I/O'); } });
  try { availability(raw).close(); await raw.start({ id: '31' }); assert.deepEqual(raw.calls, []); assert.equal(raw.navigations[0], '/pages/discover/workspace?publish=1&edit_id=31'); }
  finally { raw.stop(); }
});

test('fresh guest publish and edit entries check config after validation before choosing any login destination', async () => {
  for (const edit of [false, true]) for (const mode of ['closed', 'open', 'already-closed']) {
    const r = runtime({ component: 'pages/discover/index.vue', authenticated: false,
      send: call => call.url.endsWith('/config') ? { data: config(mode === 'open' ? 1 : 0) } : normal(call) });
    try {
      assert.equal(r.auth.isLoggedIn, false);
      if (mode === 'already-closed') availability(r).close();
      await r.start({ publish: '1', ...(edit ? { edit_id: '31' } : { topic_id: '9' }) });
      assert.deepEqual(r.navigations, mode === 'open' ? ['/pages/auth/login'] : []);
      assert.equal(count(r, /\/config$/), mode === 'already-closed' ? 0 : 1);
      assert.equal(r.calls.filter(row => !row.url.endsWith('/config')).length, 0);
      assert.equal(r.checkout.showPublish.value, false); assert.equal(r.auth.isLoggedIn, false);
    } finally { r.stop(); }
  }
  const invalid = runtime({ component: 'pages/discover/index.vue', authenticated: false, send: () => { throw Error('Invalid guest I/O'); } });
  try { await invalid.start({ publish: '1', topic_id: '00' }); assert.deepEqual(invalid.calls, []); assert.deepEqual(invalid.navigations, []); }
  finally { invalid.stop(); }
});

test('a delayed guest availability result cannot navigate after owner, hide or unload boundaries', async () => {
  for (const boundary of ['owner', 'hide', 'unload']) {
    const waiting = deferred(); const r = runtime({ component: 'pages/discover/index.vue', authenticated: false,
      send: call => call.url.endsWith('/config') ? waiting.promise : normal(call) });
    try {
      await r.start({ publish: '1' }); assert.equal(count(r, /\/config$/), 1); assert.deepEqual(r.navigations, []);
      if (boundary === 'owner') r.auth.setLogin('new-account', 22); else r.hooks[boundary === 'hide' ? 'onHide' : 'onUnload']();
      waiting.resolve({ data: config(1) }); await tick();
      assert.deepEqual(r.navigations, []); assert.equal(r.checkout.showPublish.value, false);
    } finally { waiting.resolve({ data: config(1) }); r.stop(); }
  }
});

test('late recovery state failures cannot repaint a new detail, owner or hidden main and deep page', async () => {
  for (const component of ['pages/discover/index.vue', 'components/community/CommunityDeepLinkFeed.vue'])
    for (const boundary of ['detail', 'owner', 'hide']) {
      const waiting = deferred(); let refuse = false, recovering = false;
      const r = runtime({ component, props: { mode: 'topic', query: { id: '9' } }, send: call => refuse && !call.url.endsWith('/config') ? closed
        : recovering && call.url.endsWith('/state/31') ? waiting.promise : normal(call) });
      try {
        if (component.startsWith('pages/')) await r.start({ id: '31' });
        else { await r.checkout.feed.initialize({ id: '9' }); await r.checkout.openPost(post()); }
        refuse = true; await api(r).apiCommunityTopics().catch(() => {}); refuse = false; recovering = true;
        const pending = r.checkout.recoverCommunity(); await tick(); assert.equal(count(r, /\/state\/31/), 1);
        if (boundary === 'owner') r.auth.setLogin('replacement', 22);
        else if (boundary === 'hide') r.hooks.onHide();
        else if (component.startsWith('pages/')) await r.checkout.openDetail(32);
        else await r.checkout.openPost(post(32));
        waiting.resolve({ httpStatus: 503, status: 503, msg: 'old recovery failure' }); await pending;
        assert.equal(r.checkout.detailError.value, '');
        assert.equal(r.checkout.detail.value?.id ?? null, boundary === 'detail' ? 32 : null);
      } finally { waiting.resolve({ httpStatus: 503, status: 503 }); r.stop(); }
    }
});

test('selecting another post during a main recovery feed read cancels restoration of the previous detail', async () => {
  const waiting = deferred(); let refuse = false, recovering = false;
  const r = runtime({ component: 'pages/discover/index.vue', send: call => refuse && !call.url.endsWith('/config') ? closed
    : recovering && call.url.endsWith('/list') ? waiting.promise : normal(call) });
  try {
    await r.start({ id: '31' }); refuse = true; await api(r).apiCommunityTopics().catch(() => {}); refuse = false; recovering = true;
    const pending = r.checkout.recoverCommunity(); await tick(); await r.checkout.openDetail(32);
    waiting.resolve({ data: [post()] }); await pending;
    assert.equal(r.checkout.detail.value.id, 32); assert.equal(count(r, /\/state\/31/), 0);
  } finally { waiting.resolve({ data: [] }); r.stop(); }
});
