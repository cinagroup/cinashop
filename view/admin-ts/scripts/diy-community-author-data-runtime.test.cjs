const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const file = path.resolve(__dirname, '../src/api/diyCommunityAuthor.ts');
const clone = value => structuredClone(value);
const flags = (community_status = 1, community_comment_status = 1, community_comment_add = 1) => ({ community_status, community_comment_status, community_comment_add });
const post = (patch = {}) => ({ id: 7, type: 0, relationId: 0, contentType: 1, title: '真实社区帖子', content: '完整原内容', image: '/static/title.png', sliderImage: ['/static/slide.png'], likeNum: 3, commentNum: 2, playNum: 1, shareNum: 0, isLike: 0, status: 1, is_verify: 1, addTime: 1700000000, author: '平台', author_image: '/static/author.png', ...patch });
const envelope = (data, status = 200, msg = 'ok') => ({ status, msg, data });
const receipt = (body, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function setup(respond = call => receipt(envelope(call.url.includes('/config') ? flags() : [post()]))) {
  const calls = [];
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  // Real API code executes. Only transport is replaced; no application API,
  // authentication helper or localhost preview implementation is loaded.
  new Function('exports', 'fetch', 'window', 'localStorage', output)(exports, async (url, init) => {
    const call = { url, init }; calls.push(call); return respond(call, calls.length);
  }, { location: { hostname: 'localhost', search: '?preview=1&token=admin' } }, {
    getItem() { throw Error('Anonymous preview must not read admin storage'); },
  });
  return { ...exports, calls };
}

test('public DTO keeps every required Uni field plus unknown response metadata without input mutation', () => {
  const u = setup(), raw = [post({ extra: { keep: [false, 0, ''] }, videoUrl: '', video_url: '', site_url: '', is_follow: 0, is_self: 0 })], original = clone(raw);
  const rows = u.checkedDiyCommunityPublicRows(raw, 3);
  assert.deepEqual(rows, raw);
  rows[0].extra.keep.push('caller');
  rows[0].sliderImage.push('/static/new.png');
  assert.deepEqual(raw, original);
});

test('sliderImage accepts only a required nullable array containing strings', () => {
  const u = setup();
  for (const sliderImage of [null, [], ['', '/api/assets/7?expires=1&signature=old']]) assert.deepEqual(u.checkedDiyCommunityPublicRows([post({ sliderImage })], 1)[0].sliderImage, sliderImage);
  for (const sliderImage of [undefined, '', '{}', {}, [null], [1], [false], Array(1)]) assert.throws(() => u.checkedDiyCommunityPublicRows([post({ sliderImage })], 1), /格式错误/);
});

test('whole-list validation rejects private hidden unreviewed and invalid duplicate rows before deduplication', () => {
  const u = setup();
  for (const patch of [{ status: 0 }, { status: '1' }, { is_verify: undefined }, { is_verify: -2 }, { is_verify: -1 }, { is_verify: 0 }, { is_verify: '1' }, { author: 7 }, { author_image: null }, { content: null }]) {
    const rows = [post(), post(patch)], original = clone(rows);
    assert.throws(() => u.checkedDiyCommunityPublicRows(rows, 2), /非公开|格式错误/);
    assert.deepEqual(rows, original);
  }
});

test('required identity counters content flags and timestamps follow the public strict DTO', () => {
  const u = setup(), invalid = [
    { id: 0 }, { id: 2147483648 }, { id: '7' }, { type: -1 }, { type: 0.5 }, { type: NaN }, { relationId: -1 }, { relationId: 2147483648 },
    { contentType: '1' }, { contentType: 0 }, { contentType: 3 }, { isLike: true }, { isLike: 2 }, { title: null }, { content: undefined }, { image: 7 },
    { likeNum: -1 }, { commentNum: '0' }, { playNum: 2147483648 }, { shareNum: NaN }, { share_num: null }, { addTime: undefined }, { addTime: -1 },
    { videoUrl: 7 }, { video_url: null }, { site_url: {} }, { is_follow: 2 }, { is_self: false },
  ];
  for (const patch of invalid) assert.throws(() => u.checkedDiyCommunityPublicRows([post(patch)], 1), /格式错误/);
  assert.equal(u.checkedDiyCommunityPublicRows([post({ type: 2, relationId: 99, contentType: 2, isLike: 1, shareNum: undefined, share_num: 3, author: undefined, author_image: undefined })], 1).length, 1);
});

test('deduplication preserves the first valid identity only after the full raw count has passed', () => {
  const u = setup(), raw = [post({ title: 'first' }), post({ title: 'later' }), post({ id: 8 })];
  assert.deepEqual(u.checkedDiyCommunityPublicRows(raw, 3).map(row => [row.id, row.title]), [[7, 'first'], [8, '真实社区帖子']]);
  assert.throws(() => u.checkedDiyCommunityPublicRows(raw, 2), /列表格式错误/);
  for (const value of [null, {}, { list: [post()] }, '[]', [null], [false], Array(1)]) assert.throws(() => u.checkedDiyCommunityPublicRows(value, 3), /格式错误/);
});

test('strict limit rejects fractional string or out-of-range input before any transport', async () => {
  const u = setup();
  for (const limit of [undefined, null, false, '3', 0, -1, 1.1, 101, NaN, Infinity]) {
    assert.throws(() => u.checkedDiyCommunityPublicRows([], limit), /整数/);
    await assert.rejects(u.apiDiyCommunityPreview(limit), /整数/);
  }
  assert.deepEqual(u.calls, []);
});

test('two actual guest GET requests use only Accept omit no-store and the identical original AbortSignal', async () => {
  const u = setup(), controller = new AbortController();
  assert.deepEqual(await u.apiDiyCommunityPreview(3, controller.signal), { open: true, rows: [post()], message: '' });
  assert.deepEqual(u.calls.map(call => call.url), ['/api/community/config', '/api/community/list?page=1&limit=3&is_follow=0']);
  for (const { init } of u.calls) {
    assert.deepEqual(Object.keys(init).sort(), ['cache', 'credentials', 'headers', 'method', 'signal']);
    assert.equal(init.method, 'GET');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.cache, 'no-store');
    assert.strictEqual(init.signal, controller.signal);
    assert.deepEqual(init.headers, { Accept: 'application/json' });
    assert.equal(Object.hasOwn(init.headers, 'Authorization'), false);
  }
});

test('localhost preview query and admin storage cannot substitute fixture posts or add auth', async () => {
  const real = post({ id: 98, title: '后端真实响应' }), u = setup(call => receipt(envelope(call.url.includes('/config') ? flags() : [real])));
  const result = await u.apiDiyCommunityPreview(100);
  assert.deepEqual(result.rows, [real]);
  assert.equal(u.calls[1].url, '/api/community/list?page=1&limit=100&is_follow=0');
  assert.equal(u.calls.some(call => /topic|preview|token|admin|detail|state|browse|like|share/.test(call.url)), false);
});

test('all three flags must be exact zero or one even when comments are disabled', async () => {
  for (const status of [0, 1]) for (const comments of [0, 1]) for (const add of [0, 1]) {
    const u = setup(call => receipt(envelope(call.url.includes('/config') ? flags(status, comments, add) : [])));
    const result = await u.apiDiyCommunityPreview(1);
    assert.equal(result.open, status === 1);
    assert.deepEqual(result.rows, []);
    assert.equal(u.calls.length, status === 1 ? 2 : 1);
  }
});

test('malformed or incomplete flags throw before list reads rather than silently closing', async () => {
  for (const config of [null, [], {}, { community_status: 0 }, flags('1'), { ...flags(), community_comment_status: undefined }, flags(1, 1, false), flags(0, 2, 1), flags(1, '0', 1)]) {
    const u = setup(() => receipt(envelope(config)));
    await assert.rejects(u.apiDiyCommunityPreview(3), /开关格式错误/);
    assert.equal(u.calls.length, 1);
  }
});

test('explicit community closure returns no posts and never starts the list request', async () => {
  const u = setup(() => receipt(envelope(flags(0))));
  assert.deepEqual(await u.apiDiyCommunityPreview(3), { open: false, rows: [], message: '社区暂未开放' });
  assert.equal(u.calls.length, 1);
});

test('non-server 410010 refusals from config or list return closed with the server message', async () => {
  for (const at of ['config', 'list']) for (const httpStatus of [200, 403]) {
    const u = setup(call => call.url.includes(at) ? receipt(envelope(null, 410010, '社区暂未开放'), httpStatus) : receipt(envelope(flags())));
    assert.deepEqual(await u.apiDiyCommunityPreview(3), { open: false, rows: [], message: '社区暂未开放' });
    assert.equal(u.calls.length, at === 'config' ? 1 : 2);
  }
});

test('only exact known 503 closure receipts are distinguished from generic server errors', async () => {
  for (const message of ['社区暂未开放', '站点升级中，请稍候访问']) for (const at of ['config', 'list']) {
    const u = setup(call => call.url.includes(at) ? receipt(envelope(null, 410010, message), 503) : receipt(envelope(flags())));
    assert.deepEqual(await u.apiDiyCommunityPreview(3), { open: false, rows: [], message });
    assert.equal(u.calls.length, at === 'config' ? 1 : 2);
  }
  for (const [httpStatus, status, message] of [[503, 410010, '未知服务故障'], [500, 410010, '社区暂未开放'], [503, 503, '社区暂未开放'], [503, 200, 'ok']]) {
    const u = setup(() => receipt(envelope(null, status, message), httpStatus));
    await assert.rejects(u.apiDiyCommunityPreview(3));
    assert.equal(u.calls.length, 1);
  }
});

test('network and JSON failures throw their actual error without reading the next endpoint', async () => {
  for (const at of ['config', 'list']) for (const phase of ['fetch', 'json']) {
    const error = new Error(`${at}-${phase}`), u = setup(call => {
      if (!call.url.includes(at)) return receipt(envelope(flags()));
      if (phase === 'fetch') throw error;
      return { status: 200, ok: true, json: async () => { throw error; } };
    });
    await assert.rejects(u.apiDiyCommunityPreview(3), reason => reason === error);
    assert.equal(u.calls.length, at === 'config' ? 1 : 2);
  }
});

test('malformed envelopes and non-200 business receipts fail explicitly', async () => {
  for (const body of [null, [], {}, { status: '200', msg: 'ok', data: flags() }, { status: 200, data: flags() }, { status: 200, msg: 'ok' }, envelope(flags(), 400, '业务失败')]) {
    const u = setup(() => receipt(body));
    await assert.rejects(u.apiDiyCommunityPreview(3), /响应格式错误|业务失败/);
    assert.equal(u.calls.length, 1);
  }
  const u = setup(() => receipt(envelope(flags()), 404));
  await assert.rejects(u.apiDiyCommunityPreview(3));
  assert.equal(u.calls.length, 1);
});

test('invalid public list receipts are thrown as whole-batch errors instead of rendering partial content', async () => {
  for (const rows of [{ list: [post()] }, [post(), post({ id: 8, status: 0 })], [post(), post(), post(), post()], [post({ sliderImage: [false] })]]) {
    const original = clone(rows), u = setup(call => receipt(envelope(call.url.includes('/config') ? flags() : rows)));
    await assert.rejects(u.apiDiyCommunityPreview(3), /格式错误|非公开/);
    assert.deepEqual(rows, original);
    assert.equal(u.calls.length, 2);
  }
});

test('an empty real public list remains open and contains no synthesized demonstrations', async () => {
  const u = setup(call => receipt(envelope(call.url.includes('/config') ? flags() : [])));
  assert.deepEqual(await u.apiDiyCommunityPreview(1), { open: true, rows: [], message: '' });
  assert.equal(u.calls.length, 2);
});

test('already aborted signals reject with the original reason before any I/O', async () => {
  const u = setup(), controller = new AbortController(), reason = new Error('owner changed');
  controller.abort(reason);
  await assert.rejects(u.apiDiyCommunityPreview(3, controller.signal), error => error === reason);
  assert.deepEqual(u.calls, []);
});

test('abort after config fetch resolution prevents JSON parsing and the next list I/O', async () => {
  const waiting = deferred(), controller = new AbortController(), reason = new Error('disposed');
  let parsed = 0;
  const u = setup(() => waiting.promise), pending = u.apiDiyCommunityPreview(3, controller.signal);
  controller.abort(reason);
  waiting.resolve({ status: 200, ok: true, json: async () => { parsed++; return envelope(flags()); } });
  await assert.rejects(pending, error => error === reason);
  assert.equal(parsed, 0);
  assert.equal(u.calls.length, 1);
});

test('abort during config body parsing rejects even when the fake transport ignores the signal', async () => {
  const body = deferred(), started = deferred(), controller = new AbortController(), reason = new Error('context changed');
  const u = setup(() => ({ status: 200, ok: true, json: () => { started.resolve(); return body.promise; } }));
  const pending = u.apiDiyCommunityPreview(3, controller.signal);
  await started.promise;
  controller.abort(reason);
  body.resolve(envelope(flags()));
  await assert.rejects(pending, error => error === reason);
  assert.equal(u.calls.length, 1);
});

test('abort between the config receipt and caller continuation forbids subsequent list I/O', async () => {
  const body = deferred(), started = deferred(), controller = new AbortController(), reason = new Error('between reads');
  const u = setup(() => ({ status: 200, ok: true, json: () => { started.resolve(); return body.promise; } }));
  const pending = u.apiDiyCommunityPreview(3, controller.signal);
  await started.promise;
  body.resolve(envelope(flags()));
  // Resume anonymousRead, then abort before apiDiyCommunityPreview resumes.
  await Promise.resolve();
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.equal(u.calls.length, 1);
});

test('late list response after cancellation never returns stale public posts', async () => {
  const waiting = deferred(), started = deferred(), controller = new AbortController(), reason = new Error('hidden');
  const u = setup(call => {
    if (call.url.includes('/config')) return receipt(envelope(flags()));
    started.resolve(); return waiting.promise;
  });
  const pending = u.apiDiyCommunityPreview(3, controller.signal);
  await started.promise;
  controller.abort(reason);
  waiting.resolve(receipt(envelope([post()])));
  await assert.rejects(pending, error => error === reason);
  assert.equal(u.calls.length, 2);
});
