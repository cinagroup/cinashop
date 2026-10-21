const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
const person = (id = 22, extra = {}) => ({ id, type: 2, relation_id: id, author: `作者${id}`, author_image: '',
  desc: '', community_num: 3, fans_num: 7, follow_num: 0, friend_num: 0, like_num: 0,
  is_follow: 0, is_fans: 0, ...extra });
const twenty = (start = 22) => Array.from({ length: 20 }, (_, i) => person(start + i));
const isWrite = call => call.url.includes('/set_interest/');
const setup = send => runtime({ feature: 'useCommunityPeople', send: send ?? (() => ({ data: [person()] })) });
async function initialized(r, query = {}) { await r.start(); await r.checkout.initialize(query); return r.checkout; }

test('actual H5 navigation preserves the three PHP list selectors without forwarding private query values', () => {
  const r = setup();
  try {
    const navigation = r.load(path.resolve(__dirname, '../src/config/navigation.ts'));
    for (const [type, tab] of [['0', 'follow'], ['1', 'friend'], ['2', 'fans']]) {
      assert.equal(navigation.resolveRegisteredPageRoute('/pages/discover/discoverFollow/index', `type=${type}&token=PRIVATE&uid=44`),
        `/pages/discover/people?tab=${tab}`);
    }
    assert.equal(navigation.resolveRegisteredPageRoute('/pages/discover/discoverFollow/index', 'type=0&tab=fans'), '');
  } finally { r.stop(); }
});

test('the four real APIs retain exact tab/page contracts and PHP legacy numeric selectors', async () => {
  const r = setup();
  try {
    const p = await initialized(r, { type: '0' });
    assert.equal(p.activeTab.value, 'follow');
    await p.changeTab('fans'); await p.changeTab('recommend'); await p.changeTab('friend');
    assert.deepEqual(r.calls.map(call => call.url), ['/api/community/follow_list/follow', '/api/community/follow_list/fans',
      '/api/community/recommend_list', '/api/community/user_friend']);
    for (const call of r.calls) assert.deepEqual(call.data, { page: 1, limit: 20 });
    await p.initialize({ type: '2' }); assert.equal(p.activeTab.value, 'fans');
    const before = r.calls.length;
    await p.initialize({ type: '0', tab: 'follow' }); assert.match(p.error.value, /链接无效/);
    assert.equal(r.calls.length, before); assert.deepEqual(p.users.value, []);
  } finally { r.stop(); }
});

test('failed pagination retries the same page and deduplicates within and across pages', async () => {
  let fail = true;
  const r = setup(call => call.data.page === 1 ? { data: twenty() }
    : fail ? (fail = false, { transport: '离线' }) : { data: [person(41), person(42), person(42)] });
  try {
    const p = await initialized(r); await p.loadMore();
    assert.match(p.error.value, /离线/); assert.equal(p.page.value, 1); assert.equal(p.users.value.length, 20);
    assert.equal(p.finished.value, false); await p.retry();
    assert.deepEqual(r.calls.slice(-2).map(call => call.data), [{ page: 2, limit: 20 }, { page: 2, limit: 20 }]);
    assert.equal(p.page.value, 2); assert.equal(p.users.value.length, 21); assert.equal(p.finished.value, true);
    assert.equal(p.error.value, ''); await p.loadMore(); assert.equal(r.calls.length, 3);
  } finally { r.stop(); }
});

test('ID-only author APIs reject unsupported typed identities before committing any list or exposing an action', async () => {
  for (const row of [person(22, { type: 1 }), person(22, { type: 3 }), person(22, { type: 0 }),
    person(0), person(0, { type: 1 }), person(0, { type: 3 })]) {
    const r = setup(() => ({ data: [person(23), row] }));
    try {
      const p = await initialized(r);
      assert.match(p.error.value, /作者身份|格式错误/); assert.deepEqual(p.users.value, []);
      assert.equal(p.page.value, 0); assert.equal(p.finished.value, false);
      p.openAuthor(row); await p.toggleFollow(row); await p.confirmUnfollow();
      assert.equal(r.navigations.length, 0); assert.equal(r.calls.filter(isWrite).length, 0);
    } finally { r.stop(); }
  }
});

test('pagination continues past page one thousand and respects the actual service ceiling without allocating large data', async () => {
  const r = setup(() => ({ data: twenty() }));
  try {
    const p = await initialized(r);
    p.page.value = 1000; await p.loadMore();
    assert.deepEqual(r.calls.at(-1).data, { page: 1001, limit: 20 });
    assert.equal(p.finished.value, false);
    p.page.value = 999999; await p.loadMore();
    assert.deepEqual(r.calls.at(-1).data, { page: 1000000, limit: 20 });
    assert.equal(p.finished.value, true);
    const before = r.calls.length; await p.loadMore(); assert.equal(r.calls.length, before);
  } finally { r.stop(); }
});

test('a cross-page type collision fails atomically and retries the exact page instead of silently merging author identities', async () => {
  let repaired = false;
  const r = setup(call => ({ data: call.data.page === 1 ? twenty()
    : repaired ? [person(41), person(42)] : [person(90), person(22, { type: 3 })] }));
  try {
    const p = await initialized(r); await p.loadMore();
    assert.match(p.error.value, /作者身份/); assert.equal(p.page.value, 1);
    assert.equal(p.users.value.length, 20); assert.equal(p.finished.value, false);
    assert.equal(p.users.value.some(row => row.relation_id === 90), false);
    p.openAuthor(person(22, { type: 3 })); await p.toggleFollow(person(22, { type: 3 }));
    assert.equal(r.navigations.length, 0); assert.equal(r.calls.filter(isWrite).length, 0);
    repaired = true; await p.retry();
    assert.deepEqual(r.calls.slice(-2).map(call => call.data), [{ page: 2, limit: 20 }, { page: 2, limit: 20 }]);
    assert.equal(p.page.value, 2); assert.equal(p.users.value.length, 21); assert.equal(p.error.value, '');
  } finally { r.stop(); }
});

test('action guards reject noncanonical current rows even when a caller bypasses the response decoder', async () => {
  const r = setup();
  try {
    const p = await initialized(r);
    for (const row of [person(22, { type: 3 }), person(22, { type: 1 }), person(22, { type: 0 }), person(0)]) {
      p.users.value = [row]; p.openAuthor(row); await p.toggleFollow(row); await p.confirmUnfollow();
    }
    assert.equal(r.navigations.length, 0); assert.equal(r.calls.filter(isWrite).length, 0);
    assert.equal(p.confirmUid.value, null);
  } finally { r.stop(); }
});

test('tab switches replace a pending read immediately and old success or failure cannot clear the new loading state', async () => {
  for (const oldResult of [{ data: [person(90)] }, { transport: '旧标签离线' }]) {
    const old = deferred(), next = deferred();
    const r = setup(call => call.url.endsWith('/user_friend') ? old.promise : next.promise);
    try {
      await r.start(); const p = r.checkout, first = p.initialize(); await tick();
      const second = p.changeTab('fans'); await tick(); assert.equal(r.calls.length, 2);
      old.resolve(oldResult); await first;
      assert.equal(p.activeTab.value, 'fans'); assert.deepEqual(p.users.value, []);
      assert.equal(p.loading.value, true); assert.equal(p.error.value, '');
      next.resolve({ data: [person(23, { is_fans: 1 })] }); await second;
      assert.equal(p.users.value[0].relation_id, 23); assert.equal(p.loading.value, false);
    } finally { r.stop(); }
  }
});

test('account epochs hide unload and new route selection fence late private responses', async () => {
  for (const boundary of ['account', 'same-credentials', 'hide', 'unload', 'route']) {
    const old = deferred(), next = deferred(); let count = 0;
    const r = setup(() => ++count === 1 ? old.promise : next.promise);
    try {
      await r.start(); const p = r.checkout, first = p.initialize(); await tick();
      if (boundary === 'account') r.auth.setLogin('new-token', 44);
      else if (boundary === 'same-credentials') r.auth.setLogin('synthetic-local-token', 11);
      else if (boundary === 'hide') r.hooks.onHide();
      else if (boundary === 'unload') r.hooks.onUnload();
      const replacement = boundary === 'route' ? p.initialize({ tab: 'recommend' })
        : boundary === 'account' || boundary === 'same-credentials' ? p.refresh() : undefined;
      if (boundary === 'hide') r.hooks.onShow();
      await tick(); old.resolve({ data: [person(90, { author: '旧账号私有资料' })] }); await first;
      assert.equal(p.users.value.some(row => row.author === '旧账号私有资料'), false);
      if (boundary === 'unload') { r.hooks.onShow(); await p.refresh(); assert.equal(r.calls.length, 1); }
      else { next.resolve({ data: [person(23)] }); await replacement; await tick(); assert.equal(p.users.value[0].relation_id, 23); }
    } finally { r.stop(); }
  }
});

test('labels distinguish following mutual follow and follow-back; own and platform author navigation use exact identities', async () => {
  const r = setup(() => ({ data: [person(11), person(0, { type: 0 }), person(22, { is_fans: 1 }),
    person(23, { is_follow: 1 }), person(24, { is_follow: 1, is_fans: 1 })] }));
  try {
    const p = await initialized(r);
    assert.deepEqual(p.users.value.map(p.followLabel), ['你自己', '关注', '回关', '已关注', '互相关注']);
    await p.toggleFollow(p.users.value[0]); assert.equal(r.calls.length, 1);
    p.openSelf(); assert.equal(r.navigations.at(-1), '/pages/discover/workspace?author_id=11');
    p.openAuthor(p.users.value[1]); assert.equal(r.navigations.at(-1), '/pages/discover/workspace?author_id=0');
    p.openAuthor(person(999)); assert.equal(r.navigations.length, 2);
  } finally { r.stop(); }
});

test('unfollow uses cancellable inline intent and posts one explicit target/status despite duplicate clicks', async () => {
  const gate = deferred(); let followed = true;
  const r = setup(call => isWrite(call) ? gate.promise
    : { data: [person(22, { is_follow: followed ? 1 : 0, is_fans: 1 })] });
  try {
    const p = await initialized(r, { tab: 'fans' }); await p.toggleFollow(p.users.value[0]);
    assert.equal(p.confirmUid.value, 22); assert.equal(r.calls.length, 1); assert.equal(r.modals.length, 0);
    p.cancelUnfollow(); await p.confirmUnfollow(); assert.equal(r.calls.length, 1);
    await p.toggleFollow(p.users.value[0]); const first = p.confirmUnfollow(); await tick();
    await p.confirmUnfollow(); await p.toggleFollow(p.users.value[0]);
    assert.equal(r.calls.filter(isWrite).length, 1); assert.equal(p.busyUid.value, 22);
    followed = false; gate.resolve({ data: { status: 0, is_follow: 0, is_fans: 1 } }); await first;
    assert.deepEqual(r.calls.find(isWrite), { url: '/api/community/set_interest/22', data: { status: 0 } });
    assert.equal(p.users.value[0].is_follow, 0); assert.equal(p.page.value, 1); assert.match(p.message.value, /已取消关注/);
  } finally { r.stop(); }
});

test('expired refreshed or replaced-account inline intents cannot select a different write', async () => {
  for (const boundary of ['expiry', 'refresh', 'account', 'tab']) {
    const r = setup(() => ({ data: [person(22, { is_follow: 1 })] }));
    const clock = Date.now;
    try {
      const p = await initialized(r); await p.toggleFollow(p.users.value[0]);
      if (boundary === 'expiry') { const then = clock(); Date.now = () => then + 60001; }
      else if (boundary === 'refresh') await p.refresh();
      else if (boundary === 'account') r.auth.setLogin('another', 44);
      else await p.changeTab('follow');
      await p.confirmUnfollow(); assert.equal(r.calls.filter(isWrite).length, 0);
      assert.equal(p.confirmUid.value, null);
    } finally { Date.now = clock; r.stop(); }
  }
});

test('unknown writes clear data and cannot replay through clicks route initialization or lifecycle until manual reread succeeds', async () => {
  for (const failure of [{ transport: '网络断开' }, { httpStatus: 503, status: 503 }, { data: { status: 0, is_follow: 0, is_fans: 0 } }]) {
    let followed = false;
    const r = setup(call => isWrite(call) ? (followed = true, failure)
      : { data: [person(22, { is_follow: followed ? 1 : 0 })] });
    try {
      const p = await initialized(r), row = p.users.value[0]; await p.toggleFollow(row);
      assert.equal(p.unknown.value, true); assert.deepEqual(p.users.value, []);
      await p.toggleFollow(row); await p.loadMore(); await p.initialize({ tab: 'fans' });
      r.hooks.onHide(); r.hooks.onShow(); await tick();
      assert.equal(r.calls.length, 2); assert.equal(r.calls.filter(isWrite).length, 1);
      await p.refresh(); assert.equal(p.unknown.value, false); assert.equal(p.users.value[0].is_follow, 1);
      assert.match(p.message.value, /已刷新/); assert.equal(r.calls.filter(isWrite).length, 1);
    } finally { r.stop(); }
  }
});

test('hidden in-flight writes retain an uncertain outcome and account-switched writes never update the replacement session', async () => {
  for (const boundary of ['hide', 'account']) {
    const gate = deferred(); let followed = false;
    const r = setup(call => isWrite(call) ? gate.promise : { data: [person(22, { is_follow: followed ? 1 : 0 })] });
    try {
      const p = await initialized(r), first = p.toggleFollow(p.users.value[0]); await tick();
      if (boundary === 'hide') { r.hooks.onHide(); r.hooks.onShow(); assert.equal(p.unknown.value, true); }
      else { r.auth.setLogin('replacement', 44); await p.refresh(); }
      followed = true; gate.resolve({ data: { status: 1, is_follow: 1, is_fans: 0 } }); await first;
      if (boundary === 'hide') {
        assert.deepEqual(p.users.value, []); assert.equal(p.unknown.value, true);
        await p.refresh(); assert.equal(p.users.value[0].is_follow, 1); assert.equal(p.unknown.value, false);
      } else { assert.equal(p.users.value[0].is_follow, 0); assert.equal(p.message.value, ''); assert.equal(p.unknown.value, false); }
      assert.equal(r.calls.filter(isWrite).length, 1);
    } finally { r.stop(); }
  }
});

test('server rejection preserves the view and platform ID zero still participates in the write lock', async () => {
  const gate = deferred();
  const r = setup(call => isWrite(call) ? gate.promise : { data: [person(0, { type: 0 })] });
  try {
    const p = await initialized(r), first = p.toggleFollow(p.users.value[0]); await tick();
    assert.equal(p.busy.value, true); assert.equal(p.busyUid.value, 0);
    await p.toggleFollow(p.users.value[0]); assert.equal(r.calls.filter(isWrite).length, 1);
    gate.resolve({ status: 400, msg: '作者不可关注' }); await first;
    assert.equal(p.unknown.value, false); assert.equal(p.users.value.length, 1); assert.match(p.error.value, /不可关注/);
  } finally { r.stop(); }
});

test('membership-changing writes reset canonical pagination before reading any next offset', async () => {
  let version = 0;
  const r = setup(call => isWrite(call) ? (version++, { data: { status: 1, is_follow: 1, is_fans: 0 } })
    : { data: call.data.page === 1 ? twenty(22 + version) : [person(90)] });
  try {
    const p = await initialized(r, { tab: 'recommend' }); await p.loadMore(); assert.equal(p.page.value, 2);
    await p.toggleFollow(p.users.value[0]);
    assert.equal(p.page.value, 1); assert.equal(p.users.value[0].relation_id, 23);
    assert.deepEqual(r.calls.at(-1).data, { page: 1, limit: 20 });
    await p.loadMore(); assert.deepEqual(r.calls.at(-1).data, { page: 2, limit: 20 });
  } finally { r.stop(); }
});

test('malformed lists expose a recoverable error and logout suppresses every private request', async () => {
  const r = setup(() => ({ data: [{ ...person(), is_follow: '1' }] }));
  try {
    const p = await initialized(r); assert.match(p.error.value, /格式错误/); assert.deepEqual(p.users.value, []);
    assert.equal(p.finished.value, false); await p.retry(); assert.equal(r.calls.length, 2);
    r.auth.clear(); const before = r.calls.length; await p.refresh(); await p.loadMore();
    assert.equal(r.calls.length, before); assert.match(p.error.value, /先登录/); p.openSelf();
    assert.equal(r.navigations.at(-1), '/pages/auth/login');
  } finally { r.stop(); }
});

test('the actual people page wires legacy entry loadmore inline cancellation and author navigation through real APIs', async () => {
  let followed = true;
  const r = runtime({ component: 'pages/discover/people.vue', send: call => isWrite(call)
    ? (followed = false, { data: { status: 0, is_follow: 0, is_fans: 1 } })
    : { data: [person(22, { is_follow: followed ? 1 : 0, is_fans: 1 })] } });
  try {
    await r.start({ type: '2' }); const p = r.checkout;
    assert.equal(p.activeTab.value, 'fans'); assert.equal(r.calls[0].url, '/api/community/follow_list/fans');
    p.openAuthor(p.users.value[0]); assert.equal(r.navigations.at(-1), '/pages/discover/workspace?author_id=22');
    await p.toggleFollow(p.users.value[0]); p.cancelUnfollow(); assert.equal(r.calls.filter(isWrite).length, 0);
    await p.toggleFollow(p.users.value[0]); await p.confirmUnfollow();
    assert.equal(p.followLabel(p.users.value[0]), '回关'); assert.equal(r.modals.length, 0);
    await r.hooks.onReachBottom(); assert.equal(r.calls.length, 3);
    p.openSelf(); assert.equal(r.navigations.at(-1), '/pages/discover/workspace?author_id=11');
  } finally { r.stop(); }
});
