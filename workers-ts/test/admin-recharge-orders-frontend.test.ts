import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../view/admin-ts');
const require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript } = require('@vue/compiler-sfc');
let runtime: any, browser: EventTarget;
const endpoint = '/finance/recharge-orders';
const envelope = (data: unknown, status = 200) => ({ status, msg: 'ok', data });
function row(overrides: Record<string, unknown> = {}) {
  return { id: 41, uid: 7, order_id: 'recharge-41', price: '100.00', give_price: '10.00', refund_price: '0.00',
    paid: 1, paid_type: '已支付', recharge_type: 'weixin', recharge_type_label: '微信充值',
    add_time: 1790535600, pay_time: 1790535660, nickname: '充值用户', avatar: '',
    user_deleted: false, user_missing: false, issues: [], ...overrides };
}
function detail(overrides: Record<string, unknown> = {}) {
  return { ...row(), trade_no: 'trade-41', channel_type: 'routine', store_id: 0, staff_id: 0,
    remarks: '', phone: '13800000007', real_name: '王用户', ...overrides };
}
const stats = { sum_price: '100.00', sum_refund_price: '0.00', sum_routine_price: '100.00', sum_weixin_price: '100.00' };
beforeAll(async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal('window', Object.assign(new EventTarget(), { innerWidth: 1280, location: { pathname: '/finance/recharges', href: '' } }));
  const result = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    export { default as Page } from './src/pages/finance/RechargeOrders.vue';
    export { default as request } from './src/utils/request';
    export * as api from './src/api/rechargeOrders';
    export { createRenderer, nextTick } from 'vue'; export { createPinia } from 'pinia';
    export { useAuthStore } from './src/stores/auth';
  ` }, alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false' }, bundle: true, write: false,
    platform: 'browser', format: 'esm', plugins: [{ name: 'recharge-order-runtime', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({ contents: compileScript(parse(readFileSync(path, 'utf8'), { filename: path }).descriptor,
        { id: 'recharge-order-runtime' }).content, loader: 'ts' }));
    } }] });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
});
function login(permissions = ['recharge_order.view'], token = 'recharge-token-a', id = 20) {
  localStorage.setItem('admin_token', token);
  localStorage.setItem('admin_session', JSON.stringify({ userInfo: { id, account: 'operator', level: 1, roles: '' },
    menus: [], uniqueAuth: permissions }));
}
beforeEach(() => {
  const values = new Map<string, string>(); browser = new EventTarget();
  vi.stubGlobal('window', Object.assign(browser, { innerWidth: 1280, location: { pathname: '/finance/recharges', href: '' } }));
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
});
afterEach(() => vi.unstubAllGlobals());
const flush = async () => { for (let i = 0; i < 8; i++) { await new Promise(done => setTimeout(done, 1)); await runtime.nextTick(); } };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function mount(permissions = ['recharge_order.view'], respond: (config: any) => Promise<unknown> | unknown = () => undefined) {
  login(permissions); const calls: any[] = [];
  runtime.request.defaults.adapter = async (config: any) => {
    calls.push(config);
    const custom = await respond(config);
    const data = custom ?? envelope(config.url.endsWith('/stats') ? stats : config.url.endsWith('/41') ? detail() :
      { list: [row()], count: 1, page: config.params.page, limit: 20 });
    return { config, data, status: 200, statusText: 'isolated recharge fixture', headers: {} };
  };
  let view: any;
  const renderer = runtime.createRenderer({ createElement: () => ({ children: [] }), createText: (text: string) => ({ text }),
    createComment: (text: string) => ({ text }), insert(node: any, parent: any) { node.parent = parent; (parent.children ??= []).push(node); },
    remove() {}, parentNode: (node: any) => node.parent, nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {} });
  const app = renderer.createApp({ setup(props: unknown, context: unknown) { view = runtime.Page.setup(props, context); return () => null; } });
  app.use(runtime.createPinia()); app.mount({ children: [] }); await flush(); return { view, calls, close: () => app.unmount() };
}

it('uses a dedicated read role and only the recharge order endpoints', async () => {
  const denied = await mount(['bill.view', 'recharge_quota.view']);
  try { expect(denied.calls).toEqual([]); expect(denied.view.canView.value).toBe(false); } finally { denied.close(); }
  const viewer = await mount();
  try { expect(viewer.calls.map(call => call.url).sort()).toEqual([endpoint, `${endpoint}/stats`]);
    expect(viewer.calls.every(call => call.method === 'get')).toBe(true);
    expect(viewer.view.list.value[0].order_id).toBe('recharge-41');
    expect(viewer.view.stats.value.sum_price).toBe('100.00');
    expect(readFileSync(resolve(root, 'src/router/index.ts'), 'utf8')).toContain('path: "finance/recharges"');
    expect(readFileSync(resolve(root, 'src/layouts/AdminLayout.vue'), 'utf8')).toContain("canMenu('/finance/recharges')");
  } finally { viewer.close(); }
});
it('applies Shanghai minute boundaries while keeping paid-only statistics separate from unpaid list', async () => {
  const f = await mount();
  try { f.view.draftPaid.value = 0; f.view.draftDates.value = ['2026-09-28 09:15', '2026-09-28 10:30'];
    f.view.draftKeyword.value = '  用户 '; f.view.search(); await flush();
    const list = f.calls.filter(call => call.url === endpoint).at(-1), summary = f.calls.filter(call => call.url.endsWith('/stats')).at(-1);
    expect(list.params).toMatchObject({ page: 1, limit: 20, paid: 0, start_time: '2026-09-28 09:15',
      end_time: '2026-09-28 10:30', keyword: '用户' });
    expect(summary.params).toMatchObject({ paid: 0, keyword: '用户' });
    expect(f.view.stats.value.sum_price).toBe('100.00');
    expect(f.calls.every(call => call.method === 'get')).toBe(true);
  } finally { f.close(); }
});
it('opens a read-only detail by recharge ID and rejects malformed IDs, rows or totals', async () => {
  const f = await mount();
  try { await f.view.openDetail(f.view.list.value[0]);
    expect(f.calls.at(-1).url).toBe(`${endpoint}/41`);
    expect(f.view.detail.value.trade_no).toBe('trade-41');
    expect(f.calls.every(call => call.method === 'get')).toBe(true);
  } finally { f.close(); }
  expect(() => runtime.api.parseRechargeOrderDetail(detail({ id: 42 }), 41)).toThrow();
  expect(() => runtime.api.parseRechargeOrderPage({ list: [row(), row()], count: 2, page: 1, limit: 20 },
    { page: 1, limit: 20, paid: 'all', start_time: '', end_time: '', keyword: '' })).toThrow('重复');
  expect(() => runtime.api.parseRechargeOrderStats({ ...stats, sum_price: null })).toThrow();
});
it('rejects invalid date and range input before new requests', async () => {
  const f = await mount();
  try { const before = f.calls.length; f.view.draftDates.value = ['2026-02-30 09:00', '2026-03-01 09:00']; f.view.search();
    await flush(); expect(f.calls).toHaveLength(before); expect(f.view.filterError.value).toContain('日期');
    expect(() => runtime.api.normalizeRechargeOrderQuery({ page: 1, limit: 20, paid: 'all',
      start_time: '2026-09-28 09:00', end_time: '2026-09-27 09:00', keyword: '' })).toThrow();
    for (const query of [
      { page: 502, limit: 20, paid: 'all', start_time: '', end_time: '', keyword: '' },
      { page: 1, limit: 20, paid: 'all', start_time: '', end_time: '', keyword: 'x'.repeat(81) },
      { page: 1, limit: 20, paid: 'all', start_time: '2038-01-19 11:14', end_time: '2038-01-19 11:14', keyword: '' },
    ]) expect(() => runtime.api.normalizeRechargeOrderQuery(query)).toThrow();
  } finally { f.close(); }
});
it('drops a late detail after account switch', async () => {
  const delayed = deferred();
  const f = await mount(['recharge_order.view'], async config => config.url === `${endpoint}/41`
    ? (await delayed.promise, envelope(detail())) : undefined);
  try { const pending = f.view.openDetail(f.view.list.value[0]);
    login(['bill.view'], 'recharge-token-b', 21); browser.dispatchEvent(new Event('admin-session-changed'));
    delayed.resolve(); await pending; await flush();
    expect(f.view.detail.value).toBeNull(); expect(f.view.list.value).toEqual([]);
    expect(f.calls.every(call => call.method === 'get')).toBe(true);
  } finally { f.close(); }
});
