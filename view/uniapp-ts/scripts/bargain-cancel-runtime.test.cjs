const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
const row = (id = 80, status = 1) => ({ id, uid: 11, bargain_id: 40, title: '待取消的砍价', image: '', status,
  bargain_price: '10.00', bargain_price_min: '2.00', price: status === 3 ? '8.00' : '2.00',
  residue_price: status === 3 ? '2.00' : '8.00', pay_status: status === 3 });
function setup({ read = () => ({ data: [row(), row(90), row(91, 3), row(92, 4)] }), cancel = () => ({ data: null }), component } = {}) {
  return runtime({ feature: 'useBargainPurchase', component, send: call => {
    if (call.url === '/api/bargain/user/list') return read(call);
    if (call.url === '/api/bargain/user/cancel') return cancel(call);
    throw Error('Unexpected cancel I/O: ' + call.url);
  } });
}
const writes = r => r.calls.filter(call => call.url === '/api/bargain/user/cancel');
test('actual mobile page offers inline confirmation for one current cutting record without a modal or write', async () => {
  const r = setup({ component: 'pages/activity/bargainDetail.vue' }); try {
    await r.start({ mine: '1' }); const p = r.checkout;
    p.requestCancel(80); assert.deepEqual(p.pendingCancel.value, { id: 80, activityId: 40, title: '待取消的砍价' });
    assert.equal(p.locked.value, true); p.requestCancel(90); p.chooseRecord(90); await p.load(2);
    assert.equal(p.pendingCancel.value.id, 80); assert.equal(r.calls.filter(x => x.url.startsWith('/api/bargain/')).length, 1);
    assert.equal(r.navigations.length, 0); assert.equal(r.modals.length, 0); assert.equal(writes(r).length, 0);
    p.keepParticipation(); assert.equal(p.pendingCancel.value, null); assert.equal(p.locked.value, false);
    await p.confirmCancel(); assert.equal(writes(r).length, 0);
  } finally { r.stop(); }
});
test('mobile cancel binds both participation and activity and refreshes the same page after success', async () => {
  let cancelled = false;
  const r = setup({ read: () => ({ data: cancelled ? [row(90)] : [row(), row(90)] }), cancel: () => { cancelled = true; return { data: null }; } });
  try {
    await r.start({ mine: '1' }); const p = r.checkout; await p.load(2); p.requestCancel(80); await p.confirmCancel();
    assert.deepEqual(writes(r), [{ url: '/api/bargain/user/cancel', data: { id: 80, bargainId: 40 } }]);
    assert.deepEqual(r.calls.at(-1), { url: '/api/bargain/user/list', data: { page: 2, limit: 20 } });
    assert.deepEqual(p.records.value.map(x => x.id), [90]); assert.equal(p.pendingCancel.value, null);
    await p.confirmCancel(); assert.equal(writes(r).length, 1);
  } finally { r.stop(); }
});
test('mobile cancellation rejects successful, used, closed, foreign and anonymous selections', async () => {
  const r = setup({ read: () => ({ data: [row(80, 2), row(90, 3), row(91, 4)] }) });
  try {
    await r.start({ mine: '1' }); const p = r.checkout;
    for (const id of [80, 90, 91, 999, '80', NaN]) { p.requestCancel(id); await p.confirmCancel(); }
    assert.equal(p.pendingCancel.value, null); assert.equal(writes(r).length, 0);
    r.auth.clear(); p.requestCancel(80); await p.confirmCancel(); assert.equal(writes(r).length, 0);
  } finally { r.stop(); }
});
test('mobile pending confirmation is discarded on hide, unload, account or route changes', async () => {
  for (const boundary of ['hide', 'unload', 'account', 'route']) {
    const r = setup(); try {
      await r.start({ mine: '1' }); const p = r.checkout; p.requestCancel(80);
      if (boundary === 'account') r.auth.setLogin('new-owner', 22);
      else if (boundary === 'route') r.hooks.onLoad({ id: '40' });
      else r.hooks[boundary === 'hide' ? 'onHide' : 'onUnload']();
      await p.confirmCancel(); assert.equal(p.pendingCancel.value, null); assert.equal(writes(r).length, 0);
    } finally { r.stop(); }
  }
});
test('mobile in-flight cancellation cannot be replayed, replaced or cleared by secondary controls', async () => {
  const waiting = deferred(), r = setup({ cancel: () => waiting.promise });
  try {
    await r.start({ mine: '1' }); const p = r.checkout; p.requestCancel(80); const work = p.confirmCancel(); await tick();
    await p.confirmCancel(); p.requestCancel(90); p.keepParticipation(); await p.load(2);
    assert.equal(writes(r).length, 1); assert.equal(p.pendingCancel.value.id, 80);
    waiting.resolve({ data: null }); await work; assert.equal(p.pendingCancel.value, null); assert.equal(p.buying.value, false);
    assert.equal(r.calls.filter(x => x.url.endsWith('/list')).length, 2);
  } finally { waiting.resolve({ data: null }); r.stop(); }
});
test('mobile late cancellation outcomes cannot republish an old list after lifecycle or account changes', async () => {
  for (const boundary of ['hide', 'unload', 'account', 'route']) {
    const waiting = deferred(), r = setup({ cancel: () => waiting.promise });
    try {
      await r.start({ mine: '1' }); const p = r.checkout; p.requestCancel(80); const work = p.confirmCancel(); await tick();
      if (boundary === 'account') r.auth.setLogin('new-owner', 22);
      else if (boundary === 'route') r.hooks.onLoad({ id: '40' });
      else r.hooks[boundary === 'hide' ? 'onHide' : 'onUnload']();
      waiting.resolve({ data: null }); await work;
      assert.equal(p.records.value.length, 0); assert.equal(p.pendingCancel.value, null); assert.equal(r.calls.length, 2);
    } finally { waiting.resolve({ data: null }); r.stop(); }
  }
});
test('mobile lost cancellation response clears the list and resolves by read without replaying the write', async () => {
  let committed = false;
  const r = setup({ read: () => ({ data: committed ? [row(90)] : [row(), row(90)] }),
    cancel: () => { committed = true; return { transport: 'Synthetic lost response' }; } });
  try {
    await r.start({ mine: '1' }); const p = r.checkout; p.requestCancel(80); await p.confirmCancel();
    assert.deepEqual(p.records.value, []); assert.equal(p.pendingCancel.value, null); assert.match(p.error.value, /请刷新记录确认结果/);
    p.requestCancel(80); await p.confirmCancel(); assert.equal(writes(r).length, 1);
    await p.load(); assert.deepEqual(p.records.value.map(x => x.id), [90]); assert.equal(writes(r).length, 1);
  } finally { r.stop(); }
});
test('mobile rejected or post-success failed read keeps the original page and requires explicit reload', async () => {
  for (const rejection of [true, false]) {
    let written = false, failRead = false;
    const r = setup({ read: () => failRead ? { httpStatus: 503, status: 503, msg: 'read unavailable' } : { data: [row(80, written ? 3 : 1)] },
      cancel: () => { written = true; failRead = !rejection; return rejection ? { status: 400, msg: '状态错误' } : { data: null }; } });
    try {
      await r.start({ mine: '1' }); const p = r.checkout; await p.load(2); p.requestCancel(80); await p.confirmCancel();
      assert.equal(p.records.value.length, 0); assert.equal(p.pendingCancel.value, null); assert.ok(p.error.value); assert.equal(p.page.value, 2);
      failRead = false; await p.load(); p.requestCancel(80); await p.confirmCancel(); assert.equal(writes(r).length, 1);
      assert.equal(p.records.value[0].status, 3);
    } finally { r.stop(); }
  }
});
test('mobile cancel API validates exact numeric identities and authentication before network I/O', async () => {
  const r = setup(); try {
    const api = r.load(require('node:path').resolve(__dirname, '../src/api/bargain.ts'));
    for (const args of [[0, 40], [80, 0], ['80', 40], [80, NaN], [80, 2147483648]]) await assert.rejects(api.apiBargainCancel(...args));
    assert.equal(r.calls.length, 0); r.auth.clear(); await assert.rejects(api.apiBargainCancel(80, 40)); assert.equal(r.calls.length, 0);
  } finally { r.stop(); }
});
