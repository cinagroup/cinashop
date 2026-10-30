const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const H = require('./helpers/bargain-records-runtime.cjs');
const { tick, copy, deferred, all, text, buttons, byLabel, replay, click, update } = H;
const BASE = '/wechat/open', PREFIX = 'cinashop_wechat_open_pending_v1_';
const ID = '11111111-1111-4111-8111-111111111111', ID2 = '22222222-2222-4222-8222-222222222222';
const APP = 'wx0123456789abcdef', REVISION = 'a'.repeat(64);
const pending = (id = ID, actor = 7) => ({ version: 1, actor_id: actor, request_id: id });
const key = (id = ID, actor = 7) => PREFIX + actor + '_' + id;
const snapshot = (patch = {}) => ({ settings: { wechat_open_app_id: APP }, raw_public_values: { wechat_open_app_id: JSON.stringify(APP) },
  secrets: { wechat_open_app_secret: { present: true, valid: true } }, revision: REVISION, runtime_ready: true,
  credentials: { database_enabled: false, authority: 'disabled', ready: false, deployment_secret_present: false }, issues: [], ...patch });
const receipt = (id = ID, patch = {}) => ({ request_id: id, actor_id: 7, state: 'committed', revision: 'b'.repeat(64), created_at: 1793100000, replayed: false, cache_status: 'cleared', ...patch });
const envelope = data => ({ data }), failure = (httpStatus, msg) => ({ httpStatus, status: httpStatus, msg, data: null });
const capture = (r, label, index = 0) => { const n = buttons(r, label)[index]; assert.ok(n, 'actual native button ' + label); return n.props.onClick; };
const journal = r => [...r.storage].filter(([name]) => name.startsWith(PREFIX));
const saves = r => r.calls.filter(c => c.method === 'POST' && c.url === BASE);
const reads = r => r.calls.filter(c => c.method === 'GET' && c.url === BASE);
const receipts = r => r.calls.filter(c => c.method === 'GET' && c.url.startsWith(BASE + '/operations/'));
const seals = r => r.calls.filter(c => c.method === 'POST' && c.url.endsWith('/resolve'));

function runtime(options = {}) {
  let r;
  const state = { snapshot: snapshot(options.snapshot), records: new Map(), nextRevision: 10 }, confirmations = [];
  function answer(call, fallback) {
    if (call.url === '/login') return fallback();
    if (call.method === 'GET' && call.url === BASE) return envelope(copy(state.snapshot));
    if (call.method === 'POST' && call.url === BASE) {
      const body = call.body;
      if (state.records.has(body.request_id)) return envelope(copy(state.records.get(body.request_id)));
      const result = receipt(body.request_id, { actor_id: r.auth.userInfo.id }); state.records.set(body.request_id, result);
      state.snapshot.settings = copy(body.settings); state.snapshot.credentials.database_enabled = body.database_credentials; state.snapshot.credentials.authority = body.database_credentials ? 'database' : 'disabled'; state.snapshot.credentials.ready = body.database_credentials;
      state.snapshot.revision = (++state.nextRevision).toString(16).padStart(64, '0');
      for (const name of Object.keys(body.secrets)) if (body.secrets[name].action !== 'keep') state.snapshot.secrets[name] = { present: body.secrets[name].action === 'replace', valid: body.secrets[name].action === 'replace' };
      return envelope(copy(result));
    }
    if (call.method === 'GET' && call.url.startsWith(BASE + '/operations/')) {
      const value = state.records.get(call.url.split('/').at(-1)); return value ? envelope(copy(value)) : { status: 404, msg: '公众号配置回执不存在', data: null };
    }
    if (call.method === 'POST' && call.url.endsWith('/resolve')) {
      const id = call.url.split('/').at(-2); assert.deepEqual(call.body, { confirmed: true });
      if (!state.records.has(id)) state.records.set(id, receipt(id, { actor_id: r.auth.userInfo.id, state: 'not_applied', cache_status: 'not_required' }));
      return envelope(copy(state.records.get(id)));
    }
    throw Error('Unexpected open controlled transport ' + call.method + ' ' + call.url);
  }
  r = H.runtime({ page: 'pages/content/WechatOpenAuthor.vue', permissions: options.permissions ?? ['wechat_open.view', 'wechat_open.manage'],
    send(call, fallback) { if (typeof call.body === 'string') { call.rawBody = call.body; call.body = JSON.parse(call.body); }
      const next = () => answer(call, fallback); return options.send ? options.send(call, next, r) : next(); } });
  r.route.fullPath = '/content/wechat-open'; r.window.location.pathname = '/content/wechat-open';
  r.window.confirm = value => { confirmations.push(String(value)); return options.confirm ? options.confirm(value, r) : true; };
  r.window.navigator = { clipboard: { writeText: async value => { r.clipboard.push(value); } } }; r.clipboard = [];
  for (const item of options.pending ?? []) r.storage.set(key(item.request_id, item.actor_id), JSON.stringify(item));
  if (options.stored !== undefined) r.storage.set(key(), typeof options.stored === 'string' ? options.stored : JSON.stringify(options.stored));
  return Object.assign(r, { server: state, confirmations, journal: () => journal(r), saves: () => saves(r),
    api: () => r.load(path.join(H.root, 'api/wechatOpen.ts')), common: () => r.load(path.join(H.repository, 'view/common/wechatOpen.ts')) });
}
function scenario(name, fn) { test(name, async () => { const mounted = [], mount = async options => { const r = runtime(options); mounted.push(r); await tick(); return r; };
  try { await fn(mount); } finally { for (const r of mounted) await r.finish(); } }); }
const save = r => click(r, '确认并保存配置');
async function replace(r, label, value) { await update(r, label + '处理方式', 'replace'); await update(r, '新' + label, value); }
async function unknown(mount, committed = true, patch = {}) { return mount({ ...patch, send(call, next, r) { if (call.method === 'POST' && call.url === BASE) { if (committed) next(); throw Error('Network Error'); } return patch.send ? patch.send(call, next, r) : next(); } }); }

scenario('switching replace to keep drops the typed material rather than silently posting it', async mount => {
  const r = await mount(); await replace(r, 'AppSecret', 'PRIVATE_DROPPED'); await update(r, 'AppSecret处理方式', 'keep'); await save(r);
  assert.deepEqual(saves(r)[0].body.secrets.wechat_open_app_secret, { action: 'keep' }); assert.ok(!saves(r)[0].rawBody.includes('PRIVATE_DROPPED'));
});
scenario('same input node accepts fast typing while the earlier save callback is retired', async mount => {
  const r = await mount(); const n = byLabel(r, '网站应用AppID'), input = n.props.onInput, old = capture(r, '确认并保存配置');
  for (const value of ['w', 'wx', APP]) replay(input, { target: { value } }); await tick(); assert.strictEqual(byLabel(r, '网站应用AppID'), n); assert.equal(n.props.value, APP);
  replay(old, {}); await tick(); assert.equal(saves(r).length, 0); await save(r); assert.equal(saves(r)[0].body.settings.wechat_open_app_id, APP);
});
scenario('secret input callbacks retire across replace/keep/replace ABA without losing legitimate fast input', async mount => {
  const r = await mount(); await update(r, 'AppSecret处理方式', 'replace'); const n = byLabel(r, '新AppSecret'), old = n.props.onInput;
  for (const value of ['T', 'To', 'AppSecret123']) replay(old, { target: { value } }); await tick(); assert.strictEqual(byLabel(r, '新AppSecret'), n); assert.equal(n.props.value, 'AppSecret123');
  await update(r, 'AppSecret处理方式', 'keep'); await update(r, 'AppSecret处理方式', 'replace'); replay(old, { target: { value: 'OLD_TOKEN' } }); await tick(); assert.equal(byLabel(r, '新AppSecret').props.value, '');
});
scenario('no view permission performs no configuration or gallery read', async mount => {
  const r = await mount({ permissions: [] }); assert.equal(r.calls.length, 0); assert.match(text(r.tree), /没有微信开放平台查看权限/);
});
scenario('runtime readiness blocks a replayed save without hiding the complete readable form', async mount => {
  const r = await mount({ snapshot: { runtime_ready: false } }); assert.ok(byLabel(r, '网站应用AppID')); replay(capture(r, '确认并保存配置'), {}); await tick(); assert.equal(saves(r).length, 0);
});
scenario('cancelled save confirmation neither persists a UUID nor posts', async mount => {
  const r = await mount({ confirm: () => false }); await save(r); assert.equal(journal(r).length, 0); assert.equal(saves(r).length, 0);
});
scenario('input mutation during confirmation retires the frozen save draft', async mount => {
  const r = await mount({ confirm(_message, host) { replay(byLabel(host, '网站应用AppID').props.onInput, { target: { value: 'wx1111111111111111' } }); return true; } });
  await save(r); assert.equal(saves(r).length, 0); assert.equal(journal(r).length, 0);
});
scenario('same-render Enter uses the current native form lease and never a stale save callback', async mount => {
  const r = await mount(); const old = all(r.tree, n => n.tag === 'form')[0].props.onKeydown;
  await update(r, '网站应用AppID', 'wx1111111111111111'); replay(old, { key: 'Enter', target: { tagName: 'INPUT', readOnly: false, disabled: false }, preventDefault() {} }); await tick(); assert.equal(saves(r).length, 0);
  replay(all(r.tree, n => n.tag === 'form')[0].props.onKeydown, { key: 'Enter', target: { tagName: 'INPUT', readOnly: false, disabled: false }, preventDefault() {} }); await tick(); assert.equal(saves(r).length, 1);
});
scenario('Enter on native selects, buttons or the readonly endpoint does not accidentally save', async mount => {
  const r = await mount(), enter = all(r.tree, n => n.tag === 'form')[0].props.onKeydown;
  for (const target of [{ tagName: 'SELECT' }, { tagName: 'BUTTON' }, { tagName: 'INPUT', readOnly: true }]) replay(enter, { key: 'Enter', target, preventDefault() {} });
  await tick(); assert.equal(saves(r).length, 0); assert.equal(journal(r).length, 0);
});
scenario('journal persistence is complete and credential-free before the first save transport begins', async mount => {
  let seen = false; const r = await mount({ send(call, next, host) { if (call.method === 'POST' && call.url === BASE) { seen = true; const entries = journal(host); assert.equal(entries.length, 1); assert.deepEqual(JSON.parse(entries[0][1]), pending(call.body.request_id)); } return next(); } });
  await replace(r, 'AppSecret', 'PRIVATE_PENDING_VALUE'); await save(r); assert.equal(seen, true);
  assert.ok(r.writes.every(write => !String(write.value).includes('PRIVATE_PENDING_VALUE')));
});
scenario('storage failure before dispatch produces no POST and does not leak replacement material', async mount => {
  const r = await mount(); await replace(r, 'AppSecret', 'PRIVATE_NO_PERSIST'); const before = r.writes.length;
  // A Map set failure is the actual storage adapter failure, not an API mock.
  r.storage.set = () => { throw Error('storage denied'); }; await save(r); assert.equal(saves(r).length, 0); assert.ok(!JSON.stringify(r.writes.slice(before)).includes('PRIVATE_NO_PERSIST'));
});
scenario('committed lost ACK is recovered by GET only with no second secret POST', async mount => {
  const r = await unknown(mount, true); await replace(r, 'AppSecret', 'PRIVATE_LOST_ACK'); await save(r); assert.equal(saves(r).length, 1); assert.equal(journal(r).length, 1);
  assert.equal(byLabel(r, '新AppSecret'), undefined); await click(r, '读取保存回执'); assert.equal(receipts(r).length, 1); assert.equal(journal(r).length, 0); assert.equal(saves(r).length, 1); assert.match(text(r.tree), /配置已保存/);
});
scenario('404 receipt remains unknown and only explicit resolve can seal a missing request', async mount => {
  const r = await unknown(mount, false); await save(r); const id = JSON.parse(journal(r)[0][1]).request_id;
  await click(r, '读取保存回执'); assert.equal(journal(r).length, 1); assert.match(text(r.tree), /没有回执不代表未保存/);
  await click(r, '核对并封存未受理请求'); assert.equal(journal(r).length, 0); assert.equal(saves(r).length, 1); assert.equal(seals(r)[0].url, BASE + '/operations/' + id + '/resolve'); assert.deepEqual(seals(r)[0].body, { confirmed: true });
});
scenario('cancelled resolve confirmation preserves unknown UUID and issues no sealing POST', async mount => {
  const r = await unknown(mount, false, { confirm: message => !message.startsWith('确认核对并封存') }); await save(r); await click(r, '核对并封存未受理请求'); assert.equal(seals(r).length, 0); assert.equal(journal(r).length, 1);
});
scenario('unknown operation is restored after actual unmount/remount without any secret draft', async mount => {
  const r = await unknown(mount, false); await replace(r, 'AppSecret', 'PRIVATE_UNMOUNT'); await save(r); const entries = journal(r);
  r.visible.value = false; await tick(); r.visible.value = true; await tick(); assert.deepEqual(journal(r), entries); assert.equal(byLabel(r, '新AppSecret'), undefined); assert.equal(saves(r).length, 1);
});
scenario('multiple owner UUIDs are recovered independently and only the selected terminal identifier is removed', async mount => {
  const r = await mount({ pending: [pending(ID), pending(ID2)] }); assert.equal(journal(r).length, 2); assert.equal(buttons(r, '确认并保存配置')[0].props.disabled, true);
  await click(r, ID2); await click(r, '核对并封存未受理请求'); assert.equal(journal(r).length, 1); assert.equal(journal(r)[0][0], key(ID)); await click(r, '核对并封存未受理请求'); assert.equal(journal(r).length, 0);
});
scenario('a retained receipt/resolve callback cannot cross selected-UUID ABA', async mount => {
  const r = await mount({ pending: [pending(ID), pending(ID2)] }); const old = capture(r, '核对并封存未受理请求'); await click(r, ID2); await click(r, ID);
  replay(old, {}); await tick(); assert.equal(seals(r).length, 0); await click(r, '核对并封存未受理请求'); assert.equal(seals(r).length, 1);
});
scenario('view and management revocation still permits exact owner recovery without re-reading configuration', async mount => {
  const r = await mount({ pending: [pending()] }); const before = reads(r).length; r.sync({ uniqueAuth: [] }); await tick(); assert.equal(reads(r).length, before);
  await click(r, '核对并封存未受理请求'); assert.equal(seals(r).length, 1); assert.equal(journal(r).length, 0); assert.equal(reads(r).length, before);
});
scenario('other owners cannot restore, clear or submit the former owner identifier', async mount => {
  const r = await mount({ pending: [pending()] }); const old = capture(r, '核对并封存未受理请求'); r.sync({ userInfo: { ...r.auth.userInfo, id: 8 }, token: 'owner-B' }); await tick();
  replay(old, {}); await tick(); assert.equal(seals(r).length, 0); assert.ok(r.storage.has(key(ID, 7))); assert.equal(buttons(r, '读取保存回执').length, 0);
});
scenario('a forged receipt actor never clears the current owner journal', async mount => {
  const r = await mount({ pending: [pending()], send(call, next) { return call.method === 'GET' && call.url.includes('/operations/') ? envelope(receipt(ID, { actor_id: 99 })) : next(); } });
  await click(r, '读取保存回执'); assert.equal(journal(r).length, 1); assert.match(text(r.tree), /身份或终态无效/);
});
scenario('an invalid terminal receipt status or extra secret response is rejected without clearing pending', async mount => {
  const r = await mount({ pending: [pending()], send(call, next) { return call.method === 'GET' && call.url.includes('/operations/') ? envelope({ ...receipt(), state: 'unknown', secret: 'must-not-display' }) : next(); } });
  await click(r, '读取保存回执'); assert.equal(journal(r).length, 1); assert.ok(!text(r.tree).includes('must-not-display'));
});
scenario('malformed owner-local journal blocks a new save and is never silently discarded', async mount => {
  const r = await mount({ stored: { ...pending(), secret: 'not-allowed' } }); assert.match(text(r.tree), /标识身份无效/); assert.ok(r.storage.has(key())); assert.equal(saves(r).length, 0);
});
scenario('HTTP409 preserves the UUID and shows the bounded real Axios server message', async mount => {
  const r = await mount({ send(call, next) { return call.method === 'POST' && call.url === BASE ? failure(409, '配置版本已变化，请核对') : next(); } }); await save(r);
  assert.equal(journal(r).length, 1); assert.match(text(r.tree), /配置版本已变化，请核对/); assert.equal(saves(r).length, 1);
});
scenario('cache-pending committed receipt is a terminal save with an accurate cache warning', async mount => {
  const r = await mount({ send(call, next) { const value = next(); if (call.method === 'POST' && call.url === BASE) value.data.cache_status = 'pending'; return value; } }); await save(r);
  assert.equal(journal(r).length, 0); assert.match(text(r.tree), /部分缓存清理尚未完成/);
});
scenario('success notice retires before the next unknown request', async mount => {
  let writes = 0; const r = await mount({ send(call, next) { if (call.method === 'POST' && call.url === BASE && ++writes === 2) throw Error('Network Error'); return next(); } });
  await save(r); assert.match(text(r.tree), /开放平台配置已保存/); await save(r); assert.ok(!text(r.tree).includes('开放平台配置已保存。')); assert.equal(journal(r).length, 1);
});
scenario('query/route ABA retires native field/save/Enter callbacks', async mount => {
  const r = await mount(); const input = byLabel(r, '网站应用AppID').props.onInput, saveFn = capture(r, '确认并保存配置'), enter = all(r.tree, n => n.tag === 'form')[0].props.onKeydown;
  r.route.fullPath = '/content/wechat-open?q=1'; await tick(); r.route.fullPath = '/content/wechat-open'; await tick();
  replay(input, { target: { value: 'wx1111111111111111' } }); replay(saveFn, {}); replay(enter, { key: 'Enter', target: { tagName: 'INPUT', readOnly: false, disabled: false }, preventDefault() {} }); await tick(); assert.equal(saves(r).length, 0); assert.equal(byLabel(r, '网站应用AppID').props.value, APP);
});
scenario('identity/token ABA retires old generation and clears replacement secrets from memory', async mount => {
  const r = await mount(); await replace(r, 'AppSecret', 'PRIVATE_OLD_OWNER'); const old = capture(r, '确认并保存配置'), original = copy(r.auth.userInfo);
  r.sync({ token: 'new-B', userInfo: { ...original, id: 8 } }); await tick(); r.sync({ token: 'read-A', userInfo: original }); await tick(); replay(old, {}); await tick();
  assert.equal(saves(r).length, 0); assert.equal(byLabel(r, '新AppSecret'), undefined);
});
scenario('storage session invalidation retires a retained confirmation callback even when values are equal', async mount => {
  const r = await mount(); const old = capture(r, '确认并保存配置'); r.sync({}, 'storage'); await tick(); replay(old, {}); await tick(); assert.equal(saves(r).length, 0);
});
scenario('successful same-payload login retires secret fields and prior native save handlers', async mount => {
  const r = await mount(); await replace(r, 'AppSecret', 'PRIVATE_BEFORE_LOGIN'); const old = capture(r, '确认并保存配置');
  await r.auth.login('operator', 'owned-password'); await tick(); replay(old, {}); await tick();
  assert.equal(byLabel(r, '新AppSecret'), undefined); assert.equal(saves(r).length, 0);
});
scenario('failed login does not retire the still-current owner draft', async mount => {
  const r = await mount({ send(call, next) { return call.url === '/login' ? failure(503, '登录服务暂不可用') : next(); } });
  await replace(r, 'AppSecret', 'PRIVATE_STILL_CURRENT'); await assert.rejects(r.auth.login('operator', 'wrong')); await tick();
  assert.equal(byLabel(r, '新AppSecret').props.value, 'PRIVATE_STILL_CURRENT'); await save(r); assert.equal(saves(r).length, 1);
});
scenario('a lease that observes direct token mismatch stays retired after token ABA', async mount => {
  const r = await mount(), old = capture(r, '确认并保存配置'); r.storage.set('admin_token', 'temporary-B'); replay(old, {}); await tick();
  r.storage.set('admin_token', r.auth.token); replay(old, {}); await tick(); assert.equal(saves(r).length, 0);
});
scenario('a late catalog rejection and finally cannot overwrite the replacement generation', async mount => {
  const old = deferred(); let read = 0; const r = await mount({ send(call, next) { if (call.method === 'GET' && call.url === BASE && ++read === 2) return old.promise; return next(); } });
  await click(r, '重新读取'); r.route.fullPath = '/content/wechat-open?fresh=1'; await tick(); assert.equal(byLabel(r, '网站应用AppID').props.value, APP);
  old.reject(Error('late old failure')); await tick(); assert.ok(!text(r.tree).includes('late old failure')); assert.equal(r.bindings.loading, false);
});
scenario('a late committed ACK after owner change never clears the original owner journal', async mount => {
  const hold = deferred(); const r = await mount({ send(call, next) { if (call.method === 'POST' && call.url === BASE) { const result = next(); hold.result = result; return hold.promise; } return next(); } });
  await save(r); const old = journal(r)[0][0]; r.sync({ userInfo: { ...r.auth.userInfo, id: 8 }, token: 'owner-B' }); await tick(); hold.resolve(hold.result); await tick(); assert.ok(r.storage.has(old)); assert.ok(!text(r.tree).includes('开放平台配置已保存。'));
});
scenario('unmount retires captured callbacks and a fresh mount creates current controls', async mount => {
  const r = await mount(); const old = capture(r, '确认并保存配置'); r.visible.value = false; await tick(); replay(old, {}); await tick(); assert.equal(saves(r).length, 0);
  r.visible.value = true; await tick(); replay(old, {}); await tick(); assert.equal(saves(r).length, 0); await save(r); assert.equal(saves(r).length, 1);
});

scenario('full two-field author and explicit credential authority render without unrelated requests', async mount => {
  const r = await mount(); assert.ok(byLabel(r, '网站应用AppID')); assert.ok(byLabel(r, 'AppSecret处理方式')); assert.ok(byLabel(r, '数据库凭据'));
  assert.equal(all(r.tree, n => n.tag === 'input' && n.props.type === 'password').length, 0); assert.ok(r.calls.every(c => c.url === BASE));
  await save(r); assert.deepEqual(saves(r)[0].body.secrets, { wechat_open_app_secret: { action: 'keep' } }); assert.equal(saves(r)[0].body.database_credentials, false);
});
scenario('deployment binding blocks copied native AppID handler while keeping secret staging explicit', async mount => {
  const r = await mount({ snapshot: { credentials: { database_enabled: false, authority: 'deployment', ready: true, deployment_secret_present: true } } });
  assert.equal(byLabel(r, '网站应用AppID').props.disabled, true); replay(byLabel(r, '网站应用AppID').props.onInput, { target: { value: 'wx1111111111111111' } }); await tick();
  await replace(r, 'AppSecret', 'NEW_STAGED_SECRET'); await save(r); assert.equal(saves(r)[0].body.settings.wechat_open_app_id, APP); assert.deepEqual(saves(r)[0].body.secrets.wechat_open_app_secret, { action: 'replace', value: 'NEW_STAGED_SECRET' });
});
scenario('enable and clear are explicit independent intents without storing material', async mount => {
  const r = await mount(); await update(r, '数据库凭据', '1'); await replace(r, 'AppSecret', 'NEW_RUNTIME_SECRET'); await save(r);
  assert.equal(saves(r)[0].body.database_credentials, true); assert.ok(!JSON.stringify(r.writes).includes('NEW_RUNTIME_SECRET'));
  await update(r, '数据库凭据', '0'); await update(r, 'AppSecret处理方式', 'clear'); await save(r); assert.deepEqual(saves(r)[1].body.secrets.wechat_open_app_secret, { action: 'clear' });
});
scenario('view-only controls and retained callbacks never write', async mount => {
  const r = await mount({ permissions: ['wechat_open.view'] }); assert.equal(byLabel(r, '网站应用AppID').props.disabled, true);
  replay(byLabel(r, '网站应用AppID').props.onInput, { target: { value: 'wx1111111111111111' } }); replay(capture(r, '确认并保存配置'), {}); await tick(); assert.equal(saves(r).length, 0);
});
scenario('explicitly clearing enabled database credentials is rejected locally until the operator disables them', async mount => {
  const r = await mount({ snapshot: { credentials: { database_enabled: true, authority: 'database', ready: true, deployment_secret_present: false } } });
  await update(r, 'AppSecret处理方式', 'clear'); await save(r); assert.equal(saves(r).length, 0); assert.equal(journal(r).length, 0); assert.match(text(r.tree), /清空密钥前请停用数据库凭据/);
  await update(r, '数据库凭据', '0'); await save(r); assert.equal(saves(r).length, 1); assert.equal(saves(r)[0].body.database_credentials, false);
});
scenario('switching an enabled database AppID requires explicit new application Secret before journaling', async mount => {
  const r = await mount({ snapshot: { credentials: { database_enabled: true, authority: 'database', ready: true, deployment_secret_present: false } } });
  await update(r, '网站应用AppID', 'wx1111111111111111'); await save(r); assert.equal(saves(r).length, 0); assert.equal(journal(r).length, 0); assert.match(text(r.tree), /明确替换新应用的AppSecret/);
  await replace(r, 'AppSecret', 'NEW_ACCOUNT_SECRET'); await save(r); assert.equal(saves(r).length, 1); assert.equal(saves(r)[0].body.settings.wechat_open_app_id, 'wx1111111111111111');
});
