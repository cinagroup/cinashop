const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vue = require('vue');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
const flags = { community_status: 1, community_comment_status: 1, community_comment_add: 1 };
const row = (id = 101, values = {}) => ({ id, communityId: 31, type: 2, uid: 22, content: `评论${id}`, isDel: 0,
  addTime: 1786710800, replyId: 0, commentReplyId: 0, isReply: 1, isShow: 1, isVerify: 1,
  likeNum: 0, isLike: 0, author: '作者22', author_image: '', comment_author: '', comment_author_type: null,
  comment_author_uid: null, reply_count: 0, ...values });
const ten = (start = 101, values = {}) => Array.from({ length: 10 }, (_, i) => row(start + i, values));
const page = (list = [row()], count = list.length, total = count) => ({ list, count, post_comment_num: total });
const writes = r => r.calls.filter(call => /comment\/(?:save)|comment_like|comment_delete/.test(call.url));
function setup(send = () => ({ data: page() })) {
  return runtime({ feature: 'useCommunityComments', send: call => call.url.endsWith('/community/config') ? { data: flags } : send(call) });
}
async function start(r, post = 31, writable = true) { await r.start(); await r.checkout.setContext(post, writable); return r.checkout; }

test('actual paged API keeps independent root/reply counts and the authoritative whole-post total', async () => {
  const r = setup(call => ({ data: call.data.reply_id ? page([row(301, { isReply: 0, replyId: 101, comment_author: '根作者' })], 1, 77)
    : page([row(101, { reply_count: 1 })], 1, 77) }));
  try {
    const c = await start(r); assert.equal(c.roots.count, 1); assert.deepEqual(c.countUpdate.value, { postId: 31, count: 77 });
    await c.toggleReplies(c.roots.rows[0]); assert.equal(c.replies.get(101).count, 1);
    assert.deepEqual(r.calls.slice(1).map(x => x.data), [0, 101].map(reply_id => ({ community_id: 31, page: 1, limit: 10, reply_id })));
    assert.equal(c.countUpdate.value.count, 77);
  } finally { r.stop(); }
});

test('root pagination failure preserves earlier rows, retries exactly and deduplicates without replacing totals', async () => {
  let fail = true; const r = setup(call => call.data.page === 1 ? { data: page(ten(), 12, 40) }
    : fail ? (fail = false, { transport: '第二页离线' }) : { data: page([row(110), row(111)], 12, 40) });
  try {
    const c = await start(r); await c.loadMore(); assert.equal(c.roots.page, 1); assert.equal(c.roots.rows.length, 10);
    assert.match(c.roots.error, /第二页离线/); await c.loadMore(); assert.equal(c.roots.rows.length, 11);
    assert.deepEqual(r.calls.slice(-2).map(x => x.data.page), [2, 2]); assert.equal(c.roots.count, 12);
    assert.equal(c.countUpdate.value.count, 40); assert.equal(c.roots.finished, true);
  } finally { r.stop(); }
});

test('reply pagination retries its own exact page and collapse fences a late response', async () => {
  let fail = true; const old = deferred();
  const r = setup(call => !call.data.reply_id ? { data: page([row(101, { reply_count: 12 })], 1, 13) }
    : call.data.page === 1 ? { data: page(ten(301, { isReply: 0, replyId: 101 }), 12, 13) }
      : fail ? (fail = false, { transport: '回复离线' }) : old.promise);
  try {
    const c = await start(r); await c.toggleReplies(c.roots.rows[0]); await c.moreReplies(101);
    assert.match(c.replies.get(101).error, /回复离线/); assert.equal(c.replies.get(101).page, 1);
    const pending = c.moreReplies(101); await tick(); await c.toggleReplies(c.roots.rows[0]);
    old.resolve({ data: page([row(311, { isReply: 0, replyId: 101 })], 12, 13) }); await pending;
    assert.equal(c.replies.get(101).expanded, false); assert.deepEqual(c.replies.get(101).rows, []);
    assert.deepEqual(r.calls.slice(-2).map(x => x.data), [1, 2].map(() => ({ community_id: 31, page: 2, limit: 10, reply_id: 101 })));
    assert.equal(c.roots.rows.length, 1);
  } finally { old.resolve({ data: page([]) }); r.stop(); }
});

test('late root and settings reads cannot restore content after route, auth or visibility boundaries', async () => {
  for (const boundary of ['post', 'account', 'version', 'hide', 'unload']) {
    const old = deferred(), r = setup(call => call.data.community_id === 31 ? old.promise : { data: page([row(202, { communityId: 32 })]) });
    try {
      await r.start(); const c = r.checkout, pending = c.setContext(31); await tick();
      if (boundary === 'post') await c.setContext(32);
      else if (boundary === 'account') r.auth.setLogin('other', 22);
      else if (boundary === 'version') r.auth.setLogin(r.auth.token, r.auth.uid);
      else r.hooks[boundary === 'hide' ? 'onHide' : 'onUnload']();
      old.resolve({ data: page([row()]) }); await pending;
      assert.equal(c.roots.rows.some(x => x.id === 101), false); assert.notEqual(c.countUpdate.value?.postId, 31);
    } finally { old.resolve({ data: page([]) }); r.stop(); }
  }
  const old = deferred(); let first = true;
  const r = runtime({ feature: 'useCommunityComments', send: call => call.url.endsWith('/config')
    ? first ? (first = false, old.promise) : { data: flags } : { data: page([row(202, { communityId: 32 })]) } });
  try { await r.start(); const work = r.checkout.setContext(31); await tick(); await r.checkout.setContext(32);
    old.resolve({ data: { ...flags, community_comment_status: 0 } }); await work; assert.equal(r.checkout.enabled.value, true);
  } finally { old.resolve({ data: flags }); r.stop(); }
});

test('own approved hidden comments remain readable/deletable and never become like/reply targets', async () => {
  const hidden = row(101, { uid: 11, isShow: 0, reply_count: 1 });
  const r = setup(call => ({ data: call.data?.reply_id ? page([row(301, { uid: 11, isShow: 0, isReply: 0, replyId: 101 })], 1, 0) : page([hidden], 1, 0) }));
  try {
    const c = await start(r); c.replyTo(c.roots.rows[0]); await c.toggleLike(c.roots.rows[0]); assert.equal(c.target.value, null);
    await c.toggleReplies(c.roots.rows[0]); assert.equal(c.replies.get(101).rows.length, 1);
    c.requestDelete(c.replies.get(101).rows[0]); assert.equal(c.deleteId.value, 301); assert.equal(writes(r).length, 0);
  } finally { r.stop(); }
  const other = setup(() => ({ data: page([row(101, { isShow: 0 })]) }));
  try { const c = await start(other); assert.deepEqual(c.roots.rows, []); assert.match(c.roots.error, /不可见/); }
  finally { other.stop(); }
});

test('root and child reply submission send the actual selected target and preserve authoritative totals', async () => {
  const r = setup(call => call.url.endsWith('/save') ? { data: { id: 901, is_verify: 1, post_comment_num: 33 } }
    : { data: call.data.reply_id ? page([row(301, { isReply: 0, replyId: 101 })], 1, 33) : page([row(101, { reply_count: 1 })], 1, 33) });
  try {
    const c = await start(r); c.replyTo(c.roots.rows[0]); c.text.value = ' 回复根 '; await c.submit();
    assert.deepEqual(writes(r)[0].data, { community_id: 31, content: '回复根', comment_reply_id: 101 });
    await c.toggleReplies(c.roots.rows[0]); c.replyTo(c.replies.get(101).rows[0]); c.text.value = '回复子评论'; await c.submit();
    assert.equal(writes(r)[1].data.comment_reply_id, 301); assert.equal(c.countUpdate.value.count, 33);
    assert.equal(c.text.value, ''); assert.equal(c.target.value, null); assert.equal(c.roots.rows.length, 1);
  } finally { r.stop(); }
});

test('content enforces the real 1000 UTF16 bound and control characters before any POST', async () => {
  const r = setup(call => call.url.endsWith('/save') ? { data: { id: 901, is_verify: 0, post_comment_num: 0 } } : { data: page([], 0, 0) });
  try {
    const c = await start(r); for (const content of ['', '字'.repeat(1001), '🙂'.repeat(501), '错误\u0001']) {
      c.text.value = content; await c.submit(); assert.equal(writes(r).length, 0);
    }
    c.text.value = '🙂'.repeat(500); await c.submit(); assert.equal(writes(r).length, 1);
    assert.match(c.message.value, /等待审核/); assert.equal(c.countUpdate.value.count, 0); assert.equal(c.roots.rows.length, 0);
  } finally { r.stop(); }
});

test('explicit like/unlike acknowledgements are authoritative and duplicate pending clicks cannot toggle twice', async () => {
  const pending = deferred(); const r = setup(call => call.url.includes('comment_like') ? pending.promise : { data: page() });
  try {
    const c = await start(r); const work = c.toggleLike(c.roots.rows[0]); await tick(); await c.toggleLike(c.roots.rows[0]);
    assert.equal(writes(r).length, 1); assert.deepEqual(writes(r)[0].data, { status: 1 });
    pending.resolve({ data: { likeNum: 17, status: 1 } }); await work; assert.equal(c.roots.rows[0].likeNum, 17);
    // Resolve the same promise shape for a desired unlike: it is deliberately malformed and locks the view.
    await c.toggleLike(c.roots.rows[0]); assert.deepEqual(writes(r)[1].data, { status: 0 }); assert.equal(c.unknown.value, true);
  } finally { pending.resolve({ data: { likeNum: 1, status: 1 } }); r.stop(); }
});

test('known rejection preserves editable draft and list; unknown create/like/delete requires a successful explicit reread', async () => {
  const rejected = setup(call => call.url.endsWith('/save') ? { status: 400, msg: '评论发布关闭' } : { data: page() });
  try { const c = await start(rejected); c.text.value = '保留的草稿'; await c.submit();
    assert.equal(c.unknown.value, false); assert.equal(c.text.value, '保留的草稿'); assert.equal(c.roots.rows.length, 1); assert.match(c.error.value, /关闭/);
  } finally { rejected.stop(); }
  for (const operation of ['create', 'like', 'delete']) for (const response of [{ transport: '断线' }, { httpStatus: 503, status: 503 }, { data: {} }]) {
    let readFails = false; const r = setup(call => /comment\/(?:save)|comment_like|comment_delete/.test(call.url) ? response
      : readFails ? { transport: '刷新失败' } : { data: page([row(101, { uid: 11 })]) });
    try {
      const c = await start(r); const run = async () => { if (operation === 'create') { c.text.value = '唯一评论'; await c.submit(); }
        else if (operation === 'like') await c.toggleLike(c.roots.rows[0] ?? row());
        else { c.requestDelete(c.roots.rows[0] ?? row(101, { uid: 11 })); await c.confirmDelete(); } };
      await run(); assert.equal(c.unknown.value, true, operation); assert.deepEqual(c.roots.rows, []); assert.equal(c.text.value, '');
      await run(); assert.equal(writes(r).length, 1); await c.setContext(0); await c.setContext(31); assert.equal(c.unknown.value, true);
      readFails = true; await c.refresh(); assert.equal(c.unknown.value, true);
      readFails = false; await c.refresh(); assert.equal(c.unknown.value, false); assert.equal(writes(r).length, 1);
    } finally { r.stop(); }
  }
});

test('unresolved operation markers survive actual composable destruction without retaining a draft', async () => {
  const r = setup(call => call.url.endsWith('/save') ? { httpStatus: 503, status: 503 } : { data: page() });
  let scope;
  try {
    const c = await start(r); c.text.value = '不能自动重发'; await c.submit(); c.dispose();
    const module = r.load(path.resolve(__dirname, '../src/composables/useCommunityComments.ts'));
    scope = vue.effectScope(); const replacement = scope.run(() => module.useCommunityComments());
    const before = r.calls.length; await replacement.setContext(31); assert.equal(r.calls.length, before);
    assert.equal(replacement.unknown.value, true); assert.equal(replacement.text.value, '');
    await replacement.refresh(); assert.equal(replacement.unknown.value, false); assert.equal(writes(r).length, 1);
  } finally { scope?.stop(); r.stop(); }
});

test('late writes cannot update a new post, release a replacement account lock or replay after hide', async () => {
  for (const boundary of ['post', 'account', 'version', 'hide', 'unload']) {
    const old = deferred(); const r = setup(call => call.url.endsWith('/save') ? old.promise : { data: page([row(101, { communityId: call.data.community_id })]) });
    try {
      const c = await start(r); c.text.value = '旧评论'; const work = c.submit(); await tick();
      if (boundary === 'post') await c.setContext(32);
      else if (boundary === 'account') r.auth.setLogin('other', 22);
      else if (boundary === 'version') r.auth.setLogin(r.auth.token, r.auth.uid);
      else r.hooks[boundary === 'hide' ? 'onHide' : 'onUnload']();
      old.resolve({ data: { id: 901, is_verify: 1, post_comment_num: 99 } }); await work;
      assert.notEqual(c.countUpdate.value?.count, 99); assert.equal(c.text.value, ''); assert.equal(c.message.value, '');
      assert.equal(writes(r).length, 1); assert.equal(c.busy.value, false);
    } finally { old.resolve({ data: { id: 901, is_verify: 1, post_comment_num: 99 } }); r.stop(); }
  }
});

test('delete intent is exact, owned, expiring and invalidated by refresh; cancellation performs no write or modal', async () => {
  const r = setup(call => call.url.includes('comment_delete') ? { data: null } : { data: page([row(101, { uid: 11 }), row(102)]) });
  const now = Date.now;
  try {
    const c = await start(r); c.requestDelete(c.roots.rows[1]); assert.equal(c.deleteId.value, null);
    c.requestDelete(c.roots.rows[0]); c.cancelDelete(); await c.confirmDelete(); assert.equal(writes(r).length, 0);
    c.requestDelete(c.roots.rows[0]); Date.now = () => now() + 60001; await c.confirmDelete(); Date.now = now; assert.equal(writes(r).length, 0);
    c.requestDelete(c.roots.rows[0]); await c.refresh(); await c.confirmDelete(); assert.equal(writes(r).length, 0);
    c.requestDelete(c.roots.rows[0]); await c.confirmDelete(); assert.equal(writes(r)[0].url, '/api/community/comment_delete/101');
    assert.deepEqual(r.modals, []);
  } finally { Date.now = now; r.stop(); }
});

test('disabled, read-only and failed config states never assume permission to send', async () => {
  for (const setting of [{ ...flags, community_status: 0 }, { ...flags, community_comment_status: 0 }, { ...flags, community_comment_add: 0 }, null]) {
    const r = runtime({ feature: 'useCommunityComments', send: call => call.url.endsWith('/config') ? { data: setting } : { data: page() } });
    try {
      const c = await start(r); c.text.value = '不应发布'; await c.submit(); assert.equal(writes(r).length, 0);
      if (setting?.community_comment_add === 0) { assert.equal(c.roots.rows.length, 1); assert.equal(c.canInteract.value, true); }
      else if (setting) assert.equal(c.enabled.value, false); else assert.match(c.error.value, /开关格式/);
    } finally { r.stop(); }
  }
});

test('nonpublic owner previews allow exact own deletion while disabling create and comment likes', async () => {
  const r = setup(call => call.url.includes('comment_delete') ? { data: null } : { data: page([row(101, { uid: 11 })]) });
  try { const c = await start(r, 31, false); c.text.value = '禁写'; await c.submit(); await c.toggleLike(c.roots.rows[0]);
    assert.equal(writes(r).length, 0); c.requestDelete(c.roots.rows[0]); await c.confirmDelete(); assert.equal(writes(r).length, 1);
  } finally { r.stop(); }
});

test('author navigation retains platform0 and real-account identity, including actual reply targets', async () => {
  const r = setup(() => ({ data: page([row(101, { uid: 0, type: 0 }), row(102, { type: 3, uid: 22 }),
    row(103, { comment_author_type: 0, comment_author_uid: 0 }), row(104, { type: 1, uid: 22 })]) }));
  try { const c = await start(r); for (const item of c.roots.rows) c.openAuthor(item);
    c.openAuthor(c.roots.rows[2], true); c.openAuthor(row(999));
    assert.deepEqual(r.navigations, ['/pages/discover/workspace?author_id=0', '/pages/discover/workspace?author_id=22', '/pages/discover/workspace?author_id=0']);
  } finally { r.stop(); }
});

test('strict page decoding rejects wrong-post, wrong-thread and unapproved rows atomically', async () => {
  for (const bad of [row(102, { communityId: 32 }), row(102, { isVerify: 0 }), row(102, { isReply: 0, replyId: 1 }),
    row(102, { likeNum: -1 }), row(102, { reply_count: '2' }), row(102, { type: 9 })]) {
    const r = setup(() => ({ data: page([row(), bad], 2, 2) }));
    try { const c = await start(r); assert.deepEqual(c.roots.rows, []); assert.match(c.roots.error, /格式错误/); }
    finally { r.stop(); }
  }
});

test('pagination follows actual int32 service ceiling and can continue past page1000', async () => {
  const r = setup(() => ({ data: page(ten(), 2147483647, 2147483647) }));
  try { const c = await start(r); c.roots.page = 1000; await c.loadMore(); assert.equal(r.calls.at(-1).data.page, 1001);
    c.roots.page = 2147483646; c.roots.finished = false; await c.loadMore(); assert.equal(r.calls.at(-1).data.page, 2147483647);
    assert.equal(c.roots.finished, true); const length = r.calls.length; await c.loadMore(); assert.equal(r.calls.length, length);
  } finally { r.stop(); }
});

test('independent pagers cannot replace a newer whole-post count with an older delayed receipt', async () => {
  const old = deferred(); const r = setup(call => call.data.page === 2 ? old.promise
    : call.data.reply_id ? { data: page([row(301, { isReply: 0, replyId: 101 })], 1, 21) }
      : { data: page(ten(101, { reply_count: 1 }), 11, 20) });
  try {
    const c = await start(r), earlier = c.loadMore(); await tick(); await c.toggleReplies(c.roots.rows[0]);
    assert.equal(c.countUpdate.value.count, 21); old.resolve({ data: page([row(111)], 11, 20) }); await earlier;
    assert.equal(c.roots.page, 2); assert.equal(c.roots.rows.length, 11); assert.equal(c.countUpdate.value.count, 21);
  } finally { old.resolve({ data: page([]) }); r.stop(); }
});

test('old owner acknowledgement cannot release an already pending replacement owner write', async () => {
  const old = deferred(), next = deferred(); let attempts = 0;
  const r = setup(call => call.url.endsWith('/save') ? ++attempts === 1 ? old.promise : next.promise : { data: page() });
  try {
    const c = await start(r); c.text.value = '账号11'; const first = c.submit(); await tick(); r.auth.setLogin('account22', 22);
    await c.refresh(); c.text.value = '账号22'; const second = c.submit(); await tick(); assert.equal(c.busy.value, true);
    old.resolve({ data: { id: 901, is_verify: 1, post_comment_num: 999 } }); await first;
    assert.equal(c.busy.value, true); assert.notEqual(c.countUpdate.value?.count, 999);
    await c.submit(); assert.equal(writes(r).length, 2);
    next.resolve({ data: { id: 902, is_verify: 0, post_comment_num: 1 } }); await second; assert.equal(c.busy.value, false);
    assert.match(c.message.value, /等待审核/);
  } finally { old.resolve({ data: {} }); next.resolve({ data: {} }); r.stop(); }
});

test('destroying while pending keeps replacement components locked after a late successful commit receipt', async () => {
  const old = deferred(), r = setup(call => call.url.endsWith('/save') ? old.promise : { data: page() }); let scope;
  try {
    const c = await start(r); c.text.value = '一次提交'; const pending = c.submit(); await tick(); c.dispose();
    const module = r.load(path.resolve(__dirname, '../src/composables/useCommunityComments.ts'));
    scope = vue.effectScope(); const next = scope.run(() => module.useCommunityComments()); await next.setContext(31);
    assert.equal(next.unknown.value, true); assert.equal(next.busy.value, true);
    old.resolve({ data: { id: 901, is_verify: 1, post_comment_num: 99 } }); await pending;
    assert.equal(next.busy.value, false); assert.equal(next.unknown.value, true); assert.equal(next.countUpdate.value, null);
    assert.equal(next.text.value, ''); await next.refresh(); assert.equal(next.unknown.value, false); assert.equal(writes(r).length, 1);
  } finally { old.resolve({ data: {} }); scope?.stop(); r.stop(); }
});
