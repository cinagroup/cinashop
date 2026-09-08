const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
const route = '/pages/activity/goods_combination_status/index';
function status() {
  return {
    userInfo: { uid: 11 }, userBool: 0, pinkBool: 0, is_ok: 0, count: 2,
    pinkT: { id: 400, uid: 22, nickname: 'Leader', avatar: '/leader.svg', cid: 30, pid: 70, k_id: 0, people: 4, status: 1, stop_time: Math.floor(Date.now() / 1000) + 3600, is_refund: 0 },
    pinkAll: [{ id: 401, uid: 33, nickname: 'Member', avatar: '/member.svg', cid: 30, pid: 70, k_id: 400, people: 4, status: 1, stop_time: 0, is_refund: 0 }],
    store_combination: { id: 30, product_id: 70, title: 'Isolated group', image: '/group.svg', price: '6.25', people: 4 },
    store_combination_host: [], store_combination_host_truncated: false,
    current_pink_order: null, resolved_pink_id: 401, state: 'active', settlement_pending: false,
  };
}
function setup({ send = () => ({ data: status() }), component } = {}) {
  const r = runtime({ feature: 'usePinkStatus', component, send: call => { assert.equal(call.method, 'GET'); return send(call); } });
  const copies = []; r.copies = copies;
  r.uni.setClipboardData = opts => { copies.push(opts.data); opts.success?.(); };
  return r;
}
const start = r => r.start({ id: '401' });

test('legacy routes are directly registered and query the member record, not an activity ID', async () => {
  const r = setup(); try {
    const nav = r.load(path.resolve(__dirname, '../src/config/navigation.ts'));
    assert.equal(nav.resolveRegisteredPageRoute(route, 'id=401'), `${route}?id=401`);
    await start(r); assert.equal(r.calls[0].url, '/api/combination/pink/401');
    assert.equal(r.checkout.detail.value.leader.id, 400); assert.equal(r.checkout.detail.value.activity.id, 30);
    assert.equal(r.checkout.title.value, '拼团进行中'); assert.equal(r.checkout.canJoin.value, true);
    r.checkout.join(); r.checkout.join(); assert.deepEqual(r.navigations, ['/pages/activity/detail?id=30&pinkId=400']);
  } finally { r.stop(); }
});
test('anonymous entry makes no API request; login returns to the same record with a fresh read', async () => {
  const r = setup(); try {
    r.auth.clear(); await start(r); assert.equal(r.calls.length, 0); assert.equal(r.checkout.detail.value, null);
    r.checkout.login(); r.checkout.login(); assert.deepEqual(r.navigations, ['/pages/auth/login']);
    r.hooks.onHide(); r.auth.setLogin('new-session', 11); r.hooks.onShow(); await tick();
    assert.equal(r.calls[0].url, '/api/combination/pink/401'); assert.ok(r.checkout.detail.value);
  } finally { r.stop(); }
});
test('expired authentication clears private state and reloads after explicit login', async () => {
  let expire = true; const r = setup({ send: () => expire ? { status: 410002, msg: 'Expired' } : { data: status() } });
  try {
    await start(r); assert.equal(r.checkout.detail.value, null); assert.equal(r.auth.isLoggedIn, false);
    assert.deepEqual(r.navigations, ['/pages/auth/login']);
    r.hooks.onHide(); expire = false; r.auth.setLogin('renewed', 11); r.hooks.onShow(); await tick();
    assert.equal(r.checkout.detail.value.activity.id, 30);
  } finally { r.stop(); }
});
test('same-token renewal immediately removes prior private state and stale responses', async () => {
  const gate = deferred(); let slow = false;
  const r = setup({ send: () => slow ? gate.promise : { data: status() } }); try {
    await start(r); slow = true; const pending = r.checkout.load(); await tick();
    r.auth.setLogin(r.auth.token, 11); assert.equal(r.checkout.detail.value, null);
    gate.resolve({ data: status() }); await pending; assert.equal(r.checkout.detail.value, null);
    slow = false; await r.checkout.load(); assert.ok(r.checkout.detail.value);
  } finally { r.stop(); }
});
test('route changes isolate late success and never silently restore a prior record', async () => {
  const gate = deferred(); const r = setup({ send: call => call.url.endsWith('/401') ? gate.promise : { status: 404, msg: 'Missing group' } });
  try {
    await start(r); r.checkout.setRoute({ id: '999' }); await tick(); assert.match(r.checkout.error.value, /Missing/);
    gate.resolve({ data: status() }); await tick(); assert.equal(r.checkout.detail.value, null); assert.equal(r.checkout.recordId.value, 999);
  } finally { r.stop(); }
});
test('hide/unload clear private details, stop actions and discard in-flight responses', async () => {
  for (const hook of ['onHide', 'onUnload']) {
    const gate = deferred(); const r = setup({ send: () => gate.promise }); try {
      await start(r); r.hooks[hook](); gate.resolve({ data: status() }); await tick();
      assert.equal(r.checkout.detail.value, null); r.checkout.list(); assert.equal(r.navigations.length, 0);
    } finally { r.stop(); }
  }
});
test('failed navigation can retry while old callbacks cannot unlock a new route navigation', async () => {
  const r = setup(); try {
    const callbacks = []; r.uni.navigateTo = opts => { r.navigations.push(opts.url); callbacks.push(opts); };
    await start(r); r.checkout.join(); callbacks[0].fail(); assert.equal(r.checkout.navigating.value, false);
    r.checkout.join(); r.checkout.setRoute({ id: '400' }); await tick(); r.checkout.join();
    callbacks[1].fail(); assert.equal(r.checkout.navigating.value, true); assert.equal(r.navigations.length, 3);
  } finally { r.stop(); }
});
test('only canonical own order IDs navigate, safely encoded, without other member order disclosure', async () => {
  const data = status(); data.pinkAll[0].uid = 11; data.userBool = 1; data.current_pink_order = 'order&fragment#1';
  const r = setup({ send: () => ({ data }) }); try {
    await start(r); assert.equal(r.checkout.canJoin.value, false); r.checkout.order();
    assert.equal(r.navigations[0], '/pages/order/detail?orderId=order%26fragment%231');
  } finally { r.stop(); }
});
test('terminal states do not imply refund settlement or allow joining', async () => {
  for (const state of ['success', 'failed']) {
    const data = status(); data.state = state; data.pinkT.status = state === 'success' ? 2 : 3;
    data.pinkBool = state === 'success' ? 1 : -1; data.is_ok = state === 'success' ? 1 : 0;
    const r = setup({ send: () => ({ data }) }); try {
      await start(r); assert.equal(r.checkout.title.value, state === 'success' ? '拼团成功' : '拼团失败');
      assert.equal(r.checkout.canJoin.value, false); r.checkout.join(); r.checkout.copyInvite(); assert.equal(r.navigations.length + r.copies.length, 0);
      r.checkout.openActivity(); assert.equal(r.navigations[0], '/pages/activity/detail?id=30');
    } finally { r.stop(); }
  }
});
test('full/expired/null-deadline pending states never advertise joining or completed settlement', async () => {
  for (const mode of ['full', 'expired', 'null']) {
    const data = status(); data.state = 'settlement_pending'; data.settlement_pending = true;
    if (mode === 'full') { data.pinkT.people = 2; data.count = 0; }
    else data.pinkT.stop_time = mode === 'null' ? 0 : Math.floor(Date.now() / 1000) - 1;
    const r = setup({ send: () => ({ data }) }); try {
      await start(r); assert.equal(r.checkout.title.value, '等待结算确认'); assert.equal(r.checkout.canJoin.value, false);
      r.checkout.join(); r.checkout.copyInvite(); assert.equal(r.navigations.length + r.copies.length, 0);
    } finally { r.stop(); }
  }
});
test('click-time deadline revalidation blocks stale visible join and invite controls', async () => {
  const data = status(); const r = setup({ send: () => ({ data }) }); const realNow = Date.now;
  try {
    await start(r); assert.equal(r.checkout.canJoin.value, true);
    Date.now = () => data.pinkT.stop_time * 1000;
    r.checkout.join(); r.checkout.copyInvite(); assert.equal(r.navigations.length + r.copies.length, 0);
  } finally { Date.now = realNow; r.stop(); }
});

test('cancellation pending has precise text, disables join and sharing, and refreshes read-only', async () => {
  const data = status(); data.cancellation_pending = true; data.settlement_pending = true; data.state = 'settlement_pending';
  const r = setup({ component: 'pages/activity/goods_combination_status/index.vue', send: () => ({ data }) });
  try {
    await start(r); assert.equal(r.checkout.title.value, '团长取消处理中');
    assert.equal(r.checkout.canJoin.value, false); assert.equal(r.checkout.remaining.value, '');
    r.checkout.join(); r.checkout.copyInvite(); assert.equal(r.navigations.length + r.copies.length, 0);
    assert.equal(r.checkout.invitation(), null); assert.equal(r.hooks.onShareAppMessage().path, '/pages/activity/index');
    await r.checkout.load(); assert.equal(r.calls.length, 2); assert.equal(r.checkout.title.value, '团长取消处理中');
    r.auth.clear(); assert.equal(r.checkout.detail.value, null); assert.equal(r.checkout.title.value, '');
  } finally { r.stop(); }
});

test('cancellation flag is strictly boolean and consistent, while absent legacy extensions remain readable', async () => {
  const r = setup(); try {
    const parser = r.load(path.resolve(__dirname, '../../common/pinkStatus.ts'));
    assert.equal(parser.parsePinkStatus(status(), 11).cancellationPending, false);
    for (const value of [null, 0, 1, 'true', {}, []]) assert.throws(() => parser.parsePinkStatus({ ...status(), cancellation_pending: value }, 11));
    assert.throws(() => parser.parsePinkStatus({ ...status(), cancellation_pending: true }, 11));
    for (const terminal of [2, 3]) {
      const data = status(); data.cancellation_pending = true; data.pinkT.status = terminal;
      data.state = terminal === 2 ? 'success' : 'failed'; data.pinkBool = terminal === 2 ? 1 : -1; data.is_ok = terminal === 2 ? 1 : 0;
      assert.throws(() => parser.parsePinkStatus(data, 11));
    }
  } finally { r.stop(); }
});
test('invites contain only the canonical leader record and no token, uid or order ID', async () => {
  const r = setup(); try { await start(r); r.checkout.copyInvite(); assert.deepEqual(r.copies, [`${route}?id=400`]); }
  finally { r.stop(); }
});
test('recommendation navigation is bounded to the returned activity IDs', async () => {
  const data = status(); data.store_combination_host = [{ ...data.store_combination, id: 31 }];
  const r = setup({ send: () => ({ data }) }); try {
    await start(r); r.checkout.openActivity(999); assert.equal(r.navigations.length, 0);
    r.checkout.openActivity(31); assert.equal(r.navigations[0], '/pages/activity/detail?id=31');
  } finally { r.stop(); }
});
for (const id of ['0', '0401', '-1', '1.2', '1e2', '2147483648', '401x']) {
  test(`invalid record ${id} never queries or navigates to an activity`, async () => {
    const r = setup(); try { await r.start({ id }); assert.equal(r.calls.length, 0); assert.match(r.checkout.error.value, /链接无效/); }
    finally { r.stop(); }
  });
}
test('scene IDs and H5 duplicate/conflicting identifiers are strictly parsed', async () => {
  const r = setup(); try {
    const parser = r.load(path.resolve(__dirname, '../../common/pinkStatus.ts'));
    assert.equal(parser.pinkRouteId({ scene: 'id%3D401%26spid%3D11' }), 401);
    for (const query of [{ id: '401', pinkRecordId: '400' }, { scene: 'id=401&id=400' }, { id: ['401'] }, { scene: '%' }]) assert.throws(() => parser.pinkRouteId(query));
    assert.deepEqual(parser.pinkQueryFromHash(`#${route}?id=401&id=400`), { id: '' });
    assert.deepEqual(parser.pinkQueryFromHash(`#${route}?%69d=401`), { id: '401' });
    assert.equal(parser.pinkQueryFromHash('#/pages/activity/detail?id=30'), null);
  } finally { r.stop(); }
});
test('malformed old activity shape, cross-user/member data and contradictory states fail closed', async () => {
  const changes = [d => ({ combination: d.store_combination, pinkList: [] }), d => ({ ...d, userInfo: { uid: 22 } }),
    d => ({ ...d, count: 99 }), d => ({ ...d, userBool: 1 }), d => ({ ...d, current_pink_order: 'other-order' }),
    d => ({ ...d, pinkBool: 1 }), d => ({ ...d, state: 'success' }), d => ({ ...d, pinkAll: [d.pinkAll[0], d.pinkAll[0]] }),
    d => ({ ...d, pinkAll: [{ ...d.pinkAll[0], cid: 99 }] }), d => ({ ...d, pinkT: { ...d.pinkT, k_id: 999 } }),
    d => ({ ...d, pinkT: { ...d.pinkT, stop_time: 0 } }), d => ({ ...d, pinkAll: Array(500).fill(d.pinkAll[0]) })];
  const r = setup(); try {
    const parser = r.load(path.resolve(__dirname, '../../common/pinkStatus.ts'));
    for (const change of changes) assert.throws(() => parser.parsePinkStatus(change(status()), 11));
    const data = status(); data.pinkT.avatar = 'javascript:alert(1)'; assert.equal(parser.parsePinkStatus(data, 11).leader.avatar, '');
  } finally { r.stop(); }
});
test('business/transport failures keep a visible error and allow explicit same-record retry', async () => {
  let failure = true; const r = setup({ send: () => failure ? { transport: 'Synthetic network failure' } : { data: status() } });
  try { await start(r); assert.match(r.checkout.error.value, /network/); assert.equal(r.checkout.detail.value, null);
    failure = false; await r.checkout.load(); assert.ok(r.checkout.detail.value); assert.equal(r.calls.length, 2);
  } finally { r.stop(); }
});
test('an unavailable activity still offers own order history without guessing an order identifier', async () => {
  const r = setup({ send: () => ({ status: 404, msg: '活动已下架，请从订单申请售后' }) }); try {
    await start(r); assert.equal(r.checkout.detail.value, null); r.checkout.orders();
    assert.deepEqual(r.navigations, ['/pages/order/list']);
  } finally { r.stop(); }
});

test('actual status SFC setup registers safe native sharing without an order or user ID', async () => {
  const r = setup({ component: 'pages/activity/goods_combination_status/index.vue' }); try {
    await start(r); assert.equal(r.checkout.title.value, '拼团进行中');
    assert.equal(r.hooks.onShareAppMessage().path, `${route}?id=400`);
    r.hooks.onHide(); assert.equal(r.hooks.onShareAppMessage().path, '/pages/activity/index');
  } finally { r.stop(); }
});
test('H5 same-route hash changes invalidate old records and duplicate IDs, with listener cleanup', async () => {
  const listeners = new Map();
  global.window = { location: { hash: `#${route}?id=401`, origin: 'http://127.0.0.1:5190', pathname: '/' },
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  const r = setup({ send: call => call.url.endsWith('/999') ? { status: 404, msg: 'Missing group' } : { data: status() } });
  try {
    await start(r); assert.ok(r.checkout.detail.value);
    window.location.hash = `#${route}?id=999`; listeners.get('hashchange')(); await tick();
    assert.equal(r.checkout.recordId.value, 999); assert.equal(r.checkout.detail.value, null); assert.match(r.checkout.error.value, /Missing/);
    window.location.hash = `#${route}?id=401&id=400`; listeners.get('hashchange')(); await tick();
    assert.equal(r.checkout.recordId.value, 0); assert.match(r.checkout.error.value, /链接无效/);
    window.location.hash = `#${route}?id=401`; listeners.get('hashchange')(); await tick();
    r.checkout.copyInvite(); assert.deepEqual(r.copies, [`http://127.0.0.1:5190/#${route}?id=400`]);
  } finally { r.stop(); assert.equal(listeners.size, 0); delete global.window; }
});
