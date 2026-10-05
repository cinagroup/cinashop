import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

// Exercise the real compiled Vue setup, Pinia identity and Axios interceptors.
// The parent task separately validates the rendered Element Plus UI in CUA.
const root = resolve(import.meta.dirname, '../../view/admin-ts');
const require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc');
let runtime: any, browser: EventTarget;
const endpoint = '/activity/combinations', revision = 'a'.repeat(64);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const grants = ['combination.view', 'combination.manage'];
beforeAll(async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal('window', Object.assign(new EventTarget(), { innerWidth: 1280, location: { search: '', pathname: endpoint, href: '' } }));
  const result = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    export { default as Page } from './src/pages/activity/Combinations.vue';
    export { default as Gallery } from './src/pages/activity/CombinationImagePicker.vue';
    export { default as request } from './src/utils/request';
    export * as api from './src/api/combination';
    export { createRenderer, nextTick, reactive } from 'vue';
    export { createPinia } from 'pinia';
    export { useAuthStore } from './src/stores/auth';
    export * as messages from 'element-plus';
  ` }, alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false' }, bundle: true, write: false, platform: 'browser', format: 'esm',
    plugins: [{ name: 'combinations-runtime', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => {
        const descriptor = parse(readFileSync(path, 'utf8'), { filename: path }).descriptor;
        const script = compileScript(descriptor, { id: 'combinations' });
        const template = compileTemplate({ source: descriptor.template.content, filename: path, id: 'combinations', compilerOptions: { bindingMetadata: script.bindings } });
        if (template.errors.length) throw Error(template.errors.map(String).join('\n'));
        return { contents: script.content, loader: 'ts' };
      });
      builder.onResolve({ filter: /^element-plus$/ }, () => ({ path: 'messages', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
        export const state = { successes: [], confirmations: [], confirm: () => Promise.resolve(), closed: 0 };
        export const ElMessage = { success: value => state.successes.push(value) };
        export const ElMessageBox = { confirm(...args) { state.confirmations.push(args); return state.confirm(...args); }, close() { state.closed++; } };
      ` }));
    } }],
  });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
});
const sku = (id: number | null = 71, overrides: Record<string, unknown> = {}) => ({ id, base_unique: 'base0001', unique: 'sell0001', suk: '红色,M', price: '12.50', cost: '8.00', ot_price: '15.00', image: '/api/assets/33', image_preview: '/api/assets/33?signature=sku', quota_total: 10, consumed: 3, remaining: 7, stock: 7, base_stock: 30, enabled: true, retired: false, valid: true, issues: [], weight: '1', volume: '0.2', bar_code: 'bar', code: 'code', ...overrides });
const shipping = () => ({ delivery_type: [1, 2], freight: 1, postage: '0.00', temp_id: 0 });
const row = (id = 1, overrides: Record<string, unknown> = {}) => ({ id, product_id: 21, title: '秋季拼团', image: '/api/assets/31', image_preview: '/api/assets/31?signature=cover', start_time: '2026-09-27T04:00:00.000Z', end_time: '2026-09-29T05:00:00.000Z', status: 1, phase: 'active', people: 3, quota_total: 10, consumed: 3, remaining: 7, stock: 7, sales: 3, sort: 0, valid: true, issues: [], revision, ...overrides });
const source = (id = 21, overrides: Record<string, unknown> = {}) => ({ product_id: id, product_type: 0, owner: { type: 0, relation_id: 0 }, title: '来源套餐', info: '可参与拼团', unit_name: '件', images: ['/api/assets/31'], images_preview: ['/api/assets/31?signature=cover'], description: '<p>来源内容</p>', description_preview: '<p>来源内容</p>', is_support_refund: 1, shipping: shipping(), skus: [sku(null, { consumed: 0, remaining: 0, quota_total: 0, enabled: false })], templates: [{ id: 2, name: '平台运费', owner_type: 0, relation_id: 0 }], source_metadata: { system_form_id: 5, writeoff: 1 }, valid: true, issues: [], ...overrides });
const detail = (id = 1, overrides: Record<string, unknown> = {}) => ({ ...source(), ...row(id), effective_time: 24, num: 5, once_num: 2, virtual: 100, is_host: 0, skus: [sku()], raw: { start_time: 1790481600, product_id: 21 }, ...overrides });
const option = (id = 21, overrides: Record<string, unknown> = {}) => ({ product_id: id, store_name: '来源套餐', image: '/api/assets/31', image_preview: '/api/assets/31?signature=cover', product_type: 0, category_name: '食品 / 套餐', stock: 30, valid: true, issues: [], ...overrides });
const options = (overrides: Record<string, unknown> = {}) => ({ categories: [{ id: 1, pid: 0, cate_name: '食品' }, { id: 2, pid: 1, cate_name: '套餐' }], labels: [{ id: 8, label_name: '隐藏标签', status: 0, is_show: 0 }], units: [{ id: 1, name: '件' }], templates: [{ id: 2, name: '平台运费', owner_type: 0, relation_id: 0 }], max_skus: 500, max_categories: 5000, max_labels: 5000, max_images: 10, ...overrides });
const rows = (list: unknown[] = [row()], count = list.length, page = 1) => ({ list, count, page, limit: 15 });
const asset = (id = 31) => ({ att_id: id, canonical_url: '/api/assets/' + id, att_dir: '/api/assets/' + id + '?signature=preview', satt_dir: '/api/assets/' + id + '?signature=thumb', real_name: '轮播图.png', att_type: 'image/png' });
const envelope = (data: unknown, status = 200, msg = 'ok') => ({ status, msg, data });
function login(permissions = grants, token = 'combination-token-a', id = 20) { localStorage.setItem('admin_token', token); localStorage.setItem('admin_session', JSON.stringify({ userInfo: { id, account: 'operator', level: 1, roles: '' }, menus: [], uniqueAuth: permissions })); }
beforeEach(() => {
  const values = new Map<string, string>(); browser = new EventTarget();
  vi.stubGlobal('window', Object.assign(browser, { innerWidth: 1280, location: { search: '', pathname: endpoint, href: '' } }));
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  runtime.messages.state.successes = []; runtime.messages.state.confirmations = []; runtime.messages.state.confirm = () => Promise.resolve(); runtime.messages.state.closed = 0;
});
afterEach(() => vi.unstubAllGlobals());
const flush = async () => { for (let index = 0; index < 8; index++) { await new Promise(done => setTimeout(done, 1)); await runtime.nextTick(); } };
function deferred() { let resolve!: (value?: unknown) => void; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function mount(permissions = grants, respond: (config: any) => unknown = () => undefined, gallery = false) {
  login(permissions); const calls: any[] = [], emissions: unknown[][] = [];
  runtime.request.defaults.adapter = async (config: any) => {
    calls.push(config); const custom = await respond(config), id = Number(config.url.match(/\/(\d+)(?:\/status)?$/u)?.[1] ?? 0);
    const fallback = config.url === '/file/category' ? { list: [{ id: 2, name: '封面' }] } : config.url === '/file/file' ? { list: [asset()], count: 1 } : config.url === '/file/upload' ? { att_id: 31, src: asset().att_dir, url: asset().canonical_url }
      : config.method !== 'get' ? { id: id || 9 } : config.url.endsWith('/options') ? options()
      : config.url.endsWith('/products') ? rows([option()], 1, config.params.page) : config.url.includes('/products/') ? source(id)
      : id ? detail(id) : rows([row()], 1, config.params.page);
    return { config, data: custom ?? envelope(fallback), status: 200, statusText: 'combination fixture', headers: {} };
  };
  let view: any; const props = runtime.reactive({ disabled: false, editorKey: 'editor-a', limit: 10 });
  const renderer = runtime.createRenderer({ createElement: () => ({ children: [] }), createText: (text: string) => ({ text }), createComment: (text: string) => ({ text }), insert(node: any, parent: any) { node.parent = parent; (parent.children ??= []).push(node); }, remove() {}, parentNode: (node: any) => node.parent, nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {} });
  const app = renderer.createApp({ setup(_props: any, context: any) {
    if (gallery) runtime.useAuthStore().$patch({ ...JSON.parse(localStorage.getItem('admin_session')!), token: localStorage.getItem('admin_token') });
    view = (gallery ? runtime.Gallery : runtime.Page).setup(gallery ? props : _props, { ...context, emit: (...args: unknown[]) => emissions.push(args) }); return () => null;
  } });
  app.use(runtime.createPinia()); app.mount({ children: [] }); await flush(); return { view, calls, props, emissions, close: () => app.unmount() };
}
const writes = (calls: any[]) => calls.filter(call => call.method !== 'get');
const body = (call: any) => JSON.parse(call.data);
function input(overrides: Record<string, unknown> = {}) { return { product_id: 21, product_type: 0, title: ' 秋季拼团 ', info: '可参与拼团', unit_name: '件', images: ['/api/assets/31'], description: '<p>内容</p>', start_time: '2026-09-27T04:00:00.000Z', end_time: '2026-09-29T05:00:00.000Z', effective_time: 24, people: 3, num: 5, once_num: 2, virtual: 100, sort: 0, status: 1, is_host: 0, is_support_refund: 1, shipping: shipping(), skus: [{ id: null, base_unique: 'base0001', enabled: true, price: '12.5', quota_total: 10, image: '/api/assets/33' }], ...overrides }; }
function fill(view: any, overrides: Record<string, unknown> = {}) { Object.assign(view.form.value, { ...source(), ...input(), skus: [sku(null, { consumed: 0, remaining: 10 })], ...overrides }); }

it('validates exact Shanghai datetime conversion, UTC bounds and full form limits including zero-priced SKUs', () => {
  const normalize = runtime.api.normalizeCombinationInput;
  expect(runtime.api.combinationUtcTime('2026-09-27T12:00')).toBe('2026-09-27T04:00:00.000Z');
  expect(runtime.api.combinationLocalTime('2026-09-27T04:00:00Z')).toBe('2026-09-27T12:00');
  expect(normalize(input()).title).toBe('秋季拼团'); expect(normalize(input({ skus: [{ ...input().skus[0], price: '0' }] })).skus[0].price).toBe('0.00');
  for (const patch of [{ title: '' }, { title: '字'.repeat(257) }, { info: '字'.repeat(256) }, { unit_name: '字'.repeat(33) }, { start_time: '2026-02-30T04:00:00Z' }, { end_time: '2026-09-27T04:00:00Z' }, { end_time: '2039-01-01T00:00:00Z' }, { effective_time: 0 }, { people: 501 }, { people: 1 }, { num: 0 }, { once_num: 6 }, { virtual: 0 }, { virtual: 101 }, { description: 'x'.repeat(200001) }, { images: [] }, { images: ['/api/assets/31', '/api/assets/31'] }, { images: Array.from({ length: 11 }, (_, index) => '/api/assets/' + (index + 1)) }]) expect(() => normalize(input(patch))).toThrow();
  expect(normalize(input({ people: 500, title: '字'.repeat(256), unit_name: '字'.repeat(32) })).people).toBe(500);
  for (const bad of ['2026-02-30T12:00', '2026-9-27T12:00', '2026-09-27T24:00']) expect(() => runtime.api.combinationUtcTime(bad)).toThrow();
});
it('enforces gallery/SKU stable-reference lengths, required enabled images and canonical decimals', () => {
  const normalize = runtime.api.normalizeCombinationInput;
  for (const picture of ['//media/x', 'http://media/x', 'https://a:b@media/x', '/api/assets/31?signature=temporary', '/bad\\image']) expect(() => normalize(input({ images: [picture] }))).toThrow();
  expect(() => runtime.api.combinationPicture('/' + 'a'.repeat(255))).toThrow(); expect(() => normalize(input({ skus: [{ ...input().skus[0], image: '/' + 'a'.repeat(128) }] }))).toThrow(); expect(() => normalize(input({ skus: [{ ...input().skus[0], image: '' }] }))).toThrow('图片');
  for (const price of ['-1', '1.234', '1e2', '01.50', '10000000000']) expect(() => normalize(input({ skus: [{ ...input().skus[0], price }] }))).toThrow();
  expect(runtime.api.combinationPreview('https://a:b@media/x')).toBe('');
  expect(() => normalize(input({ images: Array.from({ length: 9 }, (_, i) => '/' + i + 'a'.repeat(225)) }))).toThrow('2000');
});
it('whitelists source ownership, readonly costs, sales, previews and consumed counts out of writes', () => {
  const result = runtime.api.normalizeCombinationInput({ ...detail(), ...input(), skus: [sku()], owner: { type: 2, relation_id: 999 }, source_metadata: { user_form: 999 } });
  expect(Object.keys(result.skus[0]).sort()).toEqual(['base_unique', 'enabled', 'id', 'image', 'price', 'quota_total']);
  for (const key of ['owner', 'product_type', 'source_metadata', 'revision', 'raw', 'sales', 'description_preview', 'images_preview']) expect(result).not.toHaveProperty(key);
  expect(result.skus[0]).toMatchObject({ id: 71, quota_total: 10, price: '12.50' });
  const disabled = runtime.api.normalizeCombinationInput(input({ status: 0, skus: [sku(71, { enabled: false, base_unique: '', price: 'broken', image: '\\legacy', quota_total: -2 })] }));
  expect(disabled.skus[0]).toEqual({ id: 71, base_unique: '', enabled: false, price: 'broken', image: '\\legacy', quota_total: -2 });
});
it('preserves damaged historical fields and retired SKUs but refuses truncated or malformed details', () => {
  const broken = detail(1, { product_id: 0, product_type: -1, owner: { type: -1, relation_id: -2 }, valid: false, start_time: '', skus: [sku(71, { retired: true, enabled: false, valid: false, base_unique: '', price: 'bad' })] });
  expect(runtime.api.parseCombinationDetail(broken).skus).toHaveLength(1);
  for (const patch of [{ skus: [null] }, { skus: Array.from({ length: 501 }, () => sku()) }, { images: ['/api/assets/31'], images_preview: [] }, { description_preview: undefined }, { revision: '' }, { templates: Array.from({ length: 5001 }, (_, i) => ({ id: i + 1, name: 'T', owner_type: 0, relation_id: 0 })) }]) expect(() => runtime.api.parseCombinationDetail(detail(1, patch))).toThrow();
});
it('enforces independent view/manage permissions and detail-only read access', async () => {
  const denied = await mount(['activity.view', 'activity.manage', 'seckill_activity.view']); try { await denied.view.openForm(1, 'view'); expect(denied.calls).toEqual([]); } finally { denied.close(); }
  const f = await mount(['combination.view']); try {
    await f.view.openForm(1, 'view'); expect(f.view.form.value.skus[0].id).toBe(71); expect(f.view.editable.value).toBe(false); await f.view.save(); await f.view.openProducts(); await f.view.openForm(1, 'copy'); await f.view.toggleStatus(f.view.list.value[0]); await f.view.remove(f.view.list.value[0]);
    expect(f.view.mode.value).toBe('view'); expect(writes(f.calls)).toEqual([]); expect(f.calls.some(c => c.url.includes('/products'))).toBe(false); expect(runtime.messages.state.confirmations).toEqual([]);
  } finally { f.close(); }
});
it('keeps name/ID, phase, status and 15-item pagination across readback and resets page one', async () => {
  const f = await mount(); try {
    expect(f.calls[0]).toMatchObject({ url: endpoint, params: { page: 1, limit: 15, keyword: '', phase: '', status: '' } }); f.view.draftKeyword.value = '  21 '; f.view.draftPhase.value = 'ended'; f.view.draftStatus.value = 0; f.view.search(); await flush(); await f.view.load(2); await f.view.load();
    expect(f.calls.at(-1).params).toEqual({ page: 2, limit: 15, keyword: '21', phase: 'ended', status: 0 }); f.view.reset(); await flush(); expect(f.calls.at(-1).params).toEqual({ page: 1, limit: 15, keyword: '', phase: '', status: '' });
  } finally { f.close(); }
});
it('reads a complete authoritative source and creates with readonly metadata excluded and exactly one UUID', async () => {
  const f = await mount(); try {
    await f.view.openForm(0, 'create'); await f.view.openProducts(); await f.view.chooseSource(f.view.products.value[0]); expect(f.view.form.value).toMatchObject({ product_id: 21, title: '来源套餐', images: ['/api/assets/31'], source_metadata: { system_form_id: 5 } });
    expect(f.view.form.value.skus[0]).toMatchObject({ id: null, unique: '', consumed: 0, quota_total: 30, remaining: 30 }); f.view.setTime('start_time', '2026-09-27T12:00'); f.view.setTime('end_time', '2026-09-29T13:00'); await f.view.save();
    const call = writes(f.calls)[0]; expect(call).toMatchObject({ method: 'post', url: endpoint }); expect(body(call)).toMatchObject({ request_id: expect.stringMatching(uuid), product_id: 21, status: 0, skus: [{ id: null, quota_total: 30 }] });
    expect(body(call)).not.toHaveProperty('revision'); expect(body(call)).not.toHaveProperty('source_metadata'); expect(writes(f.calls)).toHaveLength(1); expect(f.calls.at(-1).method).toBe('get');
  } finally { f.close(); }
});
it('filters a single category and hidden label with authoritative source-owned templates', async () => {
  const templates = [{ id: 9, name: '供应商模板', owner_type: 2, relation_id: 7 }];
  const f = await mount(grants, c => c.url.includes('/products/') ? envelope(source(21, { owner: { type: 2, relation_id: 7 }, templates, shipping: { ...shipping(), freight: 3, temp_id: 9 } })) : undefined); try {
    await f.view.openForm(0, 'create'); await f.view.openProducts(); expect(f.view.categoryTree.value[0].children[0].value).toBe(2); f.view.productCategory.value = 1; f.view.productLabel.value = 8; f.view.productKeyword.value = '  套餐 '; f.view.searchProducts(); await flush();
    expect(f.calls.at(-1).params).toEqual({ page: 1, limit: 15, keyword: '套餐', category_id: 1, label_id: 8 }); await f.view.chooseSource(f.view.products.value[0]); expect(f.view.availableTemplates.value).toEqual(templates); expect(f.view.options.value.templates[0].id).toBe(2);
  } finally { f.close(); }
});
it('keeps the entire prior draft when source identity or capacity fails', async () => {
  for (const material of [source(22), source(21, { skus: Array.from({ length: 501 }, () => sku()) }), source(21, { valid: false, issues: ['不可参与'] }), source(21, { images_preview: [] })]) {
    const f = await mount(grants, c => c.url.includes('/products/') ? envelope(material) : undefined); try {
      await f.view.openForm(0, 'create'); fill(f.view, { title: '保留草稿', description: '<p>我的内容</p>' }); const before = JSON.parse(JSON.stringify(f.view.form.value)); await f.view.openProducts(); await f.view.chooseSource(f.view.products.value[0]); expect(f.view.form.value).toEqual(before); expect(f.view.productError.value).not.toBe(''); expect(f.view.productsVisible.value).toBe(true);
    } finally { f.close(); }
  }
});
it('discards source detail arriving after picker cancel, editor replacement or same-account ABA', async () => {
  for (const interrupt of ['picker', 'editor', 'aba']) {
    const wait = deferred(); const f = await mount(grants, async c => { if (c.url.includes('/products/')) { await wait.promise; return envelope(source(21, { title: '迟到来源' })); } }); try {
      await f.view.openForm(0, 'create'); fill(f.view, { title: '原草稿' }); await f.view.openProducts(); const pending = f.view.chooseSource(f.view.products.value[0]); await flush();
      if (interrupt === 'picker') f.view.closeProducts(); else if (interrupt === 'editor') { f.view.closeForm(); await f.view.openForm(0, 'create'); fill(f.view, { title: '新草稿' }); } else { login(grants, 'combination-token-b', 21); browser.dispatchEvent(new Event('admin-session-changed')); await flush(); login(); browser.dispatchEvent(new Event('admin-session-changed')); await flush(); }
      wait.resolve(); await pending; expect(f.view.form.value?.title).not.toBe('迟到来源'); expect(writes(f.calls)).toEqual([]);
    } finally { wait.resolve(); f.close(); }
  }
});
it('prohibits saved source replacement and uses fresh detailed revision for total-minus-consumed updates', async () => {
  const f = await mount(grants, c => c.url === endpoint + '/1' && c.method === 'get' ? envelope(detail(1, { revision: 'b'.repeat(64) })) : undefined); try {
    await f.view.openForm(1, 'edit'); await f.view.openProducts(); expect(f.calls.some(c => c.url.endsWith('/products'))).toBe(false); const s = f.view.form.value.skus[0]; s.quota_total = 20; expect(f.view.nextRemaining(s)).toBe(17); await f.view.save();
    const call = writes(f.calls)[0]; expect(call.method).toBe('put'); expect(body(call)).toMatchObject({ revision: 'b'.repeat(64), request_id: expect.stringMatching(uuid), product_id: 21, skus: [{ id: 71, quota_total: 20 }] }); expect(body(call).skus[0]).not.toHaveProperty('consumed');
  } finally { f.close(); }
});
it('copies configured total quota into a new entity without reviving or sending retired historical SKUs', async () => {
  const f = await mount(grants, c => c.url === endpoint + '/1' && c.method === 'get' ? envelope(detail(1, { skus: [sku(), sku(72, { retired: true, enabled: false, valid: false, base_unique: '', price: 'bad' })] })) : undefined); try {
    await f.view.openForm(1, 'copy'); expect(f.view.form.value.skus).toHaveLength(2); expect(f.view.form.value.skus[0]).toMatchObject({ id: null, unique: '', quota_total: 10, consumed: 0, remaining: 10 }); f.view.selectSkus(true); expect(f.view.form.value.skus[1].enabled).toBe(false); await f.view.save();
    const call = writes(f.calls)[0]; expect(call.method).toBe('post'); expect(body(call)).not.toHaveProperty('revision'); expect(body(call).skus).toHaveLength(1); expect(body(call).skus[0]).toMatchObject({ id: null, quota_total: 10 }); expect(detail().skus[0].id).toBe(71);
  } finally { f.close(); }
});
it('locks the copied source just like PHP without loading candidates or replacing its product identity', async () => {
  const f = await mount(); try {
    await f.view.openForm(1, 'copy'); const before = JSON.parse(JSON.stringify(f.view.form.value));
    await f.view.openProducts(); await f.view.chooseSource(option(22)); expect(f.view.form.value).toEqual(before);
    expect(f.view.form.value.product_id).toBe(21); expect(f.view.productsVisible.value).toBe(false); expect(f.calls.some(c => c.url.includes('/products'))).toBe(false);
    await f.view.save(); expect(writes(f.calls)[0].method).toBe('post'); expect(body(writes(f.calls)[0]).product_id).toBe(21);
  } finally { f.close(); }
});
it('makes batch price/total changes atomic and excludes retired or unchecked identities', async () => {
  const f = await mount(grants, c => c.url === endpoint + '/1' && c.method === 'get' ? envelope(detail(1, { skus: [sku(), sku(72, { base_unique: 'base0002', consumed: 8 }), sku(73, { retired: true, enabled: false }), sku(74, { enabled: false })] })) : undefined); try {
    await f.view.openForm(1, 'edit'); f.view.batchPrice.value = '0'; f.view.batchQuota.value = '7'; f.view.applyBatch(); expect(f.view.formError.value).toContain('均未修改'); expect(f.view.form.value.skus.map((s: any) => s.price)).toEqual(['12.50', '12.50', '12.50', '12.50']);
    f.view.batchQuota.value = '20'; f.view.applyBatch(); expect(f.view.form.value.skus.slice(0, 2).map((s: any) => [s.id, s.price, s.quota_total, s.consumed])).toEqual([[71, '0.00', 20, 3], [72, '0.00', 20, 8]]); expect(f.view.form.value.skus[2]).toMatchObject({ id: 73, quota_total: 10, price: '12.50', enabled: false }); expect(f.view.form.value.skus[3].price).toBe('12.50'); f.view.selectSkus(true); expect(f.view.form.value.skus[2].enabled).toBe(false);
  } finally { f.close(); }
});
it('blocks quota below consumed and preserves every disabled damaged ID during retirement', async () => {
  const f = await mount(grants, c => c.url === endpoint + '/1' && c.method === 'get' ? envelope(detail(1, { skus: [sku(), sku(72, { enabled: false, retired: true, valid: false, base_unique: '', price: 'bad', image: '\\bad' })] })) : undefined); try {
    await f.view.openForm(1, 'edit'); f.view.form.value.skus[0].quota_total = 2; await f.view.save(); expect(writes(f.calls)).toEqual([]); expect(f.view.formError.value).toContain('总额度'); f.view.form.value.skus[0].quota_total = 10; await f.view.save();
    expect(body(writes(f.calls)[0]).skus).toHaveLength(2); expect(body(writes(f.calls)[0]).skus[1]).toEqual({ id: 72, base_unique: '', price: 'bad', image: '\\bad', quota_total: 10, enabled: false });
  } finally { f.close(); }
});
it('recalculates people/virtual thresholds with ceiling and resets zero fill to 100 percent', async () => {
  const f = await mount(); try {
    await f.view.openForm(1, 'edit'); f.view.form.value.people = 3; f.view.desiredFill.value = 1; f.view.fillChanged(); expect(f.view.form.value.virtual).toBe(66); expect(f.view.requiredReal.value).toBe(2); f.view.desiredFill.value = 0; f.view.fillChanged(); expect(f.view.form.value.virtual).toBe(100); expect(f.view.requiredReal.value).toBe(3);
    f.view.form.value.people = 10; f.view.desiredFill.value = 3; f.view.recomputeVirtual(); expect(f.view.form.value.virtual).toBe(70); expect(f.view.requiredReal.value).toBe(7); f.view.form.value.virtual = 51; f.view.thresholdChanged(); expect(f.view.desiredFill.value).toBe(4); expect(runtime.api.combinationRequiredReal(3, 34)).toBe(2);
  } finally { f.close(); }
});
it('validates physical freight and permits inherited zero-postage nonphysical freight', () => {
  const normalize = runtime.api.normalizeCombinationInput;
  for (const s of [{ ...shipping(), delivery_type: [] }, { ...shipping(), delivery_type: [1, 1] }, { ...shipping(), freight: 2, postage: '0' }, { ...shipping(), freight: 2, postage: '100000000' }, { ...shipping(), freight: 3, temp_id: 0 }]) expect(() => normalize(input({ shipping: s }))).toThrow();
  expect(normalize(input({ shipping: { ...shipping(), freight: 2, postage: '1.5' } })).shipping.postage).toBe('1.50'); expect(normalize(input({ product_type: 1, shipping: { ...shipping(), freight: 2, postage: '0' } })).shipping.postage).toBe('0.00');
});
it('allows valid ended status/read/copy/delete while preventing in-place editing', async () => {
  const f = await mount(grants, c => c.url === endpoint ? envelope(rows([row(1, { phase: 'ended', status: 0 })])) : c.url === endpoint + '/1' && c.method === 'get' ? envelope(detail(1, { phase: 'ended', status: 0 })) : undefined); try {
    await f.view.openForm(1, 'edit'); expect(f.view.editable.value).toBe(false); await f.view.save(); expect(writes(f.calls)).toEqual([]);
    await f.view.toggleStatus(f.view.list.value[0]); expect(writes(f.calls)[0]).toMatchObject({ method: 'put', url: endpoint + '/1/status' }); expect(body(writes(f.calls)[0]).status).toBe(1);
    await f.view.openForm(1, 'copy'); expect(f.view.editable.value).toBe(true); f.view.setTime('end_time', '2026-10-01T13:00'); expect(f.view.form.value.end_time).toBe('2026-10-01T05:00:00.000Z'); f.view.closeForm(); await f.view.remove(f.view.list.value[0]); expect(writes(f.calls).at(-1).method).toBe('delete');
  } finally { f.close(); }
});
it('adds/reorders/removes multi-images with aligned previews and no partial duplicate overflow', async () => {
  const f = await mount(); try {
    await f.view.openForm(0, 'create'); fill(f.view); f.view.addImages([{ reference: '/api/assets/32', preview: '/api/assets/32?signature=second' }, { reference: '/api/assets/34', preview: '' }]); expect(f.view.form.value.images).toEqual(['/api/assets/31', '/api/assets/32', '/api/assets/34']); f.view.moveImage(2, 0);
    expect(f.view.form.value.images).toEqual(['/api/assets/34', '/api/assets/31', '/api/assets/32']); expect(f.view.form.value.images_preview).toEqual(['', '/api/assets/31?signature=cover', '/api/assets/32?signature=second']); const before = [...f.view.form.value.images]; f.view.addImages([{ reference: '/api/assets/32', preview: '' }, { reference: '/api/assets/35', preview: '' }]); expect(f.view.form.value.images).toEqual(before); f.view.removeImage(0); expect(f.view.form.value.images_preview[0]).toContain('signature=cover');
  } finally { f.close(); }
});
it('replaces only current enabled SKU images and strips signed preview metadata from the write', async () => {
  const f = await mount(); try {
    await f.view.openForm(1, 'edit'); const s = f.view.form.value.skus[0]; f.view.chooseSkuImage({ ...s }, [{ reference: '/api/assets/40', preview: '' }]); expect(s.image).toBe('/api/assets/33'); f.view.chooseSkuImage(s, [{ reference: '/api/assets/40', preview: '/api/assets/40?signature=new' }]); expect(s.image_preview).toContain('signature=new'); await f.view.save();
    expect(body(writes(f.calls)[0]).skus[0].image).toBe('/api/assets/40'); expect(body(writes(f.calls)[0]).skus[0]).not.toHaveProperty('image_preview');
  } finally { f.close(); }
});
it('requires confirmation and sends one fresh UUID/revision for status/delete; cancellation sends nothing', async () => {
  const f = await mount(); try {
    runtime.messages.state.confirm = () => Promise.reject(Error('cancel')); await f.view.toggleStatus(f.view.list.value[0]); await f.view.remove(f.view.list.value[0]); expect(writes(f.calls)).toEqual([]); runtime.messages.state.confirm = () => Promise.resolve(); await f.view.toggleStatus(f.view.list.value[0]); await f.view.remove(f.view.list.value[0]);
    expect(writes(f.calls).map(c => [c.method, c.url])).toEqual([['put', endpoint + '/1/status'], ['delete', endpoint + '/1']]); for (const call of writes(f.calls)) expect(body(call)).toMatchObject({ request_id: expect.stringMatching(uuid), revision }); expect(new Set(writes(f.calls).map(c => body(c).request_id)).size).toBe(2);
    expect(runtime.messages.state.confirmations[0][0]).toContain('提前到期'); expect(runtime.messages.state.confirmations.at(-1)[0]).toContain('已有订单继续按成团规则处理'); expect(runtime.messages.state.confirmations.at(-1)[0]).not.toContain('全部退款');
  } finally { f.close(); }
});
it('never retries an unknown save and clears the draft before GET-only reconciliation', async () => {
  for (const result of ['network', 'malformed', 'conflict']) {
    const f = await mount(grants, c => { if (c.method !== 'get') { if (result === 'network') throw Error('lost'); return result === 'conflict' ? envelope(null, 409, '版本冲突') : envelope({ id: 999 }); } }); try {
      await f.view.openForm(1, 'edit'); await f.view.save(); expect(writes(f.calls)).toHaveLength(1); expect(f.view.form.value).toBeNull(); expect(f.view.actionNotice.value).toContain(result === 'conflict' ? '未完成' : '未确认'); await f.view.save(); await f.view.load(); expect(writes(f.calls)).toHaveLength(1); expect(f.calls.at(-1).method).toBe('get');
    } finally { f.close(); }
  }
});
it('rejects stale confirmation after same-account ABA without a mutation', async () => {
  const wait = deferred(), f = await mount(); try {
    runtime.messages.state.confirm = () => wait.promise; const pending = f.view.remove(f.view.list.value[0]); await flush(); login(grants, 'combination-token-b', 21); browser.dispatchEvent(new Event('admin-session-changed')); await flush(); login(); browser.dispatchEvent(new Event('admin-session-changed')); await flush(); wait.resolve(); await pending; expect(writes(f.calls)).toEqual([]); expect(runtime.messages.state.closed).toBeGreaterThan(0);
  } finally { wait.resolve(); f.close(); }
});
it('abandons late writes and authentication failure from a replaced session', async () => {
  const wait = deferred(), f = await mount(grants, async c => { if (c.method !== 'get') { await wait.promise; return envelope(null, 410000, 'old token'); } }); try {
    await f.view.openForm(1, 'edit'); const pending = f.view.save(); await flush(); login(grants, 'combination-token-b', 21); browser.dispatchEvent(new Event('admin-session-changed')); await flush(); wait.resolve(); await pending; expect(localStorage.getItem('admin_token')).toBe('combination-token-b'); expect(runtime.messages.state.successes).toEqual([]); expect(f.view.actionNotice.value).toBe(''); expect(writes(f.calls)).toHaveLength(1);
  } finally { wait.resolve(); f.close(); }
});
it('drops late detailed responses while keeping a replacement editor intact', async () => {
  const wait = deferred(), f = await mount(grants, async c => { if (c.url === endpoint + '/1' && c.method === 'get') { await wait.promise; return envelope(detail(1, { title: '迟到详情' })); } }); try {
    const pending = f.view.openForm(1, 'edit'); await flush(); f.view.closeForm(); await f.view.openForm(0, 'create'); fill(f.view, { title: '新的编辑器' }); wait.resolve(); await pending; expect(f.view.form.value.title).toBe('新的编辑器'); login(grants, 'combination-token-b', 21); browser.dispatchEvent(new Event('admin-session-changed')); await flush(); expect(f.view.form.value).toBeNull();
  } finally { wait.resolve(); f.close(); }
});
it('falls back from an empty final page after delete and retains directory filters', async () => {
  let deleted = false; const f = await mount(grants, c => { if (c.method === 'delete') deleted = true; if (c.url === endpoint) return envelope(c.params.page === 2 ? rows(deleted ? [] : [row()], deleted ? 15 : 16, 2) : rows([row()], deleted ? 15 : 16)); }); try {
    f.view.draftKeyword.value = '拼团'; f.view.draftStatus.value = 1; f.view.search(); await flush(); await f.view.load(2); await f.view.remove(f.view.list.value[0]); expect(f.view.page.value).toBe(1); expect(f.calls.at(-1).params).toEqual({ page: 1, limit: 15, keyword: '拼团', phase: '', status: 1 });
  } finally { f.close(); }
});
it('blocks invalid enabling and exposes complete option/list failures for explicit reread', async () => {
  const f = await mount(grants, c => c.url === endpoint ? envelope(rows([row(1, { status: 0, valid: false })])) : c.url.endsWith('/options') ? envelope(options({ templates: [{ id: 2, name: 'x', owner_type: 0, relation_id: 0 }, { id: 2, name: 'y', owner_type: 0, relation_id: 0 }] })) : undefined); try {
    await f.view.toggleStatus(f.view.list.value[0]); expect(writes(f.calls)).toEqual([]); await f.view.openForm(1, 'edit'); expect(f.view.optionsError.value).not.toBe(''); await f.view.save(); expect(writes(f.calls)).toEqual([]);
  } finally { f.close(); }
  const bad = await mount(grants, c => c.url === endpoint ? envelope(rows([row(), row()])) : undefined); try { expect(bad.view.listError.value).toContain('重复'); expect(bad.view.list.value).toEqual([]); } finally { bad.close(); }
});
it('retains gallery choices across pages and emits one array only after explicit confirmation', async () => {
  const f = await mount([...grants, 'attachment.view'], c => c.url === '/file/file' ? envelope({ list: [asset(c.params.page === 1 ? 31 : 32)], count: 21 }) : undefined, true); try {
    await f.view.open(); f.view.choose(f.view.items.value[0]); expect(f.emissions).toEqual([]); await f.view.load(2); f.view.choose(f.view.items.value[0]); expect(f.view.selected.value.map((p: any) => p.reference)).toEqual(['/api/assets/31', '/api/assets/32']); f.view.confirmChoice();
    expect(f.emissions).toEqual([['choose', [{ reference: '/api/assets/31', preview: asset().att_dir }, { reference: '/api/assets/32', preview: asset(32).att_dir }]]]); expect(f.view.visible.value).toBe(false);
  } finally { f.close(); }
});
it('keeps gallery/upload ACL independent and rejects cap overflow or stale editor choices', async () => {
  const denied = await mount(grants, () => undefined, true); try { await denied.view.open(); expect(denied.calls).toEqual([]); } finally { denied.close(); }
  const f = await mount([...grants, 'attachment.view'], c => c.url === '/file/file' ? envelope({ list: [asset(31), asset(32)], count: 2 }) : undefined, true); try {
    f.props.limit = 1; await f.view.open(); f.view.choose(f.view.items.value[0]); f.view.choose(f.view.items.value[1]); expect(f.view.selected.value).toHaveLength(1); expect(f.view.canUpload.value).toBe(false); await f.view.upload({ file: new File(['x'], 'x.png', { type: 'image/png' }) }); expect(writes(f.calls)).toEqual([]); f.props.editorKey = 'editor-b'; await flush(); f.view.confirmChoice(); expect(f.emissions).toEqual([]); expect(f.view.visible.value).toBe(false);
  } finally { f.close(); }
});
it('reconciles unknown attachment uploads through GET without replay', async () => {
  const f = await mount([...grants, 'attachment.view', 'attachment.manage'], c => { if (c.url === '/file/upload') throw Error('upload lost'); }, true); try {
    await f.view.open(); await f.view.upload({ file: new File(['x'], 'x.png', { type: 'image/png' }) }); expect(writes(f.calls)).toHaveLength(1); expect(f.calls.at(-1).method).toBe('get'); expect(f.view.error.value).toContain('勿重复上传'); await f.view.load(); expect(writes(f.calls)).toHaveLength(1);
  } finally { f.close(); }
});
it('clearing a datetime invalidates the draft instead of silently submitting the previous timestamp', async () => {
  const f = await mount(); try { await f.view.openForm(1, 'edit'); f.view.setTime('start_time', ''); expect(f.view.form.value.start_time).toBe(''); await f.view.save(); expect(writes(f.calls)).toEqual([]); f.view.setTime('start_time', '2026-09-27T12:00'); await f.view.save(); expect(writes(f.calls)).toHaveLength(1); } finally { f.close(); }
});
it('discards an older candidate page when the latest filter or page request finishes first', async () => {
  const wait = deferred(), f = await mount(grants, async c => { if (c.url.endsWith('/products') && c.params.page === 2) { await wait.promise; return envelope(rows([option(22)], 31, 2)); } if (c.url.endsWith('/products') && c.params.page === 3) return envelope(rows([option(23)], 31, 3)); }); try {
    await f.view.openForm(0, 'create'); await f.view.openProducts(); const pending = f.view.loadProducts(2); await flush(); await f.view.loadProducts(3); expect(f.view.products.value[0].product_id).toBe(23); wait.resolve(); await pending; expect(f.view.products.value[0].product_id).toBe(23); expect(f.view.productPage.value).toBe(3);
  } finally { wait.resolve(); f.close(); }
});
it('does not install late options from a closed editor into a new draft', async () => {
  const wait = deferred(); let held = true; const f = await mount(grants, async c => { if (c.url.endsWith('/options') && held) { held = false; await wait.promise; return envelope(options({ units: [{ id: 9, name: '过期单位' }] })); } }); try {
    const pending = f.view.openForm(0, 'create'); await flush(); f.view.closeForm(); await f.view.openForm(0, 'create'); expect(f.view.options.value.units[0].name).toBe('件'); wait.resolve(); await pending; expect(f.view.options.value.units[0].name).toBe('件'); expect(f.view.optionsLoading.value).toBe(false);
  } finally { wait.resolve(); f.close(); }
});
it('requires one participating SKU for hidden create/copy without reviving retired rows', async () => {
  const f = await mount(); try {
    await f.view.openForm(0, 'create'); fill(f.view, { status: 0 }); f.view.selectSkus(false); await f.view.save(); expect(f.view.formError.value).toContain('至少一个'); expect(writes(f.calls)).toEqual([]); f.view.selectSkus(true); await f.view.save(); expect(writes(f.calls)).toHaveLength(1);
  } finally { f.close(); }
});
it('never mixes platform shipping templates into a supplier detail missing its template collection', async () => {
  const f = await mount(grants, c => c.url === endpoint + '/1' && c.method === 'get' ? envelope(detail(1, { owner: { type: 2, relation_id: 9 }, templates: undefined, shipping: { ...shipping(), freight: 3, temp_id: 22 } })) : undefined); try { await f.view.openForm(1, 'view'); expect(f.view.form.value.shipping.temp_id).toBe(22); expect(f.view.availableTemplates.value).toEqual([]); expect(f.view.options.value.templates).toHaveLength(1); } finally { f.close(); }
});
it('uses late directory request cancellation to protect the latest account and filter list', async () => {
  const wait = deferred(), f = await mount(grants, async c => { if (c.url === endpoint && c.params.keyword === 'slow') { await wait.promise; return envelope(rows([row(8, { title: '旧筛选' })])); } }); try {
    f.view.draftKeyword.value = 'slow'; f.view.search(); await flush(); f.view.draftKeyword.value = 'latest'; f.view.search(); await flush(); expect(f.view.list.value[0].id).toBe(1); wait.resolve(); await flush(); expect(f.view.list.value[0].id).toBe(1); expect(f.view.keyword.value).toBe('latest');
  } finally { wait.resolve(); f.close(); }
});
it('limits gallery/source options completely and rejects ambiguous category trees or duplicate labels', async () => {
  for (const patch of [{ units: Array.from({ length: 5001 }, (_, i) => ({ id: i + 1, name: 'U' })) }, { categories: [{ id: 1, pid: 2, cate_name: '循环' }, { id: 2, pid: 1, cate_name: '循环' }] }, { labels: [{ id: 8, label_name: '甲' }, { id: 8, label_name: '乙' }] }]) {
    const f = await mount(grants, c => c.url.endsWith('/options') ? envelope(options(patch)) : undefined); try { await f.view.openForm(0, 'create'); expect(f.view.optionsError.value).not.toBe(''); await f.view.openProducts(); expect(f.calls.some(c => c.url.endsWith('/products'))).toBe(false); } finally { f.close(); }
  }
});
it('unknown create/status/delete results only perform reconciliation GETs without writing the operation again', async () => {
  for (const operation of ['create', 'status', 'delete']) {
    const f = await mount(grants, c => { if (c.method !== 'get') throw Error('transport closed'); }); try {
      if (operation === 'create') { await f.view.openForm(0, 'create'); fill(f.view); await f.view.save(); } else if (operation === 'status') await f.view.toggleStatus(f.view.list.value[0]); else await f.view.remove(f.view.list.value[0]);
      expect(writes(f.calls)).toHaveLength(1); expect(f.view.actionNotice.value).toContain('未确认'); await f.view.load(); await f.view.load(); expect(writes(f.calls)).toHaveLength(1);
      expect(body(writes(f.calls)[0]).request_id).toMatch(uuid);
    } finally { f.close(); }
  }
});
it('closing a gallery cancels late list responses and prevents selected images from escaping its session', async () => {
  const wait = deferred(), f = await mount([...grants, 'attachment.view'], async c => { if (c.url === '/file/file') { await wait.promise; return envelope({ list: [asset()], count: 1 }); } }, true); try {
    const pending = f.view.open(); await flush(); f.view.close(); wait.resolve(); await pending; expect(f.view.items.value).toEqual([]); expect(f.view.visible.value).toBe(false); f.view.choose(asset()); f.view.confirmChoice(); expect(f.emissions).toEqual([]);
  } finally { wait.resolve(); f.close(); }
});
