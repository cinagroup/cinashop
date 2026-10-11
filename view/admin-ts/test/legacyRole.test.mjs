// Executes the real SFC setup and Axios adapter. Native PostgreSQL and rendered browser checks are separate evidence.
import assert from 'node:assert/strict';
import { test, before, beforeEach, afterEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript } = require('@vue/compiler-sfc'), { build } = createRequire(resolve(root, '../../workers-ts/package.json'))('esbuild');
let runtime, storage, browser, apps, receipts;
const originals = new Map(), uuid = '123e4567-e89b-42d3-a456-426614174000', hash = 'a'.repeat(64), revision = 'b'.repeat(64);
const grants = ['system.legacy_role_view', 'system.legacy_role_status', 'system.legacy_role_delete'];
const key = 'admin_legacy_role_pending_v1:20';
const row = (changes = {}) => ({ id: 30, type: 1, relation_id: 0, role_name: '基础角色', rules: '展示名称，仅供查看', level: 2, status: 1, ...changes });
const references = () => [
  { id: 31, account: 'active-member', real_name: '启用账号', roles: [30, 40], level: 2, status: 1, is_del: 0, effective_permission_change: true },
  { id: 32, account: 'inactive-member', real_name: '停用账号', roles: [30], level: 2, status: 0, is_del: 0, effective_permission_change: false },
  { id: 33, account: 'removed-member', real_name: '历史账号', roles: [30], level: 2, status: 1, is_del: 1, effective_permission_change: false },
];
const pending = (changes = {}) => ({ version: 1, operation_id: uuid, actor_id: 20, operation: 'legacy-role-status', request_hash: hash, target_id: 30, action: 'status', ...changes });
const receipt = (p, state = 'committed') => ({ operation_id: p.operation_id, actor_id: p.actor_id, operation: p.operation, state,
  request_hash: state === 'committed' ? p.request_hash : null, result: state === 'committed' ? p.operation === 'legacy-role-delete' ? { id: p.target_id, deleted: true } : { id: p.target_id, created: false } : null });
const body = config => typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
const owner = config => Number(String(config.headers['Authori-zation']).match(/role-token-(\d+)/)?.[1] ?? 20);
function preview(config) {
  const e = body(config), before = row({ rules: 'system.view,331' }), refs = references();
  return { operation_id: e.operation_id, actor_id: owner(config), operation: e.operation, request_hash: hash, revision, expires_at: Math.floor(Date.now() / 1000) + 300, requires_confirmation: true,
    summary: { target_id: e.payload.id, target_name: before.role_name, action: e.operation === 'legacy-role-status' ? 'status' : 'delete', before,
      after: e.operation === 'legacy-role-delete' ? null : { ...before, status: e.payload.status }, impact: { reference_count: refs.length, active_reference_count: 1, references: refs } } };
}
function standard(config) {
  if (config.url === '/setting/role' && config.method === 'get') return { list: [row()], count: 1 };
  if (config.url === '/setting/role-authority/preview') return preview(config);
  if (config.url.startsWith('/setting/role-authority/receipt/')) {
    const p = pending({ operation_id: config.url.split('/').at(-1), actor_id: owner(config), operation: config.params.operation });
    return receipts.get(p.operation_id) ?? receipt(p, 'unknown');
  }
  if (config.url === '/setting/role-authority/resolve') {
    const e = body(config), p = pending({ operation_id: e.operation_id, actor_id: owner(config), operation: e.operation });
    const r = receipts.get(p.operation_id) ?? receipt(p, 'not_applied'); receipts.set(p.operation_id, r); return r;
  }
  if (mutations([config]).length) {
    const deleted = config.method === 'delete', p = pending({ operation_id: config.headers['X-Admin-Operation-Id'], actor_id: owner(config),
      operation: deleted ? 'legacy-role-delete' : 'legacy-role-status', action: deleted ? 'delete' : 'status' });
    const r = receipt(p); receipts.set(p.operation_id, r); return r;
  }
  throw Error(`Unexpected adapter request ${config.method} ${config.url}`);
}
function setGlobal(key, value) { if (!originals.has(key)) originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); }
before(async () => {
  setGlobal('window', Object.assign(new EventTarget(), { location: { pathname: '/system/legacy-roles', href: '', search: '' } }));
  setGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  const result = await build({ stdin: { contents: `export { default as Page } from './src/pages/system/LegacyRoles.vue'; export { default as request } from './src/utils/request';
    export * as api from './src/api/legacyRole'; export * as operations from './src/utils/legacyRoleOperation'; export { createRenderer, nextTick } from 'vue';
    export { createPinia } from 'pinia'; export { useAuthStore } from './src/stores/auth'; export * as messages from 'element-plus';`, resolveDir: root },
    absWorkingDir: root, alias: { '@': resolve(root, 'src') }, bundle: true, write: false, platform: 'browser', format: 'esm',
    define: { 'import.meta.env.DEV': 'false', __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' },
    plugins: [{ name: 'role-setup', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({ contents: compileScript(parse(readFileSync(path, 'utf8'), { filename: path }).descriptor, { id: 'legacy-role' }).content, loader: 'ts' }));
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
  browser = Object.assign(new EventTarget(), { location: { pathname: '/system/legacy-roles', href: '', search: '' } });
  setGlobal('window', browser); setGlobal('localStorage', { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) });
  const locks = new Map(); setGlobal('navigator', { locks: { request: async (name, _options, run) => {
    const prior = locks.get(name) ?? Promise.resolve(); let release; const next = new Promise(done => release = done); locks.set(name, next);
    await prior; try { return await run(); } finally { release(); if (locks.get(name) === next) locks.delete(name); }
  } } });
  Object.assign(runtime.messages.state, { success: [], warnings: [], confirmations: [], confirm: async () => {} });
});
afterEach(() => { for (const app of apps) app.unmount(); for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } originals.clear(); });
const flush = async () => { for (let i = 0; i < 5; i++) { await new Promise(done => setTimeout(done, 1)); await runtime.nextTick(); } };
function login(permissions = grants, id = 20, suffix = '') {
  storage.set('admin_token', `role-token-${id}${suffix}`); storage.set('admin_session', JSON.stringify({ userInfo: { id, account: 'operator', real_name: '当前账号', level: 1, roles: '2' }, menus: [], uniqueAuth: permissions }));
}
function deferred() { let done, fail; const promise = new Promise((resolve, reject) => { done = resolve; fail = reject; }); return { promise, done, fail }; }
async function mount(permissions, respond, id = 20) {
  login(permissions, id); const calls = [];
  runtime.request.defaults.adapter = async config => { calls.push(config); const result = await (respond ? respond(config) : standard(config));
    return { config, data: result?.__envelope ?? { status: 200, msg: 'ok', data: result }, status: result?.__http ?? 200, statusText: 'fixture', headers: {} }; };
  let view; const renderer = runtime.createRenderer({ createElement: () => ({ children: [] }), createText: text => ({ text }), createComment: text => ({ text }),
    insert(node, parent) { node.parent = parent; (parent.children ??= []).push(node); }, remove() {}, parentNode: node => node.parent, nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {} });
  const app = renderer.createApp({ setup(props, context) { view = runtime.Page.setup(props, context); return () => null; } }), pinia = runtime.createPinia(); app.use(pinia); apps.push(app);
  app.mount({ children: [] }); await flush(); return { view, calls, auth: runtime.useAuthStore(pinia), close: () => { app.unmount(); apps = apps.filter(a => a !== app); } };
}
async function confirm(view) { view.confirmation.checked = true; await view.confirmOperation(); }
const mutations = calls => calls.filter(config => config.method === 'put' && config.url.startsWith('/setting/role/set_status/') || config.method === 'delete' && /^\/setting\/role\/\d+$/.test(config.url));
const statusPreview = async view => view.prepareStatus(view.rows.value[0]);

test('old list DTO and canonical status/delete requests keep display names out of bodies', async () => {
  const f = await mount(); assert.equal(f.view.rows.value[0].rules, '展示名称，仅供查看');
  await statusPreview(f.view); assert.equal(f.view.rows.value[0].status, 1); assert.equal(mutations(f.calls).length, 0);
  assert.equal(f.view.preview.value.summary.impact.references.length, 3); await confirm(f.view);
  await f.view.prepareDelete(f.view.rows.value[0]); assert.equal(f.view.preview.value.summary.after, null); await confirm(f.view);
  const writes = mutations(f.calls); assert.deepEqual(writes.map(c => [c.method, c.url]), [['put', '/setting/role/set_status/30/0'], ['delete', '/setting/role/30']]);
  for (const c of writes) { assert.equal(c.data, undefined); assert.match(c.headers['X-Admin-Operation-Id'], runtime.api.roleUUID); assert.equal(c.headers['X-Admin-Revision'], revision); assert.equal(c.headers['X-Admin-Confirmed'], 'true'); assert.match(c.headers['X-Admin-Expires-At'], /^\d+$/); }
  assert.ok(f.calls.every(c => !c.url.startsWith('/system/authority/'))); assert.equal(storage.has(key), false);
});
test('status and delete fine keys are independent; list, form and save grants never elevate either writer', async () => {
  for (const permission of ['system.legacy_role_view', 'system.view', 'system.legacy_role_form_view', 'system.legacy_role_manage']) {
    const f = await mount(['system.legacy_role_view', permission]); await statusPreview(f.view); await f.view.prepareDelete(f.view.rows.value[0]);
    assert.equal(f.view.canStatus.value, false); assert.equal(f.view.canDelete.value, false); assert.equal(f.calls.filter(c => c.url.endsWith('/preview')).length, 0); f.close();
  }
  const status = await mount(['system.legacy_role_status']); assert.equal(status.view.canView.value, true); await statusPreview(status.view); assert.ok(status.view.preview.value);
  status.view.cancelPreview(); await status.view.prepareDelete(status.view.rows.value[0]); assert.equal(status.view.preview.value, null); status.close();
  const del = await mount(['system.legacy_role_delete']); assert.equal(del.view.canView.value, true); await statusPreview(del.view); assert.equal(del.view.preview.value, null); await del.view.prepareDelete(del.view.rows.value[0]); assert.ok(del.view.preview.value);
});
test('complete impact rejects missing, truncated, unsorted, foreign and miscounted references', () => {
  const envelope = { operation_id: uuid, operation: 'legacy-role-status', payload: { id: 30, status: 0 } };
  for (const change of [v => delete v.summary.impact, v => v.summary.impact.references.pop(), v => v.summary.impact.references.reverse(), v => v.summary.impact.references[1].id = 31,
    v => v.summary.impact.active_reference_count = 2, v => v.summary.impact.references[0].roles = [40], v => v.summary.impact.references[1].effective_permission_change = true,
    v => v.summary.impact.references[0].roles = ['30'], v => v.summary.impact.references[0].is_del = '0', v => delete v.summary.impact.references[0].account]) {
    const value = preview({ data: envelope, headers: {} }); change(value); assert.throws(() => runtime.api.parseRolePreview(value, envelope, 20));
  }
});
test('preview binds identity, expiry, action and exact status-only change or physical deletion', () => {
  for (const kind of ['legacy-role-status', 'legacy-role-delete']) {
    const envelope = { operation_id: uuid, operation: kind, payload: kind === 'legacy-role-status' ? { id: 30, status: 0 } : { id: 30 } };
    const original = preview({ data: envelope, headers: {} }); assert.doesNotThrow(() => runtime.api.parseRolePreview(original, envelope, 20));
    for (const change of [v => v.actor_id = 99, v => v.operation_id = crypto.randomUUID(), v => v.summary.target_id = 90, v => v.summary.target_name = 'other',
      v => v.expires_at = 0, v => v.revision = 'bad', v => v.summary.action = 'update', v => v.requires_confirmation = false,
      v => { if (kind === 'legacy-role-status') v.summary.after.rules = 'different'; else v.summary.after = v.summary.before; }]) {
      const value = structuredClone(original); change(value); assert.throws(() => runtime.api.parseRolePreview(value, envelope, 20));
    }
  }
});
test('only explicit unchanged unexpired confirmation sends a mutation; revoked precise permission cancels preview', async () => {
  const f = await mount(); await statusPreview(f.view); await f.view.confirmOperation(); assert.equal(mutations(f.calls).length, 0);
  f.view.preview.value.expires_at = 0; await confirm(f.view); assert.equal(mutations(f.calls).length, 0);
  await statusPreview(f.view); f.auth.$patch({ uniqueAuth: ['system.legacy_role_view', 'system.legacy_role_delete'] }); await confirm(f.view);
  assert.equal(f.view.preview.value, null); assert.equal(mutations(f.calls).length, 0);
});
for (const issue of ['timeout', 'http500', 'nodata', 'malformed', 'foreignReceipt', 'requestHash']) test(`unknown ${issue} keeps exactly seven pre-send recovery fields and blocks new UUID`, async () => {
  const f = await mount(undefined, config => { if (mutations([config]).length) {
    assert.deepEqual(Object.keys(JSON.parse(storage.get(key))), ['version', 'operation_id', 'actor_id', 'operation', 'request_hash', 'target_id', 'action']);
    assert.ok(!storage.get(key).includes(revision)); assert.ok(!storage.get(key).includes('active-member')); assert.ok(!storage.get(key).includes('system.view'));
    if (issue === 'timeout') throw Error('timeout'); if (issue === 'http500') return { __http: 500 }; if (issue === 'nodata') return { __envelope: { status: 200, msg: 'ok' } }; if (issue === 'malformed') return { state: 'committed' };
    const r = standard(config); if (issue === 'foreignReceipt') r.actor_id = 99; else r.request_hash = 'c'.repeat(64); return r;
  } return standard(config); });
  await statusPreview(f.view); await confirm(f.view); assert.ok(f.view.pending.value); assert.equal(f.view.writeBlocked.value, true); assert.equal(runtime.messages.state.success.length, 0);
  await f.view.prepareDelete(f.view.rows.value[0]); assert.equal(mutations(f.calls).length, 1); assert.equal(f.calls.filter(c => c.url.endsWith('/preview')).length, 1);
});
test('HTTP404 and new list state never unlock pending; only matching receipt or permanent seal may clear it', async () => {
  const f = await mount(undefined, config => { if (mutations([config]).length) throw Error('lost'); if (config.url.includes('/receipt/')) return { __http: 404 }; return standard(config); });
  await statusPreview(f.view); await confirm(f.view); const raw = storage.get(key); await f.view.recoverOperation(); await f.view.loadList(); assert.equal(storage.get(key), raw);
  runtime.messages.state.confirm = async () => { throw Error('cancel'); }; await f.view.resolveOperation(); assert.equal(f.calls.filter(c => c.url.endsWith('/resolve')).length, 0);
  runtime.messages.state.confirm = async () => {}; await f.view.resolveOperation(); assert.equal(f.view.pending.value, null); assert.equal(storage.has(key), false);
});
test('unknown receipt and malformed seal retain pending, including raw evidence', async () => {
  const f = await mount(undefined, config => { if (mutations([config]).length) throw Error('lost'); if (config.url.endsWith('/resolve')) return { state: 'not_applied' }; return standard(config); });
  await statusPreview(f.view); await confirm(f.view); const raw = storage.get(key); await f.view.recoverOperation(); await f.view.resolveOperation(); assert.equal(storage.get(key), raw); assert.ok(f.view.pending.value); assert.equal(runtime.messages.state.success.length, 0);
});
test('reload and switched actor isolate pending; same actor new login can recover after writer revocation', async () => {
  const respond = config => { if (mutations([config]).length) throw Error('lost'); return standard(config); };
  const first = await mount(undefined, respond); await statusPreview(first.view); await confirm(first.view); const raw = storage.get(key); first.close();
  const foreign = await mount([], respond, 31); assert.equal(foreign.view.pending.value, null); assert.equal(storage.get(key), raw); foreign.close();
  const same = await mount([], respond); assert.ok(same.view.pending.value); assert.equal(same.view.canView.value, false); assert.equal(same.view.canRetry.value, false);
  const r = receipt(same.view.pending.value); receipts.set(r.operation_id, r); await same.view.recoverOperation(); assert.equal(storage.has(key), false); assert.equal(mutations(same.calls).length, 0);
});
test('late commit response from replaced token/actor cannot clear original recovery or change new UI', async () => {
  const gate = deferred(), f = await mount(undefined, config => mutations([config]).length ? gate.promise : standard(config));
  await statusPreview(f.view); const writing = confirm(f.view); await flush(); const raw = storage.get(key), original = JSON.parse(raw);
  login([], 31); browser.dispatchEvent(new Event('admin-session-changed')); await flush(); gate.done(receipt(original)); await writing;
  assert.equal(storage.get(key), raw); assert.equal(f.view.pending.value, null); assert.equal(runtime.messages.state.success.length, 0);
  login([], 20, '-new-version'); browser.dispatchEvent(new Event('admin-session-changed')); await flush(); assert.ok(f.view.pending.value); assert.equal(f.view.canRetry.value, false);
});
test('late list and preview responses cannot refill replacement account UI', async () => {
  const list = deferred(); let listCalls = 0;
  const f = await mount(undefined, config => config.url === '/setting/role' && config.method === 'get' && ++listCalls > 1 ? list.promise : standard(config));
  const listing = f.view.loadList(); await flush(); login([], 31); browser.dispatchEvent(new Event('admin-session-changed')); await flush(); list.done({ list: [row()], count: 1 }); await listing;
  assert.deepEqual(f.view.rows.value, []); f.close();
  const gate = deferred(), second = await mount(undefined, config => config.url.endsWith('/preview') ? gate.promise : standard(config));
  const previewing = statusPreview(second.view); await flush(); const request = second.calls.find(c => c.url.endsWith('/preview'));
  login([], 31); browser.dispatchEvent(new Event('admin-session-changed')); await flush(); gate.done(preview(request)); await previewing;
  assert.equal(second.view.preview.value, null); assert.equal(second.view.confirmation.show, false);
});
test('double confirm and retry use the same original operation and empty-body canonical path', async () => {
  let attempts = 0; const gate = deferred(), f = await mount(undefined, config => mutations([config]).length && ++attempts === 1 ? gate.promise : standard(config));
  await statusPreview(f.view); const first = confirm(f.view); await flush(); await confirm(f.view); assert.equal(mutations(f.calls).length, 1);
  gate.fail(Error('lost')); await first; const original = mutations(f.calls)[0]; await f.view.retryOperation(); const retried = mutations(f.calls)[1];
  assert.equal(retried.headers['X-Admin-Operation-Id'], original.headers['X-Admin-Operation-Id']); assert.equal(retried.url, original.url); assert.equal(retried.data, undefined); assert.equal(f.view.pending.value, null);
});
test('unavailable storage/locks and malformed pending never send or erase recovery evidence', async () => {
  const f = await mount(); await statusPreview(f.view); const original = localStorage.setItem; localStorage.setItem = (k, v) => { if (k === key) throw Error('storage unavailable'); return original(k, v); };
  await confirm(f.view); assert.equal(mutations(f.calls).length, 0); assert.equal(f.view.writeBlocked.value, true); localStorage.setItem = original;
  storage.set(key, '{invalid'); browser.dispatchEvent(Object.assign(new Event('storage'), { storageArea: localStorage, key })); await flush(); assert.equal(storage.get(key), '{invalid');
  assert.equal(f.view.writeBlocked.value, true); f.close(); storage.delete(key);
  const second = await mount(); await statusPreview(second.view); setGlobal('navigator', {}); await confirm(second.view); assert.equal(mutations(second.calls).length, 0); assert.equal(second.view.writeBlocked.value, true);
});
test('WebLocks serialize actor reservations; unknown, foreign and stale receipts retain original record', async () => {
  const store = new runtime.operations.RolePendingStore(localStorage), p = pending(), other = pending({ operation_id: '123e4567-e89b-42d3-a456-426614174001' });
  const results = await Promise.allSettled([store.reserve(p, () => true), store.reserve(other, () => true)]); assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(await store.finish(receipt(p, 'unknown'), p, () => true), false); await assert.rejects(store.finish({ ...receipt(p), actor_id: 99 }, p, () => true));
  assert.equal(await store.finish(receipt(p), p, () => false), false); assert.deepEqual(store.read(20), p); assert.equal(await store.finish(receipt(p), p, () => true), true);
});
test('deleted snapshot proof remains internal; wire receipt strict parser refuses expanded/incorrect result', () => {
  const p = pending({ operation: 'legacy-role-delete', action: 'delete' }); assert.doesNotThrow(() => runtime.api.parseRoleReceipt(receipt(p), p));
  for (const result of [{ id: 30, deleted: false }, { id: 30, deleted: true, deleted_role: row() }, { id: 30, created: false }, { id: 31, deleted: true }]) assert.throws(() => runtime.api.parseRoleReceipt({ ...receipt(p), result }, p));
});
