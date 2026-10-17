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
    import Page from './src/pages/FinanceExtracts.vue';export {Page};export const captured={};
    const setup=Page.setup;Page.setup=(p,c)=>{const value=setup(p,c);captured.view=value;return value;};
    export * as api from './src/api/supplierExtracts';export {http} from './src/api/http';
    export {createPinia,disposePinia} from 'pinia';export {createRenderer,h,nextTick,ref} from 'vue';
    export {createRouter,createMemoryHistory,RouterView} from 'vue-router';` },
    alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_API_BASE_URL': '"/supplierapi"',
      '__VUE_OPTIONS_API__': 'true', '__VUE_PROD_DEVTOOLS__': 'false', '__VUE_PROD_HYDRATION_MISMATCH_DETAILS__': 'false' },
    bundle: true, write: false, platform: 'browser', format: 'esm', plugins: [{ name: 'actual-supplier-extract', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => {
        const descriptor = parse(readFileSync(path, 'utf8'), { filename: path }).descriptor;
        const script = compileScript(descriptor, { id: 'supplier-extract', genDefaultAs: '__Page' });
        const template = compileTemplate({ source: descriptor.template.content, filename: path, id: 'supplier-extract', compilerOptions: { bindingMetadata: script.bindings, expressionPlugins: ['typescript'] } });
        if (template.errors.length) throw Error(String(template.errors));
        return { contents: `${script.content}\n${template.code}\n__Page.render=render;export default __Page;`, loader: 'ts' };
      });
    } }] });
  runtimeDirectory = mkdtempSync('/tmp/cinashop-supplier-extract-sfc-');
  const path = resolve(runtimeDirectory, 'compiled-page.mjs'); writeFileSync(path, result.outputFiles[0].text);
  runtime = await import(pathToFileURL(path).href);
}, 30000);
afterAll(() => { if (runtimeDirectory) rmSync(runtimeDirectory, { recursive: true, force: true }); });
function login(permissions = ['supplier.finance.view'], token = 'owned-extract-session-a', id = 21, supplierId = 7) {
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
async function mount(url = '/finance/extracts', override: (config: any) => unknown = () => undefined) {
  const calls: any[] = [];
  runtime.http.defaults.adapter = async (config: any) => {
    calls.push(config); const custom = await override(config);
    const value = custom ?? transport(config);
    return { config, data: { status: 200, msg: 'owned extract transport', data: value }, status: 200, statusText: 'owned', headers: {} };
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
  const refresh = runtime.ref(0);
  const router = runtime.createRouter({ history: runtime.createMemoryHistory(), routes: [
    { path: '/finance/extracts', component: runtime.Page, props: () => ({ refreshKey: refresh.value }) }, { path: '/away', component: { render: () => null } } ] });
  const app = renderer.createApp({ render: () => runtime.h(runtime.RouterView) }); app.use(pinia); app.use(router);
  app.component('el-button', { inheritAttrs: false, setup(_: unknown, { attrs, slots }: any) { return () => runtime.h('button', attrs, slots.default?.()); } });
  await router.push(url); app.mount(host); await flush();
  return { view: runtime.captured.view, host, calls, router, refresh, close: () => app.unmount() };
}

const query = (changes: Record<string, unknown> = {}) => ({ status: '', pay_status: '', extract_type: '', data: '', page: 1, limit: 20, ...changes });
const marks = new Map<number, { mark: string; revision: string }>();
beforeEach(() => marks.clear());
function row(id = 105): any {
  return { id, supplier_id: 7, extract_type: id === 104 ? 'weixin' : id === 103 ? 'alipay' : 'bank',
    bank_code: '000062220001', bank_address: '申请时开户行', alipay_account: 'historical-alipay', wechat: 'historical-wechat',
    qrcode_url: '/owned-media/qrcode.png', extract_price: id === 104 ? '30.00' : id === 103 ? '20.00' : id === 102 ? '40.00' : '1.00',
    balance: '735.00', supplier_mark: marks.get(id)?.mark ?? '', status: id === 102 ? -1 : [103, 104].includes(id) ? 1 : 0,
    pay_status: id === 104 ? 1 : 0, admin_id: [103, 104].includes(id) ? 101 : 0, admin_name: [103, 104].includes(id) ? '历史经办人' : '',
    fail_msg: id === 102 ? '账目待复核' : '', fail_time: id === 102 ? '2026-09-05 11:00:00' : '',
    voucher_image: id === 104 ? '/owned-media/voucher.png' : '', voucher_title: id === 104 ? '本机转账登记' : '',
    pay_time: id === 104 ? '2026-09-05 12:00:00' : '', add_time: '2026-09-04 12:00:00', revision: marks.get(id)?.revision ?? 'a'.repeat(64) };
}
function history(q = query()) {
  let list = Array.from({ length: 105 }, (_, i) => row(105 - i));
  if (q.status) list = list.filter(value => value.status === Number(q.status));
  if (q.pay_status) list = list.filter(value => value.pay_status === Number(q.pay_status));
  if (q.extract_type) list = list.filter(value => value.extract_type === q.extract_type);
  return { version: 'supplier-extract-v1', selection: 'history', supplier_id: 7, ...q, bounded: true,
    statistics: { pending_review: '102.00', pending_transfer: '20.00', paid: '30.00', withdrawable: '735.00', extract_min_price: '5.50', extract_max_price: '200.00' },
    count: list.length, list: list.slice((Number(q.page) - 1) * Number(q.limit), Number(q.page) * Number(q.limit)) };
}
function markResult(id: number) { const value = row(id); return { version: 'supplier-extract-mark-v1', supplier_id: 7, id, supplier_mark: value.supplier_mark, revision: value.revision, bounded: true }; }
function transport(config: any) {
  const id = Number(config.url.match(/\/mark\/(\d+)$/)?.[1]);
  if (id) { if (config.method === 'post') marks.set(id, { mark: JSON.parse(config.data).mark, revision: 'b'.repeat(64) }); return markResult(id); }
  return history(config.params);
}
function nodes(node: Node, tag: string): Node[] { return [...(node.tag === tag ? [node] : []), ...node.children.flatMap(child => nodes(child, tag))]; }

describe('actual Supplier withdrawal history and snapshot details', () => {
  it('reads its own closed snapshot with view permission, shows exact returned cards and hides remark writes', async () => {
    const f = await mount(); try {
      expect(f.view.result.value.count).toBe(105); expect(f.calls).toHaveLength(1);
      expect(f.calls[0]).toMatchObject({ method: 'get', params: { selection: 'history', ...query() } });
      expect(f.calls[0].headers.Authorization).toBe('Bearer owned-extract-session-a'); expect(f.calls[0].params).not.toHaveProperty('supplier_id');
      expect(content(f.host)).toContain('¥735.00'); expect(content(f.host)).toContain('¥102.00'); expect(content(f.host)).not.toContain('编辑备注');
      await f.view.openMark(f.view.result.value.list[0]); await f.view.saveMark(); expect(f.calls).toHaveLength(1);
    } finally { f.close(); }
  });
  it('shows all105 applications across six pages and closes sensitive details when paging', async () => {
    const f = await mount(); try {
      const ids: number[] = []; f.view.openDetails(f.view.result.value.list[0]); expect(f.view.detail.value.id).toBe(105);
      for (let page = 1; page <= 6; page++) { if (page > 1) await f.view.load(page); ids.push(...f.view.result.value.list.map((r: any) => r.id)); }
      expect(ids).toEqual(Array.from({ length: 105 }, (_, i) => 105 - i)); expect(f.view.detail.value).toBeUndefined();
    } finally { f.close(); }
  });
  it('binds actual native selects and dates, clearing old cards and details before the next read', async () => {
    const f = await mount('/finance/extracts?status=1&pay_status=1&extract_type=weixin&from=2026-09-01&to=2026-09-04');
    try {
      expect(f.calls[0].params).toEqual({ selection: 'history', ...query({ status: '1', pay_status: '1', extract_type: 'weixin', data: '2026/09/01-2026/09/04' }) });
      f.view.openDetails(f.view.result.value.list[0]); expect(f.view.detail.value.id).toBe(104);
      const select = nodes(f.host, 'select')[1]; select.children.forEach(n => { n.selected = n.props.value === '0'; }); select.dispatchEvent(new Event('change')); await flush();
      expect(f.view.result.value).toBeNull(); expect(f.view.detail.value).toBeUndefined(); await f.view.load(); expect(f.calls.at(-1).params.pay_status).toBe('0'); expect(f.view.result.value.count).toBe(0);
      const input = nodes(f.host, 'input')[0]; input.value = '2026-09-02'; input.dispatchEvent(new Event('input')); await flush(); expect(f.view.from.value).toBe('2026-09-02');
    } finally { f.close(); }
  });
  it('shows the recorded bank and paid QR/voucher details without reading current settlement settings', async () => {
    const f = await mount(); try {
      f.view.openDetails(f.view.result.value.list[0]); await flush(); expect(content(f.host)).toContain('000062220001'); expect(content(f.host)).toContain('申请时开户行');
      f.view.openDetails(f.view.result.value.list[1]); await flush(); const text = content(f.host);
      expect(text).toContain('historical-wechat'); expect(text).toContain('本机转账登记'); expect(text).toContain('历史经办人');
      expect(nodes(f.host, 'img').map(n => n.props.src)).toEqual(['/owned-media/qrcode.png', '/owned-media/voucher.png']);
      expect(nodes(f.host, 'img').every(n => n.props.referrerpolicy === 'no-referrer')).toBe(true); expect(f.calls).toHaveLength(1);
      f.view.openDetails(f.view.result.value.list[3]); await flush(); expect(content(f.host)).toContain('账目待复核'); expect(content(f.host)).toContain('2026-09-05 11:00:00');
    } finally { f.close(); }
  });
  it('uses an explicit placeholder after an image failure and clears details on a parent application refresh', async () => {
    const f = await mount(); try {
      f.view.openDetails(f.view.result.value.list[1]); await flush(); nodes(f.host, 'img')[0].props.onError(); await flush();
      expect(content(f.host)).toContain('图片暂不可用'); expect(nodes(f.host, 'img')).toHaveLength(1);
      f.refresh.value++; await flush(); expect(f.view.detail.value).toBeUndefined(); expect(f.calls).toHaveLength(2);
    } finally { f.close(); }
  });
  it('never makes an image from a private bearer alias or an executable URL', async () => {
    const f = await mount(undefined, c => { const value = transport(c); if (!('list' in value)) throw Error('Expected owned history fixture'); value.list[1].qrcode_url = '/kefuapi/assets/23?signature=private'; value.list[1].voucher_image = 'javascript:alert(1)'; return value; });
    try { f.view.openDetails(f.view.result.value.list[1]); await flush(); expect(nodes(f.host, 'img')).toHaveLength(0); expect(nodes(f.host, 'a')).toHaveLength(0); expect(content(f.host)).toContain('图片暂不可用'); }
    finally { f.close(); }
  });
  it('rejects invalid route scope and dates before a request and clears previous sensitive content', async () => {
    const invalid = await mount('/finance/extracts?supplier_id=8'); try { await invalid.view.load(); expect(invalid.calls).toEqual([]); } finally { invalid.close(); }
    const f = await mount(); try { f.view.openDetails(f.view.result.value.list[0]); f.view.from.value = '2026-02-30'; f.view.to.value = '2026-03-01'; await f.view.load(); expect(f.calls).toHaveLength(1); expect(f.view.result.value).toBeNull(); expect(f.view.detail.value).toBeUndefined(); expect(f.view.error.value).toBeTruthy(); } finally { f.close(); }
  });
  it.each(['filter', 'route', 'session', 'unmount'])('discards a late history after %s even when abort is ignored', async kind => {
    const late = gate(); let blocked = false; const f = await mount(undefined, c => { if (blocked) { c.signal = undefined; return late.promise; } }); let closed = false;
    try {
      f.view.openDetails(f.view.result.value.list[0]); blocked = true; const pending = f.view.load(); await flush();
      if (kind === 'filter') { f.view.payStatus.value = '1'; f.view.payStatus.value = ''; }
      if (kind === 'route') await f.router.push('/away');
      if (kind === 'session') { login([], 'owned-extract-b', 31, 8); browser.dispatchEvent(new Event('supplier-session-changed')); login(); browser.dispatchEvent(new Event('supplier-session-changed')); }
      if (kind === 'unmount') { f.close(); closed = true; }
      late.resolve(history()); await pending; expect(f.view.result.value).toBeNull(); expect(f.view.detail.value).toBeUndefined();
    } finally { if (!closed) f.close(); }
  });
});

describe('actual Supplier withdrawal descriptive write lifecycle', () => {
  it('reads a fresh revision, posts only its description and refreshes after a successful save', async () => {
    login(['supplier.finance.view', 'supplier.finance.manage']); const f = await mount(); try {
      await f.view.openMark(f.view.result.value.list[0]); f.view.mark.value = '到账信息已核对'; await f.view.saveMark();
      const posts = f.calls.filter(c => c.method === 'post'); expect(posts).toHaveLength(1);
      expect(JSON.parse(posts[0].data)).toEqual({ selection: 'history', mark: '到账信息已核对', expected_revision: 'a'.repeat(64) }); expect(posts[0].url.endsWith('/mark/105')).toBe(true);
      expect(f.view.result.value.list[0].supplier_mark).toBe('到账信息已核对'); expect(f.view.editingId.value).toBe(0); expect(f.view.notice.value).toContain('已保存');
    } finally { f.close(); }
  });
  it('requires manual GET after an unknown committed reply and never blindly repeats a POST', async () => {
    login(['supplier.finance.view', 'supplier.finance.manage']); const f = await mount(undefined, c => { if (c.method === 'post') { transport(c); throw Error('回执丢失'); } }); try {
      await f.view.openMark(f.view.result.value.list[0]); f.view.mark.value = '已核对'; await f.view.saveMark(); expect(f.view.unknown.value).toBe(true);
      await f.view.saveMark(); expect(f.calls.filter(c => c.method === 'post')).toHaveLength(1);
      await f.view.readMark(); expect(f.view.markError.value).toContain('当前备注已与提交内容一致'); expect(f.view.mark.value).toBe('已核对'); expect(f.calls.filter(c => c.method === 'post')).toHaveLength(1);
    } finally { f.close(); }
  });
  it('shows another operator current text after an unknown result without overwriting it', async () => {
    login(['supplier.finance.view', 'supplier.finance.manage']); const f = await mount(undefined, c => { if (c.method === 'post') throw Error('提交结果未知'); }); try {
      await f.view.openMark(f.view.result.value.list[0]); f.view.mark.value = '待核对'; await f.view.saveMark(); marks.set(105, { mark: '财务新备注', revision: 'c'.repeat(64) });
      await f.view.readMark(); expect(f.view.mark.value).toBe('财务新备注'); expect(f.view.markError.value).toContain('不同'); expect(f.calls.filter(c => c.method === 'post')).toHaveLength(1);
    } finally { f.close(); }
  });
  it.each(['filter', 'route', 'permission', 'unmount'])('rejects a late remark read after %s', async kind => {
    login(['supplier.finance.view', 'supplier.finance.manage']); const late = gate(); const f = await mount(undefined, c => { if (c.url.includes('/mark/')) { c.signal = undefined; return late.promise; } }); let closed = false;
    try {
      const pending = f.view.openMark(f.view.result.value.list[0]); await flush();
      if (kind === 'filter') f.view.status.value = '1'; if (kind === 'route') await f.router.push('/away');
      if (kind === 'permission') { login(['supplier.finance.view']); browser.dispatchEvent(new Event('supplier-session-changed')); }
      if (kind === 'unmount') { f.close(); closed = true; }
      late.resolve(markResult(105)); await pending; expect(f.view.markContext.value).toBeNull(); expect(f.view.editingId.value).toBe(0);
    } finally { if (!closed) f.close(); }
  });
  it('blocks double submission and discards a late success after account A to B to A', async () => {
    login(['supplier.finance.view', 'supplier.finance.manage']); const late = gate(); const f = await mount(undefined, c => { if (c.method === 'post') { c.signal = undefined; return late.promise; } }); try {
      await f.view.openMark(f.view.result.value.list[0]); f.view.mark.value = 'pending'; const pending = f.view.saveMark(); await flush(); await f.view.saveMark(); expect(f.calls.filter(c => c.method === 'post')).toHaveLength(1);
      login([], 'owned-extract-b', 31, 8); browser.dispatchEvent(new Event('supplier-session-changed')); login(['supplier.finance.view', 'supplier.finance.manage']); browser.dispatchEvent(new Event('supplier-session-changed'));
      late.resolve({ ...markResult(105), supplier_mark: 'pending' }); await pending; expect(f.view.result.value).toBeNull(); expect(f.view.notice.value).toBe('');
    } finally { f.close(); }
  });
  it('does not publish an old success notice when its refresh returns after leaving the route', async () => {
    login(['supplier.finance.view', 'supplier.finance.manage']); const late = gate(); let block = false;
    const f = await mount(undefined, c => { if (c.method === 'post') { block = true; return transport(c); } if (block && c.url.endsWith('/list')) { c.signal = undefined; return late.promise; } });
    try { await f.view.openMark(f.view.result.value.list[0]); f.view.mark.value = '已核对'; const pending = f.view.saveMark(); await flush(); await f.router.push('/away'); late.resolve(history()); await pending; expect(f.view.notice.value).toBe(''); expect(f.view.result.value).toBeNull(); }
    finally { f.close(); }
  });
});

describe('closed history, statistics, account and remark response validation', () => {
  it.each(['tenant', 'query', 'count', 'duplicate', 'type', 'review', 'pay', 'amount', 'statistics', 'negativeStat', 'unknown', 'internal', 'revision', 'time'])('rejects corrupted %s history', kind => {
    const v: any = history();
    if (kind === 'tenant') v.supplier_id = 8; if (kind === 'query') v.pay_status = '1'; if (kind === 'count') v.count = 2;
    if (kind === 'duplicate') v.list[1].id = v.list[0].id; if (kind === 'type') v.list[0].extract_type = 'cash';
    if (kind === 'review') v.list[0].status = '0'; if (kind === 'pay') v.list[0].pay_status = 2; if (kind === 'amount') v.list[0].extract_price = '1e2';
    if (kind === 'statistics') v.statistics.extract_min_price = '5.5'; if (kind === 'negativeStat') v.statistics.withdrawable = '-1.00';
    if (kind === 'unknown') v.account = 'current'; if (kind === 'internal') v.list[0].mark = 'not public DTO'; if (kind === 'revision') v.list[0].revision = 'weak'; if (kind === 'time') v.list[0].pay_time = '2026-02-30 12:00:00';
    expect(() => runtime.api.parseSupplierExtractHistory(v, query(), 7)).toThrow();
  });
  it.each(['id', 'tenant', 'revision', 'extra', 'bounded'])('rejects corrupted %s remark response', kind => {
    const v: any = markResult(105); if (kind === 'id') v.id = 104; if (kind === 'tenant') v.supplier_id = 8; if (kind === 'revision') v.revision = 'wrong'; if (kind === 'extra') v.status = 1; if (kind === 'bounded') v.bounded = false;
    expect(() => runtime.api.parseSupplierExtractMark(v, 7, 105)).toThrow();
  });
  it('reads255 Unicode characters while preserving bank identifiers as text', () => {
    const v = { ...markResult(105), supplier_mark: '🌷'.repeat(255) }; expect(runtime.api.parseSupplierExtractMark(v, 7, 105).supplier_mark).toBe(v.supplier_mark);
    expect(() => runtime.api.parseSupplierExtractMark({ ...v, supplier_mark: v.supplier_mark + '🌷' }, 7, 105)).toThrow();
    expect(runtime.api.parseSupplierExtractHistory(history(), query(), 7).list[0].bank_code).toBe('000062220001');
  });
  it.each(['/api/assets/23', '/kefuapi/assets/23?signature=old', 'https://foreign.test/api/assets/23', 'javascript:alert(1)', 'data:image/svg+xml,test', '//foreign.test/x.png', 'http://foreign.test/x.png', '/%61pi/assets/23'])('does not promote unsafe or private image %s', value => {
    expect(runtime.api.supplierExtractImage(value)).toBe('');
  });
});
