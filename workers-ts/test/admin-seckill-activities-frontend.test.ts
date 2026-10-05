import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

// Exercise the real compiled Vue setup, Pinia identity and Axios interceptors.
// The parent task separately validates the rendered Element Plus UI in CUA.
const root = resolve(import.meta.dirname, '../../view/admin-ts');
const require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript } = require('@vue/compiler-sfc');
let runtime: any, browser: EventTarget;
const endpoint = '/activity/seckill-activities', revision = 'a'.repeat(64);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const grants = ['seckill_activity.view', 'seckill_activity.manage'];
beforeAll(async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal('window', Object.assign(new EventTarget(), { innerWidth: 1280, location: { search: '', pathname: endpoint, href: '' } }));
  const result = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    export { default as Page } from './src/pages/activity/SeckillActivities.vue';
    export { default as Gallery } from './src/pages/activity/SeckillActivityImagePicker.vue';
    export { default as request } from './src/utils/request';
    export * as api from './src/api/seckillActivity';
    export { createRenderer, nextTick, reactive } from 'vue';
    export { createPinia } from 'pinia';
    export { useAuthStore } from './src/stores/auth';
    export * as messages from 'element-plus';
  ` }, alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false' }, bundle: true, write: false, platform: 'browser', format: 'esm',
    plugins: [{ name: 'seckill-activities-runtime', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({ contents: compileScript(parse(readFileSync(path, 'utf8'), { filename: path }).descriptor, { id: 'seckill-activities' }).content, loader: 'ts' }));
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
const slot = (id = 4) => ({ id, title: '午间', start_time: '12:00', end_time: '13:00', status: 1, valid: true });
const sku = (id: number | null = 71, overrides: Record<string, unknown> = {}) => ({ id, base_unique: 'base0001', unique: 'sell0001', suk: '红色,M', price: '12.50', cost: '8.00', ot_price: '15.00', image: '/api/assets/33', image_preview: '/api/assets/33?signature=sku', quota: 7, quota_show: 10, quota_total: 10, consumed: 3, remaining: 7, stock: 7, base_stock: 30, enabled: true, retired: false, valid: true, issues: [], ...overrides });
const product = (id = 21, overrides: Record<string, unknown> = {}) => ({ child_id: 61, product_id: id, store_name: '午间套餐', image: '/api/assets/32', image_preview: '/api/assets/32?signature=product', product_type: 0, category_name: '食品 / 套餐', status: 1, valid: true, issues: [], skus: [sku()], ...overrides });
const row = (id = 1, overrides: Record<string, unknown> = {}) => ({ id, name: '秋季秒杀', start_day: '2026-09-27', end_day: '2026-09-29', time_ids: [4], time_list: [slot()], image: '/api/assets/31', image_preview: '/api/assets/31?signature=parent', status: 1, phase: 'active', product_count: 1, add_time: 1790438400, valid: true, issues: [], revision, ...overrides });
const detail = (id = 1, overrides: Record<string, unknown> = {}) => ({ ...row(id), num: 5, once_num: 2, products: [product()], raw: { start_day: 1790438400, time_id: '[4]' }, ...overrides });
const rows = (list: unknown[] = [row()], count = list.length, page = 1) => ({ list, count, page, limit: 15 });
const option = (id = 21, overrides: Record<string, unknown> = {}) => ({ product_id: id, store_name: '午间套餐', image: '/api/assets/32', image_preview: '/api/assets/32?signature=product', product_type: 0, category_name: '食品 / 套餐', stock: 30, valid: true, issues: [], ...overrides });
const options = (overrides: Record<string, unknown> = {}) => ({ times: [slot()], categories: [{ id: 1, pid: 0, cate_name: '食品' }, { id: 2, pid: 1, cate_name: '套餐' }], labels: [{ id: 8, label_name: '隐藏标签', status: 0, is_show: 0 }], max_slots: 64, max_products: 100, max_skus: 500, max_total_skus: 5000, max_categories: 5000, max_labels: 5000, ...overrides });
const source = (id = 21, overrides: Record<string, unknown> = {}) => ({ ...option(id), skus: [sku(81, { consumed: 0, quota_total: 0, remaining: 0, quota: 0, quota_show: 0, enabled: false })], ...overrides });
const asset = (id = 31) => ({ att_id: id, canonical_url: `/api/assets/${id}`, att_dir: `/api/assets/${id}?signature=preview`, satt_dir: `/api/assets/${id}?signature=thumb`, real_name: '氛围图.png', att_type: 'image/png' });
const envelope = (data: unknown, status = 200, msg = 'ok') => ({ status, msg, data });
function login(permissions = grants, token = 'parent-token-a', id = 20) { localStorage.setItem('admin_token', token); localStorage.setItem('admin_session', JSON.stringify({ userInfo: { id, account: 'operator', level: 1, roles: '' }, menus: [], uniqueAuth: permissions })); }
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
    return { config, data: custom ?? envelope(fallback), status: 200, statusText: 'parent fixture', headers: {} };
  };
  let view: any; const props = runtime.reactive({ disabled: false, editorKey: 'editor-a' });
  const renderer = runtime.createRenderer({ createElement: () => ({ children: [] }), createText: (text: string) => ({ text }), createComment: (text: string) => ({ text }), insert(node: any, parent: any) { node.parent = parent; (parent.children ??= []).push(node); }, remove() {}, parentNode: (node: any) => node.parent, nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {} });
  const app = renderer.createApp({ setup(_props: any, context: any) {
    // A standalone picker has the same store already hydrated by its parent.
    if (gallery) runtime.useAuthStore().$patch({ ...JSON.parse(localStorage.getItem('admin_session')!), token: localStorage.getItem('admin_token') });
    view = (gallery ? runtime.Gallery : runtime.Page).setup(gallery ? props : _props, { ...context, emit: (...args: unknown[]) => emissions.push(args) }); return () => null;
  } });
  app.use(runtime.createPinia()); app.mount({ children: [] }); await flush(); return { view, calls, props, emissions, close: () => app.unmount() };
}
const writes = (calls: any[]) => calls.filter(call => call.method !== 'get');
const body = (call: any) => JSON.parse(call.data);
function input(overrides: Record<string, unknown> = {}) { return { name: ' 秋季秒杀 ', start_day: '2026-09-27', end_day: '2026-09-29', time_ids: [4], num: 5, once_num: 2, image: '/api/assets/31', status: 1, products: [{ child_id: null, product_id: 21, status: 1, skus: [{ id: null, base_unique: 'base0001', price: '12.5', quota_total: 10, enabled: true }] }], ...overrides }; }
function fill(view: any, overrides: Record<string, unknown> = {}) { Object.assign(view.form.value, { ...input(), products: [product(21, { child_id: null, skus: [sku(null, { consumed: 0, quota_total: 10, remaining: 10 })] })], ...overrides }); }

it('validates Shanghai inclusive dates, multiple slots, limits, money and stable picture references', () => {
  const normalize = runtime.api.normalizeSeckillActivityInput;
  expect(runtime.api.activityDay('2026-09-27')).toBe(Date.parse('2026-09-27T00:00:00+08:00') / 1000);
  expect(normalize(input()).name).toBe('秋季秒杀'); expect(normalize(input()).products[0].skus[0].price).toBe('12.50');
  expect(normalize(input({ end_day: '2026-09-27' })).end_day).toBe('2026-09-27');
  for (const patch of [{ name: '' }, { name: '字'.repeat(129) }, { start_day: '2026-02-30' }, { start_day: '2026-9-27' }, { end_day: '2026-09-26' }, { start_day: '2039-01-01', end_day: '2039-01-02' }, { time_ids: [] }, { time_ids: [4, 4] }, { time_ids: Array.from({ length: 65 }, (_, i) => i + 1) }, { num: 0 }, { once_num: 6 }, { image: '//image.test/a' }, { image: 'http://image.test/a' }, { image: 'https://a:b@image.test/a' }, { image: '/api/assets/31?signature=x' }, { image: '/bad\\image' }]) expect(() => normalize(input(patch))).toThrow();
  for (const bad of ['0', '-1', '1.234', '1e2', '01.50']) expect(() => normalize(input({ products: [{ ...input().products[0], skus: [{ ...input().products[0].skus[0], price: bad }] }] }))).toThrow();
  expect(runtime.api.activityImagePreview('/api/assets/31')).toBe(''); expect(runtime.api.activityImagePreview('/api/assets/31', asset().att_dir)).toContain('signature=preview');
});
it('whitelists configured total quota and retains disabled damaged identities without sales or remaining writes', () => {
  const p = product(0, { status: 0, valid: false, skus: [sku(71, { enabled: false, base_unique: '', price: 'damaged', quota_total: -2 })] });
  const result = runtime.api.normalizeSeckillActivityInput(input({ products: [p], raw: { status: 77 }, sales: 99 }));
  expect(result.products[0]).toEqual({ child_id: 61, product_id: 0, status: 0, skus: [{ id: 71, base_unique: '', price: 'damaged', quota_total: -2, enabled: false }] });
  expect(result).not.toHaveProperty('raw'); expect(result.products[0].skus[0]).not.toHaveProperty('quota');
  expect(() => runtime.api.normalizeSeckillActivityInput(input({ products: [{ ...p, child_id: null }] }))).toThrow();
  expect(runtime.api.normalizeSeckillActivityInput(input({ products: [{ ...p, skus: [] }] })).products[0].skus).toEqual([]);
});
it('rejects incomplete or over-cap details while preserving invalid and deleted historical rows', () => {
  const broken = detail(1, { start_day: '', valid: false, products: [product(0, { deleted: true, valid: false, skus: [sku(71, { valid: false, price: 'bad', base_unique: '', retired: true, enabled: false })] })] });
  expect(runtime.api.parseSeckillActivityDetail(broken).products[0].product_id).toBe(0);
  expect(() => runtime.api.parseSeckillActivityDetail(detail(1, { products: [null] }))).toThrow('商品响应格式错误');
  expect(() => runtime.api.parseSeckillActivityDetail(detail(1, { products: Array.from({ length: 101 }, () => product()) }))).toThrow('不能编辑截断数据');
  expect(() => runtime.api.parseSeckillActivityDetail(detail(1, { products: [product(21, { skus: Array.from({ length: 501 }, () => sku()) })] }))).toThrow();
  expect(() => runtime.api.parseSeckillActivityDetail(detail(1, { products: Array.from({ length: 11 }, () => product(21, { skus: Array.from({ length: 500 }, () => sku()) })) }))).toThrow('不能编辑截断数据');
  expect(() => runtime.api.parseSeckillActivityRow(row(1, { revision: '' }))).toThrow();
});
it('uses independent parent permissions and supports detail-only read access without writes or pickers', async () => {
  const denied = await mount(['activity.view', 'activity.manage', 'seckill_time.view']); try { await denied.view.openForm(1, 'view'); expect(denied.calls).toEqual([]); } finally { denied.close(); }
  const f = await mount(['seckill_activity.view']); try {
    await f.view.openForm(1, 'view'); expect(f.view.form.value.products[0].child_id).toBe(61); expect(f.view.editable.value).toBe(false);
    await f.view.save(); await f.view.openProducts(); await f.view.openForm(1, 'copy'); await f.view.remove(f.view.list.value[0]); await f.view.toggleStatus(f.view.list.value[0]);
    expect(f.view.mode.value).toBe('view'); expect(writes(f.calls)).toEqual([]); expect(f.calls.some(c => c.url.includes('/products'))).toBe(false); expect(runtime.messages.state.confirmations).toEqual([]);
  } finally { f.close(); }
});
it('keeps 15-item name/ID, phase and status filters across refresh and validates pagination', async () => {
  const f = await mount(); try {
    expect(f.calls[0]).toMatchObject({ url: endpoint, params: { page: 1, limit: 15, keyword: '', phase: '', status: '' } });
    f.view.draftKeyword.value = '  21  '; f.view.draftPhase.value = 'ended'; f.view.draftStatus.value = 0; f.view.search(); await flush(); await f.view.load(2); await f.view.load();
    expect(f.calls.at(-1).params).toEqual({ page: 2, limit: 15, keyword: '21', phase: 'ended', status: 0 }); f.view.reset(); await flush(); expect(f.calls.at(-1).params.page).toBe(1);
  } finally { f.close(); }
  const bad = await mount(grants, c => c.url === endpoint ? envelope(rows([row(), row()])) : undefined); try { expect(bad.view.listError.value).toContain('记录重复'); expect(bad.view.list.value).toEqual([]); } finally { bad.close(); }
});
it('creates through product search and full SKU detail with one UUID and no existing identities', async () => {
  const f = await mount(); try {
    await f.view.openForm(0, 'create'); await f.view.save(); expect(f.view.formError.value).toContain('活动名称'); expect(writes(f.calls)).toEqual([]);
    Object.assign(f.view.form.value, input({ products: [] })); await f.view.openProducts(); expect(f.calls.at(-1).params).toEqual({ page: 1, limit: 15, keyword: '', category_id: '', label_id: '' });
    f.view.toggleProductChoice(f.view.productOptions.value[0], true); await f.view.addSelectedProducts(); const p = f.view.form.value.products[0]; expect(p.child_id).toBeNull(); expect(p.skus[0].id).toBeNull(); expect(p.skus[0].consumed).toBe(0); expect(p.skus[0].quota_total).toBe(30);
    f.view.closeProducts(); await f.view.save(); const write = writes(f.calls)[0]; expect(write).toMatchObject({ method: 'post', url: endpoint }); expect(body(write)).toMatchObject({ name: '秋季秒杀', request_id: expect.stringMatching(uuid) });
    expect(body(write)).not.toHaveProperty('revision'); expect(body(write).products[0].skus[0]).toEqual({ id: null, base_unique: 'base0001', price: '12.50', quota_total: 30, enabled: true }); expect(f.calls.at(-1).method).toBe('get');
  } finally { f.close(); }
});
it('updates existing child and SKU identities in place using total-minus-consumed quota and fresh revision', async () => {
  const f = await mount(grants, c => c.url === `${endpoint}/1` && c.method === 'get' ? envelope(detail(1, { revision: 'b'.repeat(64) })) : undefined); try {
    await f.view.openForm(1, 'edit'); const s = f.view.form.value.products[0].skus[0]; expect(s).toMatchObject({ cost: '8.00', ot_price: '15.00' }); s.quota_total = 20; expect(f.view.nextRemaining(s)).toBe(17); f.view.form.value.status = 0; await f.view.save();
    const write = writes(f.calls)[0]; expect(write.method).toBe('put'); expect(body(write)).toMatchObject({ revision: 'b'.repeat(64), status: 0, products: [{ child_id: 61, product_id: 21, status: 1, skus: [{ id: 71, quota_total: 20 }] }] });
    for (const key of ['quota', 'quota_show', 'consumed', 'remaining', 'stock', 'sales', 'unique', 'suk', 'cost', 'ot_price']) expect(body(write).products[0].skus[0]).not.toHaveProperty(key);
  } finally { f.close(); }
});
it('keeps damaged historical source and SKU identities visible and allows explicit retirement or price repair', async () => {
  const bad = product(0, { valid: false, issues: ['基础商品不存在'], skus: [sku(71, { valid: false, base_unique: '', price: 'bad', issues: ['基础规格不存在'] })] });
  const f = await mount(grants, c => c.url === `${endpoint}/1` && c.method === 'get' ? envelope(detail(1, { valid: false, products: [bad] })) : undefined); try {
    await f.view.openForm(1, 'edit'); expect(f.view.form.value.products[0].product_id).toBe(0); f.view.removeProduct(f.view.form.value.products[0]); await f.view.save();
    expect(body(writes(f.calls)[0]).products[0]).toMatchObject({ child_id: 61, product_id: 0, status: 0, skus: [{ id: 71, price: 'bad', enabled: false }] });
  } finally { f.close(); }
  const repair = await mount(grants, c => c.url === `${endpoint}/1` && c.method === 'get' ? envelope(detail(1, { products: [product(21, { skus: [sku(71, { valid: false, price: 'bad' })] })] })) : undefined); try { await repair.view.openForm(1, 'edit'); repair.view.form.value.products[0].skus[0].price = '15'; await repair.view.save(); expect(body(writes(repair.calls)[0]).products[0].skus[0].price).toBe('15.00'); } finally { repair.close(); }
});
it('copies into POST using source remaining quota and clears child/SKU identity and revision', async () => {
  const f = await mount(); try {
    await f.view.openForm(1, 'copy'); expect(f.view.formId.value).toBe(0); const p = f.view.form.value.products[0]; expect(p.child_id).toBeNull(); expect(p.skus[0]).toMatchObject({ id: null, consumed: 0, quota_total: 7, remaining: 7 });
    await f.view.save(); const write = writes(f.calls)[0]; expect(write.method).toBe('post'); expect(body(write)).not.toHaveProperty('revision'); expect(body(write).products[0].skus[0].quota_total).toBe(7);
    expect(detail().products[0].skus[0].id).toBe(71);
  } finally { f.close(); }
});
it('does not revive retired SKU or deleted child identities and blocks total quota below consumed', async () => {
  const f = await mount(grants, c => c.url === `${endpoint}/1` && c.method === 'get' ? envelope(detail(1, { products: [product(21, { skus: [sku(71, { retired: true, enabled: false }), sku(72, { base_unique: 'base0002', unique: 'sell0002', suk: '蓝色,M' })] })] })) : undefined); try {
    await f.view.openForm(1, 'edit'); const p = f.view.form.value.products[0]; f.view.selectSkus(p); expect(p.skus[0].enabled).toBe(false); p.skus[1].quota_total = 2; await f.view.save(); expect(f.view.formError.value).toContain('小于已消耗'); expect(writes(f.calls)).toEqual([]);
    p.skus[1].quota_total = 3; await f.view.save(); expect(body(writes(f.calls)[0]).products[0].skus[0]).toMatchObject({ id: 71, enabled: false });
  } finally { f.close(); }
});
it('shows deleted and damaged copy sources until explicitly removed, without reviving their identities', async () => {
  const f = await mount(grants, c => c.url === `${endpoint}/1` && c.method === 'get' ? envelope(detail(1, { products: [product(), product(22, { child_id: 62, deleted: true, skus: [sku(72, { enabled: false, retired: true, base_unique: 'base0002' })] })] })) : undefined); try {
    await f.view.openForm(1, 'copy'); const history = f.view.form.value.products[1]; expect(history.deleted).toBe(true); expect(history.skus[0].enabled).toBe(false); expect(history.child_id).toBeNull();
    f.view.selectSkus(history); expect(history.skus[0].enabled).toBe(false); f.view.removeProduct(history); expect(f.view.form.value.products).toHaveLength(1); await f.view.save(); expect(body(writes(f.calls)[0]).products).toHaveLength(1);
  } finally { f.close(); }
});
it('blocks writes when complete option capacity cannot be verified, and recovers through GET', async () => {
  let broken = true; const f = await mount(grants, c => c.url.endsWith('/options') && broken ? envelope(options({ max_total_skus: 500 })) : undefined); try {
    await f.view.openForm(0, 'create'); fill(f.view); expect(f.view.optionsError.value).toContain('选项响应格式错误'); await f.view.save(); expect(writes(f.calls)).toEqual([]); broken = false; await f.view.loadOptions(); await f.view.save(); expect(writes(f.calls)).toHaveLength(1);
  } finally { f.close(); }
});
it('confirms explicit parent-to-all-child status changes, cancel and soft delete', async () => {
  const f = await mount(grants, c => c.url === endpoint ? envelope(rows([row(1, { status: 0 })])) : undefined); try {
    runtime.messages.state.confirm = () => Promise.reject('cancel'); await f.view.toggleStatus(f.view.list.value[0]); expect(writes(f.calls)).toEqual([]);
    runtime.messages.state.confirm = () => Promise.resolve(); await f.view.toggleStatus(f.view.list.value[0]); expect(runtime.messages.state.confirmations.at(-1)[0]).toContain('之前单独关闭的商品也会被重新开启');
    expect(body(writes(f.calls)[0])).toEqual({ revision, request_id: expect.stringMatching(uuid), status: 1 }); await f.view.remove(f.view.list.value[0]); expect(writes(f.calls)[1].method).toBe('delete'); expect(runtime.messages.state.confirmations.at(-1)[0]).toContain('订单、退款和规格身份会保留');
  } finally { f.close(); }
});
it('deletes the last tail row and returns to the preceding filtered page', async () => {
  let deleted = false; const f = await mount(grants, c => { if (c.method === 'delete') { deleted = true; return envelope({ id: 16 }); } if (c.url === endpoint) return envelope(c.params.page === 2 ? rows(deleted ? [] : [row(16)], deleted ? 15 : 16, 2) : rows(Array.from({ length: 15 }, (_, i) => row(i + 1)), deleted ? 15 : 16)); return undefined; }); try {
    f.view.draftKeyword.value = '秋季'; f.view.draftStatus.value = 1; f.view.draftPhase.value = 'active'; f.view.search(); await flush(); await f.view.load(2); await f.view.remove(f.view.list.value[0]);
    expect(f.view.page.value).toBe(1); expect(f.calls.at(-1).params).toEqual({ page: 1, limit: 15, keyword: '秋季', status: 1, phase: 'active' });
  } finally { f.close(); }
});
it.each(['network', 'malformed', 'conflict'])('only rereads after %s mutation and never automatically repeats the UUID', async failure => {
  const f = await mount(grants, c => { if (c.method === 'get') return undefined; if (failure === 'network') throw Error('断线'); return failure === 'malformed' ? envelope({}) : envelope(null, 409, '活动已变化'); }); try {
    await f.view.openForm(0, 'create'); fill(f.view); await f.view.save(); expect(writes(f.calls)).toHaveLength(1); expect(f.calls.at(-1).method).toBe('get'); expect(runtime.messages.state.successes).toEqual([]); expect(f.view.actionNotice.value).toContain(failure === 'conflict' ? '操作未完成' : '操作结果未确认');
    if (failure !== 'conflict') expect(f.view.uncertainOperation.value.body).toEqual(body(writes(f.calls)[0])); await f.view.load(); expect(writes(f.calls)).toHaveLength(1);
  } finally { f.close(); }
});
it('drops late list, detail, option and source-product responses when their editor scope changes', async () => {
  const lateList = deferred(), lateDetail = deferred(), lateOptions = deferred(), lateProduct = deferred(); let pending = '';
  const f = await mount(grants, c => pending === 'list' && c.url === endpoint ? lateList.promise : pending === 'detail' && c.url === `${endpoint}/1` ? lateDetail.promise : pending === 'options' && c.url.endsWith('/options') ? lateOptions.promise : pending === 'product' && c.url.includes('/products/') ? lateProduct.promise : undefined); try {
    pending = 'list'; const reading = f.view.load(); await flush(); pending = ''; await f.view.load(); lateList.resolve(envelope(rows([row(99)]))); await reading; expect(f.view.list.value[0].id).toBe(1);
    pending = 'detail'; const opening = f.view.openForm(1, 'edit'); await flush(); pending = ''; await f.view.openForm(0, 'create'); lateDetail.resolve(envelope(detail())); await opening; expect(f.view.formId.value).toBe(0); expect(f.view.form.value.name).toBe('');
    pending = 'options'; const options = f.view.loadOptions(); await flush(); f.view.closeForm(); lateOptions.resolve(envelope({ times: [slot(99)], max_slots: 64, max_products: 100, max_skus: 500 })); await options; expect(f.view.availableTimes.value).toEqual([]);
    pending = ''; await f.view.openForm(0, 'create'); await f.view.openProducts(); f.view.toggleProductChoice(f.view.productOptions.value[0], true); pending = 'product'; const adding = f.view.addSelectedProducts(); await flush(); f.view.closeProducts(); lateProduct.resolve(envelope(source())); await adding; expect(f.view.form.value.products).toEqual([]);
  } finally { f.close(); }
});
it('invalidates pending confirmation and delayed writes during A-B-A account replacement', async () => {
  const confirmation = deferred(), mutation = deferred(); runtime.messages.state.confirm = () => confirmation.promise;
  const f = await mount(grants, c => c.method === 'post' ? mutation.promise : undefined); try {
    const changing = f.view.toggleStatus(f.view.list.value[0]); login(grants, 'parent-token-b', 21); browser.dispatchEvent(new Event('admin-session-changed')); login(); browser.dispatchEvent(new Event('admin-session-changed')); await flush(); confirmation.resolve(); await changing; expect(writes(f.calls)).toEqual([]);
    await f.view.openForm(0, 'create'); fill(f.view); const saving = f.view.save(); await flush(); const old = writes(f.calls)[0]; login(grants, 'parent-token-b', 21); browser.dispatchEvent(Object.assign(new Event('storage'), { key: 'admin_session' })); await flush(); await f.view.openForm(0, 'create'); fill(f.view, { name: '新账号表单' }); mutation.resolve(envelope({ id: 99 })); await saving;
    expect(old.signal.aborted).toBe(true); expect(f.view.form.value.name).toBe('新账号表单'); expect(f.view.formVisible.value).toBe(true); expect(runtime.messages.state.successes).toEqual([]);
  } finally { f.close(); }
});
it('reads invalid historical parents without enabling them or silently editing failed details', async () => {
  const f = await mount(grants, c => c.url === endpoint ? envelope(rows([row(1, { status: 0, valid: false, phase: 'invalid', start_day: '', issues: ['日期损坏'] })])) : c.url === `${endpoint}/1` ? envelope(detail(2)) : undefined); try {
    await f.view.toggleStatus(f.view.list.value[0]); expect(writes(f.calls)).toEqual([]); expect(f.view.actionNotice.value).toContain('先编辑修复'); await f.view.openForm(1, 'edit'); expect(f.view.form.value).toBeNull(); expect(f.view.formError.value).toContain('身份不一致');
  } finally { f.close(); }
});
it('builds a complete selectable classification tree and rejects ambiguous or over-cap options', async () => {
  const tree = runtime.api.activityCategoryTree;
  expect(tree(options().categories)).toEqual([{ value: 1, label: '食品', children: [{ value: 2, label: '套餐' }] }]);
  for (const categories of [[{ id: 1, pid: 0, cate_name: '甲' }, { id: 1, pid: 0, cate_name: '乙' }], [{ id: 1, pid: 9, cate_name: '孤项' }], [{ id: 1, pid: 2, cate_name: '甲' }, { id: 2, pid: 1, cate_name: '乙' }], [{ id: 0, pid: 0, cate_name: '非法' }], Array.from({ length: 5001 }, (_, index) => ({ id: index + 1, pid: 0, cate_name: '超限' }))]) expect(() => tree(categories)).toThrow();
  const f = await mount(grants, c => c.url.endsWith('/options') ? envelope(options({ labels: [{ id: 8, label_name: '甲' }, { id: 8, label_name: '乙' }] })) : undefined); try { await f.view.openForm(0, 'create'); expect(f.view.optionsError.value).toContain('标签选项格式错误'); await f.view.openProducts(); expect(f.calls.some(c => c.url.endsWith('/products'))).toBe(false); } finally { f.close(); }
});
it('filters products by a single parent category and hidden label without losing the selected ID cache', async () => {
  const f = await mount(); try {
    await f.view.openForm(0, 'create'); await f.view.openProducts(); f.view.toggleProductChoice(f.view.productOptions.value[0], true);
    expect(f.view.categoryOptions.value[0].children[0].value).toBe(2); expect(f.view.productLabels.value[0]).toMatchObject({ id: 8, status: 0, is_show: 0 });
    f.view.productCategory.value = 1; f.view.productLabel.value = 8; f.view.productKeyword.value = '  套餐 '; f.view.searchProducts(); await flush();
    expect(f.calls.at(-1).params).toEqual({ page: 1, limit: 15, keyword: '套餐', category_id: 1, label_id: 8 }); expect(f.view.productChoices.value.map((p: any) => p.product_id)).toEqual([21]);
    f.view.resetProducts(); await flush(); expect(f.calls.at(-1).params).toEqual({ page: 1, limit: 15, keyword: '', category_id: '', label_id: '' }); expect(f.view.productChoices.value).toHaveLength(1);
  } finally { f.close(); }
});
it('retains cross-page selections and current-page select-all only changes that page', async () => {
  const f = await mount(grants, c => c.url.endsWith('/products') ? envelope(rows(c.params.page === 1 ? [option(21), option(22)] : [option(23), option(24, { valid: false })], 17, c.params.page)) : undefined); try {
    await f.view.openForm(0, 'create'); await f.view.openProducts(); f.view.togglePageProducts(true); expect(f.view.allPageProductsSelected.value).toBe(true);
    await f.view.loadProducts(2); expect(f.view.allPageProductsSelected.value).toBe(false); f.view.togglePageProducts(true); expect(f.view.productChoices.value.map((p: any) => p.product_id)).toEqual([21, 22, 23]);
    f.view.togglePageProducts(false); expect(f.view.productChoices.value.map((p: any) => p.product_id)).toEqual([21, 22]); await f.view.loadProducts(1); expect(f.view.allPageProductsSelected.value).toBe(true);
    f.view.removeProductChoice(21); expect(f.view.somePageProductsSelected.value).toBe(true); expect(f.view.allPageProductsSelected.value).toBe(false); f.view.clearProductChoices(); expect(f.view.productChoices.value).toEqual([]);
  } finally { f.close(); }
});
it('rereads every selected source then commits one complete batch using authoritative SKU data', async () => {
  const second = deferred(); const f = await mount(grants, c => c.url.endsWith('/products') ? envelope(rows([option(21), option(22)], 2)) : c.url === `${endpoint}/products/21` ? envelope(source(21, { store_name: '已更新来源', product_type: 4, category_name: '新分类', skus: [sku(901, { base_stock: 17, price: '23.00', image: '/api/assets/81', image_preview: '/api/assets/81?signature=own' })] })) : c.url === `${endpoint}/products/22` ? second.promise : undefined); try {
    await f.view.openForm(0, 'create'); await f.view.openProducts(); f.view.togglePageProducts(true); const adding = f.view.addSelectedProducts(); await flush();
    expect(f.view.productReadProgress.value).toBe(1); expect(f.view.form.value.products).toEqual([]); expect(f.view.addingProduct.value).toBe(true); await f.view.save(); expect(writes(f.calls)).toEqual([]);
    second.resolve(envelope(source(22, { store_name: '第二商品', skus: [sku(902, { base_unique: 'base0002' })] }))); await adding;
    expect(f.view.form.value.products).toHaveLength(2); expect(f.view.form.value.products[0]).toMatchObject({ child_id: null, store_name: '已更新来源', product_type: 4, category_name: '新分类', skus: [{ id: null, unique: '', consumed: 0, quota_total: 17, price: '23.00', image_preview: '/api/assets/81?signature=own' }] });
    const sourceReads = f.calls.filter(c => c.url.includes('/products/')); expect(sourceReads.map(c => c.url)).toEqual([`${endpoint}/products/21`, `${endpoint}/products/22`]); expect(sourceReads[0].signal).toBe(sourceReads[1].signal);
    expect(f.view.expandedProducts.value).toEqual([]); expect(f.view.productsVisible.value).toBe(false); expect(writes(f.calls)).toEqual([]);
  } finally { f.close(); }
});
it.each(['network', 'invalid', 'identity', 'over-cap'])('preserves all selections and makes no partial additions after a %s source failure', async failure => {
  let broken = true; const f = await mount(grants, c => {
    if (c.url.endsWith('/products')) return envelope(rows([option(21), option(22)], 2));
    if (c.url === `${endpoint}/products/22` && broken) { if (failure === 'network') throw Error('来源断线'); return envelope(failure === 'invalid' ? source(22, { valid: false }) : failure === 'identity' ? source(99) : source(22, { skus: Array.from({ length: 501 }, () => sku()) })); }
    return undefined;
  }); try {
    await f.view.openForm(0, 'create'); await f.view.openProducts(); f.view.togglePageProducts(true); await f.view.addSelectedProducts();
    expect(f.view.form.value.products).toEqual([]); expect(f.view.productChoices.value.map((p: any) => p.product_id)).toEqual([21, 22]); expect(f.view.productsVisible.value).toBe(true); expect(f.view.productError.value).not.toBe(''); expect(writes(f.calls)).toEqual([]);
    broken = false; await f.view.addSelectedProducts(); expect(f.view.form.value.products.map((p: any) => p.product_id)).toEqual([21, 22]); expect(f.calls.filter(c => c.url === `${endpoint}/products/21`)).toHaveLength(2);
  } finally { f.close(); }
});
it('enforces the 100-product capacity before page selection and before authoritative source reads', async () => {
  const f = await mount(grants, c => c.url.endsWith('/products') ? envelope(rows([option(21), option(22)], 2)) : undefined); try {
    await f.view.openForm(0, 'create'); f.view.form.value.products = Array.from({ length: 99 }, (_, index) => product(index + 100, { child_id: null })); await f.view.openProducts(); f.view.togglePageProducts(true);
    expect(f.view.productChoices.value).toEqual([]); expect(f.view.productError.value).toContain('100'); f.view.toggleProductChoice(f.view.productOptions.value[0], true); expect(f.view.productChoices.value).toHaveLength(1);
    f.view.form.value.products.push(product(300, { child_id: null })); await f.view.addSelectedProducts(); expect(f.calls.filter(c => c.url.includes('/products/'))).toEqual([]); expect(f.view.form.value.products).toHaveLength(100);
  } finally { f.close(); }
});
it('rejects an entire selected batch when complete source SKU counts would exceed 5000', async () => {
  const f = await mount(grants, c => c.url.endsWith('/products') ? envelope(rows([option(21), option(22)], 2)) : c.url.includes('/products/') ? envelope(source(Number(c.url.split('/').at(-1)), { skus: Array.from({ length: 6 }, (_, index) => sku(null, { base_unique: `sku${index}`, suk: `规格${index}` })) })) : undefined); try {
    await f.view.openForm(0, 'create'); f.view.form.value.products = Array.from({ length: 10 }, (_, index) => product(index + 100, { child_id: null, skus: Array.from({ length: 499 }, () => sku(null)) })); await f.view.openProducts(); f.view.togglePageProducts(true); await f.view.addSelectedProducts();
    expect(f.view.productError.value).toContain('5000'); expect(f.view.form.value.products).toHaveLength(10); expect(f.view.skuCount.value).toBe(4990); expect(f.view.productChoices.value).toHaveLength(2); expect(writes(f.calls)).toEqual([]);
  } finally { f.close(); }
});
it.each(['picker', 'account'])('discards a partially read batch after %s replacement and aborts the shared source request', async replacement => {
  const late = deferred(); const f = await mount(grants, c => c.url.endsWith('/products') ? envelope(rows([option(21), option(22)], 2)) : c.url === `${endpoint}/products/22` ? late.promise : undefined); try {
    await f.view.openForm(0, 'create'); await f.view.openProducts(); f.view.togglePageProducts(true); const adding = f.view.addSelectedProducts(); await flush(); expect(f.view.productReadProgress.value).toBe(1); const old = f.calls.at(-1);
    if (replacement === 'picker') { f.view.closeProducts(); await f.view.openProducts(); } else { login(grants, 'parent-token-b', 21); browser.dispatchEvent(new Event('admin-session-changed')); login(); browser.dispatchEvent(new Event('admin-session-changed')); await flush(); await f.view.openForm(0, 'create'); await f.view.openProducts(); }
    f.view.toggleProductChoice(f.view.productOptions.value[0], true); late.resolve(envelope(source(22))); await adding;
    expect(old.signal.aborted).toBe(true); expect(f.view.form.value.products).toEqual([]); expect(f.view.productChoices.value.map((p: any) => p.product_id)).toEqual([21]); expect(f.view.addingProduct.value).toBe(false); expect(writes(f.calls)).toEqual([]);
  } finally { f.close(); }
});
it('drops a late product page after filtering while retaining selected IDs from the previous page', async () => {
  const late = deferred(); const f = await mount(grants, c => c.url.endsWith('/products') && c.params.page === 2 ? late.promise : undefined); try {
    await f.view.openForm(0, 'create'); await f.view.openProducts(); f.view.togglePageProducts(true); const paging = f.view.loadProducts(2); await flush(); const old = f.calls.at(-1);
    f.view.productCategory.value = 1; f.view.searchProducts(); await flush(); late.resolve(envelope(rows([option(99)], 16, 2))); await paging;
    expect(old.signal.aborted).toBe(true); expect(f.view.productPage.value).toBe(1); expect(f.view.productOptions.value[0].product_id).toBe(21); expect(f.view.productChoices.value[0].product_id).toBe(21);
  } finally { f.close(); }
});
it('applies cross-product price and configured total atomically without changing consumed, IDs or inactive history', async () => {
  const sourceProducts = [product(21, { skus: [sku(71), sku(72, { base_unique: 'base0002', enabled: false, consumed: 9 }), sku(73, { base_unique: 'base0003', retired: true, enabled: false })] }), product(22, { child_id: 62, status: 0, skus: [sku(74, { base_unique: 'base0004', consumed: 5, remaining: 5 })] }), product(23, { child_id: 63, deleted: true, skus: [sku(75, { enabled: false, retired: true })] })];
  const f = await mount(grants, c => c.url === `${endpoint}/1` && c.method === 'get' ? envelope(detail(1, { products: sourceProducts })) : undefined); try {
    await f.view.openForm(1, 'edit'); f.view.toggleAllBulkProducts(true); expect(f.view.bulkProductKeys.value).toEqual(['child:61', 'child:62']); f.view.openBulkSettings(); f.view.bulkPrice.value = '18.5'; f.view.bulkQuota.value = '20'; f.view.applyBulkSettings();
    const [first, second, history] = f.view.form.value.products; expect(first.skus[0]).toMatchObject({ id: 71, unique: 'sell0001', price: '18.50', quota_total: 20, consumed: 3, remaining: 7, stock: 7 }); expect(second).toMatchObject({ status: 0, skus: [{ id: 74, price: '18.50', quota_total: 20, consumed: 5, remaining: 5 }] });
    expect(first.skus[1]).toMatchObject({ id: 72, enabled: false, price: '12.50', quota_total: 10 }); expect(first.skus[2]).toMatchObject({ id: 73, retired: true, enabled: false, price: '12.50' }); expect(history.deleted).toBe(true); expect(history.skus[0].quota_total).toBe(10); expect(writes(f.calls)).toEqual([]);
    await f.view.save(); const submitted = body(writes(f.calls)[0]); expect(submitted.products[1].status).toBe(0); expect(submitted.products[0].skus[0]).toEqual({ id: 71, base_unique: 'base0001', price: '18.50', quota_total: 20, enabled: true });
    for (const key of ['image', 'image_preview', 'cost', 'ot_price', 'consumed', 'remaining', 'unique']) expect(submitted.products[0].skus[0]).not.toHaveProperty(key); for (const key of ['product_type', 'category_name']) expect(submitted.products[0]).not.toHaveProperty(key);
  } finally { f.close(); }
});
it.each(['4', '1.5', '2147483648'])('leaves every selected price and quota intact when bulk quota %s is invalid', async quota => {
  const f = await mount(grants, c => c.url === `${endpoint}/1` && c.method === 'get' ? envelope(detail(1, { products: [product(), product(22, { child_id: 62, skus: [sku(72, { consumed: 5, base_unique: 'base0002' })] })] })) : undefined); try {
    await f.view.openForm(1, 'edit'); f.view.toggleAllBulkProducts(true); f.view.openBulkSettings(); f.view.bulkPrice.value = '19'; f.view.bulkQuota.value = quota; f.view.applyBulkSettings();
    expect(f.view.bulkError.value).not.toBe(''); expect(f.view.bulkVisible.value).toBe(true); for (const p of f.view.form.value.products) expect(p.skus[0]).toMatchObject({ price: '12.50', quota_total: 10 }); await f.view.save(); expect(writes(f.calls)).toEqual([]);
  } finally { f.close(); }
});
it('keeps bulk selection stable across filtered and removed draft rows and never selects deleted history', async () => {
  const f = await mount(); try {
    await f.view.openForm(0, 'create'); f.view.form.value.products = [product(21, { child_id: null }), product(22, { child_id: null, store_name: '晚餐' }), product(23, { child_id: null, deleted: true })];
    f.view.toggleBulkProduct(f.view.form.value.products[1], true); f.view.removeProduct(f.view.form.value.products[0]); expect(f.view.bulkProductKeys.value).toEqual(['base:22']); expect(f.view.productKey(f.view.form.value.products[0], 0)).toBe('base:22');
    f.view.productFilter.value = '23'; f.view.toggleAllBulkProducts(true); expect(f.view.bulkProductKeys.value).toEqual(['base:22']); f.view.productFilter.value = '晚餐'; expect(f.view.allBulkSelected.value).toBe(true);
    f.view.openBulkSettings(); f.view.bulkPrice.value = '22'; f.view.applyBulkSettings(); expect(f.view.form.value.products[0].skus[0].price).toBe('22.00'); expect(f.view.form.value.products[1].skus[0].price).toBe('12.50');
  } finally { f.close(); }
});
it('only removes after confirmation, retaining saved identities and disabling every historical SKU', async () => {
  const f = await mount(grants, c => c.url === `${endpoint}/1` && c.method === 'get' ? envelope(detail(1, { products: [product(), product(22, { child_id: null, skus: [sku(null)] }), product(23, { child_id: 63, deleted: true, skus: [sku(73, { retired: true, enabled: false })] })] })) : undefined); try {
    await f.view.openForm(1, 'edit'); f.view.toggleAllBulkProducts(true); runtime.messages.state.confirm = () => Promise.reject('cancel'); await f.view.removeBulkProducts(); expect(f.view.form.value.products).toHaveLength(3); expect(f.view.form.value.products[0].skus[0].enabled).toBe(true);
    runtime.messages.state.confirm = () => Promise.resolve(); await f.view.removeBulkProducts(); expect(f.view.form.value.products).toHaveLength(2); expect(f.view.form.value.products[0]).toMatchObject({ child_id: 61, product_id: 21, status: 0, skus: [{ id: 71, unique: 'sell0001', consumed: 3, enabled: false }] }); expect(f.view.form.value.products[1]).toMatchObject({ child_id: 63, deleted: true }); expect(writes(f.calls)).toEqual([]);
    expect(runtime.messages.state.confirmations.at(-1)[0]).toContain('保存活动后生效'); await f.view.save(); expect(body(writes(f.calls)[0]).products[0]).toMatchObject({ child_id: 61, status: 0, skus: [{ id: 71, enabled: false }] });
  } finally { f.close(); }
});
it('invalidates deferred bulk confirmation and bulk settings when the owning editor is replaced', async () => {
  const confirmation = deferred(); runtime.messages.state.confirm = () => confirmation.promise; const f = await mount(); try {
    await f.view.openForm(1, 'edit'); f.view.toggleAllBulkProducts(true); const removing = f.view.removeBulkProducts(); await flush(); expect(f.view.bulkRemoving.value).toBe(true); await f.view.save(); expect(writes(f.calls)).toEqual([]);
    f.view.closeForm(); await f.view.openForm(0, 'create'); fill(f.view); confirmation.resolve(); await removing; expect(f.view.form.value.products[0].status).toBe(1); expect(f.view.form.value.products[0].skus[0].enabled).toBe(true); expect(runtime.messages.state.closed).toBeGreaterThan(0);
    f.view.toggleAllBulkProducts(true); f.view.openBulkSettings(); f.view.bulkPrice.value = '99'; login(grants, 'parent-token-b', 21); browser.dispatchEvent(new Event('admin-session-changed')); await flush(); await f.view.openForm(0, 'create'); fill(f.view); f.view.applyBulkSettings(); expect(f.view.form.value.products[0].skus[0].price).toBe('12.50'); expect(f.view.bulkVisible.value).toBe(false);
  } finally { f.close(); }
});
it('does not expose picker or bulk draft mutations to a parent view-only account', async () => {
  const f = await mount(['seckill_activity.view']); try {
    await f.view.openForm(1, 'view'); const p = f.view.form.value.products[0]; f.view.toggleBulkProduct(p, true); f.view.toggleAllBulkProducts(true); f.view.openBulkSettings(); f.view.batchPrice.value = '99'; f.view.applyBatch(p); await f.view.removeBulkProducts(); f.view.removeProduct(p); await f.view.openProducts();
    expect(p).toMatchObject({ status: 1, skus: [{ id: 71, price: '12.50', enabled: true }] }); expect(f.view.bulkProductKeys.value).toEqual([]); expect(f.view.bulkVisible.value).toBe(false); expect(f.view.productsVisible.value).toBe(false); expect(runtime.messages.state.confirmations).toEqual([]); expect(writes(f.calls)).toEqual([]);
  } finally { f.close(); }
});
it('uses each SKU signed preview without product-photo fallback and keeps business type labels distinct from owner scope', async () => {
  const f = await mount(grants, c => c.url === `${endpoint}/1` && c.method === 'get' ? envelope(detail(1, { products: [product(21, { product_type: 4, skus: [sku(71, { image: '/private/supplier-one.png', image_preview: '/api/assets/81?signature=own' }), sku(72, { image: '/private/other.png', image_preview: '' }), sku(73, { image_preview: 'javascript:alert(1)' })] })] })) : undefined); try {
    await f.view.openForm(1, 'view'); const p = f.view.form.value.products[0]; expect(f.view.productImage(p)).toContain('signature=product'); expect(p.category_name).toBe('食品 / 套餐'); expect(f.view.skuImage(p.skus[0])).toBe('/api/assets/81?signature=own'); expect(f.view.skuImage(p.skus[1])).toBe(''); expect(f.view.skuImage(p.skus[2])).toBe('');
    expect([0, 1, 2, 3, 4, 9].map(value => f.view.productTypeLabel(value))).toEqual(['普通商品', '卡密商品', '优惠券商品', '虚拟商品', '次卡商品', '未知类型 #9']);
  } finally { f.close(); }
});
it('keeps the gallery behind attachment ACL and emits a canonical reference with signed preview', async () => {
  const denied = await mount(grants, undefined, true); try { await denied.view.open(); expect(denied.calls).toEqual([]); } finally { denied.close(); }
  const f = await mount([...grants, 'attachment.view'], undefined, true); try {
    await f.view.open(); expect(f.view.canUpload.value).toBe(false); expect(f.calls.at(-1)).toMatchObject({ url: '/file/file', params: { page: 1, limit: 20, pid: 0, name: '', file_type: 1 } }); f.view.choose(f.view.items.value[0]); expect(f.emissions).toEqual([['choose', '/api/assets/31', '/api/assets/31?signature=preview']]); expect(f.view.visible.value).toBe(false);
  } finally { f.close(); }
});
it('uploads only valid raster files with attachment.manage and reads back an unknown upload once', async () => {
  const f = await mount([...grants, 'attachment.view', 'attachment.manage'], c => c.url === '/file/upload' ? Promise.reject(Error('上传断线')) : undefined, true); try {
    await f.view.open(); await f.view.upload({ file: new File(['svg'], 'a.svg', { type: 'image/svg+xml' }) }); expect(writes(f.calls)).toEqual([]); await f.view.upload({ file: new File(['png'], 'a.png', { type: 'image/png' }) });
    expect(writes(f.calls)).toHaveLength(1); expect(writes(f.calls)[0].data).toBeInstanceOf(FormData); expect(f.calls.at(-1).method).toBe('get'); expect(f.view.error.value).toContain('上传结果未确认'); await f.view.load(); expect(writes(f.calls)).toHaveLength(1);
  } finally { f.close(); }
});
it('cancels gallery results and selection when the owning editor or account changes', async () => {
  const late = deferred(); let hold = false; const f = await mount([...grants, 'attachment.view'], c => c.url === '/file/file' && hold ? late.promise : undefined, true); try {
    await f.view.open(); const old = f.view.items.value[0]; hold = true; const loading = f.view.load(); await flush(); f.props.editorKey = 'editor-b'; late.resolve(envelope({ list: [asset(99)], count: 1 })); await loading; f.view.choose(old); expect(f.view.visible.value).toBe(false); expect(f.view.items.value).toEqual([]); expect(f.emissions).toEqual([]);
    hold = false; await f.view.open(); login([], 'parent-token-b', 21); f.view.choose(f.view.items.value[0]); expect(f.emissions).toEqual([]);
  } finally { f.close(); }
});
