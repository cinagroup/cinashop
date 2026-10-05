import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../view/admin-ts');
const require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript } = require('@vue/compiler-sfc');
const base = '/supplier/menu-rules';
const envelope = (data: unknown) => ({ status: 200, msg: 'ok', data });
const rule = (id = 70) => ({ id, pid: 0, type: 4, auth_type: 2, menu_name: '订单读取',
  menu_path: '', unique_auth: 'supplier-order-view', api_url: 'order/list', methods: 'GET',
  icon: '', sort: 1, is_show: 0, is_show_path: 0, access: 1, is_del: 0,
  revision: '123', role_reference_count: 2,
  role_reference_ids: [3, 8],
  effective_permissions: ['supplier.order.view'], children: [] });
const catalog = { permissions: [{ key: 'order', label: '订单管理', manage: true }],
  navigation: [{ path: '/orders', name: '订单管理', permission: 'supplier.order.view' }], write_ready: false };

let runtime: any, browser: EventTarget, values: Map<string, string>;
beforeAll(async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal('window', Object.assign(new EventTarget(),
    { location: { search: '', pathname: '/supplier/menu-rules', href: '' } }));
  const result = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    export { default as Page } from './src/pages/supplier/SupplierMenuRules.vue';
    export { default as request } from './src/utils/request';
    export * as api from './src/api/supplierMenuRules';
    export { createRenderer, nextTick } from 'vue';
    export { createPinia } from 'pinia';
  ` }, alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false' },
  bundle: true, write: false, platform: 'browser', format: 'esm',
  plugins: [{ name: 'supplier-menu-rules-runtime', setup(builder) {
    builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({ contents: compileScript(parse(readFileSync(path, 'utf8'),
      { filename: path }).descriptor, { id: 'supplier-menu-rules-runtime' }).content, loader: 'ts' }));
  } }] });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
});
beforeEach(() => {
  values = new Map(); browser = new EventTarget();
  vi.stubGlobal('window', Object.assign(browser,
    { location: { search: '', pathname: '/supplier/menu-rules', href: '' } }));
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key) });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const flush = async () => { for (let i = 0; i < 7; i++) { await new Promise(done => setTimeout(done, 1)); await runtime.nextTick(); } };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function login(permissions = ['supplier_menu_rules.view'], token = 'menu-a', id = 20) {
  values.set('admin_token', token);
  values.set('admin_session', JSON.stringify({ userInfo: { id, account: 'operator', level: 1, roles: '' },
    menus: [], uniqueAuth: permissions }));
}
async function mount(permissions = ['supplier_menu_rules.view'],
  respond: (config: any) => unknown = () => undefined) {
  login(permissions); const calls: any[] = [];
  runtime.request.defaults.adapter = async (config: any) => {
    calls.push(config);
    const custom = await respond(config);
    const data = custom ?? envelope(config.url === `${base}/catalog` ? catalog :
      config.url === base ? { list: [rule()], count: 1 } : rule(Number(config.url.split('/').at(-1))));
    return { config, data, status: 200, statusText: 'supplier menu fixture', headers: {} };
  };
  let view: any;
  const renderer = runtime.createRenderer({ createElement: () => ({ children: [] }),
    createText: (text: string) => ({ text }), createComment: (text: string) => ({ text }),
    insert(node: any, parent: any) { node.parent = parent; (parent.children ??= []).push(node); },
    remove() {}, parentNode: (node: any) => node.parent, nextSibling: () => null,
    patchProp() {}, setText() {}, setElementText() {} });
  const app = renderer.createApp({ setup(props: unknown, context: unknown) {
    view = runtime.Page.setup(props, context); return () => null;
  } });
  app.use(runtime.createPinia()); app.mount({ children: [] }); await flush();
  return { view, calls, close: () => app.unmount() };
}

it('uses an independent view grant and reads only the type-4 tree and static catalog', async () => {
  const denied = await mount(['config.view']);
  try { expect(denied.view.canView.value).toBe(false); expect(denied.calls).toEqual([]); }
  finally { denied.close(); }
  const reader = await mount();
  try {
    expect(reader.view.canView.value).toBe(true);
    expect(reader.calls.map(call => call.url).sort()).toEqual([base, `${base}/catalog`]);
    expect(reader.calls.every(call => call.method === 'get' && call.baseURL === '/adminapi')).toBe(true);
    expect(reader.view.rules.value[0]).toMatchObject({ type: 4, is_show: 0, role_reference_count: 2 });
    expect(reader.view.catalog.value.navigation).toEqual(catalog.navigation);
  } finally { reader.close(); }
});

it('keeps hidden filter explicit, loads scoped detail, and sends no write method', async () => {
  const mounted = await mount();
  try {
    mounted.view.draftVisibility.value = 'hidden';
    mounted.view.draftKeyword.value = '订单'; mounted.view.search(); await flush();
    const filtered = mounted.calls.filter(call => call.url === base).at(-1);
    expect(filtered.params).toEqual({ keyword: '订单', is_show: 0 });
    await mounted.view.openDetail(mounted.view.rules.value[0]);
    expect(mounted.calls.at(-1).url).toBe(`${base}/70`);
    expect(mounted.view.detail.value.effective_permissions).toEqual(['supplier.order.view']);
    expect(mounted.view.detail.value.role_reference_ids).toEqual([3, 8]);
    mounted.view.resetFilters(); await flush();
    expect(mounted.calls.filter(call => call.url === base).at(-1).params).toEqual({});
    expect(mounted.calls.every(call => call.method === 'get')).toBe(true);
  } finally { mounted.close(); }
});

it('rejects cross-type or deleted rows in the adapter, including details', async () => {
  expect(runtime.api.parseSupplierMenuRulePage({ list: [{ ...rule(), auth_type: 0 }], count: 1 }).list[0].auth_type).toBe(0);
  expect(() => runtime.api.parseSupplierMenuRulePage({ list: [{ ...rule(), type: 1 }], count: 1 }))
    .toThrow('响应无效');
  expect(() => runtime.api.parseSupplierMenuRulePage({ list: [{ ...rule(), is_del: 1 }], count: 1 }))
    .toThrow('响应无效');
  const mounted = await mount(['supplier_menu_rules.view'], config =>
    config.url === `${base}/70` ? envelope({ ...rule(), type: 1 }) : undefined);
  try {
    await mounted.view.openDetail(mounted.view.rules.value[0]);
    expect(mounted.view.detail.value).toBeNull();
    expect(mounted.view.detailError.value).toContain('响应无效');
  } finally { mounted.close(); }
});

it('aborts a prior account request and never shows its later rule tree', async () => {
  const late = deferred<unknown>(); let block = false;
  const mounted = await mount(['supplier_menu_rules.view'], config =>
    block && config.url === base ? late.promise : undefined);
  try {
    block = true; const pending = mounted.view.load(); await flush();
    const oldCall = mounted.calls.filter(call => call.url === base).at(-1);
    login(['config.view'], 'menu-b', 21);
    browser.dispatchEvent(new Event('admin-session-changed')); await flush();
    expect(oldCall.signal.aborted).toBe(true);
    late.resolve(envelope({ list: [rule(99)], count: 1 }));
    await pending; await flush();
    expect(mounted.view.canView.value).toBe(false);
    expect(mounted.view.rules.value).toEqual([]);
    expect(mounted.view.catalog.value).toBeNull();
  } finally { mounted.close(); }
});
