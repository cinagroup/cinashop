import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../view/admin-ts');
const require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript } = require('@vue/compiler-sfc');
const base = '/supplier/supplier';
const version = 'a'.repeat(64);
const envelope = (data: unknown) => ({ status: 200, msg: 'ok', data });
const row = (id = 7) => ({ id, supplier_name: '甲供应商', name: '联系人', phone: '13800138000',
  address: '广东省深圳市南山区', is_show: 1, add_time: 1788200000,
  _add_time: '2026-09-01 08:00:00', mark: '原备注', sort: 0, revision: version });
const detail = (id = 7) => ({ ...row(id), email: 'owner@example.com', province: 1, city: 2,
  area: 3, street: 0, detailed_address: '科技园', account: 'supplier-a', pwd: '', conf_pwd: '' });
const filled = () => ({ supplier_name: '乙供应商', name: '联系人', phone: '13800138000',
  email: 'owner@example.com', address: '广东省深圳市南山区', province: 1, city: 2,
  area: 3, street: 0, detailed_address: '科技园', mark: '', account: 'supplier-b',
  pwd: 'Strong-password-2026', conf_pwd: 'Strong-password-2026', sort: 0, is_show: 1 });

let runtime: any, browser: EventTarget, values: Map<string, string>;

beforeAll(async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { search: '', pathname: '/supplier/directory', href: '' } }));
  const result = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    export { default as Page } from './src/pages/supplier/SupplierDirectory.vue';
    export { default as request } from './src/utils/request';
    export * as api from './src/api/supplierDirectory';
    export * as messages from 'element-plus';
    export { createRenderer, nextTick } from 'vue';
    export { createPinia } from 'pinia';
  ` }, alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false' },
  bundle: true, write: false, platform: 'browser', format: 'esm',
  plugins: [{ name: 'supplier-directory-runtime', setup(builder) {
    builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({ contents: compileScript(parse(readFileSync(path, 'utf8'),
      { filename: path }).descriptor, { id: 'supplier-directory-runtime' }).content, loader: 'ts' }));
    builder.onResolve({ filter: /^element-plus$/ }, ({ path }) => ({ path, namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
      export const state = { errors: [], warnings: [], successes: [], confirmations: [] };
      export const ElMessage = { error: value => state.errors.push(value),
        warning: value => state.warnings.push(value), success: value => state.successes.push(value) };
      export const ElMessageBox = { confirm: async (...args) => { state.confirmations.push(args); }, close() {} };
    ` }));
  } }] });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
});

beforeEach(() => {
  values = new Map(); browser = new EventTarget();
  vi.stubGlobal('window', Object.assign(browser, { location: { search: '', pathname: '/supplier/directory', href: '' } }));
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  runtime.messages.state.errors = []; runtime.messages.state.warnings = [];
  runtime.messages.state.successes = []; runtime.messages.state.confirmations = [];
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const flush = async () => { for (let i = 0; i < 9; i++) { await new Promise(done => setTimeout(done, 1)); await runtime.nextTick(); } };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function login(permissions = ['supplier_directory.view'], token = 'directory-a', id = 20) {
  values.set('admin_token', token);
  values.set('admin_session', JSON.stringify({ userInfo: { id, account: 'operator', level: 1, roles: '' },
    menus: [], uniqueAuth: permissions }));
}
async function mount(permissions = ['supplier_directory.view'], respond: (config: any) => unknown = () => undefined) {
  login(permissions); const calls: any[] = [];
  runtime.request.defaults.adapter = async (config: any) => {
    calls.push(config); const custom = await respond(config);
    const id = Number(config.url.split('/').at(-1));
    const data = custom ?? envelope(config.url === `${base}/cities` ? []
      : config.url === base && config.method === 'get' ? { list: [row()], count: 1, page: config.params.page, limit: config.params.limit }
      : config.url === base && config.method === 'post' ? { id: 21, admin_id: 22 }
      : config.url.includes('/set_status/') ? { id: Number(config.url.split('/').at(-2)),
        is_show: id, revision: 'b'.repeat(64) }
      : config.method === 'delete' ? { id, is_del: 1 }
      : config.method === 'put' ? { ...detail(id), revision: 'b'.repeat(64) }
      : detail(id));
    return { config, data, status: 200, statusText: 'supplier directory fixture', headers: {} };
  };
  let view: any;
  const renderer = runtime.createRenderer({ createElement: () => ({ children: [] }), createText: (text: string) => ({ text }),
    createComment: (text: string) => ({ text }), insert(node: any, parent: any) { node.parent = parent; (parent.children ??= []).push(node); },
    remove() {}, parentNode: (node: any) => node.parent, nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {} });
  const app = renderer.createApp({ setup(props: unknown, context: unknown) { view = runtime.Page.setup(props, context); return () => null; } });
  app.use(runtime.createPinia()); app.mount({ children: [] }); await flush();
  return { view, calls, close: () => app.unmount() };
}

it('requires the independent directory grant and keeps view-only users read-only', async () => {
  const denied = await mount(['supplier_application.view']);
  try { expect(denied.view.canView.value).toBe(false); expect(denied.calls).toEqual([]); }
  finally { denied.close(); }
  const reader = await mount();
  try {
    expect(reader.view.canView.value).toBe(true);
    expect(reader.view.canManage.value).toBe(false);
    expect(reader.calls.map(call => call.url)).toEqual([base]);
    reader.view.openCreate(); await reader.view.openEdit(reader.view.list.value[0]);
    await reader.view.toggleStatus(reader.view.list.value[0]);
    await reader.view.remove(reader.view.list.value[0]);
    expect(reader.calls.map(call => call.url)).toEqual([base]);
  } finally { reader.close(); }
});

it('searches and paginates the real directory instead of the onboarding application list', async () => {
  const mounted = await mount();
  try {
    mounted.view.draftKeyword.value = '甲供应商'; mounted.view.search(); await flush();
    const query = mounted.calls.at(-1);
    expect(query.url).toBe(base);
    expect(query.params).toMatchObject({ keywords: '甲供应商', page: 1, limit: 15 });
    await mounted.view.load(2);
    expect(mounted.calls.at(-1).params).toMatchObject({ page: 2, limit: 15 });
    mounted.view.changePageSize(30); await flush();
    expect(mounted.calls.at(-1).params).toMatchObject({ page: 1, limit: 30 });
  } finally { mounted.close(); }
});

it('creates and edits with full fields while keeping a blank edit password unchanged', async () => {
  const mounted = await mount(['supplier_directory.view', 'supplier_directory.manage']);
  try {
    mounted.view.openCreate(); await flush();
    expect(mounted.calls.some(call => call.url === `${base}/cities` && call.params.pid === 0 &&
      call.baseURL === '/adminapi')).toBe(true);
    mounted.view.draft.value = filled(); await mounted.view.save();
    const created = mounted.calls.find(call => call.method === 'post');
    expect(created.url).toBe(base);
    expect(JSON.parse(created.data)).toMatchObject({ supplier_name: '乙供应商', account: 'supplier-b',
      province: 1, city: 2, area: 3, pwd: 'Strong-password-2026' });
    expect(runtime.messages.state.successes).toContain('供应商已添加');

    await mounted.view.openEdit(mounted.view.list.value[0]); await flush();
    expect(mounted.view.draft.value.pwd).toBe('');
    mounted.view.draft.value.mark = '更新备注'; await mounted.view.save();
    const updated = mounted.calls.find(call => call.method === 'put');
    expect(updated.url).toBe(`${base}/7`);
    expect(JSON.parse(updated.data)).toMatchObject({ mark: '更新备注', pwd: '',
      expected_revision: version, expected_account: 'supplier-a' });
    expect(runtime.messages.state.successes).toContain('供应商已更新');
  } finally { mounted.close(); }
});

it('loads four-level city rows through the protected Admin endpoint', async () => {
  const cities = [{ value: 1, id: 1, label: '广东省', pid: 0, level: 1,
    parent_name: '中国', children: [], loading: false, _loading: false }];
  const mounted = await mount(['supplier_directory.view', 'supplier_directory.manage'], config =>
    config.url === `${base}/cities` ? envelope(cities) : undefined);
  try {
    const result = await runtime.api.apiSupplierDirectoryCities(0);
    expect(result).toEqual(cities);
    const cityCall = mounted.calls.at(-1);
    expect(cityCall).toMatchObject({ url: `${base}/cities`, baseURL: '/adminapi', params: { pid: 0 } });
  } finally { mounted.close(); }
});

it('cannot submit an empty create if edit detail fails to load', async () => {
  const mounted = await mount(['supplier_directory.view', 'supplier_directory.manage'], config =>
    config.url === `${base}/7` && config.method === 'get'
      ? { status: 404, msg: '供应商不存在', data: null } : undefined);
  try {
    await mounted.view.openEdit(mounted.view.list.value[0]); await flush();
    expect(mounted.view.editingId.value).toBe(7);
    expect(mounted.view.editorReady.value).toBe(false);
    expect(mounted.view.editorError.value).toContain('供应商不存在');
    await mounted.view.save();
    expect(mounted.calls.filter(call => call.method === 'post' || call.method === 'put')).toEqual([]);
  } finally { mounted.close(); }
});

it('uses the listed revision for status and delete, with explicit deletion confirmation', async () => {
  const mounted = await mount(['supplier_directory.view', 'supplier_directory.manage']);
  try {
    await mounted.view.toggleStatus(mounted.view.list.value[0]);
    const status = mounted.calls.find(call => call.url.includes('/set_status/'));
    expect(status.url).toBe(`${base}/set_status/7/0`);
    expect(JSON.parse(status.data)).toEqual({ expected_revision: version });
    await mounted.view.remove(mounted.view.list.value[0]);
    const deleted = mounted.calls.find(call => call.method === 'delete');
    expect(deleted.url).toBe(`${base}/7`);
    expect(JSON.parse(deleted.data)).toEqual({ expected_revision: version });
    expect(runtime.messages.state.confirmations).toHaveLength(1);
    expect(runtime.messages.state.confirmations[0][0]).toContain('历史订单与财务记录保留');
  } finally { mounted.close(); }
});

it('closes a stale edit on 409 and never writes after an account switch', async () => {
  const mounted = await mount(['supplier_directory.view', 'supplier_directory.manage'], config =>
    config.method === 'put' && config.url === `${base}/7`
      ? { status: 409, msg: '资料已变更', data: null } : undefined);
  try {
    await mounted.view.openEdit(mounted.view.list.value[0]); await flush();
    await mounted.view.save();
    expect(mounted.view.editorVisible.value).toBe(false);
    expect(runtime.messages.state.warnings.at(-1)).toContain('最新记录');
    expect(mounted.calls.filter(call => call.url === base && call.method === 'get')).toHaveLength(2);
    login(['supplier_application.view'], 'directory-b', 21);
    browser.dispatchEvent(new Event('admin-session-changed')); await flush();
    expect(mounted.view.canView.value).toBe(false);
    expect(mounted.view.list.value).toEqual([]);
    await mounted.view.toggleStatus(row());
    expect(mounted.calls.filter(call => call.url.includes('/set_status/'))).toHaveLength(0);
  } finally { mounted.close(); }
});

it('aborts a previous account\'s late list and does not resurrect the rows', async () => {
  const late = deferred<unknown>(); let block = false;
  const mounted = await mount(['supplier_directory.view'], config => block && config.url === base ? late.promise : undefined);
  try {
    block = true; const pending = mounted.view.load(1); await flush();
    const stale = mounted.calls.at(-1);
    login(['supplier_application.view'], 'directory-b', 21);
    browser.dispatchEvent(new Event('admin-session-changed')); await flush();
    expect(stale.signal.aborted).toBe(true);
    late.resolve(envelope({ list: [row(99)], count: 1, page: 1, limit: 15 }));
    await pending; await flush();
    expect(mounted.view.canView.value).toBe(false);
    expect(mounted.view.list.value).toEqual([]);
  } finally { mounted.close(); }
});

it('drops an old account\'s late detail and save responses after session replacement', async () => {
  const lateDetail = deferred<unknown>(); let blockDetail = false;
  const first = await mount(['supplier_directory.view', 'supplier_directory.manage'], config =>
    blockDetail && config.url === `${base}/7` && config.method === 'get' ? lateDetail.promise : undefined);
  try {
    blockDetail = true;
    const pending = first.view.openEdit(first.view.list.value[0]); await flush();
    const stale = first.calls.at(-1);
    login(['supplier_application.view'], 'directory-b', 21);
    browser.dispatchEvent(new Event('admin-session-changed')); await flush();
    expect(stale.signal.aborted).toBe(true);
    lateDetail.resolve(envelope(detail())); await pending; await flush();
    expect(first.view.editorVisible.value).toBe(false);
    expect(first.view.editingId.value).toBe(0);
  } finally { first.close(); }

  const lateSave = deferred<unknown>(); let blockSave = false;
  const second = await mount(['supplier_directory.view', 'supplier_directory.manage'], config =>
    blockSave && config.url === `${base}/7` && config.method === 'put' ? lateSave.promise : undefined);
  try {
    await second.view.openEdit(second.view.list.value[0]); await flush();
    blockSave = true; const pending = second.view.save(); await flush();
    const stale = second.calls.at(-1);
    login(['supplier_application.view'], 'directory-c', 22);
    browser.dispatchEvent(new Event('admin-session-changed')); await flush();
    expect(stale.signal.aborted).toBe(true);
    lateSave.resolve(envelope({ ...detail(), revision: 'b'.repeat(64) }));
    await pending; await flush();
    expect(second.view.list.value).toEqual([]);
    expect(second.view.editorVisible.value).toBe(false);
    expect(runtime.messages.state.successes).toEqual([]);
  } finally { second.close(); }
});

it('rejects weak passwords and missing revisions before sending a write', async () => {
  const mounted = await mount(['supplier_directory.view', 'supplier_directory.manage']);
  try {
    mounted.view.openCreate(); await flush();
    mounted.view.draft.value = { ...filled(), pwd: 'weak', conf_pwd: 'weak' };
    await mounted.view.save();
    expect(mounted.view.editorError.value).toContain('12至72位');
    expect(mounted.calls.filter(call => call.method === 'post')).toHaveLength(0);
    await expect(runtime.api.apiSupplierDirectoryDelete(7, 'bad')).rejects.toThrow('版本无效');
  } finally { mounted.close(); }
});
