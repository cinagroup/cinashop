const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const H = require('./helpers/bargain-records-runtime.cjs');
const { tick, copy, deferred, all, text, buttons, byLabel, replay, click, update } = H;
const BASE = '/wechat/base', PREFIX = 'cinashop_wechat_base_pending_v1_';
const ID = '11111111-1111-4111-8111-111111111111', ID2 = '22222222-2222-4222-8222-222222222222';
const APP = 'wx0123456789abcdef', REVISION = 'a'.repeat(64);
const preview = id => `/api/assets/${id}?expires=1793100000&signature=${'a'.repeat(43)}`;
const pending = (id = ID, actor = 7) => ({ version: 1, actor_id: actor, request_id: id });
const key = (id = ID, actor = 7) => PREFIX + actor + '_' + id;
const snapshot = (patch = {}) => ({ settings: { wechat_appid: APP, wechat_encode: 0, share_qrcode: 0, spread_share_forever: 0, wechat_qrcode: '/api/assets/1', create_wechat_user: 1 },
  raw_public_values: { wechat_appid: JSON.stringify(APP), wechat_encode: '0', share_qrcode: '0', spread_share_forever: '"0"', wechat_qrcode: '"/api/assets/1"', create_wechat_user: '1' },
  secrets: { wechat_appsecret: { present: true, valid: true }, wechat_encodingaeskey: { present: true, valid: true }, wechat_token: { present: true, valid: true } },
  revision: REVISION, runtime_ready: true, api: 'https://shop.example.test/api/wechat/serve',
  callback: { database_enabled: false, authority: 'deployment', ready: true, mode: 2, deployment_token_present: true, deployment_aes_present: true },
  asset_previews: { wechat_qrcode: preview(1) }, issues: [], ...patch });
const receipt = (id = ID, patch = {}) => ({ request_id: id, actor_id: 7, state: 'committed', revision: 'b'.repeat(64), created_at: 1793100000, replayed: false, cache_status: 'cleared', ...patch });
const envelope = data => ({ data }), failure = (httpStatus, msg) => ({ httpStatus, status: httpStatus, msg, data: null });
const capture = (r, label, index = 0) => { const n = buttons(r, label)[index]; assert.ok(n, 'actual native button ' + label); return n.props.onClick; };
const css = (r, cls) => all(r.tree, n => String(n.props.class ?? '').split(' ').includes(cls));
const journal = r => [...r.storage].filter(([name]) => name.startsWith(PREFIX));
const saves = r => r.calls.filter(c => c.method === 'POST' && c.url === BASE);
const reads = r => r.calls.filter(c => c.method === 'GET' && c.url === BASE);
const receipts = r => r.calls.filter(c => c.method === 'GET' && c.url.startsWith(BASE + '/operations/'));
const seals = r => r.calls.filter(c => c.method === 'POST' && c.url.endsWith('/resolve'));
const optionsCalls = r => r.calls.filter(c => c.url.endsWith('/attachment-options'));
const option = (id, pid = 0) => ({ att_id: id, pid, real_name: '平台图片' + id, reference: '/api/assets/' + id, preview: preview(id) });

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
      state.snapshot.settings = copy(body.settings); state.snapshot.callback.database_enabled = body.database_callback;
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
    if (call.url.endsWith('/attachment-categories')) return envelope({ list: [{ id: 1, pid: 0, name: '公众号图片' }] });
    if (call.url.endsWith('/attachment-options')) {
      const { page, limit, pid, name } = call.params, total = name ? 1 : 21;
      return envelope({ list: Array.from({ length: Math.max(0, Math.min(limit, total - (page - 1) * limit)) }, (_, i) => option((page - 1) * limit + i + 1 + pid * 100, pid)), count: total, page, limit });
    }
    throw Error('Unexpected base controlled transport ' + call.method + ' ' + call.url);
  }
  r = H.runtime({ page: 'pages/content/WechatBaseAuthor.vue', permissions: options.permissions ?? ['wechat_base.view', 'wechat_base.manage'],
    send(call, fallback) { if (typeof call.body === 'string') { call.rawBody = call.body; call.body = JSON.parse(call.body); }
      const next = () => answer(call, fallback); return options.send ? options.send(call, next, r) : next(); } });
  r.route.fullPath = '/content/wechat-base'; r.window.location.pathname = '/content/wechat-base';
  r.window.confirm = value => { confirmations.push(String(value)); return options.confirm ? options.confirm(value, r) : true; };
  r.window.navigator = { clipboard: { writeText: async value => { r.clipboard.push(value); } } }; r.clipboard = [];
  for (const item of options.pending ?? []) r.storage.set(key(item.request_id, item.actor_id), JSON.stringify(item));
  if (options.stored !== undefined) r.storage.set(key(), typeof options.stored === 'string' ? options.stored : JSON.stringify(options.stored));
  return Object.assign(r, { server: state, confirmations, journal: () => journal(r), saves: () => saves(r),
    api: () => r.load(path.join(H.root, 'api/wechatBase.ts')), common: () => r.load(path.join(H.repository, 'view/common/wechatBase.ts')) });
}
function scenario(name, fn) { test(name, async () => { const mounted = [], mount = async options => { const r = runtime(options); mounted.push(r); await tick(); return r; };
  try { await fn(mount); } finally { for (const r of mounted) await r.finish(); } }); }
const save = r => click(r, '确认并保存配置');
async function replace(r, label, value) { await update(r, label + '处理方式', 'replace'); await update(r, '新' + label, value); }
async function unknown(mount, committed = true, patch = {}) { return mount({ ...patch, send(call, next, r) { if (call.method === 'POST' && call.url === BASE) { if (committed) next(); throw Error('Network Error'); } return patch.send ? patch.send(call, next, r) : next(); } }); }

scenario('current compiled template renders all three original sections, ten controls and explicit authority without unrelated reads', async mount => {
  const r = await mount(); assert.equal(reads(r).length, 1); assert.match(text(r.tree), /公众号基础设置/);
  assert.deepEqual(all(r.tree, n => n.tag === 'legend').map(text), ['公众号开发者信息', '服务器配置', '微信公众号']);
  for (const label of ['AppID', 'AppSecret处理方式', 'EncodingAESKey处理方式', 'Token处理方式', '接口地址', '消息加解密方式', '公众号分享二维码', '推广海报有效期', '关注二维码引用', '关注公众号是否生成用户']) assert.ok(byLabel(r, label), label);
  assert.equal(byLabel(r, 'AppID').props.maxlength, undefined); assert.ok(Object.hasOwn(byLabel(r, '接口地址').props, 'readonly'));
  assert.equal(saves(r).length, 0); assert.ok(r.calls.every(call => call.url === BASE));
});
scenario('a save keeps all original secrets without echoing or serializing any empty replacement', async mount => {
  const r = await mount(); assert.equal(all(r.tree, n => n.tag === 'input' && n.props.type === 'password').length, 0); await save(r);
  assert.deepEqual(saves(r)[0].body.secrets, { wechat_appsecret: { action: 'keep' }, wechat_encodingaeskey: { action: 'keep' }, wechat_token: { action: 'keep' } });
  assert.deepEqual(saves(r)[0].body.settings, snapshot().settings); assert.equal(journal(r).length, 0); assert.equal(reads(r).length, 2);
});
scenario('native public controls submit every original public value with explicit database staging', async mount => {
  const r = await mount(); await update(r, 'AppID', 'wx1111111111111111'); await update(r, '消息加解密方式', '1'); await update(r, '公众号分享二维码', '1');
  await update(r, '推广海报有效期', '1'); await update(r, '关注公众号是否生成用户', '0'); await update(r, '数据库回调权威', '1'); await click(r, '清空关注二维码'); await save(r);
  assert.deepEqual(saves(r)[0].body.settings, { wechat_appid: 'wx1111111111111111', wechat_encode: 1, share_qrcode: 1, spread_share_forever: 1, create_wechat_user: 0, wechat_qrcode: '' });
  assert.equal(saves(r)[0].body.database_callback, true); assert.match(text(r.tree), /不会覆盖部署绑定/);
});
scenario('explicit replacement and clear retain separate secret intents and never enter storage writes or confirmation text', async mount => {
  const r = await mount(); await replace(r, 'AppSecret', 'PRIVATE_REPLACEMENT_123'); await update(r, 'Token处理方式', 'clear');
  const n = byLabel(r, '新AppSecret'); assert.equal(n.props.type, 'password'); assert.equal(n.props.autocomplete, 'new-password');
  await save(r); assert.deepEqual(saves(r)[0].body.secrets.wechat_appsecret, { action: 'replace', value: 'PRIVATE_REPLACEMENT_123' });
  assert.deepEqual(saves(r)[0].body.secrets.wechat_token, { action: 'clear' });
  assert.ok(!JSON.stringify(r.writes).includes('PRIVATE_REPLACEMENT_123')); assert.ok(!r.confirmations.join().includes('PRIVATE_REPLACEMENT_123'));
  assert.equal(byLabel(r, '新AppSecret'), undefined);
});
scenario('switching replace to keep drops the typed material rather than silently posting it', async mount => {
  const r = await mount(); await replace(r, 'AppSecret', 'PRIVATE_DROPPED'); await update(r, 'AppSecret处理方式', 'keep'); await save(r);
  assert.deepEqual(saves(r)[0].body.secrets.wechat_appsecret, { action: 'keep' }); assert.ok(!saves(r)[0].rawBody.includes('PRIVATE_DROPPED'));
});
scenario('same input node accepts fast typing while the earlier save callback is retired', async mount => {
  const r = await mount(); const n = byLabel(r, 'AppID'), input = n.props.onInput, old = capture(r, '确认并保存配置');
  for (const value of ['w', 'wx', APP]) replay(input, { target: { value } }); await tick(); assert.strictEqual(byLabel(r, 'AppID'), n); assert.equal(n.props.value, APP);
  replay(old, {}); await tick(); assert.equal(saves(r).length, 0); await save(r); assert.equal(saves(r)[0].body.settings.wechat_appid, APP);
});
scenario('secret input callbacks retire across replace/keep/replace ABA without losing legitimate fast input', async mount => {
  const r = await mount(); await update(r, 'Token处理方式', 'replace'); const n = byLabel(r, '新Token'), old = n.props.onInput;
  for (const value of ['T', 'To', 'Token123']) replay(old, { target: { value } }); await tick(); assert.strictEqual(byLabel(r, '新Token'), n); assert.equal(n.props.value, 'Token123');
  await update(r, 'Token处理方式', 'keep'); await update(r, 'Token处理方式', 'replace'); replay(old, { target: { value: 'OLD_TOKEN' } }); await tick(); assert.equal(byLabel(r, '新Token').props.value, '');
});
scenario('random token and AES buttons generate cryptographic drafts with canonical lengths and copy only explicitly', async mount => {
  const r = await mount(); await click(r, '随机生成新Token'); const token = byLabel(r, '新Token').props.value; assert.match(token, /^[A-Za-z0-9]{32}$/);
  await click(r, '随机生成新EncodingAESKey'); const aes = byLabel(r, '新EncodingAESKey').props.value; assert.match(aes, /^[A-Za-z0-9]{43}$/); assert.equal(Buffer.from(aes + '=', 'base64').length, 32);
  assert.deepEqual(r.clipboard, []); await click(r, '复制新Token'); assert.deepEqual(r.clipboard, [token]);
  assert.equal(journal(r).length, 0); assert.ok(!JSON.stringify(r.writes).includes(token)); assert.ok(!JSON.stringify(r.writes).includes(aes));
});
scenario('cancelled random regeneration leaves the original keep intent intact', async mount => {
  const r = await mount({ confirm: () => false }); await click(r, '随机生成新Token'); assert.equal(byLabel(r, '新Token'), undefined); assert.equal(journal(r).length, 0);
});
scenario('API copy uses only the derived readonly address', async mount => {
  const r = await mount(); await click(r, '复制接口地址'); assert.deepEqual(r.clipboard, [snapshot().api]); assert.equal(saves(r).length, 0);
});
for (const [label, invalid] of [['AppID', 'wxshort'], ['AppID', 'bad\nappid'], ['新Token', 'ab'], ['新Token', 'token with space'], ['新EncodingAESKey', 'a'.repeat(42)], ['新AppSecret', 'bad secret']])
  scenario('invalid native author input is not journaled or posted: ' + label + ' ' + JSON.stringify(invalid), async mount => {
    const r = await mount(); if (label.startsWith('新')) await update(r, label.slice(1) + '处理方式', 'replace'); await update(r, label, invalid); await save(r);
    assert.equal(saves(r).length, 0); assert.equal(journal(r).length, 0); assert.ok(all(r.tree, n => n.props.role === 'alert').length);
  });
scenario('invalid historical public projections remain explicit null and cannot be mounted as silent defaults', async mount => {
  const row = snapshot(); row.settings.wechat_encode = null; row.raw_public_values.wechat_encode = '7'; row.issues = [{ key: 'wechat_encode', message: '历史模式需核对' }];
  const r = await mount({ snapshot: row }); assert.equal(byLabel(r, '消息加解密方式').props.value, ''); await save(r); assert.equal(saves(r).length, 0);
  await update(r, '消息加解密方式', '2'); await save(r); assert.equal(saves(r)[0].body.settings.wechat_encode, 2);
});
scenario('history raw image is not replaced with its safe preview or corrected on mount', async mount => {
  const row = snapshot(); row.settings.wechat_qrcode = 'http://legacy.example.test/uploads/raw.png'; row.asset_previews.wechat_qrcode = ''; const r = await mount({ snapshot: row });
  await save(r); assert.equal(saves(r)[0].body.settings.wechat_qrcode, row.settings.wechat_qrcode); assert.equal(all(r.tree, n => n.tag === 'img').length, 0);
});
scenario('view-only native field/save/gallery replays cannot write or select but can copy the endpoint', async mount => {
  const r = await mount({ permissions: ['wechat_base.view'] }); assert.equal(byLabel(r, 'AppID').props.disabled, true);
  replay(byLabel(r, 'AppID').props.onInput, { target: { value: 'wx1111111111111111' } }); replay(capture(r, '确认并保存配置'), {}); replay(capture(r, '从图库选择关注二维码'), {}); await tick();
  assert.equal(saves(r).length, 0); assert.equal(optionsCalls(r).length, 0); await click(r, '复制接口地址'); assert.equal(r.clipboard.length, 1);
});
scenario('no view permission performs no configuration or gallery read', async mount => {
  const r = await mount({ permissions: [] }); assert.equal(r.calls.length, 0); assert.match(text(r.tree), /没有公众号基础设置查看权限/);
});
scenario('runtime readiness blocks a replayed save without hiding the complete readable form', async mount => {
  const r = await mount({ snapshot: { runtime_ready: false } }); assert.ok(byLabel(r, 'AppID')); replay(capture(r, '确认并保存配置'), {}); await tick(); assert.equal(saves(r).length, 0);
});
scenario('cancelled save confirmation neither persists a UUID nor posts', async mount => {
  const r = await mount({ confirm: () => false }); await save(r); assert.equal(journal(r).length, 0); assert.equal(saves(r).length, 0);
});
scenario('input mutation during confirmation retires the frozen save draft', async mount => {
  const r = await mount({ confirm(_message, host) { replay(byLabel(host, 'AppID').props.onInput, { target: { value: 'wx1111111111111111' } }); return true; } });
  await save(r); assert.equal(saves(r).length, 0); assert.equal(journal(r).length, 0);
});
scenario('same-render Enter uses the current native form lease and never a stale save callback', async mount => {
  const r = await mount(); const old = all(r.tree, n => n.tag === 'form')[0].props.onKeydown;
  await update(r, 'AppID', 'wx1111111111111111'); replay(old, { key: 'Enter', target: { tagName: 'INPUT', readOnly: false, disabled: false }, preventDefault() {} }); await tick(); assert.equal(saves(r).length, 0);
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
  await save(r); assert.match(text(r.tree), /公众号配置已保存/); await save(r); assert.ok(!text(r.tree).includes('公众号配置已保存。')); assert.equal(journal(r).length, 1);
});
scenario('query/route ABA retires native field/save/Enter callbacks', async mount => {
  const r = await mount(); const input = byLabel(r, 'AppID').props.onInput, saveFn = capture(r, '确认并保存配置'), enter = all(r.tree, n => n.tag === 'form')[0].props.onKeydown;
  r.route.fullPath = '/content/wechat-base?q=1'; await tick(); r.route.fullPath = '/content/wechat-base'; await tick();
  replay(input, { target: { value: 'wx1111111111111111' } }); replay(saveFn, {}); replay(enter, { key: 'Enter', target: { tagName: 'INPUT', readOnly: false, disabled: false }, preventDefault() {} }); await tick(); assert.equal(saves(r).length, 0); assert.equal(byLabel(r, 'AppID').props.value, APP);
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
  await click(r, '重新读取'); r.route.fullPath = '/content/wechat-base?fresh=1'; await tick(); assert.equal(byLabel(r, 'AppID').props.value, APP);
  old.reject(Error('late old failure')); await tick(); assert.ok(!text(r.tree).includes('late old failure')); assert.equal(r.bindings.loading, false);
});
scenario('a late committed ACK after owner change never clears the original owner journal', async mount => {
  const hold = deferred(); const r = await mount({ send(call, next) { if (call.method === 'POST' && call.url === BASE) { const result = next(); hold.result = result; return hold.promise; } return next(); } });
  await save(r); const old = journal(r)[0][0]; r.sync({ userInfo: { ...r.auth.userInfo, id: 8 }, token: 'owner-B' }); await tick(); hold.resolve(hold.result); await tick(); assert.ok(r.storage.has(old)); assert.ok(!text(r.tree).includes('公众号配置已保存。'));
});
scenario('unmount retires captured callbacks and a fresh mount creates current controls', async mount => {
  const r = await mount(); const old = capture(r, '确认并保存配置'); r.visible.value = false; await tick(); replay(old, {}); await tick(); assert.equal(saves(r).length, 0);
  r.visible.value = true; await tick(); replay(old, {}); await tick(); assert.equal(saves(r).length, 0); await save(r); assert.equal(saves(r).length, 1);
});
scenario('actual gallery loads dedicated categories and twenty-plus-one pagination with canonical selection', async mount => {
  const r = await mount(); await click(r, '从图库选择关注二维码'); assert.equal(css(r, 'gallery-dialog').length, 1); assert.equal(optionsCalls(r).length, 1);
  assert.equal(all(r.tree, n => n.tag === 'img' && n.props.alt?.startsWith('平台图片')).length, 20); await click(r, '图库下一页'); assert.equal(optionsCalls(r)[1].params.page, 2);
  await click(r, '平台图片21'); assert.equal(css(r, 'gallery-dialog').length, 0); await save(r); assert.equal(saves(r)[0].body.settings.wechat_qrcode, '/api/assets/21'); assert.ok(!saves(r)[0].rawBody.includes('signature='));
});
scenario('gallery search preserves fast input, suppresses dirty old picks and applies its exact literal query', async mount => {
  const r = await mount(); await click(r, '从图库选择关注二维码'); const oldPick = capture(r, '平台图片1'), n = byLabel(r, '图片名称');
  for (const value of ['a', 'ab', 'abc']) replay(n.props.onInput, { target: { value } }); await tick(); assert.strictEqual(byLabel(r, '图片名称'), n); assert.equal(n.props.value, 'abc');
  replay(oldPick, {}); await tick(); assert.equal(css(r, 'gallery-dialog').length, 1); await click(r, '搜索图片'); assert.equal(optionsCalls(r).at(-1).params.name, 'abc'); assert.equal(optionsCalls(r).at(-1).params.page, 1);
});
scenario('gallery category selection resets page and old page-one callbacks cannot select after category ABA', async mount => {
  const r = await mount(); await click(r, '从图库选择关注二维码'); const old = capture(r, '平台图片1'); await update(r, '图片分类', '1'); await update(r, '图片分类', '0'); replay(old, {}); await tick();
  assert.equal(css(r, 'gallery-dialog').length, 1); assert.equal(byLabel(r, '关注二维码引用').props.value, '/api/assets/1');
  assert.deepEqual(optionsCalls(r).map(c => c.params.pid), [0, 1, 0]);
});
scenario('gallery close/reopen retires old picks and old save callbacks', async mount => {
  const r = await mount(); const oldSave = capture(r, '确认并保存配置'); await click(r, '从图库选择关注二维码'); const pick = capture(r, '平台图片1'); await click(r, '关闭图库'); await click(r, '从图库选择关注二维码');
  replay(pick, {}); replay(oldSave, {}); await tick(); assert.equal(css(r, 'gallery-dialog').length, 1); assert.equal(saves(r).length, 0);
});
scenario('late categories after gallery close do not launch attachment options or reopen the dialog', async mount => {
  const hold = deferred(); const r = await mount({ send(call, next) { return call.url.endsWith('/attachment-categories') ? hold.promise : next(); } });
  await click(r, '从图库选择关注二维码'); await click(r, '关闭图库'); hold.resolve(envelope({ list: [] })); await tick(); assert.equal(optionsCalls(r).length, 0); assert.equal(css(r, 'gallery-dialog').length, 0);
});
scenario('late gallery options after session replacement never alter the new draft', async mount => {
  const hold = deferred(); const r = await mount({ send(call, next) { return call.url.endsWith('/attachment-options') ? hold.promise : next(); } });
  await click(r, '从图库选择关注二维码'); r.sync({ token: 'new-token' }); await tick(); hold.resolve(envelope({ list: [option(99)], count: 1, page: 1, limit: 20 })); await tick();
  assert.equal(css(r, 'gallery-dialog').length, 0); assert.equal(byLabel(r, '关注二维码引用').props.value, '/api/assets/1');
});
scenario('malformed or foreign gallery reference rejects the full response instead of submitting a safe subset', async mount => {
  const r = await mount({ send(call, next) { return call.url.endsWith('/attachment-options') ? envelope({ list: [{ ...option(1), reference: '/api/assets/2' }], count: 1, page: 1, limit: 20 }) : next(); } });
  await click(r, '从图库选择关注二维码'); assert.match(text(r.tree), /稳定引用身份无效/); assert.equal(buttons(r, '平台图片1').length, 0); assert.equal(saves(r).length, 0);
});
scenario('strict API parsers reject hidden secret fields, wrong identities, unsafe previews and invalid route IDs before I/O', async mount => {
  const r = await mount(), api = r.api(); assert.throws(() => api.checkedWechatBaseSnapshot({ ...snapshot(), wechat_appsecret: 'PRIVATE' }));
  assert.throws(() => api.checkedWechatBaseSnapshot({ ...snapshot(), raw_public_values: { ...snapshot().raw_public_values, wechat_token: 'PRIVATE' } }));
  assert.throws(() => api.checkedWechatBaseReceipt(receipt(), ID2, 7)); assert.throws(() => api.checkedWechatBaseReceipt(receipt(), ID, 8));
  assert.throws(() => api.wechatBasePreview('javascript:alert(1)')); assert.throws(() => api.wechatBasePreview('//other.test/image.png'));
  const count = r.calls.length; assert.throws(() => api.apiWechatBaseReceipt('../other')); assert.throws(() => api.apiResolveWechatBase('../other')); assert.equal(r.calls.length, count);
});
