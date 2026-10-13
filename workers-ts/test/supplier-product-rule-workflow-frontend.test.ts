import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../../view/supplier-ts'), require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc');
let runtime: any, pinia: any, surface: EventTarget;
beforeAll(async () => {
  const bundle = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `export {default as Page} from './src/pages/ProductSpecifications.vue';
    export {http,ApiError} from './src/api/http'; export * as rules from './src/utils/productRules'; export * as api from './src/api/productRules';
    export * as dialogs from 'element-plus'; export {AxiosError} from 'axios'; export {createPinia,disposePinia} from 'pinia'; export {createRenderer,nextTick} from 'vue';` },
    alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_API_BASE_URL': '"/supplierapi"',
      '__VUE_OPTIONS_API__': 'true', '__VUE_PROD_DEVTOOLS__': 'false', '__VUE_PROD_HYDRATION_MISMATCH_DETAILS__': 'false' }, bundle: true, write: false, platform: 'browser', format: 'esm',
    plugins: [{ name: 'actual-supplier-rule-page', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => { const descriptor = parse(readFileSync(path, 'utf8'), { filename: path }).descriptor;
        const template = compileTemplate({ source: descriptor.template.content, filename: path, id: 'supplier-rules', compilerOptions: { expressionPlugins: ['typescript'] } });
        if (template.errors.length) throw Error(String(template.errors)); return { contents: compileScript(descriptor, { id: 'supplier-rules' }).content, loader: 'ts' }; });
      builder.onResolve({ filter: /^element-plus$/ }, () => ({ path: 'dialog', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const messages=[];export const ElMessage={success:m=>messages.push(m),warning:m=>messages.push(m),error:m=>messages.push(m)};export const ElMessageBox={confirm:async()=>{}};` }));
    } }] });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
}, 30000);
beforeEach(() => { const storage = new Map<string, string>(); surface = new EventTarget(); vi.stubGlobal('window', surface);
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  localStorage.setItem('supplier-token', 'rule-session-a'); localStorage.setItem('supplier-user', '{"id":21,"supplier_id":20}');
  localStorage.setItem('supplier-permissions', '["supplier.product.view","supplier.product.manage"]'); pinia = runtime.createPinia(); runtime.dialogs.messages.length = 0; runtime.dialogs.ElMessageBox.confirm = async () => {}; });
afterEach(() => { runtime.disposePinia(pinia); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const spec = () => [{ value: '颜色', detail: ['红', '蓝'] }, { value: '尺码', detail: ['S', 'M'] }];
const row = (id = 201) => ({ id, type: 2, relation_id: 20, rule_name: '当前模板', rule_value: JSON.stringify(spec()), attr_name: '颜色,尺码', attr_value: ['红,蓝', 'S,M'], spec: spec(), revision: 'c'.repeat(64) });
const data = () => ({ count: 1, page: 0, limit: 0, revision: 'a'.repeat(64), list: [row()] });
const gate = () => { let resolve!: (value: any) => void; return { promise: new Promise<any>(done => resolve = done), resolve }; };
async function flush() { for (let i = 0; i < 35; i++) { await Promise.resolve(); await runtime.nextTick(); } }
async function mount(override: (config: any, fixture: any) => unknown = () => undefined) {
  const calls: any[] = [], fixture = { value: data(), apply(config: any) {
    const id = Number(config.url.split('/').at(-1)), body = config.data ? JSON.parse(config.data) : {};
    if (config.method === 'delete') { fixture.value.list = fixture.value.list.filter(item => item.id !== id); fixture.value.count = fixture.value.list.length; return null; }
    const current = id ? fixture.value.list.find(item => item.id === id)! : row(400); Object.assign(current, { rule_name: body.rule_name, spec: body.spec,
      rule_value: JSON.stringify(body.spec), attr_name: body.spec.map((item: any) => item.value).join(','), attr_value: body.spec.map((item: any) => item.detail.join(',')), revision: 'd'.repeat(64) });
    if (!id) fixture.value.list.push(current); fixture.value.count = fixture.value.list.length; fixture.value.revision = 'b'.repeat(64); return { id: current.id, revision: current.revision };
  } };
  runtime.http.defaults.adapter = async (config: any) => {
    calls.push(config); const custom = await override(config, fixture);
    const result = custom !== undefined ? custom : ['post', 'delete'].includes(config.method) ? fixture.apply(config)
      : config.url === '/product/product/rule' ? { ...structuredClone(fixture.value), page: config.params?.page ?? 0, limit: config.params?.limit ?? 0 }
      : { info: structuredClone(fixture.value.list.find(item => item.id === Number(config.url.split('/').at(-1)))) };
    return { config, data: { status: 200, msg: 'owned-rule-transport', data: result }, status: 200, statusText: 'fixture', headers: {} };
  };
  let view: any; const renderer = runtime.createRenderer({ createElement: () => ({ children: [] }), createText: (text: string) => ({ text }), createComment: (text: string) => ({ text }),
    insert(n: any, p: any) { n.parent = p; (p.children ??= []).push(n); }, remove() {}, parentNode: (n: any) => n.parent, nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {} });
  const app = renderer.createApp({ setup() { view = runtime.Page.setup({}, { emit() {}, expose() {} }); return () => null; } }); app.use(pinia); app.mount({ children: [] }); await flush();
  return { view, fixture, calls, close: () => app.unmount() };
}
const writes = (f: any) => f.calls.filter((config: any) => ['post', 'delete'].includes(config.method));
async function fillCreate(f: any, name = '新模板') { await f.view.openCreate(); Object.assign(f.view.form, { rule_name: name, spec: spec() }); }
describe('actual mounted Supplier rule library SFC, parsed transport and atomic application preparation', () => {
  it('loads the modern paged catalog then takes a complete bounded snapshot before create', async () => {
    const f = await mount(); try { expect(f.calls[0].params).toEqual({ rule_name: '', page: 1, limit: 20 }); await f.view.openCreate();
      expect(f.calls.at(-1).params).toEqual({}); expect(f.view.createIds.value).toEqual([201]); expect(f.view.submitDisabled.value).toBe(true); } finally { f.close(); }
  });
  it('creates with catalog revision and closes only after verifying the returned stored ID and row revision', async () => {
    const f = await mount(); try { await fillCreate(f); await f.view.submit(); expect(JSON.parse(writes(f)[0].data)).toEqual({ rule_name: '新模板', spec: spec(), expected_revision: 'a'.repeat(64) });
      expect(f.view.attempt.value).toBeNull(); expect(f.view.editing.value).toBe(false); expect(f.view.catalog.value.list.map((row: any) => row.id)).toEqual([201, 400]); } finally { f.close(); }
  });
  it('edits from the exact legacy info detail and does not mutate the catalog row before the readback', async () => {
    const f = await mount(); try { await f.view.openEdit(201); f.view.form.rule_name = '修改模板'; expect(f.view.catalog.value.list[0].rule_name).toBe('当前模板'); await f.view.submit();
      expect(JSON.parse(writes(f)[0].data)).toEqual({ rule_name: '修改模板', spec: spec(), expected_revision: 'c'.repeat(64) }); expect(f.view.catalog.value.list[0].rule_name).toBe('修改模板'); } finally { f.close(); }
  });
  it('deletes with exact revision and verifies actual absence instead of optimistic removal', async () => {
    const f = await mount(); try { await f.view.removeRule(f.view.catalog.value.list[0]); expect(writes(f)[0].method).toBe('delete'); expect(JSON.parse(writes(f)[0].data)).toEqual({ expected_revision: 'c'.repeat(64) });
      expect(f.view.attempt.value).toBeNull(); expect(f.view.catalog.value.count).toBe(0); } finally { f.close(); }
  });
  it('freezes the attempted draft and blocks duplicate POST or editor close during an outstanding write', async () => {
    const wait = gate(), f = await mount((config, fixture) => config.method === 'post' ? wait.promise.then(() => fixture.apply(config)) : undefined);
    try { await fillCreate(f); const pending = f.view.submit(); await flush(); expect(Object.isFrozen(f.view.attempt.value)).toBe(true); expect(Object.isFrozen(f.view.attempt.value.payload.spec[0].detail)).toBe(true);
      f.view.closeEditor(); await f.view.openCreate(); await f.view.submit(); expect(f.view.editing.value).toBe(true); expect(writes(f)).toHaveLength(1); wait.resolve(undefined); await pending; } finally { wait.resolve(undefined); f.close(); }
  });
  it.each(['post', 'delete'])('recovers committed unknown %s by a GET without replaying immutable attempt', async method => {
    const f = await mount((config, fixture) => { if (config.method === method) { fixture.apply(config); throw Error('unknown committed transport'); } });
    try { if (method === 'post') { await fillCreate(f); await f.view.submit(); } else await f.view.removeRule(f.view.catalog.value.list[0]);
      const original = f.view.attempt.value; expect(original).not.toBeNull(); f.view.closeEditor(); await f.view.openCreate(); await f.view.submit(); expect(f.view.attempt.value).toBe(original); expect(writes(f)).toHaveLength(1);
      await f.view.recover(); expect(f.view.attempt.value).toBeNull(); expect(writes(f)).toHaveLength(1); } finally { f.close(); }
  });
  it('does not mistake a pre-existing matching rule for an unknown create and requires explicit end after fresh facts', async () => {
    const f = await mount(config => { if (config.method === 'post') throw Error('unknown before commit'); });
    try { await fillCreate(f, '当前模板'); await f.view.submit(); f.view.finishAttempt(); expect(f.view.attempt.value).not.toBeNull(); await f.view.recover(); expect(f.view.attempt.value).not.toBeNull();
      expect(f.view.recoveryRead.value).toBe(true); f.view.finishAttempt(); expect(f.view.attempt.value).toBeNull(); expect(writes(f)).toHaveLength(1); } finally { f.close(); }
  });
  it('keeps a success response with unverified stored fields blocked and never announces success', async () => {
    const f = await mount(config => config.method === 'post' ? { id: 400, revision: 'd'.repeat(64) } : undefined);
    try { await fillCreate(f); await f.view.submit(); expect(f.view.attempt.value).not.toBeNull(); expect(f.view.notice.value).toBe(''); expect(f.view.editing.value).toBe(true); } finally { f.close(); }
  });
  it('does not clear an acknowledged write when a later verification GET definitely refuses access', async () => {
    let acknowledged = false; const f = await mount((config, fixture) => { if (config.method === 'post') { acknowledged = true; return fixture.apply(config); }
      if (acknowledged && config.method === 'get') throw new runtime.ApiError('reader access withdrawn', 400011); });
    try { await fillCreate(f); await f.view.submit(); expect(f.view.attempt.value).not.toBeNull(); await f.view.submit(); expect(writes(f)).toHaveLength(1); } finally { f.close(); }
  });
  it.each(['legacy', 'axios'])('permits explicit draft correction after genuine %s atomic write refusal', async mode => {
    let refused = false; const f = await mount((config, fixture) => { if (config.method !== 'post' || refused) return; refused = true;
      if (mode === 'legacy') throw new runtime.ApiError('duplicate name', 400); throw new runtime.AxiosError('conflict', 'ERR_BAD_REQUEST', config, undefined, { status: 409, data: { status: 409, msg: 'atomic refusal' }, config, headers: {}, statusText: 'Conflict' }); });
    try { await fillCreate(f); await f.view.submit(); expect(f.view.attempt.value).toBeNull(); expect(f.view.editing.value).toBe(true); f.view.form.rule_name = '更正模板'; await f.view.submit();
      expect(f.view.attempt.value).toBeNull(); expect(writes(f)).toHaveLength(2); expect(f.view.catalog.value.list.at(-1).rule_name).toBe('更正模板'); } finally { f.close(); }
  });
  it('keeps mismatched Axios response status unknown across close and reopen without a second POST', async () => {
    const f = await mount(config => { if (config.method === 'post') throw new runtime.AxiosError('mismatch', 'ERR_BAD_REQUEST', config, undefined, { status: 409, data: { status: 200, msg: 'inconsistent' }, config, headers: {}, statusText: 'Conflict' }); });
    try { await fillCreate(f); await f.view.submit(); f.view.closeEditor(); await f.view.openCreate(); await f.view.submit(); expect(f.view.attempt.value).not.toBeNull(); expect(writes(f)).toHaveLength(1); } finally { f.close(); }
  });
  it('rejects stale detail and list responses after the filter generation changes and accepts the newest page', async () => {
    const wait = gate(); let delayed = true; const f = await mount(config => config.url === '/product/product/rule/201' && delayed ? wait.promise : undefined);
    try { const pending = f.view.openEdit(201); await flush(); f.view.filter.rule_name = '其他'; await flush(); wait.resolve({ info: row() }); await pending; expect(f.view.editing.value).toBe(false);
      f.view.filter.page = 2; await f.view.load(); expect(f.view.catalog.value.page).toBe(2); delayed = false;
    } finally { wait.resolve({ info: row() }); f.close(); }
  });
  it('does not write after a delete confirmation changes filter context', async () => {
    const wait = gate(), f = await mount(); runtime.dialogs.ElMessageBox.confirm = () => wait.promise;
    try { const pending = f.view.removeRule(f.view.catalog.value.list[0]); await flush(); f.view.filter.rule_name = 'other'; wait.resolve(undefined); await pending; expect(writes(f)).toEqual([]); } finally { wait.resolve(undefined); f.close(); }
  });
  it('invalidates an outstanding old-owner write result when the session token changes', async () => {
    const wait = gate(), f = await mount((config, fixture) => config.method === 'post' ? wait.promise.then(() => fixture.apply(config)) : undefined);
    try { await fillCreate(f); const pending = f.view.submit(); await flush(); localStorage.setItem('supplier-token', 'new-owner'); surface.dispatchEvent(new Event('supplier-session-changed'));
      wait.resolve(undefined); await pending; expect(f.view.catalog.value).toBeNull(); expect(f.view.editing.value).toBe(false); expect(f.view.notice.value).toBe(''); } finally { wait.resolve(undefined); f.close(); }
  });
  it('clears management draft on real permission withdrawal and keeps read-only handlers unable to write', async () => {
    const f = await mount(); try { await f.view.openEdit(201); localStorage.setItem('supplier-permissions', '["supplier.product.view"]'); surface.dispatchEvent(new Event('supplier-session-changed')); await flush();
      expect(f.view.canManage.value).toBe(false); expect(f.view.editing.value).toBe(false); await f.view.submit(); expect(writes(f)).toEqual([]); } finally { f.close(); }
    localStorage.setItem('supplier-token', 'reader-new'); const read = await mount(); try { await read.view.openCreate(); await read.view.openEdit(201); await read.view.removeRule(read.view.catalog.value.list[0]); await read.view.submit(); expect(writes(read)).toEqual([]); } finally { read.close(); }
  });
  it('prepares normal copied dimensions/SKU details without changing the source arrays', () => {
    const input = spec(), before = structuredClone(input), result = runtime.rules.prepareSupplierProductRuleApplication(input);
    expect(result).toEqual({ items: before, details: [{ 颜色: '红', 尺码: 'S' }, { 颜色: '红', 尺码: 'M' }, { 颜色: '蓝', 尺码: 'S' }, { 颜色: '蓝', 尺码: 'M' }] });
    result.items[0].detail.push('绿'); expect(input).toEqual(before);
  });
  it('rejects 15×15 overflow before mutating a populated product draft and rejects ambiguous SKU delimiters', () => {
    const draft = { items: spec(), attrs: [{ suk: '红,S', price: '9.99', stock: 10 }] }, before = structuredClone(draft);
    expect(() => runtime.rules.prepareSupplierProductRuleApplication([{ value: 'A', detail: Array.from({ length: 15 }, (_, i) => `${i}`) }, { value: 'B', detail: Array.from({ length: 15 }, (_, i) => `${i}`) }])).toThrow(); expect(draft).toEqual(before);
    expect(() => runtime.rules.prepareSupplierProductRuleApplication([{ value: 'A', detail: ['a,b', 'a'] }, { value: 'B', detail: ['c', 'b,c'] }])).toThrow();
  });
  it('rejects malformed owner, count, revision and derived DTO facts before exposing them to the editor', () => {
    for (const value of [{ ...data(), count: 2 }, { ...data(), list: [{ ...row(), type: 0 }] }, { ...data(), list: [{ ...row(), attr_name: 'fake' }] }]) expect(() => runtime.rules.parseSupplierProductRuleCatalog(value)).toThrow();
    expect(() => runtime.rules.parseSupplierProductRuleReceipt({ id: 400, revision: 'forged' })).toThrow();
  });
});
