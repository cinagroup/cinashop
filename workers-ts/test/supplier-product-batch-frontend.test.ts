import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../../view/supplier-ts'), require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc');
let runtime: any, preview: any, pinia: any, windowSurface: EventTarget;
beforeAll(async () => {
  const bundle = async (simulated: boolean) => build({ absWorkingDir: root, stdin: { resolveDir: root, contents: simulated
    ? `export * from './src/api/supplier';` : `export { default as Batch } from './src/components/ProductBatchDialog.vue';
      export { http } from './src/api/http'; export * as dialog from 'element-plus'; export { createPinia, disposePinia } from 'pinia';
      export { createRenderer, h, nextTick, reactive } from 'vue'; export { createRouter, createMemoryHistory, RouterView } from 'vue-router';` },
    alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': String(simulated), 'import.meta.env.VITE_API_BASE_URL': '"/supplierapi"',
      '__VUE_OPTIONS_API__': 'true', '__VUE_PROD_DEVTOOLS__': 'false', '__VUE_PROD_HYDRATION_MISMATCH_DETAILS__': 'false' },
    bundle: true, write: false, platform: 'browser', format: 'esm', plugins: [{ name: 'actual-batch-sfc', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => { const descriptor = parse(readFileSync(path, 'utf8'), { filename: path }).descriptor;
        const template = compileTemplate({ source: descriptor.template.content, filename: path, id: 'supplier-batch', compilerOptions: { expressionPlugins: ['typescript'] } });
        if (template.errors.length) throw Error(String(template.errors)); return { contents: compileScript(descriptor, { id: 'supplier-batch' }).content, loader: 'ts' }; });
      builder.onResolve({ filter: /^element-plus$/ }, () => ({ path: 'dialogs', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const messages=[],confirmations=[];
        export const ElMessage={success:m=>messages.push(m),warning:m=>messages.push(m),error:m=>messages.push(m)};
        export const ElMessageBox={confirm:async (...args)=>{confirmations.push(args)}};` }));
    } }] });
  const actual = await bundle(false); runtime = await import(`data:text/javascript;base64,${Buffer.from(actual.outputFiles[0].text).toString('base64')}`);
  const simulated = await bundle(true); vi.stubGlobal('window', { location: { search: '?preview=1' } });
  preview = await import(`data:text/javascript;base64,${Buffer.from(simulated.outputFiles[0].text).toString('base64')}`); vi.unstubAllGlobals();
}, 30000);
beforeEach(() => {
  const storage = new Map<string, string>(); windowSurface = new EventTarget(); vi.stubGlobal('window', windowSurface);
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  localStorage.setItem('supplier-token', 'fixture-a'); localStorage.setItem('supplier-user', '{"id":21,"supplier_id":20}');
  localStorage.setItem('supplier-permissions', '["supplier.product.view","supplier.product.manage"]');
  pinia = runtime.createPinia(); runtime.dialog.messages.length = 0; runtime.dialog.confirmations.length = 0;
  runtime.dialog.ElMessageBox.confirm = async (...args: any[]) => { runtime.dialog.confirmations.push(args); };
});
afterEach(() => { runtime.disposePinia(pinia); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const state = (ids = [1, 2]) => ({ ids, count: ids.length, revision: 'a'.repeat(64), products: ids.map(id => ({ id, type: 2, relation_id: 20,
  product_type: 0, store_name: `physical-${id}`, is_del: 0, is_show: 1, is_verify: 1, cate_id: '101', delivery_type: '1', system_form_id: 0,
  freight: 1, postage: '0.00', temp_id: 0 })), relations: ids.map(id => ({ product_id: id, relation_id: 101, relation_pid: 100, status: 1 })) });
const tree = [{ id: 100, cate_name: '根', pid: 0, path: '', level: 0, is_show: 1, children: [
  { id: 101, cate_name: '子', pid: 100, path: '100', level: 1, is_show: 1, children: [] }] },
  { id: 110, cate_name: '目标', pid: 0, path: '', level: 0, is_show: 1, children: [] },
  { id: 120, cate_name: '隐藏', pid: 0, path: '', level: 0, is_show: 0, children: [] }];
const gate = () => { let resolve!: (value: any) => void; return { promise: new Promise<any>(done => resolve = done), resolve }; };
async function flush() { for (let i = 0; i < 35; i++) { await Promise.resolve(); await runtime.nextTick(); } }
async function mount(override: (config: any, fixture: any) => unknown = () => undefined) {
  const calls: any[] = [], events: string[] = [], fixture = { value: state(), apply(config: any) {
    const body = JSON.parse(config.data), data = body.data; fixture.value.revision = 'b'.repeat(64);
    for (const row of fixture.value.products) {
      if (body.type === 1) row.cate_id = data.cate_id.join(','); else if (body.type === 3) row.delivery_type = data.delivery_type.join(',');
      else if (body.type === 7) row.system_form_id = data.system_form_id;
      else Object.assign(row, { freight: data.freight, postage: data.postage, temp_id: data.temp_id });
    }
    if (body.type === 1) fixture.value.relations = fixture.value.products.flatMap(row => data.cate_id.map((id: number) => ({ product_id: row.id, relation_id: id, relation_pid: id === 101 ? 100 : 0, status: row.is_show })));
    return { ...JSON.parse(JSON.stringify(fixture.value)), updated: fixture.value.count, verified: true };
  } };
  runtime.http.defaults.adapter = async (config: any) => {
    calls.push(config); const custom = await override(config, fixture);
    const data = custom !== undefined ? custom : config.method === 'post' ? fixture.apply(config)
      : config.url === '/product/product/batch-selection' ? JSON.parse(JSON.stringify(fixture.value))
        : config.url === '/product/category/tree' ? tree : config.url === '/form/all_system_form' ? [{ id: 50, name: '留言' }]
          : config.url.startsWith('/form/info/') ? { info: { value: [{ title: '留言', name: '文本框', require: false }] } }
            : { data: [{ id: 60, name: '当前运费', type: '按件数' }], count: 21 };
    return { config, data: { status: 200, msg: 'fixture', data }, status: 200, statusText: 'fixture', headers: {} };
  };
  let view: any; const props = runtime.reactive({ selectedIds: [1, 2], filters: { store_name: 'physical', is_show: '', is_verify: '', page: 1, limit: 20 } });
  const wrapper = { setup() { view = runtime.Batch.setup(props, { emit: (event: string) => events.push(event), expose() {} }); return () => null; } };
  const router = runtime.createRouter({ history: runtime.createMemoryHistory(), routes: [{ path: '/products', component: wrapper }, { path: '/elsewhere', component: { render: () => null } }] });
  const renderer = runtime.createRenderer({ createElement: () => ({ children: [] }), createText: (text: string) => ({ text }), createComment: (text: string) => ({ text }),
    insert(n: any, p: any) { n.parent = p; (p.children ??= []).push(n); }, remove() {}, parentNode: (n: any) => n.parent, nextSibling: () => null,
    patchProp() {}, setText() {}, setElementText() {} });
  const app = renderer.createApp({ render: () => runtime.h(runtime.RouterView) }); app.use(pinia); app.use(router); await router.push('/products'); app.mount({ children: [] }); await flush();
  return { view, props, calls, fixture, events, router, close: () => app.unmount() };
}
const writes = (f: any) => f.calls.filter((config: any) => config.method === 'post');
const reads = (f: any) => f.calls.filter((config: any) => config.url === '/product/product/batch-selection');
describe('mounted Supplier batch dialog and actual HTTP state transitions', () => {
  it('loads scoped choices and requires complete fresh selected facts before enabling submit', async () => {
    const f = await mount(); try { expect(f.view.submitDisabled.value).toBe(true); await f.view.readSelection();
      expect(f.view.phase.value).toBe('ready'); expect(reads(f)[0].params).toMatchObject({ all: 0, ids: '1,2', where: '{}' });
      expect(f.view.categoryOptions.value.map((row: any) => row.id)).toEqual([100, 101, 110]);
    } finally { f.close(); }
  });
  it.each([{ type: 1, draft: { cate_id: [110] }, data: { cate_id: [110] } }, { type: 3, draft: { delivery_type: [2] }, data: { delivery_type: [2] } },
    { type: 7, draft: { system_form_id: 50 }, data: { system_form_id: 50 } }, { type: 8, draft: { freight: 2, postage: '1.2' }, data: { freight: 2, postage: '1.20', temp_id: 0 } }])
    ('sends only operation $type fields then rereads and verifies every original product', async scenario => {
      const f = await mount(); try { await f.view.readSelection(); Object.assign(f.view.draft, { type: scenario.type, ...scenario.draft });
        await f.view.submit(); expect(writes(f)).toHaveLength(1);
        expect(JSON.parse(writes(f)[0].data)).toEqual({ type: scenario.type, all: 0, ids: [1, 2], where: {}, data: scenario.data, expected_revision: 'a'.repeat(64) });
        expect(reads(f)).toHaveLength(2); expect(f.view.phase.value).toBe('verified'); expect(f.events).toContain('changed');
      } finally { f.close(); }
    });
  it('supports filtered all with the complete current filter and a captured target set', async () => {
    const f = await mount(); try { f.view.mode.value = 1; await flush(); await f.view.readSelection();
      f.view.draft.type = 3; f.view.draft.delivery_type = [2]; await f.view.submit();
      expect(JSON.parse(writes(f)[0].data)).toMatchObject({ all: 1, ids: [], where: f.props.filters });
      expect(reads(f)[1].params).toMatchObject({ all: 0, ids: '1,2', where: '{}' });
    } finally { f.close(); }
  });
  it('ignores late selected facts when the selected IDs or filter generation changed', async () => {
    const wait = gate(), f = await mount(config => config.url === '/product/product/batch-selection' ? wait.promise : undefined);
    try { const pending = f.view.readSelection(); await flush(); f.props.selectedIds = [2]; f.props.filters.store_name = 'new'; await flush();
      wait.resolve(state()); await pending; expect(f.view.facts.value).toBeNull(); expect(f.view.phase.value).toBe('idle'); await f.view.submit(); expect(writes(f)).toEqual([]);
    } finally { wait.resolve(state()); f.close(); }
  });
  it('does not send a confirmation completed after the current selection changed', async () => {
    const wait = gate(), f = await mount(); runtime.dialog.ElMessageBox.confirm = () => wait.promise;
    try { await f.view.readSelection(); f.view.draft.cate_id = [110]; const pending = f.view.submit(); await flush();
      f.props.selectedIds = [2]; await flush(); wait.resolve(undefined); await pending; expect(writes(f)).toEqual([]);
    } finally { wait.resolve(undefined); f.close(); }
  });
  it('requires a new confirmation when the chosen operation changes while confirming', async () => {
    const wait = gate(), f = await mount(); runtime.dialog.ElMessageBox.confirm = () => wait.promise;
    try { await f.view.readSelection(); f.view.draft.cate_id = [110]; await flush(); const pending = f.view.submit(); await flush();
      f.view.draft.type = 3; await flush(); wait.resolve(undefined); await pending; expect(writes(f)).toEqual([]); expect(f.view.phase.value).toBe('ready');
    } finally { wait.resolve(undefined); f.close(); }
  });
  it('blocks duplicate submission while the real POST remains in flight', async () => {
    const wait = gate(), f = await mount((config, fixture) => config.method === 'post' ? wait.promise.then(() => fixture.apply(config)) : undefined);
    try { await f.view.readSelection(); f.view.draft.type = 3; f.view.draft.delivery_type = [2]; const pending = f.view.submit(); await flush();
      await f.view.submit(); expect(writes(f)).toHaveLength(1); expect(f.view.busy.value).toBe(true); wait.resolve(undefined); await pending;
      expect(f.view.phase.value).toBe('verified');
    } finally { wait.resolve(undefined); f.close(); }
  });
  it('recovers a committed mutation whose response was lost using original IDs and without resubmitting', async () => {
    const f = await mount((config, fixture) => { if (config.method === 'post') { fixture.apply(config); throw Error('fixture response lost'); } });
    try { await f.view.readSelection(); f.view.draft.type = 3; f.view.draft.delivery_type = [2]; await f.view.submit();
      expect(f.view.phase.value).toBe('unknown'); f.props.selectedIds = [2]; await flush(); await f.view.submit(); expect(writes(f)).toHaveLength(1);
      await f.view.recover(); expect(reads(f)[1].params.ids).toBe('1,2'); expect(f.view.phase.value).toBe('verified');
    } finally { f.close(); }
  });
  it('keeps mismatched unknown execution blocked and preserves the exact intended draft', async () => {
    const f = await mount(config => { if (config.method === 'post') throw Error('unknown'); });
    try { await f.view.readSelection(); f.view.draft.type = 3; f.view.draft.delivery_type = [2]; await f.view.submit(); await f.view.recover();
      expect(f.view.phase.value).toBe('unknown'); expect(f.view.draft.delivery_type).toEqual([2]); await f.view.submit(); await f.view.readSelection(); expect(writes(f)).toHaveLength(1);
    } finally { f.close(); }
  });
  it('rejects incomplete successful receipts rather than showing a verified success', async () => {
    const f = await mount(config => config.method === 'post' ? { updated: 2, verified: true } : undefined);
    try { await f.view.readSelection(); f.view.draft.type = 3; await f.view.submit(); expect(f.view.phase.value).toBe('unknown'); expect(f.events).not.toContain('changed'); }
    finally { f.close(); }
  });
  it('refuses malformed or over-capacity facts before showing ready controls', async () => {
    const f = await mount(config => config.url === '/product/product/batch-selection' ? { ...state(), count: 101 } : undefined);
    try { await f.view.readSelection(); expect(f.view.phase.value).toBe('idle'); expect(f.view.submitDisabled.value).toBe(true); }
    finally { f.close(); }
  });
  it('keeps view-only direct handler calls from reading write choices or dispatching mutations', async () => {
    localStorage.setItem('supplier-permissions', '["supplier.product.view"]'); const f = await mount();
    try { await f.view.readSelection(); await f.view.submit(); await f.view.recover(); expect(f.calls).toEqual([]); expect(f.view.canManage.value).toBe(false); }
    finally { f.close(); }
  });
  it('rejects unavailable categories, empty delivery, precision loss and nonphysical freight before dispatch', async () => {
    const f = await mount(); try { await f.view.readSelection(); f.view.draft.cate_id = [120]; await f.view.submit();
      Object.assign(f.view.draft, { type: 3, delivery_type: [] }); await f.view.submit();
      Object.assign(f.view.draft, { type: 8, freight: 2, postage: '1.001' }); await f.view.submit();
      f.view.draft.postage = '1.00'; f.view.facts.value.products[0].product_type = 1; await f.view.submit(); expect(writes(f)).toEqual([]);
    } finally { f.close(); }
  });
  it('ignores old form detail after the operator removes the form choice', async () => {
    const wait = gate(), f = await mount(config => config.url === '/form/info/50' ? wait.promise : undefined);
    try { f.view.draft.type = 7; f.view.draft.system_form_id = 50; const pending = f.view.loadFormFields(); await flush();
      f.view.draft.system_form_id = 0; await f.view.loadFormFields(); wait.resolve({ info: { value: [{ title: 'old', name: '文本框', require: true }] } });
      await pending; expect(f.view.formFields.value).toEqual([]); expect(f.view.formLoading.value).toBe(false);
    } finally { wait.resolve({ info: { value: [] } }); f.close(); }
  });
  it('discards a freight page response after Supplier session revocation', async () => {
    const wait = gate(), f = await mount(config => Number(config.params?.page) === 2 ? wait.promise : undefined);
    try { const pending = f.view.loadFreight(2); await flush(); localStorage.removeItem('supplier-token'); windowSurface.dispatchEvent(new Event('supplier-session-changed'));
      wait.resolve({ data: [{ id: 80, name: 'late' }], count: 21 }); await pending; expect(f.view.freightOptions.value).toEqual([]); expect(f.view.canManage.value).toBe(false);
    } finally { wait.resolve({ data: [], count: 0 }); f.close(); }
  });
  it('never resurrects previous facts or write authority after A to B to A', async () => {
    const wait = gate(), f = await mount(config => config.url === '/product/product/batch-selection' ? wait.promise : undefined);
    try { const pending = f.view.readSelection(); await flush(); localStorage.setItem('supplier-token', 'fixture-b'); windowSurface.dispatchEvent(new Event('supplier-session-changed'));
      localStorage.setItem('supplier-token', 'fixture-a'); windowSurface.dispatchEvent(new Event('supplier-session-changed'));
      wait.resolve(state()); await pending; expect(f.view.facts.value).toBeNull(); expect(f.view.canManage.value).toBe(false); await f.view.submit(); expect(writes(f)).toEqual([]);
    } finally { wait.resolve(state()); f.close(); }
  });
  it('keeps verified completion visible after the parent refresh clears selected rows', async () => {
    const f = await mount(); try { await f.view.readSelection(); f.view.draft.type = 3; f.view.draft.delivery_type = [2]; await f.view.submit();
      f.props.selectedIds = []; await flush(); expect(f.view.phase.value).toBe('verified'); expect(f.view.confirmation.value).toContain('一致');
    } finally { f.close(); }
  });
});
describe('explicit preview batch model uses the same four field slices', () => {
  it('preserves media, SKU, price and inventory while simulated delivery/form/freight are changed', async () => {
    const before = await preview.getProductDetail(71), selection = { all: 0, ids: [71], where: {} };
    for (const [type, data] of [[3, { delivery_type: [2] }], [7, { system_form_id: 50 }], [8, { freight: 2, postage: '1.25', temp_id: 0 }]]) {
      const facts = await preview.getSupplierProductBatchSelection(selection);
      const result = await preview.applySupplierProductBatch({ ...selection, type, data, expected_revision: facts.revision });
      expect(result.verified).toBe(true);
    }
    const after = await preview.getProductDetail(71); expect(after.attrs).toEqual(before.attrs); expect(after.slider_image).toEqual(before.slider_image);
    expect(after.freight).toBe(2); expect(after.postage).toBe('1.25');
  });
});
