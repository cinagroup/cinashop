const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
// Reuse only the installed Vue/Pinia/Axios host. The selected page, auth store,
// request interceptors, menu API and shared contract are the current real files.
const H = require('./helpers/bargain-records-runtime.cjs');
const { tick, copy, deferred, all, text, buttons, replay, click } = H;
const BASE = '/wechat/menu', PREFIX = 'cinashop_wechat_menu_pending_v1_';
const ID = '11111111-1111-4111-8111-111111111111';
const APP = 'wx0123456789abcdef';
const leaf = (name = '服务', patch = {}) => ({ name, type: 'click', key: 'service', ...patch });
const snapshot = (patch = {}) => ({ menus: [leaf()], raw: JSON.stringify([leaf()]), present: true, expired: false,
  issues: [], revision: 'a'.repeat(64), app_id: APP, configured: true, runtime_ready: true, pending: null, ...patch });
const receipt = (id = ID, patch = {}) => ({ operation_id: id, actor_id: 7, resolver_id: 7, app_id: APP,
  state: 'accepted', provider_code: 0, created_at: 1793100000, local_saved: true, ...patch });
const command = (patch = {}) => ({ operation_id: ID, revision: 'a'.repeat(64), button: [leaf()], replace_history: false, confirmed: true, ...patch });
const envelope = data => ({ data });
const failure = (httpStatus, msg) => ({ httpStatus, status: httpStatus, msg, data: null });
const capture = (r, label, index = 0) => { const n = buttons(r, label)[index]; assert.ok(n, 'actual rendered button ' + label); return n.props.onClick; };
const css = (r, cls) => all(r.tree, n => String(n.props.class ?? '').split(' ').includes(cls));
const journal = r => [...r.storage].filter(([key]) => key.startsWith(PREFIX));
const posts = r => r.calls.filter(c => c.method === 'POST' && c.url === BASE);
const reads = r => r.calls.filter(c => c.method === 'GET' && c.url === BASE);
const observations = r => r.calls.filter(c => c.url.endsWith('/observe'));
const receiptReads = r => r.calls.filter(c => c.method === 'GET' && c.url.startsWith(BASE + '/operations/'));
const confirmations = r => r.calls.filter(c => c.url.endsWith('/confirm-observation'));
const seals = r => r.calls.filter(c => c.url.endsWith('/resolve-missing'));
// A contained native select has an implicit label; do not invent an aria-label
// that the real template does not declare.
const byLabel = (r, label) => H.byLabel(r, label) ?? all(r.tree, n => n.tag === 'label' && text(n).startsWith(label))
  .flatMap(n => all(n, child => ['input', 'select', 'textarea'].includes(child.tag)))[0];
async function update(r, label, value) {
  const n = byLabel(r, label); assert.ok(n, 'actual labelled native control ' + label); assert.ok(!n.props.disabled);
  replay(n.tag === 'select' ? n.props.onChange : n.props.onInput, { target: { value } }); await tick(); return n;
}
const rowControl = (r, name, label) => {
  const row = css(r, 'menu-row').find(n => all(n, c => c.tag === 'button')[0] && text(all(n, c => c.tag === 'button')[0]) === name);
  assert.ok(row, 'actual menu row ' + name);
  const n = all(row, c => c.tag === 'button' && text(c) === label)[0]; assert.ok(n); return n.props.onClick;
};

function runtime(options = {}) {
  let r;
  const state = { snapshot: snapshot(options.snapshot), records: new Map(), deliveryCount: 0, nextRevision: 10 };
  const confirmations = [];
  function answer(call, fallback) {
    if (call.url === '/login') return fallback();
    if (call.method === 'GET' && call.url === BASE) return envelope(copy(state.snapshot));
    if (call.method === 'POST' && call.url === BASE) {
      const body = call.body;
      if (state.records.has(body.operation_id)) return envelope(copy(state.records.get(body.operation_id).receipt));
      const result = receipt(body.operation_id, { actor_id: call.actor_id, resolver_id: call.actor_id,
        state: options.publishState ?? 'accepted', local_saved: (options.publishState ?? 'accepted') === 'accepted',
        provider_code: options.publishState === 'unknown' ? null : 0 });
      state.records.set(body.operation_id, { receipt: result, button: copy(body.button) }); state.deliveryCount++;
      if (result.state === 'accepted') {
        state.snapshot.menus = copy(body.button); state.snapshot.raw = JSON.stringify(body.button);
        state.snapshot.issues = []; state.snapshot.pending = null;
        state.snapshot.revision = (++state.nextRevision).toString(16).padStart(64, '0');
      } else if (result.state === 'unknown') state.snapshot.pending = copy(result);
      return envelope(copy(result));
    }
    if (call.method === 'GET' && call.url.startsWith(BASE + '/operations/')) {
      const value = state.records.get(call.url.split('/').at(-1));
      return value ? envelope(copy(value.receipt)) : { status: 404, msg: '菜单发布记录不存在', data: null };
    }
    if (call.method === 'POST' && call.url.endsWith('/resolve-missing')) {
      const id = call.url.split('/').at(-2); assert.equal(call.body.operation_id, id);
      const previous = state.records.get(id); if (previous) return envelope(copy(previous.receipt));
      const result = receipt(id, { actor_id: call.actor_id, resolver_id: call.actor_id,
        state: 'not_dispatched', local_saved: false, provider_code: null });
      state.records.set(id, { receipt: result, button: copy(call.body.button) });
      if (state.snapshot.pending?.operation_id === id) state.snapshot.pending = null;
      return envelope(copy(result));
    }
    if (call.method === 'POST' && call.url.endsWith('/observe')) {
      const value = state.records.get(call.url.split('/').at(-2));
      if (!value) return { status: 404, msg: '菜单发布记录不存在', data: null };
      return envelope({ receipt: copy(value.receipt), observed: true, remote_button: copy(value.button),
        matches: true, observation: 'b'.repeat(64) });
    }
    if (call.method === 'POST' && call.url.endsWith('/confirm-observation')) {
      const value = state.records.get(call.url.split('/').at(-2));
      if (!value) return { status: 404, msg: '菜单发布记录不存在', data: null };
      const result = { ...value.receipt, state: 'observed_match', local_saved: true };
      value.receipt = result; state.snapshot.menus = copy(value.button); state.snapshot.raw = JSON.stringify(value.button);
      state.snapshot.issues = []; state.snapshot.pending = null; state.snapshot.revision = (++state.nextRevision).toString(16).padStart(64, '0');
      return envelope(copy(result));
    }
    throw Error('Unexpected menu transport ' + call.method + ' ' + call.url);
  }
  r = H.runtime({ page: 'pages/content/WechatMenuAuthor.vue', permissions: options.permissions ?? ['wechat_menu.view', 'wechat_menu.manage'],
    send(call, fallback) {
      if (typeof call.body === 'string') { call.rawBody = call.body; call.body = JSON.parse(call.body); }
      call.actor_id = r.auth.userInfo?.id;
      const next = () => answer(call, fallback);
      return options.send ? options.send(call, next, r) : next();
    } });
  r.route.fullPath = '/content/wechat-menu'; r.window.location.pathname = '/content/wechat-menu';
  r.window.confirm = value => { confirmations.push(String(value)); return options.confirm ? options.confirm(value, r) : true; };
  if (options.stored !== undefined) r.storage.set(PREFIX + r.auth.userInfo.id,
    typeof options.stored === 'string' ? options.stored : JSON.stringify({ actor_id: r.auth.userInfo.id, payload: options.stored }));
  return Object.assign(r, { server: state, confirmations, posts: () => posts(r), journal: () => journal(r),
    menuApi: () => r.load(path.join(H.root, 'api/wechatMenu.ts')),
    common: () => r.load(path.join(H.repository, 'view/common/wechatMenu.ts')) });
}
function scenario(name, fn) {
  test(name, async () => { const mounted = []; const mount = async options => { const r = runtime(options); mounted.push(r); await tick(); return r; };
    try { await fn(mount); } finally { for (const r of mounted) await r.finish(); } });
}
async function publish(r) { await click(r, '确认并发布到微信'); }
async function select(r, name = '服务') { await click(r, name); }
async function input(r, name, key) { await update(r, '菜单名称', name); if (key !== undefined) await update(r, '点击关键词', key); }
async function unknown(mount, options = {}) {
  const r = await mount({ publishState: 'unknown', ...options }); await publish(r); assert.equal(journal(r).length, 1); return r;
}

scenario('actual editor reads only the menu API and presents native three-action controls without unrelated I/O', async mount => {
  const r = await mount(); assert.equal(reads(r).length, 1); assert.match(text(r.tree), /公众号自定义菜单/);
  await select(r); assert.deepEqual(all(r.tree, n => n.tag === 'option').map(text), ['点击关键词', '打开网页', '打开小程序']);
  assert.equal(byLabel(r, '菜单名称').props.maxlength, undefined); assert.equal(byLabel(r, '点击关键词').props.value, 'service');
  assert.equal(posts(r).length, 0); assert.equal(journal(r).length, 0); assert.ok(r.calls.every(c => c.url === BASE));
});

scenario('three roots and five children per root are enforced by current native add/remove/select controls', async mount => {
  const r = await mount({ snapshot: { menus: [], raw: '[]' } });
  for (let i = 0; i < 3; i++) { await click(r, '添加一级菜单'); await input(r, '一级' + i, 'root-' + i); }
  const oldAdd = capture(r, '添加一级菜单'); assert.equal(buttons(r, '添加一级菜单')[0].props.disabled, true);
  replay(oldAdd, {}); await tick(); assert.equal(r.bindings.draft.length, 3);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 5; j++) { await click(r, '添加子菜单', i); await input(r, `子${i}-${j}`, `key-${i}-${j}`); }
  for (const n of buttons(r, '添加子菜单')) assert.equal(n.props.disabled, true);
  const last = capture(r, '添加子菜单', 0); replay(last, {}); await tick(); assert.equal(r.bindings.draft[0].sub_button.length, 5);
  await select(r, '子0-0'); assert.equal(byLabel(r, '菜单名称').props.value, '子0-0');
  replay(rowControl(r, '子0-0', '删除'), {}); await tick(); assert.equal(r.bindings.draft[0].sub_button.length, 4);
  assert.equal(buttons(r, '添加子菜单')[0].props.disabled, false);
  replay(rowControl(r, '一级1', '删除'), {}); await tick(); assert.equal(r.bindings.draft.length, 2);
  assert.equal(posts(r).length, 0); await publish(r); assert.equal(posts(r)[0].body.button.length, 2);
  assert.equal(posts(r)[0].body.button[0].sub_button.length, 4);
});

scenario('all three action branches retain inactive fields and submit the complete local author document', async mount => {
  const original = leaf('完整', { url: 'https://example.test/original', appid: 'wx1111111111111111', pagepath: 'pages/original/index' });
  const r = await mount({ snapshot: { menus: [original] } }); await select(r, '完整');
  await update(r, '响应类型', 'view'); await update(r, '网页链接', 'https://example.test/changed');
  assert.equal(byLabel(r, '点击关键词'), undefined); await update(r, '响应类型', 'miniprogram');
  assert.equal(byLabel(r, '小程序 AppID').props.value, original.appid); await update(r, '小程序页面路径', 'pages/changed/index');
  assert.equal(byLabel(r, '备用网页链接').props.value, 'https://example.test/changed'); await update(r, '响应类型', 'click');
  assert.equal(byLabel(r, '点击关键词').props.value, 'service'); await publish(r);
  assert.deepEqual(posts(r)[0].body.button[0], { name: '完整', type: 'click', key: 'service', url: 'https://example.test/changed',
    appid: original.appid, pagepath: 'pages/changed/index' });
});

scenario('a parent with children edits only its name and preserves its former inactive action fields', async mount => {
  const parent = leaf('展开', { url: 'https://example.test/kept', sub_button: [leaf('子项')] });
  const r = await mount({ snapshot: { menus: [parent] } }); await select(r, '展开');
  assert.equal(all(r.tree, n => n.tag === 'select').length, 0); assert.equal(byLabel(r, '点击关键词'), undefined);
  await update(r, '菜单名称', '展开改名'); await publish(r);
  assert.deepEqual(posts(r)[0].body.button[0], { ...parent, name: '展开改名' });
});

scenario('current input node accepts several fast native events before rendering while an old publish callback retires', async mount => {
  const r = await mount(); await select(r); const n = byLabel(r, '菜单名称'), issued = n.props.onInput, oldPublish = capture(r, '确认并发布到微信');
  for (const value of ['A', 'AB', 'ABC']) replay(issued, { target: { value } }); await tick();
  assert.strictEqual(byLabel(r, '菜单名称'), n); assert.equal(n.props.value, 'ABC');
  replay(oldPublish, {}); await tick(); assert.equal(posts(r).length, 0);
  await publish(r); assert.equal(posts(r)[0].body.button[0].name, 'ABC');
});

scenario('root and child names use UTF8 bytes without UTF16 clipping at sixteen and sixty bytes', async mount => {
  const r = await mount(); await select(r); await update(r, '菜单名称', '🧭'.repeat(4)); await publish(r);
  assert.equal(posts(r)[0].body.button[0].name, '🧭'.repeat(4)); await select(r, '🧭'.repeat(4));
  await update(r, '菜单名称', '🧭'.repeat(5)); await publish(r); assert.equal(posts(r).length, 1); assert.match(text(r.tree), /16字节/);
  await update(r, '菜单名称', '父'); await click(r, '添加子菜单'); await input(r, '🧭'.repeat(15), 'child'); await publish(r);
  assert.equal(posts(r)[1].body.button[0].sub_button[0].name, '🧭'.repeat(15));
  await select(r, '🧭'.repeat(15)); await update(r, '菜单名称', '🧭'.repeat(16)); await publish(r); assert.equal(posts(r).length, 2);
  assert.equal(byLabel(r, '菜单名称').props.value, '🧭'.repeat(16));
});

for (const [field, invalid] of [['菜单名称', 'bad\nname'], ['菜单名称', 'bad\u0085name'], ['菜单名称', 'bad\ud800'],
  ['点击关键词', 'a'.repeat(65)], ['点击关键词', '🧭'.repeat(33)]]) scenario('invalid byte/control draft never persists or sends: ' + field + ' ' + JSON.stringify(invalid), async mount => {
  const r = await mount(); await select(r); await update(r, field, invalid); await publish(r);
  assert.equal(posts(r).length, 0); assert.equal(journal(r).length, 0); assert.ok(all(r.tree, n => n.props.role === 'alert').length);
});

scenario('a full sixty-four-unit keyword and valid mini-program branch are submitted without reducing inactive values', async mount => {
  const r = await mount(); await select(r); await update(r, '点击关键词', 'a'.repeat(64)); await publish(r);
  assert.equal(posts(r)[0].body.button[0].key.length, 64); await select(r); await update(r, '响应类型', 'miniprogram');
  await update(r, '小程序 AppID', 'wx0123456789abcdef'); await update(r, '小程序页面路径', 'pages/home/index?from=menu');
  await update(r, '备用网页链接', 'https://example.test/fallback'); await publish(r);
  assert.equal(posts(r)[1].body.button[0].key, 'a'.repeat(64)); assert.equal(posts(r)[1].body.button[0].pagepath, 'pages/home/index?from=menu');
});

scenario('invalid links and mini-program paths do not dispatch a partially valid replacement', async mount => {
  const r = await mount(); await select(r); await update(r, '响应类型', 'view');
  for (const url of ['javascript:alert(1)', 'https://user:password@example.test/x', 'https://example.test/a b']) {
    await update(r, '网页链接', url); await publish(r); assert.equal(posts(r).length, 0);
  }
  await update(r, '响应类型', 'miniprogram'); await update(r, '小程序 AppID', 'wx0123456789abcdef');
  await update(r, '备用网页链接', 'https://example.test/fallback'); await update(r, '小程序页面路径', '/pages/home');
  await publish(r); assert.equal(posts(r).length, 0); assert.equal(journal(r).length, 0);
});

for (const raw of [null, 'null', '{invalid JSON', '[{"name":"原文","type":"media_id","media_id":"historical"}]']) {
  scenario('unsupported or absent raw history is preserved without becoming an editable empty list: ' + JSON.stringify(raw), async mount => {
    const r = await mount({ snapshot: { menus: null, raw, issues: ['完整历史不能由此编辑器表示'] } });
    assert.equal(css(r, 'editor-layout').length, 0); assert.equal(r.bindings.snapshot.raw, raw);
    assert.equal(r.bindings.replaceHistory, false); assert.equal(posts(r).length, 0); assert.equal(journal(r).length, 0);
    const oldPublish = capture(r, '确认并发布到微信'); replay(oldPublish, {}); await tick(); assert.equal(posts(r).length, 0);
    if (raw !== null) assert.ok(text(r.tree).includes(raw));
  });
}

scenario('whole-history replacement is explicit, cancel preserves raw and a confirmed rebuild sends its marker', async mount => {
  let allow = false; const raw = '[{"unknown":"original"}]';
  const r = await mount({ snapshot: { menus: null, raw, issues: ['原文需完整核对'] }, confirm: () => allow });
  await click(r, '核对后整体重建'); assert.equal(css(r, 'editor-layout').length, 0); assert.equal(r.bindings.snapshot.raw, raw);
  allow = true; await click(r, '核对后整体重建'); assert.equal(css(r, 'editor-layout').length, 1);
  await click(r, '添加一级菜单'); await input(r, '新菜单', 'new-key'); await publish(r);
  assert.equal(posts(r)[0].body.replace_history, true); assert.deepEqual(posts(r)[0].body.button, [leaf('新菜单', { key: 'new-key', sub_button: [] })]);
});

scenario('an explicitly empty saved draft is displayed but can never publish or delete a remote menu', async mount => {
  const r = await mount({ snapshot: { menus: [], raw: '[]' } });
  assert.equal(css(r, 'editor-layout').length, 1); assert.equal(buttons(r, '确认并发布到微信')[0].props.disabled, true);
  replay(capture(r, '确认并发布到微信'), {}); await tick(); assert.equal(posts(r).length, 0); assert.equal(journal(r).length, 0);
});

scenario('cancelled publish and cancelled draft removal perform neither persistent writes nor remote writes', async mount => {
  const r = await mount({ confirm: () => false }); await publish(r); replay(rowControl(r, '服务', '删除'), {}); await tick();
  assert.equal(posts(r).length, 0); assert.equal(journal(r).length, 0); assert.equal(r.bindings.draft.length, 1); assert.equal(r.confirmations.length, 2);
});

scenario('a confirm-time draft mutation invalidates the captured payload before persistence', async mount => {
  let mutate; const r = await mount({ confirm: message => { if (String(message).startsWith('确认将以下菜单')) mutate?.(); return true; } });
  await select(r); const handler = byLabel(r, '菜单名称').props.onInput; mutate = () => replay(handler, { target: { value: '确认期间变更' } });
  await publish(r); assert.equal(posts(r).length, 0); assert.equal(journal(r).length, 0); assert.equal(byLabel(r, '菜单名称').props.value, '确认期间变更');
});

scenario('the entire non-secret command is durably stored and read back before POST', async mount => {
  let observed; const r = await mount({ send(c, next, host) { if (c.method === 'POST' && c.url === BASE) {
    observed = JSON.parse(host.storage.get(PREFIX + c.actor_id)); assert.deepEqual(observed.payload, c.body);
  } return next(); } });
  await publish(r); assert.equal(observed.actor_id, 7); assert.equal(observed.payload.confirmed, true);
  assert.deepEqual(Object.keys(observed.payload), ['operation_id', 'revision', 'button', 'replace_history', 'confirmed']);
  assert.equal(JSON.stringify(observed).includes('read-A'), false); assert.equal(journal(r).length, 0);
});

scenario('storage failure stops publication and cannot claim a remote request was sent', async mount => {
  const r = await mount(); const set = r.storage.set.bind(r.storage);
  r.storage.set = (key, value) => { if (key.startsWith(PREFIX)) throw Error('存储空间不足'); return set(key, value); };
  await publish(r); assert.equal(posts(r).length, 0); assert.equal(journal(r).length, 0); assert.match(text(r.tree), /存储空间不足/);
});

scenario('unknown ACK keeps its UUID, disables editing and rejects replayed new-publish and add callbacks', async mount => {
  const r = await mount({ publishState: 'unknown' }); await select(r);
  const oldAdd = capture(r, '添加一级菜单'), oldPublish = capture(r, '确认并发布到微信'), oldInput = byLabel(r, '菜单名称').props.onInput;
  await publish(r); assert.equal(journal(r).length, 1); assert.match(text(r.tree), /待核对/);
  const before = r.calls.length; replay(oldAdd, {}); replay(oldPublish, {}); replay(oldInput, { target: { value: '不能覆盖' } }); await tick();
  assert.equal(r.calls.length, before); assert.equal(posts(r).length, 1); assert.equal(r.bindings.draft[0].name, '服务');
  assert.equal(buttons(r, '确认并发布到微信')[0].props.disabled, true);
});

scenario('native retry uses the same UUID and exact complete payload without cloning a Vue Proxy or creating another operation', async mount => {
  const r = await unknown(mount), original = copy(posts(r)[0].body);
  await click(r, '原样继续或核对原请求'); assert.equal(posts(r).length, 2); assert.deepEqual(posts(r)[1].body, original);
  assert.equal(r.server.deliveryCount, 1); assert.equal(journal(r).length, 1); assert.equal(r.bindings.pendingId, original.operation_id);
});

scenario('lost accepted ACK is recovered by GET receipt with no second publish POST', async mount => {
  let dropped = false; const r = await mount({ send(c, next) { const response = next();
    if (!dropped && c.url === BASE && c.method === 'POST') { dropped = true; throw new H.axios.AxiosError('Network Error', H.axios.AxiosError.ERR_NETWORK); }
    return response; } });
  await publish(r); const id = posts(r)[0].body.operation_id; assert.equal(journal(r).length, 1);
  assert.match(text(r.tree), /Network Error/); await click(r, '读取发布记录');
  assert.equal(receiptReads(r)[0].url, BASE + '/operations/' + id); assert.equal(posts(r).length, 1);
  assert.equal(r.server.deliveryCount, 1); assert.equal(journal(r).length, 0); assert.match(text(r.tree), /微信已接受发布，本地菜单已保存/);
});

scenario('receipt404 is still unknown and cannot discard the original journal or create another UUID', async mount => {
  const r = await unknown(mount, { send(c, next) { return c.method === 'GET' && c.url.includes('/operations/')
    ? { status: 404, msg: '菜单发布记录不存在', data: null } : next(); } });
  const raw = journal(r)[0][1]; await click(r, '读取发布记录'); assert.equal(journal(r)[0][1], raw); assert.equal(posts(r).length, 1);
  assert.match(text(r.tree), /记录不存在/); assert.equal(buttons(r, '确认并发布到微信')[0].props.disabled, true);
});

scenario('HTTP409 preserves its Chinese response message and the original journal', async mount => {
  const r = await mount({ send(c, next) { return c.method === 'POST' && c.url === BASE ? failure(409, '公众号配置或菜单已变化，请保留原请求核对') : next(); } });
  await publish(r); assert.match(text(r.tree), /公众号配置或菜单已变化，请保留原请求核对/);
  assert.equal(journal(r).length, 1); assert.equal(posts(r).length, 1); assert.match(text(r.tree), /新发布已暂停/);
});

scenario('a malformed or mismatched terminal receipt cannot erase a pending journal', async mount => {
  let invalid = receipt('22222222-2222-4222-8222-222222222222');
  const r = await unknown(mount, { send(c, next) { return c.method === 'GET' && c.url.includes('/operations/') ? envelope(invalid) : next(); } });
  await click(r, '读取发布记录'); assert.equal(journal(r).length, 1);
  invalid = receipt(posts(r)[0].body.operation_id, { state: 'accepted', local_saved: false }); await click(r, '读取发布记录');
  assert.equal(journal(r).length, 1); assert.equal(posts(r).length, 1); assert.match(text(r.tree), /回执身份或状态无效/);
});

scenario('a matching remote observation retains the complete default array and never claims that this operation published it', async mount => {
  const remote = [{ name: '原文', type: 'media_id', media_id: 'opaque', extra: { nested: [1, 2] } }];
  const r = await unknown(mount, { send(c, next) { if (c.url.endsWith('/observe')) return envelope({
    receipt: receipt(posts(r)[0].body.operation_id, { state: 'unknown', local_saved: false, provider_code: null }),
    observed: true, matches: true, remote_button: remote, observation: 'b'.repeat(64) }); return next(); } });
  await click(r, '读取微信线上菜单'); assert.deepEqual(r.bindings.observation.remote_button, remote);
  assert.match(text(r.tree), /此观察不能证明是哪次请求完成的发布/); assert.doesNotMatch(text(r.tree), /微信已接受发布，本地菜单已保存/);
  assert.equal(journal(r).length, 1); assert.equal(posts(r).length, 1); assert.equal(observations(r).length, 1);
});

scenario('failed remote read is not an empty match and does not clear an unknown operation', async mount => {
  const r = await unknown(mount, { send(c, next) { return c.url.endsWith('/observe') ? envelope({
    receipt: receipt(posts(r)[0].body.operation_id, { state: 'unknown', local_saved: false, provider_code: null }), observed: false, provider_code: 46003 }) : next(); } });
  await click(r, '读取微信线上菜单'); assert.match(text(r.tree), /未返回可核对的菜单/);
  assert.equal(r.bindings.observation.remote_button, undefined); assert.equal(journal(r).length, 1); assert.equal(posts(r).length, 1);
});

scenario('matching observation requires a separate explicit confirmation, sends exact id/stamp and records observed-match distinctly', async mount => {
  let permit = false; const r = await unknown(mount, { confirm: message => !String(message).startsWith('确认已经核对') || permit });
  await click(r, '读取微信线上菜单'); const id = posts(r)[0].body.operation_id;
  await click(r, '人工确认线上匹配并保存本地'); assert.equal(confirmations(r).length, 0); assert.equal(journal(r).length, 1);
  permit = true; await click(r, '人工确认线上匹配并保存本地');
  assert.equal(confirmations(r)[0].url, BASE + '/operations/' + id + '/confirm-observation');
  assert.deepEqual(confirmations(r)[0].body, { observation: 'b'.repeat(64), confirmed: true });
  assert.equal(journal(r).length, 0); assert.equal(posts(r).length, 1); assert.equal(r.server.deliveryCount, 1);
  assert.match(text(r.tree), /已人工核对线上菜单匹配/); assert.doesNotMatch(text(r.tree), /微信已接受发布，本地菜单已保存/);
});

scenario('old observed confirmation retires after a new observation even when the returned signature is identical', async mount => {
  const r = await unknown(mount); await click(r, '读取微信线上菜单'); const old = capture(r, '人工确认线上匹配并保存本地');
  await click(r, '读取微信线上菜单'); replay(old, {}); await tick(); assert.equal(confirmations(r).length, 0); assert.equal(journal(r).length, 1);
  await click(r, '人工确认线上匹配并保存本地'); assert.equal(confirmations(r).length, 1); assert.equal(journal(r).length, 0);
});

scenario('a mismatching new remote observation hides confirmation and rejects the captured former-match handler', async mount => {
  let matches = true; const r = await unknown(mount, { send(c, next) {
    const result = next(); if (c.url.endsWith('/observe')) result.data.matches = matches; return result;
  } });
  await click(r, '读取微信线上菜单'); const old = capture(r, '人工确认线上匹配并保存本地');
  matches = false; await click(r, '读取微信线上菜单'); assert.equal(buttons(r, '人工确认线上匹配并保存本地').length, 0);
  replay(old, {}); await tick(); assert.equal(confirmations(r).length, 0); assert.equal(journal(r).length, 1); assert.equal(posts(r).length, 1);
});

for (const mode of ['route', 'actor']) scenario('confirm-time ' + mode + ' replacement cannot submit the old observation', async mount => {
  let changed = false; const r = await unknown(mount, { confirm(message, host) {
    if (String(message).startsWith('确认已经核对')) {
      changed = true;
      if (mode === 'route') host.route.fullPath = '/content/wechat-menu?changed=1';
      else host.sync({ userInfo: { ...host.auth.userInfo, id: 8 } });
    }
    return true;
  } });
  await click(r, '读取微信线上菜单'); await click(r, '人工确认线上匹配并保存本地');
  assert.equal(changed, true); assert.equal(confirmations(r).length, 0); assert.equal(r.storage.has(PREFIX + 7), true); assert.equal(posts(r).length, 1);
});

scenario('a late observed-match ACK after unmount leaves the journal for a fresh receipt recovery', async mount => {
  const gate = deferred(); const r = await unknown(mount, { send(c, next) { return c.url.endsWith('/confirm-observation') ? gate.promise.then(next) : next(); } });
  await click(r, '读取微信线上菜单'); await click(r, '人工确认线上匹配并保存本地');
  const request = confirmations(r)[0]; r.visible.value = false; await tick(); assert.equal(request.signal.aborted, true);
  gate.resolve(); await tick(); assert.equal(journal(r).length, 1); r.visible.value = true; await tick();
  assert.equal(confirmations(r).length, 1); await click(r, '读取发布记录'); assert.equal(journal(r).length, 0); assert.equal(posts(r).length, 1);
});

scenario('pending operations survive real page unmount/remount and restore without an automatic new POST', async mount => {
  const r = await unknown(mount), original = journal(r)[0][1]; r.visible.value = false; await tick();
  assert.equal(journal(r)[0][1], original); r.visible.value = true; await tick();
  assert.equal(posts(r).length, 1); assert.equal(journal(r)[0][1], original); assert.match(text(r.tree), /原样继续或核对原请求/);
  await click(r, '原样继续或核对原请求'); assert.equal(posts(r).length, 2); assert.equal(r.server.deliveryCount, 1);
});

scenario('a server-only pending UUID blocks new drafts without fabricating a client replay payload', async mount => {
  const r = await mount({ snapshot: { pending: receipt(ID, { state: 'unknown', local_saved: false, provider_code: null }) } });
  assert.equal(buttons(r, '原样继续或核对原请求').length, 0); assert.equal(buttons(r, '确认并发布到微信')[0].props.disabled, true);
  replay(capture(r, '确认并发布到微信'), {}); await tick(); assert.equal(posts(r).length, 0); assert.equal(journal(r).length, 0);
});

scenario('owner-local pending storage is never replaced by a different actor and is restored on return', async mount => {
  const r = await unknown(mount), raw = journal(r)[0][1], original = copy(r.auth.userInfo);
  r.sync({ userInfo: { ...original, id: 8 } }); await tick(); assert.equal(r.bindings.localPending, null);
  assert.equal(r.storage.get(PREFIX + 7), raw); assert.equal(r.storage.has(PREFIX + 8), false); assert.equal(posts(r).length, 1);
  r.sync({ userInfo: original }); await tick(); assert.equal(r.bindings.localPending.operation_id, posts(r)[0].body.operation_id);
  assert.equal(r.storage.get(PREFIX + 7), raw);
});

scenario('corrupt or foreign-owner stored commands are preserved and do not issue I/O or become empty drafts', async mount => {
  for (const stored of ['{bad JSON', JSON.stringify({ actor_id: 88, payload: command() })]) {
    const r = await mount({ stored }); assert.equal(reads(r).length, 0); assert.equal(posts(r).length, 0);
    assert.equal(journal(r)[0][1], stored); assert.ok(text(r.tree).includes('Unexpected') || text(r.tree).includes('JSON') || text(r.tree).includes('待核对操作记录不完整'));
  }
});

scenario('view-only renders all history but native disabled callbacks cannot edit, publish, rebuild or observe', async mount => {
  const r = await mount({ permissions: ['wechat_menu.view'] }); await select(r);
  assert.match(text(r.tree), /仅可查看/); const n = byLabel(r, '菜单名称'); assert.equal(n.props.disabled, true);
  replay(n.props.onInput, { target: { value: '非法改写' } }); replay(capture(r, '添加一级菜单'), {}); replay(capture(r, '确认并发布到微信'), {}); await tick();
  assert.equal(r.bindings.draft[0].name, '服务'); assert.equal(posts(r).length, 0); assert.equal(journal(r).length, 0); assert.equal(reads(r).length, 1);
});

for (const permission of ['wechat_content.manage', 'activity.manage', 'system_config.manage']) scenario('unrelated permission does not grant menu access: ' + permission, async mount => {
  const r = await mount({ permissions: [permission] }); assert.equal(r.calls.length, 0); assert.match(text(r.tree), /没有公众号菜单查看权限/);
});

for (const flag of ['runtime_ready', 'configured']) scenario('missing ' + flag + ' blocks native and replayed publication without affecting the historical read', async mount => {
  const r = await mount({ snapshot: { [flag]: false } }); assert.equal(reads(r).length, 1);
  assert.equal(buttons(r, '确认并发布到微信')[0].props.disabled, true); replay(capture(r, '确认并发布到微信'), {}); await tick();
  assert.equal(posts(r).length, 0); assert.equal(journal(r).length, 0);
});

scenario('old selection, remove, add, input and publish listeners retire after structural delete/add ABA', async mount => {
  const r = await mount(); await select(r);
  const functions = [capture(r, '服务'), rowControl(r, '服务', '删除'), capture(r, '添加一级菜单'), capture(r, '确认并发布到微信')], field = byLabel(r, '菜单名称').props.onInput;
  replay(rowControl(r, '服务', '删除'), {}); await tick(); await click(r, '添加一级菜单'); await input(r, '服务', 'replacement');
  const before = r.calls.length; for (const fn of functions) replay(fn, {}); replay(field, { target: { value: 'old' } }); await tick();
  assert.equal(r.calls.length, before); assert.equal(byLabel(r, '菜单名称').props.value, '服务'); assert.equal(r.bindings.draft[0].key, 'replacement');
  await publish(r); assert.equal(posts(r)[0].body.button[0].key, 'replacement');
});

scenario('hidden branch fields and an old publish callback retire across action-type ABA', async mount => {
  const r = await mount(); await select(r); const key = byLabel(r, '点击关键词').props.onInput, oldPublish = capture(r, '确认并发布到微信');
  await update(r, '响应类型', 'view'); await update(r, '网页链接', 'https://example.test/branch'); await update(r, '响应类型', 'click');
  replay(key, { target: { value: 'stale' } }); replay(oldPublish, {}); await tick(); assert.equal(byLabel(r, '点击关键词').props.value, 'service'); assert.equal(posts(r).length, 0);
  await publish(r); assert.equal(posts(r)[0].body.button[0].url, 'https://example.test/branch');
});

for (const mode of ['route', 'owner', 'token', 'permission', 'storage']) scenario('all captured native callbacks are inert after ' + mode + ' ABA and current controls still work', async mount => {
  const r = await mount(); await select(r); const inputHandler = byLabel(r, '菜单名称').props.onInput;
  const issued = [capture(r, '重新读取'), capture(r, '服务'), capture(r, '添加一级菜单'), rowControl(r, '服务', '删除'), capture(r, '确认并发布到微信')];
  const original = { token: r.auth.token, userInfo: copy(r.auth.userInfo), uniqueAuth: [...r.auth.uniqueAuth] };
  if (mode === 'route') { r.route.fullPath = '/content/wechat-menu?source=x'; r.route.fullPath = '/content/wechat-menu'; }
  else if (mode === 'owner') { r.sync({ userInfo: { ...original.userInfo, id: 8 } }); r.sync(original); }
  else if (mode === 'token') { r.sync({ token: 'replacement' }); r.sync(original); }
  else if (mode === 'permission') { r.sync({ uniqueAuth: [] }); r.sync(original); }
  else { r.sync({}, 'storage'); r.sync({}, 'storage'); }
  await tick(); const before = r.calls.length; for (const fn of issued) replay(fn, {}); replay(inputHandler, { target: { value: 'stale' } }); await tick();
  assert.equal(r.calls.length, before); assert.equal(posts(r).length, 0); assert.equal(r.bindings.selected, null);
  await select(r); assert.equal(byLabel(r, '菜单名称').props.value, '服务'); await publish(r); assert.equal(posts(r).length, 1);
});

scenario('a silent local-session replacement fences already-issued callbacks before a storage event', async mount => {
  const r = await mount(), issued = capture(r, '确认并发布到微信'), before = r.calls.length;
  r.storage.set('admin_session', JSON.stringify({ userInfo: { ...r.auth.userInfo, id: 99 }, menus: [], uniqueAuth: r.auth.uniqueAuth }));
  replay(issued, {}); await tick(); assert.equal(r.calls.length, before); assert.equal(journal(r).length, 0);
});

scenario('a late catalog rejection and finally cannot overwrite a newer route read', async mount => {
  const old = deferred(), fresh = deferred(); let count = 0;
  const r = await mount({ send(c, next) { if (c.url === BASE && c.method === 'GET') { count++; if (count === 1) return old.promise; if (count === 2) return fresh.promise; } return next(); } });
  r.route.fullPath = '/content/wechat-menu?read=new'; await tick(); assert.equal(reads(r)[0].signal.aborted, true);
  old.reject(Error('旧读取失败')); await tick(); assert.equal(r.bindings.loading, true); assert.equal(r.bindings.snapshot, null); assert.equal(r.bindings.error, '');
  fresh.resolve(envelope(snapshot({ menus: [leaf('当前')] }))); await tick(); assert.equal(r.bindings.loading, false); assert.match(text(r.tree), /当前/); assert.doesNotMatch(text(r.tree), /旧读取失败/);
});

scenario('a late committed ACK after unmount cannot erase the original journal or populate a replacement view', async mount => {
  const gate = deferred(); const r = await mount({ send(c, next) { return c.url === BASE && c.method === 'POST' ? gate.promise.then(next) : next(); } });
  await publish(r); const issued = posts(r)[0]; assert.equal(journal(r).length, 1); r.visible.value = false; await tick(); assert.equal(issued.signal.aborted, true);
  gate.resolve(); await tick(); assert.equal(journal(r).length, 1); r.visible.value = true; await tick(); assert.equal(posts(r).length, 1);
  assert.doesNotMatch(text(r.tree), /微信已接受发布，本地菜单已保存/); await click(r, '读取发布记录'); assert.equal(journal(r).length, 0); assert.equal(posts(r).length, 1);
});

scenario('a late observation after route replacement cannot add an old matching claim or clear its journal', async mount => {
  const gate = deferred(); const r = await unknown(mount, { send(c, next) { return c.url.endsWith('/observe') ? gate.promise.then(next) : next(); } });
  await click(r, '读取微信线上菜单'); const issued = observations(r)[0]; r.route.fullPath = '/content/wechat-menu?new=1'; await tick(); assert.equal(issued.signal.aborted, true);
  gate.resolve(); await tick(); assert.equal(r.bindings.observation, null); assert.equal(journal(r).length, 1); assert.equal(posts(r).length, 1);
});

scenario('real same-payload Pinia login retires old callbacks and a failed login preserves the active view', async mount => {
  let fail = false; const r = await mount({ send(c, next) { return c.url === '/login' && fail ? failure(503, '登录暂不可用') : next(); } });
  const old = capture(r, '确认并发布到微信'); await r.auth.login('operator', 'password'); await tick(); const before = r.calls.length;
  replay(old, {}); await tick(); assert.equal(r.calls.length, before); const fresh = capture(r, '确认并发布到微信');
  fail = true; await assert.rejects(r.auth.login('operator', 'password')); await tick(); replay(fresh, {}); await tick(); assert.equal(posts(r).length, 1);
});

scenario('a previous bearer401 cannot clear a replacement owner token or insert the previous error', async mount => {
  const gate = deferred(); let first = true; const r = await mount({ send(c, next) { if (c.url === BASE && c.method === 'GET' && first) { first = false; return gate.promise; } return next(); } });
  r.sync({ token: 'new-owner-token', userInfo: { ...r.auth.userInfo, id: 8 } }); await tick(); gate.resolve(failure(401, '旧请求已失效')); await tick();
  assert.equal(r.storage.get('admin_token'), 'new-owner-token'); assert.equal(r.window.location.href, ''); assert.doesNotMatch(text(r.tree), /旧请求已失效/); assert.match(text(r.tree), /公众号自定义菜单/);
});


scenario('a pre-admission409 and receipt404 can explicitly seal the exact original command then publish a fresh revision', async mount => {
  let stale = true; const r = await mount({ send(c, next) {
    if (stale && c.method === 'POST' && c.url === BASE) return failure(409, '菜单版本已变化');
    return next();
  } });
  await publish(r); const original = copy(posts(r)[0].body), raw = journal(r)[0][1];
  r.server.snapshot.revision = 'c'.repeat(64); await click(r, '读取发布记录');
  assert.equal(journal(r)[0][1], raw); assert.equal(r.server.records.size, 0);
  const oldRetry = capture(r, '原样继续或核对原请求'); await click(r, '核对并封存未受理请求');
  assert.equal(seals(r).length, 1); assert.equal(seals(r)[0].url, BASE + '/operations/' + original.operation_id + '/resolve-missing');
  assert.deepEqual(seals(r)[0].body, original); assert.equal(seals(r)[0].body.revision, 'a'.repeat(64));
  assert.equal(posts(r).length, 1); assert.equal(r.server.deliveryCount, 0); assert.equal(journal(r).length, 0);
  assert.equal(r.server.records.get(original.operation_id).receipt.state, 'not_dispatched');
  assert.equal(r.bindings.snapshot.revision, 'c'.repeat(64)); assert.match(text(r.tree), /本次未发出发布/);
  const before = r.calls.length; replay(oldRetry, {}); await tick(); assert.equal(r.calls.length, before);
  stale = false; await publish(r); assert.equal(posts(r).length, 2);
  assert.notEqual(posts(r)[1].body.operation_id, original.operation_id); assert.equal(posts(r)[1].body.revision, 'c'.repeat(64));
  assert.equal(r.server.deliveryCount, 1);
});

scenario('missing-request sealing requires explicit confirmation and fences confirm-time route or owner changes', async mount => {
  for (const mode of ['cancel', 'route', 'owner']) {
    const r = await unknown(mount, { confirm(message, host) {
      if (String(message).startsWith('确认核对并封存')) {
        if (mode === 'cancel') return false;
        if (mode === 'route') host.route.fullPath = '/content/wechat-menu?seal=new';
        else host.sync({ userInfo: { ...host.auth.userInfo, id: 8 } });
      }
      return true;
    } });
    const original = journal(r)[0][1]; await click(r, '核对并封存未受理请求');
    assert.equal(seals(r).length, 0); assert.equal(posts(r).length, 1); assert.equal(r.storage.get(PREFIX + 7), original);
  }
});

scenario('sealing an already-admitted unknown request does not cancel it or discard the journal and server-only pending has no fabricated seal', async mount => {
  const r = await unknown(mount); const original = journal(r)[0][1]; await click(r, '核对并封存未受理请求');
  assert.equal(seals(r).length, 1); assert.equal(journal(r)[0][1], original); assert.equal(posts(r).length, 1);
  assert.equal(r.server.deliveryCount, 1); assert.equal(r.bindings.serverPending.state, 'unknown');
  assert.equal(buttons(r, '确认并发布到微信')[0].props.disabled, true); assert.doesNotMatch(text(r.tree), /本次未发出发布/);
  const onlyServer = await mount({ snapshot: { pending: receipt(ID, { state: 'unknown', local_saved: false, provider_code: null }) } });
  assert.equal(buttons(onlyServer, '核对并封存未受理请求').length, 0); assert.equal(journal(onlyServer).length, 0);
});

scenario('network and invalid seal receipts preserve the exact journal and never fabricate non-dispatch', async mount => {
  let mode = 'id'; const r = await unknown(mount, { send(c, next) {
    if (c.url.endsWith('/resolve-missing')) {
      if (mode === 'network') throw new H.axios.AxiosError('Network Error', H.axios.AxiosError.ERR_NETWORK);
      if (mode === 'conflict') return failure(409, '受理事实仍待核对');
      return envelope(receipt(mode === 'id' ? '22222222-2222-4222-8222-222222222222' : c.body.operation_id,
        { state: 'not_dispatched', local_saved: mode !== 'id', provider_code: null }));
    }
    return next();
  } });
  const original = journal(r)[0][1];
  for (mode of ['id', 'state', 'network', 'conflict']) {
    await click(r, '核对并封存未受理请求'); assert.equal(journal(r)[0][1], original);
    assert.equal(posts(r).length, 1); assert.equal(r.server.deliveryCount, 1); assert.equal(buttons(r, '确认并发布到微信')[0].props.disabled, true);
  }
  assert.equal(seals(r).length, 4); assert.match(text(r.tree), /受理事实仍待核对/); assert.doesNotMatch(text(r.tree), /本次未发出发布/);
});

scenario('captured seal callbacks retire across route owner token permission storage and unmount ABA while current sealing remains usable', async mount => {
  for (const mode of ['route', 'owner', 'token', 'permission', 'storage', 'unmount']) {
    const r = await unknown(mount), old = capture(r, '核对并封存未受理请求');
    const original = { token: r.auth.token, userInfo: copy(r.auth.userInfo), uniqueAuth: [...r.auth.uniqueAuth] };
    if (mode === 'route') { r.route.fullPath = '/content/wechat-menu?seal=changed'; r.route.fullPath = '/content/wechat-menu'; }
    else if (mode === 'owner') { r.sync({ userInfo: { ...original.userInfo, id: 8 } }); r.sync(original); }
    else if (mode === 'token') { r.sync({ token: 'seal-replacement' }); r.sync(original); }
    else if (mode === 'permission') { r.sync({ uniqueAuth: [] }); r.sync(original); }
    else if (mode === 'storage') { r.sync({}, 'storage'); r.sync({}, 'storage'); }
    else { r.visible.value = false; await tick(); r.visible.value = true; }
    await tick(); const before = r.calls.length; replay(old, {}); await tick(); assert.equal(r.calls.length, before);
    assert.equal(seals(r).length, 0); assert.equal(journal(r).length, 1);
    await click(r, '核对并封存未受理请求'); assert.equal(seals(r).length, 1); assert.equal(journal(r).length, 1); assert.equal(posts(r).length, 1);
  }
});

scenario('late not-dispatched sealing ACK after unmount or owner change leaves the journal for explicit fresh receipt recovery', async mount => {
  for (const mode of ['unmount', 'owner']) {
    const gate = deferred(); const r = await mount({ stored: command(), send(c, next) { return c.url.endsWith('/resolve-missing') ? gate.promise.then(next) : next(); } });
    const owner = copy(r.auth.userInfo), original = journal(r)[0][1]; await click(r, '核对并封存未受理请求'); const issued = seals(r)[0];
    if (mode === 'unmount') r.visible.value = false; else r.sync({ userInfo: { ...owner, id: 8 } });
    await tick(); assert.equal(issued.signal.aborted, true); gate.resolve(); await tick();
    assert.equal(r.storage.get(PREFIX + 7), original); assert.doesNotMatch(text(r.tree), /本次未发出发布/); assert.equal(posts(r).length, 0);
    if (mode === 'unmount') r.visible.value = true; else r.sync({ userInfo: owner });
    await tick(); assert.equal(journal(r).length, 1); await click(r, '读取发布记录');
    assert.equal(journal(r).length, 0); assert.equal(seals(r).length, 1); assert.equal(posts(r).length, 0); assert.match(text(r.tree), /本次未发出发布/);
  }
});
