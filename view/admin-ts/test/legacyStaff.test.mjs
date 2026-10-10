// These tests execute the actual SFC setup and Axios adapter. They do not claim PostgreSQL or browser coverage.
import assert from 'node:assert/strict';
import { test, before, beforeEach, afterEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript } = require('@vue/compiler-sfc');
const { build } = createRequire(resolve(root, '../../workers-ts/package.json'))('esbuild');
let runtime, storage, browser, apps;
const originals = new Map();
const uuid = '123e4567-e89b-42d3-a456-426614174000', hash = 'a'.repeat(64), revision = 'b'.repeat(64);
const fields = { account: 'new-operator', conf_pwd: 'synthetic-password-123', pwd: 'synthetic-password-123', real_name: '新管理员', phone: '13800000000', roles: [2, 7], status: 1 };
const pending = (changes = {}) => ({ version: 1, operation_id: uuid, actor_id: 20, operation: 'legacy-admin-save', request_hash: hash, target_id: 0, action: 'create', ...changes });
const receipt = (p, state = 'committed') => ({ operation_id: p.operation_id, actor_id: p.actor_id, operation: p.operation, state,
  request_hash: state === 'committed' ? p.request_hash : null, result: state === 'committed' ? p.operation === 'legacy-admin-delete' ? { id: p.target_id, deleted: true } : { id: p.target_id || 40, created: p.action === 'create' } : null });
function values(changes = {}) { return { account: 'operator-old', real_name: '原管理员', phone: '13900000000', roles: [2], status: 1, level: 2, is_del: 0, ...changes }; }
function form(id = 0) {
  const initial = id ? { account: 'operator-old', real_name: '原管理员', phone: '13900000000', roles: [2], status: 1 } : { account: '', real_name: '', phone: '', roles: [], status: 1 };
  return { title: id ? '管理员修改' : '管理员添加', action: `setting/admin${id ? `/${id}` : ''}`, method: id ? 'PUT' : 'POST', rules: [
    ...['account', 'pwd', 'conf_pwd', 'real_name', 'phone'].map(field => ({ type: 'input', field, title: field, value: initial[field] ?? '' })),
    { type: 'select', field: 'roles', title: '角色', value: initial.roles, props: { multiple: true }, options: [{ value: 2, label: '基础角色' }, { value: 7, label: '运营角色' }] },
    { type: 'radio', field: 'status', title: '状态', value: initial.status, options: [{ value: 1, label: '开启' }, { value: 0, label: '关闭' }] },
  ] };
}
function row(id = 30) { return { id, account: 'operator-old', real_name: '原管理员', phone: '13900000000', roles: '基础角色', level: 2, status: 1, last_ip: '', last_time: 0, add_time: 1, _add_time: '1970-01-01 08:00:01', _last_time: '' }; }
const body = config => typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
const owner = config => Number(String(config.headers['Authori-zation']).match(/staff-token-(\d+)/)?.[1] ?? 20);
function preview(config) {
  const e = body(config), p = e.payload, action = e.operation === 'legacy-admin-save' ? p.id === 0 ? 'create' : 'update' : e.operation === 'legacy-admin-status' ? 'status' : 'delete';
  const before = action === 'create' ? null : values();
  const after = values(action === 'create' || action === 'update' ? { account: p.account, real_name: p.real_name, phone: p.phone, roles: p.roles, status: p.status }
    : { status: action === 'delete' ? 0 : p.status, is_del: action === 'delete' ? 1 : 0 });
  return { operation_id: e.operation_id, actor_id: owner(config), operation: e.operation, request_hash: hash, revision, expires_at: Math.floor(Date.now() / 1000) + 300,
    requires_confirmation: true, summary: { target_id: p.id, target_name: after.account, action, before, after: { ...after, password_changed: !!p.pwd } } };
}
let receipts;
function standard(config) {
  if (config.url === '/setting/admin-authority/preview') return preview(config);
  if (config.url.startsWith('/setting/admin-authority/receipt/')) {
    const p = pending({ operation_id: config.url.split('/').at(-1), actor_id: owner(config), operation: config.params.operation });
    return receipts.get(p.operation_id) ?? receipt(p, 'unknown');
  }
  if (config.url === '/setting/admin-authority/resolve') {
    const e = body(config), p = pending({ operation_id: e.operation_id, actor_id: owner(config), operation: e.operation });
    const r = receipts.get(p.operation_id) ?? receipt(p, 'not_applied'); receipts.set(p.operation_id, r); return r;
  }
  if (config.url === '/setting/admin/create') return form();
  if (/^\/setting\/admin\/\d+\/edit$/.test(config.url)) return form(Number(config.url.split('/')[3]));
  if (config.url === '/setting/admin' && config.method === 'get') return { list: [row()], count: 1 };
  if (['post', 'put', 'delete'].includes(config.method)) {
    const status = config.url.startsWith('/setting/set_status/'), deleted = config.method === 'delete', id = config.url === '/setting/admin' ? 0 : Number(config.url.split('/')[3]);
    const p = pending({ operation_id: config.headers['X-Admin-Operation-Id'], actor_id: owner(config), operation: deleted ? 'legacy-admin-delete' : status ? 'legacy-admin-status' : 'legacy-admin-save', target_id: id, action: deleted ? 'delete' : status ? 'status' : id ? 'update' : 'create' });
    const r = receipt(p); receipts.set(p.operation_id, r); return r;
  }
  throw Error(`Unexpected adapter request ${config.method} ${config.url}`);
}
function setGlobal(key, value) { if (!originals.has(key)) originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); }
before(async () => {
  setGlobal('window', Object.assign(new EventTarget(), { location: { pathname: '/system/legacy-staff', href: '', search: '' } }));
  setGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  const result = await build({ stdin: { contents: `export { default as Page } from './src/pages/system/LegacyStaff.vue'; export { default as request } from './src/utils/request';
    export * as api from './src/api/legacyAdmin'; export * as operations from './src/utils/legacyStaffOperation'; export { createRenderer, nextTick } from 'vue';
    export { createPinia } from 'pinia'; export { useAuthStore } from './src/stores/auth'; export * as messages from 'element-plus';`, resolveDir: root },
    absWorkingDir: root, alias: { '@': resolve(root, 'src') }, bundle: true, write: false, platform: 'browser', format: 'esm', define: { 'import.meta.env.DEV': 'false', __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' },
    plugins: [{ name: 'staff-setup', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({ contents: compileScript(parse(readFileSync(path, 'utf8'), { filename: path }).descriptor, { id: 'legacy-staff' }).content, loader: 'ts' }));
      builder.onResolve({ filter: /^element-plus$/ }, () => ({ path: 'messages', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const state={success:[],warnings:[],confirmations:[],confirm:async()=>{}};
        export const ElMessage={success:x=>state.success.push(x),warning:x=>state.warnings.push(x),error:()=>{}};
        export const ElMessageBox={confirm:async(...args)=>{state.confirmations.push(args);await state.confirm(...args);},close:()=>{}};` }));
    } }],
  });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
});
beforeEach(() => {
  storage = new Map(); receipts = new Map(); apps = [];
  browser = Object.assign(new EventTarget(), { location: { pathname: '/system/legacy-staff', href: '', search: '' } });
  setGlobal('window', browser); setGlobal('localStorage', { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) });
  const locks = new Map();
  setGlobal('navigator', { locks: { request: async (name, _options, run) => {
    const prior = locks.get(name) ?? Promise.resolve(); let release; const next = new Promise(done => release = done); locks.set(name, next);
    await prior; try { return await run(); } finally { release(); if (locks.get(name) === next) locks.delete(name); }
  } } });
  Object.assign(runtime.messages.state, { success: [], warnings: [], confirmations: [], confirm: async () => {} });
});
afterEach(() => { for (const app of apps) app.unmount(); for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } originals.clear(); });
const flush = async () => { for (let i = 0; i < 5; i++) { await new Promise(done => setTimeout(done, 1)); await runtime.nextTick(); } };
function login(grants = ['system.legacy_admin_view', 'system.legacy_admin_form_view', 'system.legacy_admin_manage'], id = 20, suffix = '') {
  storage.set('admin_token', `staff-token-${id}${suffix}`); storage.set('admin_session', JSON.stringify({ userInfo: { id, account: 'operator', real_name: '当前账号', level: 1, roles: '2' }, menus: [], uniqueAuth: grants }));
}
function deferred() { let done, fail; const promise = new Promise((resolve, reject) => { done = resolve; fail = reject; }); return { promise, done, fail }; }
async function mount(grants, respond, id = 20) {
  login(grants, id); const calls = [];
  runtime.request.defaults.adapter = async config => { calls.push(config); const result = await (respond ? respond(config) : standard(config));
    return { config, data: result?.__envelope ?? { status: 200, msg: 'ok', data: result }, status: result?.__http ?? 200, statusText: 'fixture', headers: {} }; };
  let view; const renderer = runtime.createRenderer({ createElement: () => ({ children: [] }), createText: text => ({ text }), createComment: text => ({ text }),
    insert(node, parent) { node.parent = parent; (parent.children ??= []).push(node); }, remove() {}, parentNode: node => node.parent, nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {} });
  const app = renderer.createApp({ setup(props, context) { view = runtime.Page.setup(props, context); return () => null; } }), pinia = runtime.createPinia(); app.use(pinia); apps.push(app);
  app.mount({ children: [] }); await flush(); return { view, calls, auth: runtime.useAuthStore(pinia), close: () => { app.unmount(); apps = apps.filter(a => a !== app); } };
}
async function savePreview(view, edit = false) { await view.openForm(edit ? view.rows.value[0] : undefined); Object.assign(view.editor.fields, fields); await view.prepareSave(); }
async function confirm(view) { view.confirmation.checked = true; await view.confirmOperation(); }
const mutations = calls => calls.filter(config => (config.url === '/setting/admin' && config.method === 'post') || /^\/setting\/admin\/\d+$/.test(config.url) || config.url.startsWith('/setting/set_status/'));
const key = 'admin_legacy_staff_pending_v1:20';

test('form preserves seven fields, numeric roles and controlled action; rejects hostile/partial DTOs', () => {
  const created = runtime.api.parseStaffForm(form(), 0), edited = runtime.api.parseStaffForm(form(30), 30);
  assert.deepEqual(Object.keys(created.fields), ['account', 'pwd', 'conf_pwd', 'real_name', 'phone', 'roles', 'status']); assert.equal(edited.fields.account, 'operator-old'); assert.deepEqual(edited.fields.roles, [2]);
  assert.equal(created.method, 'POST'); assert.equal(edited.action, 'setting/admin/30');
  for (const change of [f => f.action = 'https://attacker.test/', f => f.action = '/adminapi/setting/admin', f => f.rules.pop(), f => f.rules[1].value = 'password leak', f => f.rules[5].value = ['2'], f => f.rules[5].options[0].value = '2', f => f.rules[5].options.push(f.rules[5].options[0]), f => f.rules[6].value = '1']) { const f = form(); change(f); assert.throws(() => runtime.api.parseStaffForm(f, 0)); }
});
test('validation enforces real storage, mobile, confirmation and Unicode bcrypt byte limits', () => {
  assert.deepEqual(runtime.api.validateStaffFields(fields, true), fields);
  assert.equal(runtime.api.validateStaffFields({ ...fields, pwd: '', conf_pwd: '' }, false).pwd, '');
  const unicode = '界'.repeat(12); assert.equal(runtime.api.validateStaffFields({ ...fields, pwd: unicode, conf_pwd: unicode }, true).pwd, unicode);
  for (const changed of [{ account: 'a'.repeat(33) }, { real_name: ' ' }, { phone: '+8613800000000' }, { roles: ['2'] }, { roles: [] }, { roles: [2, 2] }, { roles: [0] }, { status: null }, { conf_pwd: 'different' }, { pwd: '', conf_pwd: '' }, { pwd: '界'.repeat(25), conf_pwd: '界'.repeat(25) }, { realm: 1 }]) assert.throws(() => runtime.api.validateStaffFields({ ...fields, ...changed }, true));
});
test('edit preserves assigned inactive or deleted numeric role IDs and requires explicit removal before preview', async () => {
  for (const state of ['停用', '已删除']) {
    const f = await mount(undefined, config => {
      if (config.url.endsWith('/edit')) { const dto = form(30); dto.rules[5].options[0].label = `基础角色（当前${state}身份，保存时请移除）`; dto.rules[5].options[0].disabled = true; return dto; }
      return standard(config);
    });
    await f.view.openForm(f.view.rows.value[0]); assert.deepEqual(f.view.editor.fields.roles, [2]); assert.equal(f.view.form.value.roleOptions[0].disabled, true); assert.equal(f.view.hasInactiveRoles.value, true);
    assert.ok(f.view.form.value.roleOptions[0].label.includes(state));
    await f.view.prepareSave(); assert.equal(f.calls.filter(c => c.url.endsWith('/preview')).length, 0);
    f.view.removeInactiveRoles(); assert.deepEqual(f.view.editor.fields.roles, []); assert.equal(f.view.hasInactiveRoles.value, false);
    Object.assign(f.view.editor.fields, { ...fields, roles: [7], pwd: '', conf_pwd: '' }); await f.view.prepareSave(); assert.ok(f.view.preview.value); assert.deepEqual(f.view.preview.value.summary.after.roles, [7]);
    await confirm(f.view); assert.deepEqual(body(mutations(f.calls).at(-1)).roles, [7]);
    f.close();
  }
});
test('dedicated staff page consumes old list/edit DTO and sends original create/update/status/delete contracts', async () => {
  const f = await mount(); await savePreview(f.view); assert.ok(f.view.preview.value); assert.equal(mutations(f.calls).length, 0);
  assert.deepEqual(f.view.preview.value.summary.after.roles, [2, 7]); await confirm(f.view);
  await savePreview(f.view, true); f.view.editor.fields.account = 'renamed-account'; await f.view.prepareSave(); await confirm(f.view);
  await f.view.prepareStatus(f.view.rows.value[0]); assert.equal(f.view.rows.value[0].status, 1); await confirm(f.view);
  await f.view.prepareDelete(f.view.rows.value[0]); await confirm(f.view);
  const writes = mutations(f.calls); assert.deepEqual(writes.map(c => [c.method, c.url]), [['post', '/setting/admin'], ['put', '/setting/admin/30'], ['put', '/setting/set_status/30/0'], ['delete', '/setting/admin/30']]);
  assert.deepEqual(Object.keys(body(writes[0])), ['account', 'conf_pwd', 'pwd', 'real_name', 'phone', 'roles', 'status']); assert.equal(body(writes[1]).account, 'renamed-account');
  for (const write of writes) { assert.match(write.headers['X-Admin-Operation-Id'], runtime.api.staffUUID); assert.equal(write.headers['X-Admin-Confirmed'], 'true'); assert.equal(write.headers['X-Admin-Revision'], revision); assert.match(write.headers['X-Admin-Expires-At'], /^\d+$/); }
  assert.equal(writes[2].data, undefined); assert.equal(writes[3].data, undefined); assert.equal(f.view.pending.value, null); assert.equal(storage.has(key), false);
  assert.ok(f.calls.every(c => !c.url.startsWith('/system/authority/')));
});
test('fine list/form/manage separation protects previews and allows form without mutation grant', async () => {
  const f = await mount(['system.legacy_admin_view', 'system.legacy_admin_form_view']); await f.view.openForm(f.view.rows.value[0]); assert.ok(f.view.form.value);
  assert.equal(f.view.canManage.value, false); await f.view.prepareSave(); await f.view.prepareStatus(f.view.rows.value[0]); await f.view.prepareDelete(f.view.rows.value[0]);
  assert.equal(f.calls.filter(c => c.url.endsWith('/preview')).length, 0); assert.equal(mutations(f.calls).length, 0);
});
test('must explicitly confirm unchanged complete preview; draft edits and permission revocation cancel it', async () => {
  const f = await mount(); await savePreview(f.view); await f.view.confirmOperation(); assert.equal(mutations(f.calls).length, 0);
  f.view.editor.fields.phone = '13911111111'; assert.equal(f.view.preview.value, null); await confirm(f.view); assert.equal(mutations(f.calls).length, 0);
  await f.view.prepareSave(); f.auth.$patch({ uniqueAuth: ['system.legacy_admin_view'] }); await confirm(f.view); assert.equal(mutations(f.calls).length, 0); assert.equal(f.view.canManage.value, false);
});
for (const issue of ['timeout', 'http500', 'nodata', 'malformed', 'foreignReceipt', 'requestHash']) test(`unknown ${issue} preserves pre-send durable metadata and blocks new UUID`, async () => {
  const f = await mount(undefined, config => { if (mutations([config]).length) {
    assert.ok(storage.has(key)); assert.deepEqual(Object.keys(JSON.parse(storage.get(key))), ['version', 'operation_id', 'actor_id', 'operation', 'request_hash', 'target_id', 'action']); assert.equal(storage.get(key).includes(fields.pwd), false);
    if (issue === 'timeout') throw Error('timeout'); if (issue === 'http500') return { __http: 500 };
    if (issue === 'nodata') return { __envelope: { status: 200, msg: 'ok' } }; if (issue === 'malformed') return { state: 'committed' };
    const r = standard(config); if (issue === 'foreignReceipt') r.actor_id = 99; else r.request_hash = 'c'.repeat(64); return r;
  } return standard(config); });
  await savePreview(f.view); await confirm(f.view); assert.ok(f.view.pending.value); assert.equal(f.view.writeBlocked.value, true); assert.equal(runtime.messages.state.success.length, 0);
  await f.view.openForm(); await f.view.prepareSave(); assert.equal(mutations(f.calls).length, 1);
});
test('unknown/notfound stays locked; only original committed receipt or permanent not_applied unlocks', async () => {
  const f = await mount(undefined, config => { if (mutations([config]).length) throw Error('lost'); return standard(config); });
  await savePreview(f.view); await confirm(f.view); const frozen = f.view.pending.value; await f.view.recoverOperation(); assert.deepEqual(f.view.pending.value, frozen); assert.ok(storage.has(key));
  await f.view.resolveOperation(); assert.equal(f.view.pending.value, null); assert.equal(storage.has(key), false); assert.equal(runtime.messages.state.success.length, 1);
});
test('reload and account switch never persist passwords or expose another actor pending; same actor fresh login restores', async () => {
  const respond = config => { if (mutations([config]).length) throw Error('response lost'); return standard(config); };
  const first = await mount(undefined, respond); await savePreview(first.view); await confirm(first.view); const raw = storage.get(key); first.close();
  const foreign = await mount([], respond, 31); assert.equal(foreign.view.pending.value, null); assert.equal(storage.get(key), raw); foreign.close();
  const same = await mount([], respond, 20); assert.ok(same.view.pending.value); assert.equal(same.view.canView.value, false); assert.equal(same.view.canRecover.value, true); assert.equal(same.view.canRetry.value, false);
  await same.view.recoverOperation(); assert.ok(same.view.pending.value); const r = receipt(same.view.pending.value); receipts.set(r.operation_id, r); await same.view.recoverOperation(); assert.equal(same.view.pending.value, null); assert.equal(storage.has(key), false); assert.equal(mutations(same.calls).length, 0);
});
test('double confirm and exact original retry cannot invent a replacement UUID or new draft', async () => {
  let attempts = 0; const blocked = deferred();
  const f = await mount(undefined, config => { if (mutations([config]).length && ++attempts === 1) return blocked.promise; return standard(config); });
  await savePreview(f.view); const first = confirm(f.view); await flush(); await confirm(f.view); assert.equal(mutations(f.calls).length, 1);
  blocked.fail(Error('lost')); await first; const original = mutations(f.calls)[0]; f.view.editor.fields.real_name = '另一草稿'; await f.view.retryOperation();
  assert.equal(mutations(f.calls).length, 2); const retried = mutations(f.calls)[1]; assert.equal(retried.data, original.data); assert.equal(retried.headers['X-Admin-Operation-Id'], original.headers['X-Admin-Operation-Id']); assert.equal(f.view.pending.value, null);
});
test('late form and write responses after token/actor replacement cannot clear original pending or change new UI', async () => {
  const gate = deferred(); const f = await mount(undefined, config => mutations([config]).length ? gate.promise : standard(config));
  await savePreview(f.view); const writing = confirm(f.view); await flush(); const raw = storage.get(key), originalPending = JSON.parse(raw);
  login([], 31); browser.dispatchEvent(new Event('admin-session-changed')); await flush(); gate.done(receipt(originalPending)); await writing;
  assert.equal(f.view.pending.value, null); assert.equal(storage.get(key), raw); assert.equal(runtime.messages.state.success.length, 0);
  login([], 20, '-new-password-version'); browser.dispatchEvent(new Event('admin-session-changed')); await flush(); assert.ok(f.view.pending.value); assert.equal(f.view.canRetry.value, false);
});
test('late edit form response and stale preview cannot refill drafts after account switch', async () => {
  const gate = deferred(); const f = await mount(undefined, config => config.url.endsWith('/edit') ? gate.promise : standard(config));
  const editing = f.view.openForm(f.view.rows.value[0]); await flush(); login([], 31); browser.dispatchEvent(new Event('admin-session-changed')); await flush(); gate.done(form(30)); await editing;
  assert.equal(f.view.editor.show, false); assert.equal(f.view.form.value, null); assert.deepEqual(f.view.editor.fields.roles, []);
  assert.equal(f.view.editor.fields.account, ''); assert.equal(f.view.canManage.value, false);
});
test('auth-version rejection after acknowledged write preserves metadata; same actor password re-login obtains original receipt', async () => {
  const f = await mount(undefined, config => { if (mutations([config]).length) { standard(config); return { __envelope: { status: 410001, msg: 'old password version', data: null } }; } return standard(config); });
  await savePreview(f.view); await confirm(f.view); assert.equal(storage.has('admin_token'), false); assert.ok(storage.has(key)); assert.equal(f.view.pending.value, null);
  login([], 20, '-password-updated'); browser.dispatchEvent(new Event('admin-session-changed')); await flush(); assert.ok(f.view.pending.value); assert.equal(f.view.canRetry.value, false);
  await f.view.recoverOperation(); assert.equal(f.view.pending.value, null); assert.equal(storage.has(key), false); assert.equal(mutations(f.calls).length, 1);
});
test('receipt HTTP404, malformed resolve, canceled resolve and new directory row cannot unlock an unknown create', async () => {
  const f = await mount(undefined, config => {
    if (mutations([config]).length) throw Error('lost');
    if (config.url.includes('/receipt/')) return { __http: 404 };
    if (config.url.endsWith('/resolve')) return { state: 'not_applied' };
    if (config.url === '/setting/admin' && config.method === 'get') return { list: [row(40)], count: 1 };
    return standard(config);
  });
  await savePreview(f.view); await confirm(f.view); const raw = storage.get(key); await f.view.recoverOperation(); assert.equal(storage.get(key), raw);
  await f.view.loadList(); assert.equal(f.view.rows.value[0].id, 40); assert.equal(storage.get(key), raw);
  runtime.messages.state.confirm = async () => { throw Error('cancel'); }; await f.view.resolveOperation(); assert.equal(f.calls.filter(c => c.url.endsWith('/resolve')).length, 0);
  runtime.messages.state.confirm = async () => {}; await f.view.resolveOperation(); assert.ok(f.view.pending.value); assert.equal(storage.get(key), raw); assert.equal(runtime.messages.state.success.length, 0);
});
test('malformed pending and failed persistence never send mutation or silently remove evidence', async () => {
  const f = await mount(); await savePreview(f.view); const original = localStorage.setItem; localStorage.setItem = (k, v) => { if (k === key) throw Error('storage unavailable'); return original(k, v); };
  await confirm(f.view); assert.equal(mutations(f.calls).length, 0); assert.equal(f.view.writeBlocked.value, true); localStorage.setItem = original;
  storage.set(key, '{invalid'); browser.dispatchEvent(Object.assign(new Event('storage'), { storageArea: localStorage, key })); await flush(); assert.equal(storage.get(key), '{invalid'); assert.equal(f.view.writeBlocked.value, true);
});
test('actor locks serialize two tabs reserve; unknown/foreign/stale receipts never clear pending', async () => {
  const store = new runtime.operations.StaffPendingStore(localStorage), p = pending(), other = pending({ operation_id: '123e4567-e89b-42d3-a456-426614174001' });
  const result = await Promise.allSettled([store.reserve(p, () => true), store.reserve(other, () => true)]); assert.equal(result.filter(r => r.status === 'fulfilled').length, 1); assert.deepEqual(store.read(20), p);
  assert.equal(await store.finish(receipt(p, 'unknown'), p, () => true), false); await assert.rejects(store.finish({ ...receipt(p), actor_id: 31 }, p, () => true));
  assert.equal(await store.finish(receipt(p), p, () => false), false); assert.deepEqual(store.read(20), p); assert.equal(await store.finish(receipt(p), p, () => true), true);
});
test('incomplete preview or fields mismatching account/phone/roles/status/password never reaches confirmation', async () => {
  for (const change of [v => delete v.summary.after.account, v => v.summary.after.account = 'other-account', v => v.summary.after.phone = '13900000000', v => v.summary.after.roles = [2], v => v.summary.after.status = 0, v => v.summary.after.password_changed = false, v => v.actor_id = 31, v => v.revision = 'bad', v => v.summary.after.level = 11]) {
    const envelope = { operation_id: uuid, operation: 'legacy-admin-save', payload: { id: 0, ...fields } };
    const v = preview({ data: JSON.stringify(envelope), headers: { 'Authori-zation': 'Bearer staff-token-20' } }); change(v); assert.throws(() => runtime.api.parseStaffPreview(v, envelope, 20));
  }
});
test('storage-bounded historic short accounts and empty roles can be repaired, disabled or deleted without inventing changes', () => {
  const before = values({ account: 'a', roles: [], real_name: '', phone: '' });
  for (const kind of ['legacy-admin-save', 'legacy-admin-status', 'legacy-admin-delete']) {
    const envelope = { operation_id: uuid, operation: kind, payload: kind === 'legacy-admin-save' ? { id: 30, ...fields } : kind === 'legacy-admin-status' ? { id: 30, status: 0 } : { id: 30 } };
    const v = preview({ data: JSON.stringify(envelope), headers: { 'Authori-zation': 'Bearer staff-token-20' } }); v.summary.before = before;
    if (kind !== 'legacy-admin-save') v.summary.after = { ...before, status: 0, is_del: kind === 'legacy-admin-delete' ? 1 : 0, password_changed: false };
    assert.doesNotThrow(() => runtime.api.parseStaffPreview(v, envelope, 20));
    if (kind !== 'legacy-admin-save') { v.summary.after.phone = '13800000000'; assert.throws(() => runtime.api.parseStaffPreview(v, envelope, 20)); }
  }
});
