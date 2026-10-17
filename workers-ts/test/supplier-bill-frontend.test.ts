import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../../view/supplier-ts'), require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc');
let runtime: any, pinia: any, browser: EventTarget, runtimeDirectory: string, hostDocument: { activeElement: null };
beforeAll(async () => {
  const result = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    import Page from './src/pages/FinanceBills.vue';export {Page};export const captured={};
    const setup=Page.setup;Page.setup=(p,c)=>{const value=setup(p,c);captured.view=value;return value;};
    export * as api from './src/api/supplierBills';export {http} from './src/api/http';
    export {createPinia,disposePinia} from 'pinia';export {createRenderer,h,nextTick} from 'vue';
    export {createRouter,createMemoryHistory,RouterView} from 'vue-router';` },
    alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_API_BASE_URL': '"/supplierapi"',
      '__VUE_OPTIONS_API__': 'true', '__VUE_PROD_DEVTOOLS__': 'false', '__VUE_PROD_HYDRATION_MISMATCH_DETAILS__': 'false' },
    bundle: true, write: false, platform: 'browser', format: 'esm', plugins: [{ name: 'actual-supplier-bill', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => {
        const descriptor = parse(readFileSync(path, 'utf8'), { filename: path }).descriptor;
        const script = compileScript(descriptor, { id: 'supplier-bill', genDefaultAs: '__Page' });
        const template = compileTemplate({ source: descriptor.template.content, filename: path, id: 'supplier-bill', compilerOptions: { bindingMetadata: script.bindings, expressionPlugins: ['typescript'] } });
        if (template.errors.length) throw Error(String(template.errors));
        return { contents: `${script.content}\n${template.code}\n__Page.render=render;export default __Page;`, loader: 'ts' };
      });
    } }] });
  runtimeDirectory = mkdtempSync('/tmp/cinashop-supplier-bill-sfc-');
  const path = resolve(runtimeDirectory, 'compiled-page.mjs'); writeFileSync(path, result.outputFiles[0].text);
  runtime = await import(pathToFileURL(path).href);
}, 30000);
afterAll(() => { if (runtimeDirectory) rmSync(runtimeDirectory, { recursive: true, force: true }); });
function login(permissions = ['supplier.finance.view'], token = 'owned-bill-session-a', id = 21, supplierId = 7) {
  localStorage.setItem('supplier-token', token); localStorage.setItem('supplier-user', JSON.stringify({ id, supplier_id: supplierId }));
  localStorage.setItem('supplier-permissions', JSON.stringify(permissions));
}
beforeEach(() => {
  const local = new Map<string, string>(); browser = new EventTarget();
  vi.stubGlobal('window', Object.assign(browser, { location: { search: '' } }));
  class HostDocument { activeElement = null; }
  vi.stubGlobal('Document', HostDocument); vi.stubGlobal('ShadowRoot', class {});
  hostDocument = new HostDocument(); vi.stubGlobal('document', hostDocument);
  vi.stubGlobal('localStorage', { getItem: (key: string) => local.get(key) ?? null,
    setItem: (key: string, value: string) => local.set(key, value), removeItem: (key: string) => local.delete(key) });
  login(); pinia = runtime.createPinia();
});
afterEach(() => { runtime.disposePinia(pinia); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const query = (changes: Record<string, unknown> = {}) => ({ timeType: 'day', status: '', data: '', page: 1, limit: 20, ...changes });
const period = (type = 'day') => type === 'week' ? '2021-00' : type === 'month' ? '2021-01' : '2021-01-01';
function group(type = 'day', key = period(type)) {
  return { id: 1, period: key, day: key, title: type === 'day' ? '日账单' : type === 'week' ? '周账单' : '月账单',
    add_time: type === 'week' ? `${key.slice(0, 4)}年第${key.slice(5)}周` : key,
    income_num: '100.20', exp_num: '2.10', entry_num: '98.10', detail_count: 105 };
}
function detail(id = 105) {
  return { id, supplier_id: 7, uid: 101, order_id: `BILL-${id}`, link_id: `ORDER-${id}`, pm: 1,
    number: '1.00', type: 1, pay_type: 'yue', status: 0, mark: '', remark: '账单夹具',
    add_time: '2021-01-01 12:00:00', trade_time: '2021-01-01 12:00:00', finish_time: '',
    user_nickname: '账单买家', type_name: '支付订单', pay_type_name: '余额支付' };
}
const context = (q = query()) => ({ version: 'supplier-bill-v1', selection: 'period', supplier_id: 7,
  timeType: q.timeType, status: q.status, data: q.data, page: q.page, limit: q.limit, bounded: true });
const groups = (q = query()) => ({ ...context(q), list: [group(String(q.timeType))], count: 1 });
function details(q = { ...query(), period: period(), keyword: '' }) {
  let all = Array.from({ length: 105 }, (_, index) => detail(105 - index));
  if (q.status) all = all.map(row => ({ ...row, status: Number(q.status) }));
  if (q.keyword) all = all.filter(row => row.order_id === q.keyword || row.user_nickname.includes(String(q.keyword)));
  return { ...context(q), period: q.period, keyword: q.keyword, count: all.length,
    list: all.slice((Number(q.page) - 1) * Number(q.limit), Number(q.page) * Number(q.limit)) };
}
const gate = () => { let resolve!: (value: any) => void; return { promise: new Promise(done => { resolve = done; }), resolve }; };
const flush = async () => { for (let i = 0; i < 40; i++) { await Promise.resolve(); await runtime.nextTick(); } };
type Node = { tag?: string; text?: string; children: Node[]; props: Record<string, any>; parent?: Node; [key: string]: any };
const content = (node: Node): string => (node.text ?? '') + node.children.map(content).join('');
async function mount(url = '/finance/bills', override: (config: any) => unknown = () => undefined) {
  const calls: any[] = [];
  runtime.http.defaults.adapter = async (config: any) => {
    calls.push(config); const custom = await override(config);
    const value = custom ?? (config.url.endsWith('fund_record_info') ? details(config.params) : groups(config.params));
    return { config, data: { status: 200, msg: 'owned bill transport', data: value }, status: 200, statusText: 'owned', headers: {} };
  };
  const host: Node = { children: [], props: {} };
  const renderer = runtime.createRenderer({ createElement: (tag: string) => {
    const node: Node = Object.assign(new EventTarget(), { tag, tagName: tag.toUpperCase(), children: [] as Node[], props: {}, value: '', multiple: false, selected: false, getRootNode: () => hostDocument });
    Object.defineProperty(node, 'options', { get: () => node.children.filter(child => child.tag === 'option') }); return node;
  }, createText: (text: string) => ({ text, children: [], props: {} }), createComment: () => ({ children: [], props: {} }),
    insert(node: Node, parent: Node, anchor?: Node) { if (node.parent) node.parent.children = node.parent.children.filter(item => item !== node); node.parent = parent; const at = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(at < 0 ? parent.children.length : at, 0, node); },
    remove(node: Node) { if (node.parent) node.parent.children = node.parent.children.filter(item => item !== node); }, parentNode: (node: Node) => node.parent,
    nextSibling: (node: Node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    patchProp(node: Node, property: string, _: unknown, value: unknown) { node.props[property] = value; if (['value', 'type', 'selected', 'multiple'].includes(property)) node[property] = value; }, setText(node: Node, value: string) { node.text = value; }, setElementText(node: Node, value: string) { node.text = value; node.children = []; } });
  const router = runtime.createRouter({ history: runtime.createMemoryHistory(), routes: [
    { path: '/finance/bills', component: runtime.Page }, { path: '/away', component: { render: () => null } } ] });
  const app = renderer.createApp({ render: () => runtime.h(runtime.RouterView) }); app.use(pinia); app.use(router);
  app.component('el-button', { inheritAttrs: false, setup(_: unknown, { attrs, slots }: any) { return () => runtime.h('button', attrs, slots.default?.()); } });
  await router.push(url); app.mount(host); await flush();
  return { view: runtime.captured.view, host, calls, router, close: () => app.unmount() };
}

describe('actual compiled Supplier bill read surface', () => {
  it('loads a closed period snapshot using only GET under finance.view without export or withdrawal actions', async () => {
    const f = await mount(); try {
      expect(f.view.groups.value.count).toBe(1); expect(f.calls).toHaveLength(1);
      expect(f.calls[0]).toMatchObject({ method: 'get', params: { selection: 'period', ...query() } });
      expect(f.calls[0].params).not.toHaveProperty('supplier_id'); expect(f.calls[0].headers.Authorization).toBe('Bearer owned-bill-session-a');
      expect(content(f.host)).toContain('¥98.10'); expect(content(f.host)).toContain('105');
      expect(content(f.host)).not.toMatch(/提现|导出|下载|保存/);
      expect(readFileSync(resolve(root, 'src/router.ts'), 'utf8')).toContain("path: 'finance/bills'");
      expect(readFileSync(resolve(root, 'src/components/AppShell.vue'), 'utf8')).toContain("path: '/finance/bills', label: '周期账单'");
    } finally { f.close(); }
  });
  it('requires finance.view even when a session has finance.manage alone', async () => {
    login(['supplier.finance.manage']); const f = await mount(); try { expect(f.calls).toEqual([]); expect(content(f.host)).toContain('无法查看账单'); } finally { f.close(); }
  });
  it('switches day/week/month without carrying a stale detail or changing PHP week00', async () => {
    const f = await mount(); try {
      await f.view.openDetails(f.view.groups.value.list[0]); expect(f.view.details.value.count).toBe(105);
      await f.view.changePeriod('week'); expect(f.view.detailPeriod.value).toBe('');
      expect(f.view.groups.value.list[0].period).toBe('2021-00'); expect(content(f.host)).toContain('2021年第00周');
      await f.view.changePeriod('month'); expect(f.calls.at(-1).params.timeType).toBe('month'); expect(f.view.groups.value.list[0].period).toBe('2021-01');
    } finally { f.close(); }
  });
  it('binds status and date filters to both groups and detail with no arbitrary IDs', async () => {
    const f = await mount('/finance/bills?status=1&from=2021-01-01&to=2021-01-02'); try {
      expect(f.calls[0].params).toMatchObject({ status: '1', data: '2021/01/01-2021/01/02' });
      await f.view.openDetails(f.view.groups.value.list[0]); expect(f.calls.at(-1).params).toMatchObject({ selection: 'period', status: '1', data: '2021/01/01-2021/01/02', period: '2021-01-01' });
      expect(f.calls.at(-1).params).not.toHaveProperty('ids');
      f.view.status.value = '0'; expect(f.view.groups.value).toBeNull(); expect(f.view.details.value).toBeNull(); expect(f.view.detailPeriod.value).toBe('');
      await f.view.loadGroups(); expect(f.calls.at(-1).params.status).toBe('0');
    } finally { f.close(); }
  });
  it('paginates every one of105 details and searches only the selected period', async () => {
    const f = await mount(); try {
      await f.view.openDetails(f.view.groups.value.list[0]); const ids: number[] = [];
      for (let page = 1; page <= 6; page++) { if (page > 1) await f.view.loadDetails(page); ids.push(...f.view.details.value.list.map((row: any) => row.id)); }
      expect(ids).toEqual(Array.from({ length: 105 }, (_, index) => 105 - index)); expect(new Set(ids).size).toBe(105);
      f.view.keyword.value = 'BILL-1'; expect(f.view.details.value).toBeNull(); await f.view.loadDetails();
      expect(f.view.details.value).toMatchObject({ count: 1, list: [{ id: 1 }], page: 1 });
      expect(f.calls.at(-1).params).toMatchObject({ period: '2021-01-01', keyword: 'BILL-1' });
      expect(f.calls.every(call => call.method === 'get')).toBe(true);
    } finally { f.close(); }
  });
  it('clears results before filter edits and discards a late earlier group response after A to B to A', async () => {
    const late = gate(); let block = false;
    const f = await mount(undefined, config => { if (block && config.url.endsWith('fund_record')) { config.signal = undefined; return late.promise; } });
    try {
      block = true; const pending = f.view.loadGroups(); await flush(); expect(f.view.groups.value).toBeNull();
      f.view.status.value = '1'; f.view.status.value = ''; block = false; await f.view.loadGroups();
      const newer = f.view.groups.value; late.resolve({ ...groups(), list: [{ ...group(), income_num: '9.00', exp_num: '1.00', entry_num: '8.00' }] });
      await pending; expect(f.view.groups.value).toBe(newer); expect(f.view.groups.value.list[0].entry_num).toBe('98.10');
    } finally { f.close(); }
  });
  it('does not publish a delayed detail after closing it, or after the route changes', async () => {
    const late = gate(); let block = false;
    const f = await mount(undefined, config => { if (block && config.url.endsWith('fund_record_info')) { config.signal = undefined; return late.promise; } });
    try {
      block = true; const pending = f.view.openDetails(f.view.groups.value.list[0]); await flush();
      f.view.closeDetails(); await f.router.push('/finance/bills?timeType=week'); await flush();
      late.resolve(details()); await pending; expect(f.view.details.value).toBeNull(); expect(f.view.detailPeriod.value).toBe('');
      expect(f.view.groups.value.timeType).toBe('week');
    } finally { f.close(); }
  });
  it('invalidates a lost permission snapshot and never resurrects an old account after A to B to A', async () => {
    const late = gate(); let block = false;
    const f = await mount(undefined, config => { if (block) { config.signal = undefined; return late.promise; } });
    try {
      block = true; const pending = f.view.loadGroups(); await flush();
      login([], 'owned-bill-session-b', 22, 8); browser.dispatchEvent(new Event('supplier-session-changed')); await flush();
      login(); browser.dispatchEvent(new Event('supplier-session-changed')); late.resolve(groups()); await pending;
      expect(f.view.groups.value).toBeNull(); expect(f.view.details.value).toBeNull(); expect(f.view.canRead.value).toBe(false);
      const count = f.calls.length; await f.view.loadGroups(); expect(f.calls).toHaveLength(count);
    } finally { f.close(); }
  });
  it('sends no request for invalid range or route query', async () => {
    const invalid = await mount('/finance/bills?timeType=quarter'); try {
      expect(invalid.calls).toEqual([]); expect(invalid.view.error.value).toContain('无效');
      await invalid.view.loadGroups(); await invalid.view.changePeriod('week'); expect(invalid.calls).toEqual([]);
      await invalid.router.push('/finance/bills?timeType=week'); await flush(); expect(invalid.view.groups.value.timeType).toBe('week');
    } finally { invalid.close(); }
    const f = await mount(); try {
      f.view.fromDate.value = '2026-02-30'; f.view.toDate.value = '2026-03-01'; const count = f.calls.length;
      await f.view.loadGroups(); expect(f.calls).toHaveLength(count); expect(f.view.groups.value).toBeNull(); expect(f.view.error.value).toBeTruthy();
    } finally { f.close(); }
  });
  it('discards an already dispatched response after the page unmounts', async () => {
    const late = gate(); let block = false;
    const f = await mount(undefined, config => { if (block) { config.signal = undefined; return late.promise; } });
    block = true; const pending = f.view.loadGroups(); await flush(); f.close();
    late.resolve(groups()); await pending; expect(f.view.groups.value).toBeNull(); expect(f.view.details.value).toBeNull();
  });
  it('clears a prior successful view when a new response has a different supplier or incomplete arithmetic', async () => {
    let corrupt = false; const f = await mount(undefined, config => corrupt ? { ...groups(config.params), supplier_id: 8 } : undefined);
    try { corrupt = true; await f.view.loadGroups(); expect(f.view.groups.value).toBeNull(); expect(f.view.error.value).toContain('无法完整核对'); } finally { f.close(); }
  });
});

describe('closed Supplier bill transport and exact money', () => {
  it('formats numeric20,2 exactly, including expense direction and signed totals', () => {
    expect(runtime.api.supplierBillMoney('999999999999999999.99')).toBe('¥999,999,999,999,999,999.99');
    expect(runtime.api.supplierBillMoney('0.01', 0)).toBe('−¥0.01');
    expect(runtime.api.supplierBillMoney('-3.05', 0)).toBe('¥3.05'); expect(runtime.api.supplierBillMoney('-0.01')).toBe('−¥0.01');
  });
  it.each(['1', '01.00', '1.0', '1e2', '-0.00', 'NaN'])('rejects noncanonical amount %s', value => {
    expect(() => runtime.api.parseSupplierBillGroups({ ...groups(), list: [{ ...group(), income_num: value }] }, query(), 7)).toThrow();
  });
  it.each(['supplier', 'version', 'selection', 'status', 'period', 'count', 'sum', 'unknown'])('rejects a corrupted %s group response', kind => {
    const value: any = structuredClone(groups());
    if (kind === 'supplier') value.supplier_id = 8;
    if (kind === 'version') value.version = 'unknown';
    if (kind === 'selection') value.selection = 'ids';
    if (kind === 'status') value.status = '1';
    if (kind === 'period') value.list[0].period = '2021-02-30';
    if (kind === 'count') value.count = 2;
    if (kind === 'sum') value.list[0].entry_num = '98.11';
    if (kind === 'unknown') value.private_rows = [];
    expect(() => runtime.api.parseSupplierBillGroups(value, query(), 7)).toThrow();
  });
  it.each(['supplier', 'period', 'keyword', 'duplicate', 'pm', 'unknown'])('rejects a corrupted %s detail response', kind => {
    const value: any = structuredClone(details()), q = { ...query(), period: period(), keyword: '' };
    if (kind === 'supplier') value.list[0].supplier_id = 8;
    if (kind === 'period') value.period = '2021-01-02';
    if (kind === 'keyword') value.keyword = 'other';
    if (kind === 'duplicate') value.list[1].id = value.list[0].id;
    if (kind === 'pm') value.list[0].pm = 2;
    if (kind === 'unknown') value.list[0].private_user = {};
    expect(() => runtime.api.parseSupplierBillDetails(value, q, 7)).toThrow();
  });
  it('accepts empty pages without inventing zero-value data, and exact leap-day ranges', () => {
    expect(runtime.api.parseSupplierBillGroups({ ...groups(), list: [], count: 0 }, query(), 7).count).toBe(0);
    expect(runtime.api.supplierBillDateRange('2024-02-29', '2024-03-01')).toBe('2024/02/29-2024/03/01');
    for (const range of [['2021-01-01', ''], ['2021-02-30', '2021-03-01'], ['2021-01-02', '2021-01-01']]) expect(() => runtime.api.supplierBillDateRange(range[0], range[1])).toThrow();
  });
  it('rejects a different row status inside an otherwise valid settled query response', () => {
    const q = { ...query({ status: '1' }), period: period(), keyword: '' };
    const value = details(q); value.list[0]!.status = 0;
    expect(() => runtime.api.parseSupplierBillDetails(value, q, 7)).toThrow();
    value.list[0]!.status = 1;
    expect(runtime.api.parseSupplierBillDetails(value, q, 7).count).toBe(105);
  });
});
