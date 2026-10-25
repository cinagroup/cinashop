const { test, assert, vue, clone, tick, deferred, all, text, loader, apiFile, projectionFile, kinds, block, harness, payload, response } = require('./helpers/diy-state-runtime.cjs');
const routes = { newVip: '/api/diy/newcomer_list?page=1&limit=10', signIn: '/api/diy/sign', ranking: '/api/diy/product_rank?limit=3' };
for (const kind of ['newVip', 'signIn', 'ranking']) test(`actual ${kind} preview API sends only its exact anonymous GET with a passed abort signal and zero Admin authority`, async () => {
  const old = global.fetch, calls = [], signal = new AbortController().signal, l = loader(); global.fetch = async (url, options) => { calls.push({ url, options }); return response(payload(kind)); };
  try { const result = await l.load(apiFile).apiDiyStatePreview(kind, signal); assert.equal(calls.length, 1); assert.equal(calls[0].url, routes[kind]); assert.deepEqual(calls[0].options, { method: 'GET', credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/json' }, signal });
    assert.deepEqual(result, l.load(projectionFile).checkedDiyStateData(kind, payload(kind), 0)); assert.equal(result.user, null);
  } finally { global.fetch = old; }
});
test('member author preview never fetches personal or grade data and unknown kinds fail before I/O', async () => {
  const old = global.fetch; let reads = 0; global.fetch = async () => { reads++; throw Error('No Admin-derived member projection'); };
  try { const api = loader().load(apiFile); assert.deepEqual(await api.apiDiyStatePreview('userInfor', new AbortController().signal), { user: null, newcomer: null, sign: null, ranks: null }); await assert.rejects(api.apiDiyStatePreview('supplier', new AbortController().signal)); assert.equal(reads, 0); } finally { global.fetch = old; }
});
for (const kind of ['newVip', 'signIn', 'ranking']) test(`${kind} API rejects invalid status and every malformed receipt tail before adopting a partial public projection`, async () => {
  const old = global.fetch, l = loader(), api = l.load(apiFile); let current; global.fetch = async () => current;
  try {
    for (const body of [null, [], {}, { status: '200', data: payload(kind) }, { status: 503, data: payload(kind) }, { status: 200 }]) { current = { ok: true, json: async () => body }; await assert.rejects(api.apiDiyStatePreview(kind, new AbortController().signal)); }
    current = { ok: false, json: async () => ({ status: 200, data: payload(kind) }) }; await assert.rejects(api.apiDiyStatePreview(kind, new AbortController().signal));
    const bad = payload(kind);
    if (kind === 'ranking') bad.star.push({ id: 99, store_name: '坏尾项', image: '/static/p.png', price: {} });
    if (kind === 'newVip') bad.newcomer_coupon.push({ id: 99, uid: 11, coupon_price: '0.00', use_min_price: '0.00', status: 1 });
    if (kind === 'signIn') bad.signList[0][6].point = -1;
    current = response(bad); await assert.rejects(api.apiDiyStatePreview(kind, new AbortController().signal));
    current = response(payload(kind)); assert.ok(await api.apiDiyStatePreview(kind, new AbortController().signal));
  } finally { global.fetch = old; }
});
for (const kind of kinds) for (const style of [0, 1]) test(`actual compiled ${kind} style${style} preview displays its real conditional content without buttons or private requests`, async () => {
  const b = block(kind); b.styleConfig.tabVal = style; if (kind === 'userInfor') b.checkboxInfo.type = [0, 1, 2, 3, 4, 5]; const r = harness([b]), old = global.fetch, calls = []; global.fetch = async (url, options) => { calls.push({ url, options }); return response(payload(kind)); };
  try { const raw = r.props.modelValue; if (kind !== 'userInfor') await r.state.loadPreview(); await tick(); const shell = all(r.tree, node => node.props.class === 'state-author-preview')[0]; assert.ok(shell); assert.equal(shell.props['data-kind'], kind); assert.equal(shell.props['data-style'], style);
    if (kind === 'userInfor') { assert.equal(r.preview().metrics.length, style ? 6 : 5); assert.equal(r.preview().metrics.some(item => item.id === 3), style === 1); assert.equal(calls.length, 0); }
    if (kind === 'signIn') { assert.equal(all(shell, node => node.props.class === 'week').length, style === 0 ? 1 : 0); assert.match(text(shell), style ? /签到立即获取/u : /周一/u); }
    if (kind === 'ranking') { assert.deepEqual(r.preview().ranks.map(group => group.key), style ? ['sales', 'star', 'collect'] : ['sales', 'collect', 'star']); const image = all(shell, node => node.tag === 'img' && node.props.alt === '排行榜标题图片预览')[0]; assert.ok(image); assert.equal(image.props.src, '/static/images/diy/ranking.png'); }
    if (kind === 'newVip') { assert.match(text(shell), /0/u); assert.match(text(shell), /9折/u); assert.match(text(shell), /当前公开商品71/u); }
    assert.equal(all(shell, node => node.tag === 'button').length, 0); assert.equal(r.props.modelValue, raw); assert.deepEqual(r.writes, []); assert.ok(calls.every(call => call.options.method === 'GET' && call.options.credentials === 'omit'));
  } finally { global.fetch = old; r.unmount(); }
});
for (const kind of ['newVip', 'signIn', 'ranking']) test(`compiled ${kind} preview does not retain a previously valid result when the whole current receipt is invalid`, async () => {
  const r = harness([block(kind)]), old = global.fetch; let bad = false; global.fetch = async () => response(bad ? {} : payload(kind));
  try { await r.state.loadPreview(); await tick(); assert.equal(r.state.previewLoaded, true); bad = true; await r.state.loadPreview(); await tick(); assert.equal(r.state.previewLoaded, false); assert.deepEqual(r.state.previewData, { user: null, newcomer: null, sign: null, ranks: null }); assert.ok(r.state.previewError); assert.deepEqual(r.writes, []); } finally { global.fetch = old; r.unmount(); }
});
for (const boundary of ['selection', 'raw', 'page', 'actor', 'permission', 'token', 'session', 'auth-event', 'disabled', 'unmount']) test(`abort-ignoring anonymous public result cannot cross ${boundary} or hydrate another current author instance`, async () => {
  const r = harness([block('newVip'), block('ranking', 20)]), old = global.fetch, pending = deferred(); global.fetch = () => pending.promise;
  try { const job = r.state.loadPreview(); await tick(); if (boundary === 'selection') r.state.select(1); if (boundary === 'raw') r.props.modelValue = JSON.stringify([...r.value(), { name: 'extension' }]); if (boundary === 'page') r.props.editorKey = 'other-state'; if (boundary === 'actor') r.actor.userInfo.id = 22;
    if (boundary === 'auth-event') r.window.dispatchEvent(new Event('admin-auth-expired'));
    if (boundary === 'permission') { r.actor.userInfo.level = 1; r.actor.uniqueAuth = ['dise.view']; } if (boundary === 'token') r.storage.set('admin_token', 'B'); if (boundary === 'session') { r.storage.set('admin_session', 'B'); r.window.dispatchEvent(new Event('storage')); } if (boundary === 'disabled') r.props.disabled = true; if (boundary === 'unmount') r.unmount();
    await tick(); pending.resolve(response(payload('newVip'))); await job; await tick(); assert.equal(r.state.previewLoaded, false); assert.deepEqual(r.state.previewData, { user: null, newcomer: null, sign: null, ranks: null }); assert.equal(r.state.previewLoading, false);
  } finally { pending.resolve(response({})); global.fetch = old; r.unmount(); }
});
test('an old preview rejection/finally cannot overwrite a newer pending response or release its loading state', async () => {
  const r = harness([block('newVip')]), old = global.fetch, first = deferred(), second = deferred(); let count = 0; global.fetch = () => ++count === 1 ? first.promise : second.promise;
  try { const before = r.state.loadPreview(); await tick(); const current = r.state.loadPreview(); await tick(); first.reject(Error('旧响应失败')); await before; await tick(); assert.equal(r.state.previewLoading, true); assert.equal(r.state.previewError, ''); assert.equal(r.state.previewLoaded, false);
    second.resolve(response(payload('newVip'))); await current; await tick(); assert.equal(r.state.previewLoaded, true); assert.equal(r.state.previewLoading, false); assert.equal(r.state.previewData.newcomer.newcomer_integral, 0);
  } finally { first.resolve(response({})); second.resolve(response({})); global.fetch = old; r.unmount(); }
});
