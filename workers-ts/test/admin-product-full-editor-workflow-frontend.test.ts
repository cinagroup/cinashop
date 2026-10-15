import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../view/admin-ts');
const require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript } = require('@vue/compiler-sfc');
const { compile } = require('@vue/compiler-dom');
let runtime: any, browser: EventTarget, storage: Map<string, string>, sessionValues: Map<string, string>;
const closes: Array<() => void> = [];
beforeAll(async () => {
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { pathname: '/product/create', search: '', href: '' } }));
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  const result = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    export { default as Page } from './src/pages/product/ProductForm.vue'; export { default as request } from './src/utils/request';
    export * from './src/pages/product/productEditorModel'; export * as vue from 'vue'; export { createRenderer, nextTick } from 'vue';
    export { state as routing } from 'vue-router'; export { state as messages } from 'element-plus';` },
    alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false' }, bundle: true, write: false, platform: 'browser', format: 'esm',
    plugins: [{ name: 'full-product-editor-page', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({ contents: compileScript(parse(readFileSync(path, 'utf8'), { filename: path }).descriptor, { id: 'full-product-editor' }).content, loader: 'ts' }));
      builder.onResolve({ filter: /^(element-plus|vue-router)$/ }, ({ path }) => ({ path, namespace: 'fixture' }));
      builder.onLoad({ filter: /^element-plus$/, namespace: 'fixture' }, () => ({ contents: `
        export const state = { errors: [], warnings: [], success: [], prompt: async () => ({ value: '合成操作原因' }) };
        export const ElMessage = { error: value => state.errors.push(value), warning: value => state.warnings.push(value), success: value => state.success.push(value) };
        export const ElMessageBox = { prompt: (...args) => state.prompt(...args) };` }));
      builder.onLoad({ filter: /^vue-router$/, namespace: 'fixture' }, () => ({ contents: `
        import { reactive } from 'vue'; export const state = { route: reactive({ params: {}, query: {} }), paths: [] };
        const router = { push: async path => { state.paths.push(path); }, replace: async path => { state.paths.push(path); } };
        export const useRoute = () => state.route; export const useRouter = () => router;`, resolveDir: root }));
    } }],
  });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
});
beforeEach(() => {
  storage = new Map(); sessionValues = new Map(); browser = Object.assign(new EventTarget(), { location: { pathname: '/product/create', search: '', href: '' } });
  vi.stubGlobal('window', browser); vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => sessionValues.get(key) ?? null, setItem: (key: string, value: string) => sessionValues.set(key, value), removeItem: (key: string) => sessionValues.delete(key) });
  Object.assign(runtime.messages, { errors: [], warnings: [], success: [], prompt: async () => ({ value: '合成操作原因' }) });
  runtime.routing.paths = []; runtime.routing.route.params = {}; runtime.routing.route.query = {};
});
afterEach(() => { for (const close of closes.splice(0)) close(); vi.unstubAllGlobals(); });
function login(id = 20, permissions = ['product.view', 'product.manage']) { storage.set('admin_token', `product-token-${id}`); storage.set('admin_session', JSON.stringify({ userInfo: { id, account: `operator-${id}`, level: 1, roles: '2' }, menus: [], uniqueAuth: permissions })); }
const flush = async () => { for (let i = 0; i < 8; i++) { await new Promise(done => setTimeout(done, 1)); await runtime.nextTick(); } };
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const parsedBody = (config: any) => typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
const optionSet = { categories: [{ id: 11, name: '一级分类' }, { id: 12, name: '二级分类' }], brands: [{ id: 21, name: '品牌一' }, { id: 22, name: '品牌二' }], product_labels: [], user_labels: [], gift_coupons: [], system_forms: [], shipping_templates: [], ensures: [], parameter_templates: [], sku_rule_templates: [] };
function completeModel() { const m = runtime.newProductEditor(); m.store_name = '合成完整商品'; m.cate_id = [11, 12]; m.brand_id = [21, 22]; m.slider_image = ['/api/assets/31']; m.attrs[0].price = 19; m.attrs[0].stock = 4; return m; }
function productDetail(id = 19) { const p = runtime.toLegacySave(completeModel()); return { productInfo: { ...p, id, type: 0, relation_id: 0, cate_id: p.cate_id.map(String), attr: { ...p.attrs[0], id: id * 10, unique: `sku${id}001`, suk: '默认' }, attrs: [], label_id: [], store_label_id: [], coupons: [], recommend_list: [] }, tempList: [], cateList: [], editor: { contract_version: 1, erp_open: false, stored_custom_form: [], retired_attrs: [], description_preview: '<p>已存预览</p>' } }; }
function standard(config: any): any {
  if (config.url === '/product/editor/options') return structuredClone(optionSet);
  if (config.url === '/unit') return { list: [{ id: 1, name: '件' }], count: 1 };
  if (config.url.includes('/category/cascader')) return [{ value: 11, label: '一级分类', pid: 0, children: [{ value: 12, label: '二级分类', pid: 11 }] }];
  if (config.url.includes('/brand/cascader')) return [{ value: 21, label: '品牌一', pid: 0 }, { value: 22, label: '品牌二', pid: 0 }];
  if (config.url === '/api/admin/erp/config') return { open_erp: false };
  if (config.url === '/product/cache') return config.method === 'get' ? { info: [] } : config.method === 'post' ? { info: parsedBody(config) } : null;
  if (config.url.startsWith('/product/editor/detail/')) return productDetail(Number(config.url.split('/').at(-1)));
  if (config.url.startsWith('/product/editor/save/')) { const body = parsedBody(config), target = Number(config.url.split('/').at(-1)); return { operation_id: body.operation_id, actor_id: 20, requested_id: target, state: 'committed', result: { id: target || 71, created: target === 0 } }; }
  if (config.url.startsWith('/product/editor/operations/')) { const resolve = config.url.endsWith('/resolve'); return { operation_id: config.url.split('/')[4], actor_id: 20, requested_id: resolve ? parsedBody(config).requested_id : null, state: resolve ? 'not_applied' : 'unknown', result: null }; }
  throw Error(`Unhandled fixture ${config.method} ${config.url}`);
}
async function mount(id?: string, override?: (config: any) => unknown, permissions?: string[]) {
  if (!storage.get('admin_token')) login(20, permissions); runtime.routing.route.params = id === undefined ? {} : { id };
  const calls: any[] = []; runtime.request.defaults.adapter = async (config: any) => { calls.push(config); const value = override ? await override(config) : undefined; const data = value === undefined ? standard(config) : value; return { config, data: data?.__envelope ?? { status: 200, msg: 'ok', data }, status: 200, statusText: 'fixture', headers: {} }; };
  let view: any; const renderer = runtime.createRenderer({ createElement: () => ({ children: [] }), createText: (text: string) => ({ text }), createComment: (text: string) => ({ text }), insert(node: any, parent: any) { node.parent = parent; (parent.children ??= []).push(node); }, remove() {}, parentNode: (node: any) => node.parent, nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {} });
  const app = renderer.createApp({ setup(props: unknown, context: unknown) { view = runtime.Page.setup(props, context); return () => null; } }); app.mount({ children: [] }); let closed = false; const close = () => { if (!closed) { closed = true; app.unmount(); } }; closes.push(close); await flush(); return { view, calls, close };
}
const saves = (calls: any[]) => calls.filter(call => call.url.startsWith('/product/editor/save/'));
function renderNodes(view: any): any[] {
  const file = resolve(root, 'src/pages/product/ProductForm.vue'), descriptor = parse(readFileSync(file, 'utf8'), { filename: file }).descriptor;
  const components = new Map<string, object>(), facade = new Proxy(runtime.vue, { get: (target, key) => key === 'resolveComponent' ? (name: string) => { if (!components.has(name)) components.set(name, { name }); return components.get(name); } : key === 'resolveDirective' ? () => undefined : key === 'withDirectives' ? (vnode: unknown) => vnode : target[key] });
  const render = new Function('Vue', compile(descriptor.template.content, { mode: 'function', prefixIdentifiers: true }).code)(facade);
  // Match Vue's public render proxy in both directions: templates read an
  // unwrapped ref and assignment updates .value rather than replacing the ref.
  const context = new Proxy(view, {
    get: (target, key) => runtime.vue.unref(target[key]),
    set(target, key, value) { if (runtime.vue.isRef(target[key])) target[key].value = value; else target[key] = value; return true; },
  }), nodes: any[] = [];
  const collect = (value: any) => { if (!value || typeof value !== 'object') return; if (Array.isArray(value)) return value.forEach(collect); nodes.push(value); if (value.children && typeof value.children === 'object' && !Array.isArray(value.children)) for (const slot of Object.values(value.children)) { if (typeof slot === 'function') collect(slot({ row: view.form.attrs[0] })); } else collect(value.children); };
  collect(render(context, [])); return nodes;
}

it('loads the complete editor contract, preserves multi-selection, renders all six steps and exercises real template navigation', async () => {
  const h = await mount('19'); expect(h.view.loaded.value).toBe(true); expect(h.view.form.cate_id).toEqual([11, 12]); expect(h.view.form.brand_id).toEqual([21, 22]); expect(h.view.form.attrs[0].unique).toBe('sku19001');
  expect(h.calls.some(c => c.url === '/product/editor/detail/19')).toBe(true); expect(h.calls.some(c => c.url === '/product/detail/19')).toBe(false);
  const nodes = renderNodes(h.view); expect(nodes.filter(n => n.type?.name === 'el-step').map(n => n.props.title)).toEqual(['基础信息', '规格库存', '商品详情', '物流设置', '营销设置', '其他设置']);
  const text = (value: any): string => typeof value === 'string' ? value : Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.children) : '';
  const next = nodes.find(n => n.type?.name === 'el-button' && typeof n.children?.default === 'function' && text(n.children.default()).includes('下一步'));
  expect(next).toBeTruthy(); next.props.onClick(); expect(runtime.vue.isRef(h.view.step)).toBe(true); expect(h.view.step.value).toBe(1);
  expect(nodes.some(n => n.props?.['aria-label'] === '商品详情')).toBe(true);
});
it('posts exactly one 59-field request after a full matching draft, then clears the draft and navigates to the committed ID', async () => {
  const h = await mount(); Object.assign(h.view.form, completeModel()); h.view.syncCustomForm(); await h.view.submit();
  const writes = saves(h.calls); expect(writes).toHaveLength(1); const body = parsedBody(writes[0]); expect(Object.keys(body.product).sort()).toEqual([...runtime.PRODUCT_EDITOR_FIELDS].sort());
  expect(body.product.cate_id).toEqual([11, 12]); expect(body.product.brand_id).toEqual([21, 22]); expect(body.product.attrs[0].pic).toBe('/api/assets/31');
  const draftIndex = h.calls.findIndex(c => c.url === '/product/cache' && c.method === 'post'), saveIndex = h.calls.indexOf(writes[0]), deleteIndex = h.calls.findIndex(c => c.url === '/product/cache' && c.method === 'delete');
  expect(draftIndex).toBeLessThan(saveIndex); expect(deleteIndex).toBeGreaterThan(saveIndex); expect(parsedBody(h.calls[draftIndex]).editor_pending.operation_id).toBe(body.operation_id); expect(runtime.routing.paths).toContain('/product/edit/71'); expect(h.view.pending.value).toBeNull();
});
it.each(['timeout', 'malformed', 'business-refusal'])('freezes an unknown %s save, retains its key and does not automatically replay on query', async mode => {
  const h = await mount(undefined, config => { if (config.url.startsWith('/product/editor/save/')) { if (mode === 'timeout') throw Error('response lost after commit'); if (mode === 'malformed') return { id: 71 }; return { __envelope: { status: 400400, msg: '合成拒绝', data: null } }; } });
  Object.assign(h.view.form, completeModel()); h.view.syncCustomForm(); await h.view.submit(); const operation = { ...h.view.pending.value };
  expect(operation.operation_id).toMatch(/^[a-f0-9-]{36}$/); expect(h.view.locked.value).toBe(true); expect(sessionValues.get('admin_full_product_pending_v1:20')).toContain(operation.operation_id);
  await h.view.submit(); await h.view.recover(false); expect(saves(h.calls)).toHaveLength(1); expect(h.view.pending.value.operation_id).toBe(operation.operation_id); expect(h.calls.some(c => c.url === '/product/cache' && c.method === 'delete')).toBe(false);
});
it('only permits a new operation key after an explicit not_applied tombstone and a fresh save click', async () => {
  let attempts = 0; const h = await mount(undefined, config => { if (config.url.startsWith('/product/editor/save/') && ++attempts === 1) throw Error('transport uncertainty'); });
  Object.assign(h.view.form, completeModel()); h.view.syncCustomForm(); await h.view.submit(); const first = h.view.pending.value.operation_id; await h.view.recover(true);
  expect(h.view.pending.value).toBeNull(); expect(saves(h.calls)).toHaveLength(1); await h.view.submit(); expect(saves(h.calls)).toHaveLength(2); expect(parsedBody(saves(h.calls)[1]).operation_id).not.toBe(first);
});
it('recovers the original committed result after response loss without repeating the save', async () => {
  let committed: any; const h = await mount(undefined, config => { if (config.url.startsWith('/product/editor/save/')) { committed = { operation_id: parsedBody(config).operation_id, actor_id: 20, requested_id: 0, state: 'committed', result: { id: 79, created: true } }; throw Error('response dropped'); } if (config.url.startsWith('/product/editor/operations/')) return committed; });
  Object.assign(h.view.form, completeModel()); h.view.syncCustomForm(); await h.view.submit(); await h.view.recover(false);
  expect(saves(h.calls)).toHaveLength(1); expect(h.view.pending.value).toBeNull(); expect(runtime.routing.paths).toContain('/product/edit/79');
});
it('does not start a product mutation if the prerequisite draft is refused or silently changed', async () => {
  for (const failure of ['refusal', 'changed']) {
    const h = await mount(undefined, config => { if (config.url === '/product/cache' && config.method === 'post') { if (failure === 'refusal') throw Error('draft full'); return { info: { ...parsedBody(config), description: 'silently truncated' } }; } });
    Object.assign(h.view.form, completeModel()); h.view.syncCustomForm(); await h.view.submit(); expect(saves(h.calls)).toHaveLength(0); expect(h.view.pending.value).toBeNull(); expect(h.view.form.store_name).toBe('合成完整商品'); h.close();
  }
});
it('restores the full server draft after its response is lost before any product request was sent', async () => {
  let persisted: any;
  const first = await mount(undefined, config => {
    if (config.url === '/product/cache' && config.method === 'post') { persisted = parsedBody(config); throw Error('draft committed but response lost'); }
  });
  Object.assign(first.view.form, completeModel()); first.view.form.description = '<p>必须恢复的完整草稿</p>'; first.view.syncCustomForm();
  await first.view.submit(); expect(saves(first.calls)).toHaveLength(0); expect(first.view.pending.value).toBeNull();
  expect(sessionValues.has('admin_full_product_resolved_v1:20')).toBe(false); expect(persisted.editor_pending).toBeTruthy(); first.close();
  const refreshed = await mount(undefined, config => config.url === '/product/cache' && config.method === 'get' ? { info: persisted } : undefined);
  expect(refreshed.view.form.description).toBe('<p>必须恢复的完整草稿</p>'); expect(refreshed.view.form.cate_id).toEqual([11, 12]);
  expect(refreshed.view.pending.value.operation_id).toBe(persisted.editor_pending.operation_id); expect(saves(refreshed.calls)).toHaveLength(0);
  expect(refreshed.calls.some(c => c.url.includes('/operations/'))).toBe(true);
});
it('drains an earlier draft before deletion and prevents manual writes from resurrecting it during deletion', async () => {
  const draft = deferred<unknown>(), deletion = deferred<unknown>(); let firstBody: any;
  const h = await mount(undefined, config => { if (config.url === '/product/cache' && config.method === 'post') { firstBody = parsedBody(config); return draft.promise; } if (config.url === '/product/cache' && config.method === 'delete') return deletion.promise; });
  Object.assign(h.view.form, completeModel()); const save = h.view.saveDraftNow(); await flush(); const clearing = h.view.clearDraft(); await flush();
  expect(h.calls.filter(c => c.method === 'delete')).toHaveLength(0); expect(h.view.locked.value).toBe(true); await h.view.saveDraftNow(); expect(h.calls.filter(c => c.url === '/product/cache' && c.method === 'post')).toHaveLength(1);
  draft.resolve({ info: firstBody }); await save; await flush(); expect(h.calls.filter(c => c.method === 'delete')).toHaveLength(1); deletion.resolve(null); await clearing; expect(h.view.draftDeleting.value).toBe(false);
});
it('restores a matching full draft and pending operation on refresh, then queries without reissuing the mutation', async () => {
  const operation = { operation_id: '9d2a99ec-3798-4fbc-822f-33143bdb70e8', actor_id: 20, requested_id: 0 }, m = completeModel(); m.description = '恢复的完整详情';
  const draft = runtime.makeEditorDraft(m, 0, operation); sessionValues.set('admin_full_product_pending_v1:20', JSON.stringify(operation));
  const h = await mount(undefined, config => config.url === '/product/cache' && config.method === 'get' ? { info: draft } : undefined);
  expect(h.view.form.description).toBe('恢复的完整详情'); expect(h.view.pending.value).toEqual(operation); expect(h.view.locked.value).toBe(true); expect(saves(h.calls)).toHaveLength(0); expect(h.calls.some(c => c.url.includes('/operations/'))).toBe(true);
});
it('does not delete a replacement account draft when the original clear action is waiting on an old write', async () => {
  const earlier = deferred<unknown>(); let body: any;
  const h = await mount(undefined, config => { if (config.url === '/product/cache' && config.method === 'post') { body = parsedBody(config); return earlier.promise; } });
  Object.assign(h.view.form, completeModel()); const writing = h.view.saveDraftNow(); await flush(); const clearing = h.view.clearDraft();
  login(21); browser.dispatchEvent(new Event('admin-session-changed')); const reloading = h.view.initialize(); await flush();
  earlier.resolve({ info: body }); await writing; await clearing; await reloading;
  expect(h.calls.some(c => c.url === '/product/cache' && c.method === 'delete')).toBe(false);
});
it('fails closed on malformed or failed complete detail, invalid route IDs and copy context', async () => {
  for (const id of ['19', '01']) {
    const h = await mount(id, config => { if (config.url.includes('/detail/')) throw Error('no complete product'); }); expect(h.view.loaded.value).toBe(false); await h.view.submit(); expect(saves(h.calls)).toHaveLength(0); h.close();
  }
  runtime.routing.route.query = { copy: '19' }; const h = await mount(); expect(h.view.loaded.value).toBe(false); expect(h.view.loadError.value).toContain('可信复制');
});
it('clears fixed content and late reads across account changes, retains the original recovery marker and ignores late success', async () => {
  const response = deferred<unknown>(); const h = await mount(undefined, config => config.url.startsWith('/product/editor/save/') ? response.promise : undefined);
  Object.assign(h.view.form, completeModel()); h.view.form.product_type = 1; h.view.form.attrs[0].delivery_mode = 'fixed'; h.view.form.attrs[0].disk_info = 'synthetic fixed content'; h.view.syncCustomForm(); const saving = h.view.submit(); await flush(); const original = { ...h.view.pending.value };
  login(21); browser.dispatchEvent(new Event('admin-session-changed')); expect(h.view.form.attrs[0].disk_info).toBe(''); expect(h.view.loaded.value).toBe(false); expect(h.view.pending.value).toBeNull();
  response.resolve({ ...original, state: 'committed', result: { id: 79, created: true } }); await saving;
  expect(runtime.routing.paths).not.toContain('/product/edit/79'); expect(sessionValues.get('admin_full_product_pending_v1:20')).toContain(original.operation_id); expect(h.calls.some(c => c.method === 'delete')).toBe(false);
});
it('allows the same active original actor to recover even after manage/view permissions are removed', async () => {
  const operation = { operation_id: '9d2a99ec-3798-4fbc-822f-33143bdb70e8', actor_id: 20, requested_id: 0 }; sessionValues.set('admin_full_product_pending_v1:20', JSON.stringify(operation));
  const h = await mount(undefined, undefined, []); expect(h.view.canManage.value).toBe(false); expect(h.view.loaded.value).toBe(false); expect(h.calls.some(c => c.url.includes('/operations/'))).toBe(true); expect(h.calls.some(c => c.url === '/product/editor/options')).toBe(false); await h.view.recover(true); expect(h.view.pending.value).toBeNull();
});
