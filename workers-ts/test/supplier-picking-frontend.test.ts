import { beforeAll, beforeEach, afterEach, it, expect, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

// Actual SFC setup, router, session and Axios; only transport/dialogs/printing
// are isolated. Browser rendering is verified separately, not inferred here.
let runtime: any;
let surface: EventTarget & { print: ReturnType<typeof vi.fn> };
const root = resolve(import.meta.dirname, '../../view/supplier-ts'), require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript } = require('@vue/compiler-sfc');
beforeAll(async () => {
  const output = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    export { default as Component } from './src/pages/PickingSheets.vue';
    export { http } from './src/api/http'; export * as session from './src/utils/supplierSession';
    export * as contract from './src/utils/pickingSheet';
    export * as dialog from 'element-plus'; export { createRenderer, h, nextTick } from 'vue';
    export { createRouter, createMemoryHistory, RouterView } from 'vue-router';
  ` }, alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_API_BASE_URL': '"/supplierapi"',
    __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' },
    bundle: true, write: false, platform: 'browser', format: 'esm', plugins: [{ name: 'actual-picking-sfc', setup(builder) {
      builder.onLoad({ filter: /PickingSheets\.vue$/ }, ({ path }) => ({ contents: compileScript(parse(readFileSync(path, 'utf8'), { filename: path }).descriptor, { id: 'supplier-picking-test' }).content, loader: 'ts' }));
      builder.onResolve({ filter: /^element-plus$/ }, () => ({ path: 'dialogs', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const state={messages:[]};
        export const ElMessage={warning:m=>state.messages.push(['warning',m]),error:m=>state.messages.push(['error',m])};` }));
    } }] });
  runtime = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text).toString('base64'));
});
beforeEach(() => {
  const values = new Map<string, string>();
  surface = Object.assign(new EventTarget(), { print: vi.fn() }); vi.stubGlobal('window', surface);
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  localStorage.setItem('supplier-token', 'local-a'); localStorage.setItem('supplier-user', '{"id":20,"supplier_id":7}');
  localStorage.setItem('supplier-permissions', '["supplier.order.view"]'); runtime.dialog.state.messages = [];
});
afterEach(() => vi.unstubAllGlobals());
const item = (index = 1) => ({ index, product_name: '本地商品', sku: '本地规格', unit_price: '0.29', quantity: 3, subtotal: '0.87' });
const sheets = (ids = [25], changes = {}) => ({ supplier: { name: '本地供应商', phone: '000000', address: '本地地址' }, list: ids.map(id => ({
  id, order_id: 'LOCAL-' + id, real_name: '本地收件人-' + id, user_phone: '000000', user_address: '本地收件地址',
  pay_time: 1700000000, pay_type: 'yue', freight_price: '0.00', coupon_price: '0.00', vip_true_price: '0.00', deduction_price: '0.00',
  use_integral: '0.00', pay_price: '0.87', mark: '', supplier_remark: '', items: [item()], ...changes,
})) });
const envelope = (data: unknown) => ({ status: 200, data });
const gate = () => { let resolve!: (value: unknown) => void; return { promise: new Promise(r => { resolve = r; }), resolve }; };
const flush = async () => { for (let i = 0; i < 35; i++) { await Promise.resolve(); await runtime.nextTick(); } };
async function mount(override: (config: any) => unknown = () => undefined, path = '/orders/picking-sheet?ids=25') {
  const calls: any[] = []; let view: any;
  runtime.http.defaults.adapter = async (config: any) => {
    calls.push(config); const body = await override(config) ?? envelope(sheets(config.params.ids.split(',').map(Number)));
    return { config, data: body, status: 200, statusText: 'isolated frontend fixture', headers: {} };
  };
  const router = runtime.createRouter({ history: runtime.createMemoryHistory(), routes: [
    { path: '/orders/picking-sheet', component: { setup(p: unknown, c: unknown) { view = runtime.Component.setup(p, c); return () => null; } } },
    { path: '/away', component: { render: () => null } },
  ] });
  const renderer = runtime.createRenderer({ createElement: () => ({ children: [] }), createText: (text: string) => ({ text }), createComment: (text: string) => ({ text }),
    insert(n: any, p: any) { n.parent = p; (p.children ??= []).push(n); }, remove() {}, parentNode: (n: any) => n.parent, nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {} });
  const app = renderer.createApp({ render: () => runtime.h(runtime.RouterView) }); app.use(router); await router.push(path); app.mount({ children: [] }); await flush();
  return { get view() { return view; }, router, calls, close: () => app.unmount() };
}

it('clears previous recipients before reload and keeps failure non-printable until explicit retry', async () => {
  const wait = gate(); let fail = false;
  const f = await mount(() => fail ? wait.promise : undefined);
  try {
    expect(f.view.pages.value[0].order.id).toBe(25); fail = true; const pending = f.view.load(); await flush();
    expect(f.view.result.value).toBeNull(); await f.view.printSheets(); expect(surface.print).not.toHaveBeenCalled();
    wait.resolve({ status: 500, msg: 'local read failed' }); await pending;
    expect(f.view.pages.value).toEqual([]); expect(f.view.errorMessage.value).toBeTruthy();
    fail = false; await f.view.load(); await f.view.printSheets(); expect(surface.print).toHaveBeenCalledTimes(1);
  } finally { f.close(); }
});

it('reacts to same-component A -> B -> A query changes and ignores the first delayed result', async () => {
  const wait = gate(); let count = 0;
  const f = await mount(c => c.params.ids === '25' && ++count === 1 ? wait.promise : undefined);
  try {
    const original = f.view; await f.router.push('/orders/picking-sheet?ids=26'); await flush();
    expect(f.view).toBe(original); expect(f.view.result.value.list[0].id).toBe(26);
    await f.router.push('/orders/picking-sheet?ids=25'); await flush();
    wait.resolve(envelope(sheets([25], { mark: 'STALE' }))); await flush();
    expect(f.view.result.value.list[0].mark).toBe(''); expect(f.calls).toHaveLength(3);
  } finally { wait.resolve(envelope(sheets())); f.close(); }
});

it('clears account A -> B -> A data immediately and never resumes requests or printing', async () => {
  const f = await mount();
  try {
    for (const token of ['local-b', 'local-a']) { localStorage.setItem('supplier-token', token); surface.dispatchEvent(new Event('supplier-session-changed')); }
    expect(f.view.result.value).toBeNull(); const count = f.calls.length;
    await f.view.load(); await f.view.printSheets(); expect(f.calls).toHaveLength(count); expect(surface.print).not.toHaveBeenCalled();
  } finally { f.close(); }
});

it('rejects a different order returned for the requested printable batch', async () => {
  const f = await mount(() => envelope(sheets([26])));
  try { expect(f.view.result.value).toBeNull(); expect(f.view.errorMessage.value).toBeTruthy(); await f.view.printSheets(); expect(surface.print).not.toHaveBeenCalled(); }
  finally { f.close(); }
});

it('does not restore a delayed recipient after unmount', async () => {
  const wait = gate(), f = await mount(() => wait.promise), view = f.view;
  f.close(); wait.resolve(envelope(sheets())); await flush(); expect(view.result.value).toBeNull(); expect(view.loading.value).toBe(false);
});

it.each(['empty', 'duplicates', 'missing-field', 'invalid-money', 'subtotal', 'boolean-quantity', 'item-index', 'too-many-items', 'invalid-time'])('rejects %s printable receipts without partial pages', async kind => {
  const value: any = sheets();
  if (kind === 'empty') value.list = [];
  if (kind === 'duplicates') value.list.push(value.list[0]);
  if (kind === 'missing-field') delete value.list[0].real_name;
  if (kind === 'invalid-money') value.list[0].pay_price = 'NaN';
  if (kind === 'subtotal') value.list[0].items[0].subtotal = '0.88';
  if (kind === 'boolean-quantity') value.list[0].items[0].quantity = true;
  if (kind === 'item-index') value.list[0].items[0].index = 2;
  if (kind === 'too-many-items') value.list[0].items = Array.from({ length: 201 }, (_, i) => item(i + 1));
  if (kind === 'invalid-time') value.list[0].pay_time = Number.POSITIVE_INFINITY;
  const f = await mount(() => envelope(value));
  try { expect(f.view.pages.value).toEqual([]); expect(f.view.errorMessage.value).toBeTruthy(); await f.view.printSheets(); expect(surface.print).not.toHaveBeenCalled(); }
  finally { f.close(); }
});

it.each(['', '25,25', '2147483648', '1.5', 'x', '1,2,3,4,5,6,7,8,9,10,11'])('rejects invalid query %s before HTTP dispatch', async ids => {
  const f = await mount(undefined, '/orders/picking-sheet?ids=' + encodeURIComponent(ids));
  try { expect(f.calls).toEqual([]); expect(f.view.pages.value).toEqual([]); expect(f.view.errorMessage.value).toBeTruthy(); }
  finally { f.close(); }
});

it('accepts ordered multi-order batches and six-item page boundaries without changing money', async () => {
  const value = sheets([26, 25], { items: Array.from({ length: 7 }, (_, i) => item(i + 1)) });
  const f = await mount(() => envelope(value), '/orders/picking-sheet?ids=26,25');
  try {
    expect(f.view.pages.value.map((page: any) => [page.order.id, page.page, page.items.length])).toEqual([[26, 1, 6], [26, 2, 1], [25, 1, 6], [25, 2, 1]]);
    expect(f.view.pages.value[0].items[0]).toMatchObject({ unit_price: '0.29', subtotal: '0.87' });
    expect(runtime.contract.formatPickingMoney('2147483647000000000.29')).toBe('¥2,147,483,647,000,000,000.29');
    const boundary = sheets([25], { items: Array.from({ length: 200 }, (_, i) => item(i + 1)) });
    expect(runtime.contract.parsePickingSheets(boundary, [25]).list[0].items).toHaveLength(200);
  } finally { f.close(); }
});

it('native beforeprint checks silent storage changes and hides stale DOM synchronously', async () => {
  const f = await mount(), setAttribute = vi.fn();
  try {
    f.view.previewRoot.value = { setAttribute };
    localStorage.setItem('supplier-token', 'silent-local-b');
    surface.dispatchEvent(new Event('beforeprint'));
    expect(f.view.result.value).toBeNull(); expect(setAttribute).toHaveBeenCalledWith('data-print-ready', 'false');
    expect(f.view.sessionValid.value).toBe(false);
  } finally { f.close(); }
});

it('late failures cannot overwrite a newer successful reload or display stale error messages', async () => {
  const wait = gate(); let count = 0;
  const f = await mount(() => ++count === 2 ? wait.promise : undefined);
  try {
    const old = f.view.load(); await flush(); await f.view.load();
    expect(f.view.result.value.list[0].id).toBe(25);
    wait.resolve({ status: 500, msg: 'STALE FAILURE' }); await old;
    expect(f.view.errorMessage.value).toBe(''); expect(f.view.loading.value).toBe(false);
    expect(runtime.dialog.state.messages).not.toContainEqual(['error', 'STALE FAILURE']);
  } finally { f.close(); }
});

it('anonymous entry and cross-tab permissions invalidation cannot print cached recipients', async () => {
  localStorage.removeItem('supplier-token'); const anonymous = await mount();
  try { expect(anonymous.calls).toEqual([]); expect(anonymous.view.sessionValid.value).toBe(false); }
  finally { anonymous.close(); }
  localStorage.setItem('supplier-token', 'local-a'); const f = await mount();
  try {
    const event = new Event('storage'); Object.defineProperties(event, { storageArea: { value: localStorage }, key: { value: 'supplier-permissions' } });
    surface.dispatchEvent(event); expect(f.view.result.value).toBeNull(); await f.view.printSheets(); expect(surface.print).not.toHaveBeenCalled();
  } finally { f.close(); }
});

it('does not print after invalidation during the render flush or read again while leaving the route', async () => {
  const f = await mount();
  try {
    const printing = f.view.printSheets(); runtime.session.clearSupplierSession(); await printing;
    expect(surface.print).not.toHaveBeenCalled();
  } finally { f.close(); }
  localStorage.setItem('supplier-token', 'local-a'); const next = await mount();
  try {
    const count = next.calls.length, messages = runtime.dialog.state.messages.length, view = next.view;
    await next.router.push('/away'); await flush();
    expect(view.result.value).toBeNull(); expect(next.calls).toHaveLength(count);
    expect(runtime.dialog.state.messages).toHaveLength(messages);
  } finally { next.close(); }
});
