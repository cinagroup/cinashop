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
    import Page from './src/pages/FinanceFlows.vue';export {Page};export const captured={};
    const setup=Page.setup;Page.setup=(p,c)=>{const value=setup(p,c);captured.view=value;return value;};
    export * as api from './src/api/supplierFlows';export {http} from './src/api/http';
    export {createPinia,disposePinia} from 'pinia';export {createRenderer,h,nextTick} from 'vue';
    export {createRouter,createMemoryHistory,RouterView} from 'vue-router';` },
    alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_API_BASE_URL': '"/supplierapi"',
      '__VUE_OPTIONS_API__': 'true', '__VUE_PROD_DEVTOOLS__': 'false', '__VUE_PROD_HYDRATION_MISMATCH_DETAILS__': 'false' },
    bundle: true, write: false, platform: 'browser', format: 'esm', plugins: [{ name: 'actual-supplier-flow', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => {
        const descriptor = parse(readFileSync(path, 'utf8'), { filename: path }).descriptor;
        const script = compileScript(descriptor, { id: 'supplier-flow', genDefaultAs: '__Page' });
        const template = compileTemplate({ source: descriptor.template.content, filename: path, id: 'supplier-flow', compilerOptions: { bindingMetadata: script.bindings, expressionPlugins: ['typescript'] } });
        if (template.errors.length) throw Error(String(template.errors));
        return { contents: `${script.content}\n${template.code}\n__Page.render=render;export default __Page;`, loader: 'ts' };
      });
    } }] });
  runtimeDirectory = mkdtempSync('/tmp/cinashop-supplier-flow-sfc-');
  const path = resolve(runtimeDirectory, 'compiled-page.mjs'); writeFileSync(path, result.outputFiles[0].text);
  runtime = await import(pathToFileURL(path).href);
}, 30000);
afterAll(() => { if (runtimeDirectory) rmSync(runtimeDirectory, { recursive: true, force: true }); });
function login(permissions = ['supplier.finance.view'], token = 'owned-flow-session-a', id = 21, supplierId = 7) {
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
const gate = () => { let resolve!: (value: any) => void; return { promise: new Promise(done => { resolve = done; }), resolve }; };
const flush = async () => { for (let i = 0; i < 40; i++) { await Promise.resolve(); await runtime.nextTick(); } };
type Node = { tag?: string; text?: string; children: Node[]; props: Record<string, any>; parent?: Node; [key: string]: any };
const content = (node: Node): string => (node.text ?? '') + node.children.map(content).join('');
async function mount(url = '/finance/flows', override: (config: any) => unknown = () => undefined) {
  const calls: any[] = [];
  runtime.http.defaults.adapter = async (config: any) => {
    calls.push(config); const custom = await override(config);
    const value = custom ?? transport(config);
    return { config, data: { status: 200, msg: 'owned flow transport', data: value }, status: 200, statusText: 'owned', headers: {} };
  };
  const host: Node = { children: [], props: {} };
  const renderer = runtime.createRenderer({ createElement: (tag: string) => {
    const node: Node = Object.assign(new EventTarget(), { tag, tagName: tag.toUpperCase(), children: [] as Node[], props: {}, value: '', multiple: false, selected: false, getRootNode: () => hostDocument });
    Object.defineProperty(node, 'options', { get: () => node.children.filter(child => child.tag === 'option') }); return node;
  }, createText: (text: string) => ({ text, children: [], props: {} }), createComment: () => ({ children: [], props: {} }),
    insert(node: Node, parent: Node, anchor?: Node) { if (node.parent) node.parent.children = node.parent.children.filter(item => item !== node); node.parent = parent; const at = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(at < 0 ? parent.children.length : at, 0, node); },
    remove(node: Node) { if (node.parent) node.parent.children = node.parent.children.filter(item => item !== node); }, parentNode: (node: Node) => node.parent,
    nextSibling: (node: Node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    patchProp(node: Node, property: string, _: unknown, value: unknown) { node.props[property] = value; if (['value', 'type', 'selected', 'multiple', 'checked'].includes(property)) node[property] = value; }, setText(node: Node, value: string) { node.text = value; }, setElementText(node: Node, value: string) { node.text = value; node.children = []; } });
  const router = runtime.createRouter({ history: runtime.createMemoryHistory(), routes: [
    { path: '/finance/flows', component: runtime.Page }, { path: '/away', component: { render: () => null } } ] });
  const app = renderer.createApp({ render: () => runtime.h(runtime.RouterView) }); app.use(pinia); app.use(router);
  app.component('el-button', { inheritAttrs: false, setup(_: unknown, { attrs, slots }: any) { return () => runtime.h('button', attrs, slots.default?.()); } });
  await router.push(url); app.mount(host); await flush();
  return { view: runtime.captured.view, host, calls, router, close: () => app.unmount() };
}


const query = (changes: Record<string, unknown> = {}) => ({ type: '', keyword: '', data: '', page: 1, limit: 20, ...changes });
const marks = new Map<number, { mark: string; revision: string }>();
beforeEach(() => marks.clear());
function row(id = 105): any {
  return { id, supplier_id: 7, is_del: 0, uid: 11, order_id: `FLOW-${id}`, link_id: `ORDER-${id}`, pm: id === 2 ? 0 : 1,
    number: '1.00', type: id === 2 ? 2 : 1, pay_type: 'yue', status: 0, mark: marks.get(id)?.mark ?? '', remark: '',
    add_time: '2026-09-04 12:00:00', trade_time: '2026-09-04 12:00:00', finish_time: '', user_nickname: '流水买家',
    type_name: id === 2 ? '退款订单' : '支付订单', pay_type_name: '余额支付', revision: marks.get(id)?.revision ?? 'a'.repeat(64) };
}
function flows(q = query()) {
  let list = Array.from({ length: 105 }, (_, i) => row(105 - i));
  if (q.type) list = list.filter(value => value.type === Number(q.type));
  if (q.keyword) list = list.filter(value => [value.order_id, value.link_id, value.user_nickname, String(value.uid)].some(text => text.includes(String(q.keyword))));
  return { version: 'supplier-flow-v1', selection: 'ledger', supplier_id: 7, ...q, bounded: true,
    count: list.length, list: list.slice((Number(q.page) - 1) * Number(q.limit), Number(q.page) * Number(q.limit)) };
}
function markResult(id: number) { const value = row(id); return { version: 'supplier-flow-mark-v1', supplier_id: 7, id, mark: value.mark, revision: value.revision, bounded: true }; }
function transport(config: any) {
  const id = Number(config.url.match(/\/mark\/(\d+)$/)?.[1]);
  if (id) {
    if (config.method === 'post') marks.set(id, { mark: JSON.parse(config.data).mark, revision: 'b'.repeat(64) });
    return markResult(id);
  }
  if (config.url.endsWith('financeRecord')) {
    const rows = String(config.params.ids).split(',').map(Number).sort((a, b) => b - a).map(row);
    return { header: ['交易单号', '关联订单', '交易时间', '交易金额', '支出收入', '交易人', '交易类型', '支付方式'],
      filekey: ['order_id', 'link_id', 'trade_time', 'number', 'pm', 'user_nickname', 'type_name', 'pay_type_name'],
      export: rows.map(value => ({ order_id: value.order_id, link_id: value.link_id, trade_time: value.trade_time, number: value.number,
        pm: value.pm === 1 ? '收入' : '支出', user_nickname: value.user_nickname, type_name: value.type_name, pay_type_name: value.pay_type_name })),
      filename: '资金流水', limit: 1000, has_more: false, bounded: true };
  }
  return flows(config.params);
}
function downloads() {
  const blobs: Blob[] = [], clicked: string[] = [];
  vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { blobs.push(blob as Blob); return 'blob:owned-flow'; });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  Object.assign(browser, { setTimeout: (f: () => void) => { f(); return 0; } });
  Object.assign(hostDocument, { body: { appendChild: vi.fn() }, createElement: () => { const a = { href: '', download: '', style: {}, click: () => clicked.push(a.download), remove: vi.fn() }; return a; } });
  return { blobs, clicked };
}
function nodes(node: Node, tag: string): Node[] { return [...(node.tag === tag ? [node] : []), ...node.children.flatMap(child => nodes(child, tag))]; }

describe('actual Supplier flow page and complete query lifecycle', () => {
  it('reads a closed tenant snapshot under view permission and hides writes and downloads', async () => {
    const f = await mount(); try {
      expect(f.view.result.value.count).toBe(105); expect(f.calls).toHaveLength(1);
      expect(f.calls[0]).toMatchObject({ method: 'get', params: { selection: 'ledger', ...query() } });
      expect(f.calls[0].headers.Authorization).toBe('Bearer owned-flow-session-a'); expect(f.calls[0].params).not.toHaveProperty('supplier_id');
      expect(content(f.host)).toContain('流水买家'); expect(content(f.host)).not.toMatch(/编辑备注|下载本页|保存流水/);
      await f.view.openMark(f.view.result.value.list[0]); await f.view.download(); expect(f.calls).toHaveLength(1);
    } finally { f.close(); }
  });
  it('shows every one of105 records across six pages without retaining selection across pages', async () => {
    login(['supplier.finance.view', 'supplier.finance.manage']); const f = await mount();
    try {
      const ids: number[] = []; f.view.toggle(f.view.result.value.list[0], true); expect(f.view.selected.value).toEqual([105]);
      for (let page = 1; page <= 6; page++) { if (page > 1) await f.view.load(page); ids.push(...f.view.result.value.list.map((r: any) => r.id)); }
      expect(ids).toEqual(Array.from({ length: 105 }, (_, i) => 105 - i)); expect(f.view.selected.value).toEqual([]);
    } finally { f.close(); }
  });
  it('binds explicit dates and literal person/UID searches while native input edits clear old results immediately', async () => {
    const f = await mount('/finance/flows?keyword=11&from=2026-09-01&to=2026-09-04');
    try {
      expect(f.calls[0].params).toMatchObject({ keyword: '11', data: '2026/09/01-2026/09/04' });
      const input = nodes(f.host, 'input').find(n => n.props.placeholder?.includes('交易单号'))!;
      input.value = '流水买家'; input.dispatchEvent(new Event('input')); await flush(); expect(f.view.result.value).toBeNull();
      await f.view.load(); expect(f.calls.at(-1).params.keyword).toBe('流水买家');
      const select = nodes(f.host, 'select')[0]; select.children.forEach(n => { n.selected = n.props.value === '2'; }); select.dispatchEvent(new Event('change')); await flush();
      await f.view.load(); expect(f.view.result.value.list).toMatchObject([{ id: 2, type: 2 }]);
    } finally { f.close(); }
  });
  it('does not issue a query from an invalid route or malformed date range', async () => {
    const invalid = await mount('/finance/flows?supplier_id=8'); try { await invalid.view.load(); expect(invalid.calls).toEqual([]); } finally { invalid.close(); }
    const f = await mount(); try { f.view.from.value = '2026-02-30'; f.view.to.value = '2026-03-01'; await f.view.load(); expect(f.calls).toHaveLength(1); expect(f.view.result.value).toBeNull(); expect(f.view.error.value).toBeTruthy(); } finally { f.close(); }
  });
  it.each(['filter', 'route', 'session', 'unmount'])('discards a group payload after %s even if transport cancellation is ignored', async kind => {
    const late = gate(); let blocked = false;
    const f = await mount(undefined, c => { if (blocked) { c.signal = undefined; return late.promise; } }); let closed = false;
    try {
      blocked = true; const pending = f.view.load(); await flush();
      if (kind === 'filter') { f.view.keyword.value = 'other'; f.view.keyword.value = ''; }
      if (kind === 'route') await f.router.push('/away');
      if (kind === 'session') { login([], 'owned-flow-b', 31, 8); browser.dispatchEvent(new Event('supplier-session-changed')); login(); browser.dispatchEvent(new Event('supplier-session-changed')); }
      if (kind === 'unmount') { f.close(); closed = true; }
      late.resolve(flows()); await pending; expect(f.view.result.value).toBeNull();
    } finally { if (!closed) f.close(); }
  });
});

describe('Supplier mark write lifecycle and selected export', () => {
  it('reads a fresh mark then sends only that loaded revision and description, refreshes after success', async () => {
    login(['supplier.finance.view', 'supplier.finance.manage']); const f = await mount();
    try {
      await f.view.openMark(f.view.result.value.list[0]); f.view.mark.value = '核对完成'; await f.view.saveMark();
      const posts = f.calls.filter(c => c.method === 'post'); expect(posts).toHaveLength(1);
      expect(posts[0].url.endsWith('/mark/105')).toBe(true); expect(JSON.parse(posts[0].data)).toEqual({ selection: 'ledger', mark: '核对完成', expected_revision: 'a'.repeat(64) });
      expect(f.view.result.value.list[0].mark).toBe('核对完成'); expect(f.view.editingId.value).toBe(0); expect(f.view.notice.value).toContain('已保存');
    } finally { f.close(); }
  });
  it('never repeats an unknown POST and lets the user read current content before another explicit edit', async () => {
    login(['supplier.finance.view', 'supplier.finance.manage']);
    const f = await mount(undefined, c => { if (c.method === 'post') { transport(c); throw Error('回执丢失'); } });
    try {
      await f.view.openMark(f.view.result.value.list[0]); f.view.mark.value = '已核对'; await f.view.saveMark(); expect(f.view.unknown.value).toBe(true);
      await f.view.saveMark(); expect(f.calls.filter(c => c.method === 'post')).toHaveLength(1);
      await f.view.readMark(); expect(f.view.markError.value).toContain('当前备注已与提交内容一致'); expect(f.view.mark.value).toBe('已核对');
      expect(f.calls.filter(c => c.method === 'post')).toHaveLength(1);
    } finally { f.close(); }
  });
  it('reports a different current remark after an unknown result without automatic overwrite', async () => {
    login(['supplier.finance.view', 'supplier.finance.manage']); const f = await mount(undefined, c => { if (c.method === 'post') throw Error('提交结果未知'); });
    try {
      await f.view.openMark(f.view.result.value.list[0]); f.view.mark.value = '待核对'; await f.view.saveMark(); marks.set(105, { mark: '另一操作员备注', revision: 'c'.repeat(64) });
      await f.view.readMark(); expect(f.view.mark.value).toBe('另一操作员备注'); expect(f.view.markError.value).toContain('不同'); expect(f.calls.filter(c => c.method === 'post')).toHaveLength(1);
    } finally { f.close(); }
  });
  it.each(['filter', 'route', 'permission', 'unmount'])('rejects a late mark read after %s', async kind => {
    login(['supplier.finance.view', 'supplier.finance.manage']); const late = gate();
    const f = await mount(undefined, c => { if (c.url.includes('/mark/')) { c.signal = undefined; return late.promise; } }); let closed = false;
    try {
      const pending = f.view.openMark(f.view.result.value.list[0]); await flush();
      if (kind === 'filter') f.view.keyword.value = 'other';
      if (kind === 'route') await f.router.push('/away');
      if (kind === 'permission') { login(['supplier.finance.view']); browser.dispatchEvent(new Event('supplier-session-changed')); }
      if (kind === 'unmount') { f.close(); closed = true; }
      late.resolve(markResult(105)); await pending; expect(f.view.markContext.value).toBeNull(); expect(f.view.editingId.value).toBe(0);
    } finally { if (!closed) f.close(); }
  });
  it('blocks double submission and rejects a late successful save after account A to B to A', async () => {
    login(['supplier.finance.view', 'supplier.finance.manage']); const late = gate();
    const f = await mount(undefined, c => { if (c.method === 'post') { c.signal = undefined; return late.promise; } });
    try {
      await f.view.openMark(f.view.result.value.list[0]); f.view.mark.value = 'pending'; const pending = f.view.saveMark(); await flush(); await f.view.saveMark();
      expect(f.calls.filter(c => c.method === 'post')).toHaveLength(1);
      login([], 'owned-flow-b', 31, 8); browser.dispatchEvent(new Event('supplier-session-changed')); login(['supplier.finance.view', 'supplier.finance.manage']); browser.dispatchEvent(new Event('supplier-session-changed'));
      late.resolve({ ...markResult(105), mark: 'pending' }); await pending; expect(f.view.result.value).toBeNull(); expect(f.view.notice.value).toBe('');
    } finally { f.close(); }
  });
  it('downloads precisely the selected rows on the loaded page and refuses stale selections', async () => {
    login(['supplier.finance.view', 'supplier.finance.manage']); const d = downloads(), f = await mount();
    try {
      f.view.toggle(f.view.result.value.list[1], true); f.view.toggle(f.view.result.value.list[0], true); await f.view.download();
      expect(f.calls.at(-1).params).toEqual({ ids: '105,104', page: 1 }); expect(d.clicked).toHaveLength(1);
      expect((await d.blobs[0].text()).split('\r\n')).toHaveLength(3);
      f.view.keyword.value = 'FLOW-1'; await f.view.download(); expect(d.clicked).toHaveLength(1); expect(f.view.selected.value).toEqual([]);
    } finally { f.close(); }
  });
  it('creates no file when a selected export resolves after a route change', async () => {
    login(['supplier.finance.view', 'supplier.finance.manage']); const late = gate(), d = downloads(); let value: unknown;
    const f = await mount(undefined, c => { if (c.url.endsWith('financeRecord')) { value = transport(c); c.signal = undefined; return late.promise; } });
    try {
      f.view.toggle(f.view.result.value.list[0], true); const pending = f.view.download(); await flush(); await f.router.push('/away'); late.resolve(value); await pending;
      expect(d.blobs).toEqual([]); expect(d.clicked).toEqual([]);
    } finally { f.close(); }
  });
});

describe('closed flow and mark response validation', () => {
  it('reads PostgreSQL character-count remarks without confusing astral characters with UTF16 code units', () => {
    const value = { ...markResult(105), mark: '🌷'.repeat(255) };
    expect(runtime.api.parseSupplierFlowMark(value, 7, 105).mark).toBe(value.mark);
    expect(() => runtime.api.parseSupplierFlowMark({ ...value, mark: value.mark + '🌷' }, 7, 105)).toThrow();
  });
  it.each(['tenant', 'query', 'count', 'duplicate', 'deleted', 'type', 'amount', 'unknown', 'rowExtra', 'revision', 'time'])('rejects a corrupted %s read', kind => {
    const v: any = flows();
    if (kind === 'tenant') v.supplier_id = 8;
    if (kind === 'query') v.keyword = 'other';
    if (kind === 'count') v.count = 2;
    if (kind === 'duplicate') v.list[1].id = v.list[0].id;
    if (kind === 'deleted') v.list[0].is_del = 1;
    if (kind === 'type') v.list[0].type_name = '退款订单';
    if (kind === 'amount') v.list[0].number = '1e2';
    if (kind === 'unknown') v.unbounded = true;
    if (kind === 'rowExtra') v.list[0].bank_code = 'private';
    if (kind === 'revision') v.list[0].revision = 'weak';
    if (kind === 'time') v.list[0].trade_time = '2026-02-30 12:00:00';
    expect(() => runtime.api.parseSupplierFlows(v, query(), 7)).toThrow();
  });
  it.each(['id', 'tenant', 'revision', 'extra', 'bounded'])('rejects a corrupted %s remark response', kind => {
    const value: any = markResult(105);
    if (kind === 'id') value.id = 104;
    if (kind === 'tenant') value.supplier_id = 8;
    if (kind === 'revision') value.revision = 'wrong';
    if (kind === 'extra') value.number = '1.00';
    if (kind === 'bounded') value.bounded = false;
    expect(() => runtime.api.parseSupplierFlowMark(value, 7, 105)).toThrow();
  });
});
