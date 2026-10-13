import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../../view/supplier-ts'), require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc');
let runtime: any, pinia: any, surface: EventTarget;
beforeAll(async () => {
  const bundle = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `export {default as Page} from './src/pages/ProductLabels.vue';
    export {http} from './src/api/http'; export * as labels from './src/utils/productLabels'; export * as dialogs from 'element-plus';
    export {createPinia,disposePinia} from 'pinia'; export {createRenderer,nextTick} from 'vue';` },
    alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_API_BASE_URL': '"/supplierapi"',
      '__VUE_OPTIONS_API__': 'true', '__VUE_PROD_DEVTOOLS__': 'false', '__VUE_PROD_HYDRATION_MISMATCH_DETAILS__': 'false' },
    bundle: true, write: false, platform: 'browser', format: 'esm', plugins: [{ name: 'actual-supplier-label-page', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => {
        const descriptor = parse(readFileSync(path, 'utf8'), { filename: path }).descriptor;
        const template = compileTemplate({ source: descriptor.template.content, filename: path, id: 'supplier-labels', compilerOptions: { expressionPlugins: ['typescript'] } });
        if (template.errors.length) throw Error(String(template.errors)); return { contents: compileScript(descriptor, { id: 'supplier-labels' }).content, loader: 'ts' };
      });
      builder.onResolve({ filter: /^element-plus$/ }, () => ({ path: 'dialog', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const messages=[];export const ElMessage={success:m=>messages.push(m),warning:m=>messages.push(m),error:m=>messages.push(m)};
        export const ElMessageBox={confirm:async()=>{}};` }));
    } }] });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
}, 30000);
beforeEach(() => {
  const storage = new Map<string, string>(); surface = new EventTarget(); vi.stubGlobal('window', surface);
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  localStorage.setItem('supplier-token', 'label-session-a'); localStorage.setItem('supplier-user', '{"id":21,"supplier_id":20}');
  localStorage.setItem('supplier-permissions', '["supplier.product.view","supplier.product.manage"]'); pinia = runtime.createPinia();
  runtime.dialogs.messages.length = 0; runtime.dialogs.ElMessageBox.confirm = async () => {};
});
afterEach(() => { runtime.disposePinia(pinia); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const row = (id = 201) => ({ id, type: 2, relation_id: 20, label_cate: 10, label_name: '当前标签', style_type: 1, color: '', bg_color: '', border_color: '', icon: '',
  is_show: 1, status: 1, sort: 0, add_time: '2026-10-13 08:00:00', group_name: '平台组', group_valid: true, selectable: true, revision: 'c'.repeat(64) });
const data = () => ({ count: 1, revision: 'a'.repeat(64), groups: [{ id: 10, type: 0, relation_id: 0, name: '平台组', is_show: 1 },
  { id: 20, type: 2, relation_id: 20, name: '原有自有组', is_show: 1 }], list: [row()] });
const form = { title: '添加商品标签', method: 'POST', action: 'product/label/0', rules: [
  { type: 'select', field: 'label_cate', title: '标签分组', value: '', options: [{ label: '平台组', value: 10 }] },
  { type: 'input', field: 'label_name', title: '标签名称', value: '', props: { maxlength: 20 } },
] };
const gate = () => { let resolve!: (value: any) => void; return { promise: new Promise<any>(done => resolve = done), resolve }; };
async function flush() { for (let i = 0; i < 35; i++) { await Promise.resolve(); await runtime.nextTick(); } }
async function mount(override: (config: any, fixture: any) => unknown = () => undefined) {
  const calls: any[] = [], fixture = { value: data(), apply(config: any) {
    const id = Number(config.url.split('/').at(-1)), body = config.data ? JSON.parse(config.data) : {};
    if (config.method === 'delete') { fixture.value.list = fixture.value.list.filter(item => item.id !== id); fixture.value.count = fixture.value.list.length; return null; }
    const current = id ? fixture.value.list.find(item => item.id === id)! : row(400);
    Object.assign(current, { label_cate: body.label_cate, label_name: body.label_name, revision: 'd'.repeat(64), group_name: body.label_cate === 10 ? '平台组' : '原有自有组' });
    if (!id) fixture.value.list.push(current); fixture.value.count = fixture.value.list.length; fixture.value.revision = 'b'.repeat(64);
    return { id: current.id, revision: current.revision };
  } };
  runtime.http.defaults.adapter = async (config: any) => {
    calls.push(config); const custom = await override(config, fixture);
    const result = custom !== undefined ? custom : config.url === '/product/label/catalog' ? structuredClone(fixture.value)
      : config.url === '/product/label/form' ? structuredClone(form) : fixture.apply(config);
    return { config, data: { status: 200, msg: 'owned-transport', data: result }, status: 200, statusText: 'fixture', headers: {} };
  };
  let view: any; const renderer = runtime.createRenderer({ createElement: () => ({ children: [] }), createText: (text: string) => ({ text }),
    createComment: (text: string) => ({ text }), insert(n: any, p: any) { n.parent = p; (p.children ??= []).push(n); }, remove() {},
    parentNode: (n: any) => n.parent, nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {} });
  const app = renderer.createApp({ setup() { view = runtime.Page.setup({}, { emit() {}, expose() {} }); return () => null; } });
  app.use(pinia); app.mount({ children: [] }); await flush();
  return { view, fixture, calls, close: () => app.unmount() };
}
const writes = (f: any) => f.calls.filter((config: any) => ['post', 'delete'].includes(config.method));

describe('actual mounted Supplier label page, DTOs and HTTP state', () => {
  it('loads the current owner catalog and exact legacy form before accepting a create', async () => {
    const f = await mount(); try { expect(f.view.rows.value.map((item: any) => item.id)).toEqual([201]); await f.view.openCreate();
      expect(f.view.groupOptions.value).toEqual([{ label: '平台组', value: 10 }]); expect(f.view.submitDisabled.value).toBe(true);
    } finally { f.close(); }
  });
  it('creates with the fresh catalog revision and rereads the returned label before closing', async () => {
    const f = await mount(); try { await f.view.openCreate(); Object.assign(f.view.draft, { group: 10, name: '新增标签' }); await f.view.save();
      expect(JSON.parse(writes(f)[0].data)).toEqual({ label_cate: 10, label_name: '新增标签', expected_revision: 'a'.repeat(64) });
      expect(f.view.attempt.value).toBeNull(); expect(f.view.editing.value).toBe(false); expect(f.view.rows.value.map((item: any) => item.id)).toEqual([201, 400]);
    } finally { f.close(); }
  });
  it('edits only cate/name with the row revision and leaves display and status facts untouched', async () => {
    const f = await mount(); try { f.view.openEdit(f.view.catalog.value.list[0]); Object.assign(f.view.draft, { group: 20, name: '编辑标签' }); await f.view.save();
      expect(JSON.parse(writes(f)[0].data)).toEqual({ label_cate: 20, label_name: '编辑标签', expected_revision: 'c'.repeat(64) });
      expect(f.view.catalog.value.list[0]).toMatchObject({ label_name: '编辑标签', label_cate: 20, status: 1, style_type: 1, sort: 0 });
    } finally { f.close(); }
  });
  it('deletes with a known row revision and rereads absence rather than removing optimistically', async () => {
    const f = await mount(); try { await f.view.remove(f.view.catalog.value.list[0]); expect(writes(f)[0].method).toBe('delete');
      expect(JSON.parse(writes(f)[0].data)).toEqual({ expected_revision: 'c'.repeat(64) }); expect(f.view.catalog.value.list).toEqual([]); expect(f.view.attempt.value).toBeNull();
    } finally { f.close(); }
  });
  it('blocks duplicate writes while POST is in flight', async () => {
    const wait = gate(), f = await mount((config, fixture) => config.method === 'post' ? wait.promise.then(() => fixture.apply(config)) : undefined);
    try { await f.view.openCreate(); Object.assign(f.view.draft, { group: 10, name: '新标签' }); const pending = f.view.save(); await flush();
      await f.view.save(); expect(writes(f)).toHaveLength(1); expect(f.view.busy.value).toBe(true); wait.resolve(undefined); await pending;
      expect(f.view.attempt.value).toBeNull();
    } finally { wait.resolve(undefined); f.close(); }
  });
  it.each(['post', 'delete'])('recovers a committed unknown %s by reading current facts without replaying it', async method => {
    const f = await mount((config, fixture) => { if (config.method === method) { fixture.apply(config); throw Error('network result unknown'); } });
    try { if (method === 'post') { await f.view.openCreate(); Object.assign(f.view.draft, { group: 10, name: '未知后新增' }); await f.view.save(); }
      else await f.view.remove(f.view.catalog.value.list[0]);
      expect(f.view.attempt.value).not.toBeNull(); await f.view.save(); expect(writes(f)).toHaveLength(1);
      await f.view.recover(); expect(f.view.attempt.value).toBeNull(); expect(writes(f)).toHaveLength(1); expect(f.view.notice.value).toContain('核对');
    } finally { f.close(); }
  });
  it('keeps an unverified unknown result blocked until an actual reread and explicit end-of-attempt', async () => {
    const f = await mount(config => { if (config.method === 'post') throw Error('unknown before commit'); });
    try { await f.view.openCreate(); Object.assign(f.view.draft, { group: 10, name: '没有提交' }); await f.view.save(); await f.view.recover();
      expect(f.view.attempt.value).not.toBeNull(); expect(f.view.recoveryRead.value).toBe(true); expect(writes(f)).toHaveLength(1);
      f.view.finishAttempt(); expect(f.view.attempt.value).toBeNull(); expect(f.view.editing.value).toBe(false);
    } finally { f.close(); }
  });
  it('does not mistake an already-existing matching label for a successful unknown create', async () => {
    const f = await mount(config => { if (config.method === 'post') throw Error('unknown rejected duplicate'); });
    try { await f.view.openCreate(); Object.assign(f.view.draft, { group: 10, name: '当前标签' }); await f.view.save(); await f.view.recover();
      expect(f.view.attempt.value).not.toBeNull(); expect(writes(f)).toHaveLength(1);
    } finally { f.close(); }
  });
  it('rejects a success response whose reread label fields or receipt revision cannot be verified', async () => {
    const f = await mount(config => config.method === 'post' ? { id: 400, revision: 'd'.repeat(64) } : undefined);
    try { await f.view.openCreate(); Object.assign(f.view.draft, { group: 10, name: '不伪造成功' }); await f.view.save();
      expect(f.view.attempt.value).not.toBeNull(); expect(f.view.editing.value).toBe(true); expect(f.view.notice.value).toBe('');
    } finally { f.close(); }
  });
  it('invalidates pending results when the Supplier account changes during the request', async () => {
    const wait = gate(), f = await mount((config, fixture) => config.method === 'post' ? wait.promise.then(() => fixture.apply(config)) : undefined);
    try { await f.view.openCreate(); Object.assign(f.view.draft, { group: 10, name: '旧身份写' }); const pending = f.view.save(); await flush();
      localStorage.setItem('supplier-token', 'new-account'); surface.dispatchEvent(new Event('supplier-session-changed')); wait.resolve(undefined); await pending;
      expect(f.view.catalog.value).toBeNull(); expect(f.view.editing.value).toBe(false); expect(f.view.notice.value).toBe('');
    } finally { wait.resolve(undefined); f.close(); }
  });
  it('does not send a delete confirmation after the visible filter generation changed', async () => {
    const wait = gate(), f = await mount(); runtime.dialogs.ElMessageBox.confirm = () => wait.promise;
    try { const pending = f.view.remove(f.view.catalog.value.list[0]); await flush(); f.view.keyword.value = '其他'; await flush(); wait.resolve(undefined); await pending; expect(writes(f)).toEqual([]); }
    finally { wait.resolve(undefined); f.close(); }
  });
  it('clears a management draft when permissions are revoked while the same account token remains', async () => {
    const f = await mount(); try { f.view.openEdit(f.view.catalog.value.list[0]);
      localStorage.setItem('supplier-permissions', '["supplier.product.view"]'); surface.dispatchEvent(new Event('supplier-session-changed')); await flush();
      expect(f.view.canManage.value).toBe(false); expect(f.view.editing.value).toBe(false); expect(f.view.catalog.value).toBeNull();
      await f.view.save(); expect(writes(f)).toEqual([]);
    } finally { f.close(); }
  });
  it('keeps viewers read-only through the actual handlers even if a write method is invoked', async () => {
    localStorage.setItem('supplier-permissions', '["supplier.product.view"]'); const f = await mount();
    try { expect(f.view.canManage.value).toBe(false); await f.view.openCreate(); f.view.openEdit(f.view.catalog.value.list[0]); await f.view.remove(f.view.catalog.value.list[0]); await f.view.save();
      expect(f.view.editing.value).toBe(false); expect(writes(f)).toEqual([]);
    } finally { f.close(); }
  });
  it('rejects malformed form actions, count/owner inconsistencies and forged response versions before use', () => {
    for (const value of [{ ...form, method: 'DELETE' }, { ...form, action: 'other/path' }]) expect(() => runtime.labels.parseSupplierProductLabelForm(value)).toThrow();
    expect(() => runtime.labels.parseSupplierProductLabelCatalog({ ...data(), count: 2 })).toThrow();
    expect(() => runtime.labels.parseSupplierProductLabelCatalog({ ...data(), list: [{ ...row(), type: 0 }] })).toThrow();
    expect(() => runtime.labels.parseSupplierProductLabelReceipt({ id: 400, revision: 'forged' })).toThrow();
  });
});
