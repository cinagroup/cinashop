const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
const key = 'cinashop_pink_cancel_v1_11_400';
const intent = { version: 1, uid: 11, pinkId: 400, cid: 30 };
function status() {
  return { userInfo: { uid: 11 }, userBool: 1, pinkBool: 0, is_ok: 0, count: 2,
    pinkT: { id: 400, uid: 11, nickname: 'Owner', avatar: '', cid: 30, pid: 70, k_id: 0, people: 4, status: 1, stop_time: Math.floor(Date.now() / 1000) + 3600, is_refund: 0 },
    pinkAll: [{ id: 401, uid: 22, nickname: 'Member', avatar: '', cid: 30, pid: 70, k_id: 400, people: 4, status: 1, stop_time: 0, is_refund: 0 }],
    store_combination: { id: 30, product_id: 70, title: 'Isolated group', image: '', price: '6.25', people: 4 },
    store_combination_host: [], store_combination_host_truncated: false, current_pink_order: 'own&order#1',
    resolved_pink_id: 400, state: 'active', settlement_pending: false };
}
function receipt(state = 'not_applied') {
  return { uid: 11, pink_id: 400, combination_id: 30, current_pink_order: 'own&order#1', state,
    completed: state === 'completed', resumable: ['accepted', 'processing', 'unknown'].includes(state) };
}
function setup(options = {}) {
  const events = [], dialogs = []; let state = options.state ?? 'not_applied';
  const r = runtime({ feature: 'usePinkStatus', component: options.component, storage: options.storage,
    send: call => {
      events.push({ method: call.method, url: call.url, data: call.data });
      if (options.send) return options.send(call);
      if (call.method === 'POST') { assert.deepEqual(JSON.parse(r.storage.get(key)), intent); state = 'processing'; return { data: { completed: true } }; }
      return { data: call.url.includes('/remove/') ? receipt(state) : status() };
    } });
  r.uni.showModal = dialog => dialogs.push(dialog);
  return Object.assign(r, { events, dialogs, setState: value => { state = value; }, confirm: async (confirm = true) => { await dialogs.at(-1).success({ confirm }); await tick(); } });
}
const start = r => r.start({ id: '400' });
const posts = r => r.events.filter(e => e.method === 'POST');

test('owner confirms once, persists before POST, ignores POST success and reads authoritative processing', async () => {
  const r = setup({ component: 'pages/activity/goods_combination_status/index.vue' }); try {
    await start(r); assert.equal(r.checkout.canCancel.value, true); assert.equal(posts(r).length, 0);
    r.checkout.cancelPink(); r.checkout.cancelPink(); assert.equal(r.dialogs.length, 1); assert.equal(posts(r).length, 0);
    await r.confirm(false); assert.equal(r.storage.has(key), false);
    r.checkout.cancelPink(); await r.confirm(); assert.deepEqual(posts(r).map(e => e.data), [{ id: 400, cid: 30 }]);
    assert.equal(r.checkout.cancellation.value.state, 'processing'); assert.equal(r.checkout.cancellation.value.completed, false);
    assert.equal(r.checkout.canInvite.value, false); assert.equal(r.checkout.canCancel.value, false);
    await r.checkout.load(); assert.equal(posts(r).length, 1);
    r.checkout.cancelPink(); assert.match(r.dialogs.at(-1).title, /原取消/); await r.confirm(); assert.equal(posts(r).length, 2);
    assert.equal(r.storage.get(key).includes('token'), false);
    r.setState('completed'); await r.checkout.load(); assert.equal(r.checkout.canResumeCancellation.value, false);
    r.checkout.cancellationOrder(); assert.equal(r.navigations[0], '/pages/order/detail?orderId=own%26order%231');
  } finally { r.stop(); }
});

test('unknown POST transport retains original identity even if GET finds no application', async () => {
  const r = setup({ send: c => c.method === 'POST' ? { transport: 'Lost response' } : { data: c.url.includes('/remove/') ? receipt() : status() } }); try {
    await start(r); r.checkout.cancelPink(); await r.confirm();
    assert.deepEqual(JSON.parse(r.storage.get(key)), intent); assert.equal(r.checkout.cancellation.value.state, 'not_applied');
    assert.match(r.checkout.cancelError.value, /Lost response/); assert.equal(r.checkout.canResumeCancellation.value, true);
    await r.checkout.load(); assert.equal(posts(r).length, 1);
  } finally { r.stop(); }
});

test('saved receipt restores before a delisted group read and across component recreation without a POST', async () => {
  const storage = new Map([[key, JSON.stringify(intent)]]);
  for (let i = 0; i < 2; i++) {
    const r = setup({ storage, send: c => c.url.includes('/remove/') ? { data: receipt('completed') } : { status: 404, msg: 'Delisted' } }); try {
      await start(r); assert.match(r.events[0].url, /remove\/400$/); assert.equal(r.checkout.detail.value, null);
      assert.equal(r.checkout.cancellation.value.state, 'completed'); assert.equal(posts(r).length, 0);
    } finally { r.stop(); }
  }
});

test('promotion does not retarget the original saved operation or allow joining/sharing the replacement', async () => {
  const data = status(); data.pinkT.id = 401; data.pinkT.uid = 22; data.pinkAll = []; data.count = 3;
  data.userBool = 0; data.current_pink_order = null; data.resolved_pink_id = 401;
  const r = setup({ storage: new Map([[key, JSON.stringify(intent)]]), send: c => ({ data: c.url.includes('/remove/') ? receipt('processing') : data }) });
  try { await start(r); assert.equal(r.checkout.detail.value.leader.id, 401); assert.equal(r.checkout.canJoin.value, false);
    r.checkout.join(); r.checkout.copyInvite(); assert.equal(r.navigations.length, 0);
    r.checkout.cancelPink(); await r.confirm(); assert.deepEqual(posts(r)[0].data, { id: 400, cid: 30 });
  } finally { r.stop(); }
});

test('existing server application from another device requires explicit confirmation and saves the same identity', async () => {
  const r = setup({ state: 'accepted' }); try { await start(r); assert.equal(r.checkout.canCancel.value, false);
    assert.equal(r.checkout.canResumeCancellation.value, true); assert.equal(r.checkout.canInvite.value, false);
    assert.equal(r.storage.has(key), false); r.checkout.cancelPink(); await r.confirm(); assert.equal(posts(r).length, 1);
  } finally { r.stop(); }
});

for (const mode of ['throw', 'silent', 'corrupt', 'other-cid']) test(`storage ${mode} fails closed without submitting`, async () => {
  const r = setup(); try { await start(r);
    if (mode === 'throw') r.uni.setStorageSync = () => { throw new Error('Disk full'); };
    if (mode === 'silent') r.uni.setStorageSync = () => {};
    if (mode === 'corrupt') r.storage.set(key, '{broken');
    if (mode === 'other-cid') r.storage.set(key, JSON.stringify({ ...intent, cid: 31 }));
    r.checkout.cancelPink(); await r.confirm(); assert.equal(posts(r).length, 0); assert.ok(r.checkout.cancelError.value);
  } finally { r.stop(); }
});

test('corrupt persisted records block fresh intent creation on entry', async () => {
  const r = setup({ storage: new Map([[key, '{broken']]) }); try { await start(r); assert.equal(r.events.length, 0);
    assert.ok(r.checkout.cancelError.value); r.checkout.cancelPink(); assert.equal(r.dialogs.length, 0);
  } finally { r.stop(); }
});

for (const change of ['hide', 'unload', 'account', 'renew', 'route', 'deadline']) test(`confirmation callback is invalidated by ${change}`, async () => {
  const r = setup(); const now = Date.now; try { await start(r); r.checkout.cancelPink();
    if (change === 'hide') r.hooks.onHide();
    if (change === 'unload') r.hooks.onUnload();
    if (change === 'account') r.auth.setLogin('another', 22);
    if (change === 'renew') r.auth.setLogin(r.auth.token, 11);
    if (change === 'route') r.checkout.setRoute({ id: '401' });
    if (change === 'deadline') Date.now = () => now() + 7_200_000;
    await r.confirm(); assert.equal(posts(r).length, 0); assert.equal(r.storage.has(key), false);
  } finally { Date.now = now; r.stop(); }
});

test('late POST after hide/account change neither exposes receipt nor starts a GET for another identity', async () => {
  const gate = deferred(); const r = setup({ send: c => c.method === 'POST' ? gate.promise : { data: c.url.includes('/remove/') ? receipt() : status() } });
  try { await start(r); r.checkout.cancelPink(); const pending = r.dialogs[0].success({ confirm: true }); await tick();
    r.hooks.onHide(); r.auth.setLogin('another', 22); const count = r.events.length;
    gate.resolve({ data: { completed: true } }); await pending; assert.equal(r.events.length, count);
    assert.equal(r.checkout.cancellation.value, null); assert.deepEqual(JSON.parse(r.storage.get(key)), intent);
    r.hooks.onShow(); await tick(); assert.equal(r.events.filter(e => e.url.includes('/remove/')).length, 1);
  } finally { r.stop(); }
});

test('in-flight submission blocks duplicate callbacks, fresh dialogs, refresh and navigation', async () => {
  const gate = deferred(); const r = setup({ send: c => c.method === 'POST' ? gate.promise : { data: c.url.includes('/remove/') ? receipt() : status() } });
  try { await start(r); r.checkout.cancelPink(); const submit = r.dialogs[0].success({ confirm: true }); await tick();
    await r.dialogs[0].success({ confirm: true }); r.checkout.cancelPink(); await r.checkout.load(); r.checkout.orders(); r.checkout.copyInvite();
    assert.equal(posts(r).length, 1); assert.equal(r.dialogs.length, 1); assert.equal(r.events.length, 3); assert.equal(r.navigations.length, 0);
    gate.resolve({ data: { completed: true } }); await submit; assert.equal(r.checkout.cancellation.value.completed, false);
  } finally { r.stop(); }
});

test('a late receipt cannot populate a reused route or old login session', async () => {
  for (const mode of ['route', 'session']) {
    const gate = deferred(); const r = setup({ send: c => c.url.includes('/remove/') ? gate.promise : { data: status() } });
    try { await start(r);
      if (mode === 'route') r.checkout.setRoute({ id: '401' }); else r.auth.setLogin(r.auth.token, 11);
      gate.resolve({ data: receipt('completed') }); await tick(); assert.equal(r.checkout.cancellation.value, null);
      r.checkout.cancelPink(); assert.equal(posts(r).length, 0);
    } finally { r.stop(); }
  }
});

test('member, alias route, expired and full group cannot start a fresh cancellation', async () => {
  for (const mode of ['member', 'alias', 'expired', 'full']) {
    const data = status();
    if (mode === 'member') { data.pinkT.uid = 22; data.pinkAll[0].uid = 11; }
    if (mode === 'expired') { data.pinkT.stop_time = 1; data.settlement_pending = true; data.state = 'settlement_pending'; }
    if (mode === 'full') { data.pinkT.people = 2; data.count = 0; data.settlement_pending = true; data.state = 'settlement_pending'; }
    const r = setup({ send: c => ({ data: c.url.includes('/remove/') ? receipt() : data }) });
    try { await r.start({ id: mode === 'alias' ? '401' : '400' }); r.checkout.cancelPink(); assert.equal(r.dialogs.length, 0); assert.equal(posts(r).length, 0); }
    finally { r.stop(); }
  }
});

test('visible invitation and fresh cancel controls expire on the page clock without waiting for another request', async () => {
  const realInterval = global.setInterval, realNow = Date.now; let pulse;
  global.setInterval = callback => { pulse = callback; return undefined; };
  const r = setup();
  try { await start(r); assert.equal(r.checkout.canInvite.value, true); assert.equal(r.checkout.canCancel.value, true);
    Date.now = () => realNow() + 7_200_000; pulse();
    assert.equal(r.checkout.canInvite.value, false); assert.equal(r.checkout.canCancel.value, false);
  } finally { r.stop(); global.setInterval = realInterval; Date.now = realNow; }
});

test('malformed/cross-owner/contradictory receipts never enable a write or invent completion', async () => {
  const r = setup(); try {
    const p = r.load(path.resolve(__dirname, '../../common/pinkCancellation.ts'));
    for (const patch of [{ uid: 22 }, { pink_id: 401 }, { combination_id: 31 }, { completed: true }, { resumable: true },
      { state: 'SUCCESS' }, { current_pink_order: 'bad order' }, { state: 'completed', completed: true, resumable: true }]) {
      assert.throws(() => p.parsePinkCancellation({ ...receipt(), ...patch }, intent));
    }
    for (const state of ['not_applied', 'accepted', 'processing', 'unknown', 'completed', 'needs_attention']) assert.equal(p.parsePinkCancellation(receipt(state), intent).state, state);
    for (const bad of ['{}', JSON.stringify({ ...intent, token: 'bad' }), JSON.stringify({ ...intent, cid: 0 }), JSON.stringify({ ...intent, uid: 22 })]) assert.throws(() => p.decodePinkCancellation(bad, 11, 400));
  } finally { r.stop(); }
});

test('rejected/read-error/completed states do not allow ordinary retry, but a later successful GET can recover', async () => {
  for (const state of ['needs_attention', 'completed']) {
    const r = setup({ state }); try { await start(r); r.checkout.cancelPink(); assert.equal(r.dialogs.length, 0); } finally { r.stop(); }
  }
  let invalid = true; const r = setup({ send: c => ({ data: c.url.includes('/remove/') ? invalid ? { ...receipt(), uid: 22 } : receipt() : status() }) });
  try { await start(r); assert.equal(r.checkout.canCancel.value, false); assert.ok(r.checkout.cancelError.value);
    invalid = false; await r.checkout.load(); assert.equal(r.checkout.canCancel.value, true);
  } finally { r.stop(); }
});
