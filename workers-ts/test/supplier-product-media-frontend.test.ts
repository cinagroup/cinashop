import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../view/supplier-ts');
const require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript } = require('@vue/compiler-sfc');
let runtime: any, pinia: any, windowSurface: EventTarget;
beforeAll(async () => {
  const result = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    export { default as Form } from './src/pages/ProductForm.vue';
    export { default as Picker } from './src/components/ProductImagePicker.vue';
    export { http } from './src/api/http'; export * as media from './src/utils/productMedia';
    export * as dialog from 'element-plus'; export { createPinia, disposePinia } from 'pinia';
    export { createRenderer, h, nextTick, reactive } from 'vue';
    export { createRouter, createMemoryHistory, RouterView } from 'vue-router';
  ` }, alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_API_BASE_URL': '"/supplierapi"', '__VUE_OPTIONS_API__': 'true', '__VUE_PROD_DEVTOOLS__': 'false', '__VUE_PROD_HYDRATION_MISMATCH_DETAILS__': 'false' },
    bundle: true, write: false, platform: 'browser', format: 'esm', plugins: [{ name: 'actual-media-sfc', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({ contents: compileScript(parse(readFileSync(path, 'utf8'), { filename: path }).descriptor, { id: 'supplier-media-regression' }).content, loader: 'ts' }));
      builder.onResolve({ filter: /^element-plus$/ }, () => ({ path: 'dialogs', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const messages=[];
        export const ElMessage={success:m=>messages.push(m),warning:m=>messages.push(m),error:m=>messages.push(m)};
        export const ElMessageBox={confirm:async()=>{},prompt:async()=>({value:'fixture'})};` }));
      builder.onResolve({ filter: /^@element-plus\/icons-vue$/ }, () => ({ path: 'icons', namespace: 'fixture-icons' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture-icons' }, () => ({ contents: 'export const ArrowLeft={},Delete={},Plus={};' }));
    } }] });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}, 60_000);
beforeEach(() => {
  const storage = new Map<string, string>();
  windowSurface = new EventTarget(); vi.stubGlobal('window', windowSurface);
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  localStorage.setItem('supplier-token', 'fixture-a');
  localStorage.setItem('supplier-user', '{"id":99,"supplier_id":20}');
  localStorage.setItem('supplier-permissions', '["supplier.product.view","supplier.product.manage","supplier.attachment.view","supplier.attachment.manage"]');
  pinia = runtime.createPinia(); runtime.dialog.messages.length = 0;
  runtime.dialog.ElMessageBox.prompt = async () => ({ value: 'fixture' });
  runtime.dialog.ElMessageBox.confirm = async () => {};
});
afterEach(() => { runtime.disposePinia(pinia); vi.unstubAllGlobals(); });
const ticket = (id: number) => `/api/assets/${id}?expires=${Math.floor(Date.now() / 1000) + 900}&signature=${'a'.repeat(43)}`;
const image = (id = 1) => ({ id, pid: 0, name: `图片${id}.png`, canonicalUrl: `/api/assets/${id}`, previewUrl: ticket(id), thumbnailUrl: ticket(id) });
const rawImage = (id = 1) => ({ att_id: id, pid: 0, type: 4, file_type: 1, module_type: 1, relation_id: 20, real_name: `图片${id}.png`, att_type: 'image/png', canonical_url: `/api/assets/${id}`, att_dir: ticket(id), satt_dir: ticket(id) });
const sku = (id = 1) => ({ id, unique: `sku${id}`, suk: '默认', detail: { 规格: '默认' }, image: '', price: '2.00', settle_price: '1.00', cost: '0.00', ot_price: '0.00', vip_price: '0.00', stock: 5, bar_code: '', weight: '0.00', volume: '0.00', brokerage: '0.00', brokerage_two: '0.00', code: '' });
const product = (id = 5) => ({ id, product_type: 0, store_name: '本地商品', store_info: '', keyword: '', unit_name: '件', bar_code: '', cate_id: [1], slider_image: ['https://images.invalid/original.png'], description: '既有说明', spec_type: 0, items: [{ value: '规格', detail: ['默认'] }], attrs: [sku()], freight: 1, postage: '0.00', temp_id: 0, is_postage: 1, is_support_refund: 1, is_limit: 0, limit_type: 1, limit_num: 1, sort: 0, ficti: 0, video_link: '' });
const gate = () => { let resolve!: (value: any) => void; return { promise: new Promise<any>(r => resolve = r), resolve }; };
async function flush() { for (let i = 0; i < 30; i++) { await Promise.resolve(); await runtime.nextTick(); } }
async function mount(which: 'Form' | 'Picker' = 'Form', override: (config: any) => unknown = () => undefined) {
  const calls: any[] = [], emitted: any[] = []; let view: any;
  runtime.http.defaults.adapter = async (config: any) => {
    calls.push(config);
    const custom = await override(config);
    const data = custom ?? (config.url === '/product/category' ? [{ id: 1, cate_name: '本地分类' }] :
      config.url === '/product/product/get_rule' ? [] : config.url === '/file/category' ? { list: [] } :
      config.url === '/file/file' ? { list: [rawImage(1), rawImage(2)], count: 2 } :
      config.method === 'post' ? { id: 5 } : product(Number(config.url.split('/').at(-1)) || 5));
    return { config, data: { status: 200, msg: 'fixture', data }, status: 200, statusText: 'fixture', headers: {} };
  };
  const props = runtime.reactive({ modelValue: true, supplierId: 20, limit: 2, contextKey: 'local-1' });
  const wrapper = { setup(_: unknown, context: any) {
    view = runtime[which].setup(which === 'Picker' ? props : {}, which === 'Picker' ? { ...context, emit: (...args: any[]) => emitted.push(args) } : context);
    return () => null;
  } };
  const router = runtime.createRouter({ history: runtime.createMemoryHistory(), routes: [{ path: '/products/:id/edit', component: wrapper }, { path: '/products', component: { render: () => null } }] });
  const renderer = runtime.createRenderer({ createElement: () => ({ children: [] }), createText: (text: string) => ({ text }), createComment: (text: string) => ({ text }), insert(n: any, p: any) { n.parent = p; (p.children ??= []).push(n); }, remove() {}, parentNode: (n: any) => n.parent, nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {} });
  const app = renderer.createApp({ render: () => runtime.h(runtime.RouterView) }); app.use(pinia); app.use(router); await router.push('/products/5/edit'); app.mount({ children: [] }); await flush();
  return { view, calls, props, emitted, router, close: () => app.unmount() };
}
it('appends stable references, reorders the main image, and excludes tickets and media metadata from save', async () => {
  const f = await mount();
  try {
    f.view.openMedia('slider'); f.view.receiveMedia([image(1), image(2)]);
    expect(f.view.form.slider_image).toEqual(['https://images.invalid/original.png', '/api/assets/1', '/api/assets/2']);
    expect(f.view.previewImage('/api/assets/1')).toBe(ticket(1));
    f.view.moveSlider(2, -1); f.view.moveSlider(1, -1);
    expect(f.view.form.slider_image[0]).toBe('/api/assets/2');
    await f.view.submit();
    const writes = f.calls.filter(c => c.method === 'post'); expect(writes).toHaveLength(1);
    const payload = JSON.parse(writes[0].data); expect(payload.slider_image[0]).toBe('/api/assets/2');
    expect(JSON.stringify(payload)).not.toContain('signature='); expect(payload.media).toBeUndefined();
  } finally { f.close(); }
});
it('enforces the 20-image form limit without partially applying an oversized selection', async () => {
  const f = await mount(); try {
    f.view.form.slider_image = Array.from({ length: 19 }, (_, i) => `https://images.invalid/${i}.png`);
    f.view.openMedia('slider'); f.view.receiveMedia([image(1), image(2)]);
    expect(f.view.form.slider_image).toHaveLength(19);
    f.view.receiveMedia([image(1)]); expect(f.view.form.slider_image).toHaveLength(20);
    f.view.openMedia('slider'); expect(f.view.mediaPickerOpen.value).toBe(false);
  } finally { f.close(); }
});
it('targets one exact SKU and invalidates selection when SKU rows regenerate', async () => {
  const f = await mount(); try {
    f.view.form.attrs = [sku(1), { ...sku(2), suk: '另一个' }];
    f.view.openMedia('sku', f.view.form.attrs[1]); f.view.receiveMedia([image(2)]);
    expect(f.view.form.attrs.map((row: any) => row.image)).toEqual(['', '/api/assets/2']);
    f.view.openMedia('sku', f.view.form.attrs[0]); f.view.regenerateSkus(false); f.view.receiveMedia([image(1)]);
    expect(f.view.form.attrs[0].image).toBe('');
  } finally { f.close(); }
});
it('batch image selection only edits the explicitly selected historical SKU rows', async () => {
  const f = await mount(); try {
    f.view.form.attrs = [sku(1), { ...sku(2), suk: '另一个' }]; f.view.selectedActiveSkuIds.value = [2];
    f.view.openMedia('sku-batch'); f.view.receiveMedia([image(1)]);
    expect(f.view.form.attrs.map((row: any) => row.image)).toEqual(['', '/api/assets/1']);
  } finally { f.close(); }
});
it('inserts escaped stable HTML images and sanitizes the draft without rewriting legacy source', async () => {
  const f = await mount(); try {
    f.view.form.description = '<p>既有内容</p><script>alert(1)</script><img src="javascript:alert(2)" onerror="alert(3)">';
    f.view.openMedia('description'); f.view.receiveMedia([{ ...image(1), name: '\"><svg onload=alert(4)>' }]);
    expect(f.view.form.description).toContain('<script>'); expect(f.view.form.description).toContain('src="/api/assets/1"');
    const preview = f.view.descriptionPreview.value;
    expect(preview).toContain('/api/assets/1?expires='); expect(preview).not.toMatch(/<script|<svg|onerror=|javascript:/);
    expect(f.view.form.description).not.toContain('signature=');
  } finally { f.close(); }
});
it('refreshes only the saved media projection and never overwrites an unsaved product draft', async () => {
  const f = await mount('Form', c => c.url === '/product/product/5' ? { ...product(), media: { version: 1, previews: { '/api/assets/1': { status: 'ready', src: ticket(1), expires_at: Math.floor(Date.now() / 1000) + 900 } } } } : undefined);
  try { f.view.form.store_name = '未保存的名称'; await f.view.refreshMediaPreview(); expect(f.view.form.store_name).toBe('未保存的名称'); expect(f.view.previewImage('/api/assets/1')).toBe(ticket(1)); }
  finally { f.close(); }
});
it('clears private form data immediately on permission ABA and refuses stale save/selection', async () => {
  const f = await mount(); try {
    f.view.openMedia('slider');
    localStorage.setItem('supplier-permissions', '[]'); windowSurface.dispatchEvent(new Event('supplier-session-changed'));
    localStorage.setItem('supplier-permissions', '["supplier.product.manage","supplier.attachment.view"]'); windowSurface.dispatchEvent(new Event('supplier-session-changed'));
    f.view.receiveMedia([image(1)]); await f.view.submit();
    expect(f.view.form.store_name).toBe(''); expect(f.view.mediaPreviews.value).toEqual({}); expect(f.calls.filter(c => c.method === 'post')).toEqual([]);
  } finally { f.close(); }
});
it('ignores delayed product detail after logout rather than resurrecting images or product data', async () => {
  const wait = gate(), f = await mount('Form', c => c.url === '/product/product/5' ? wait.promise : undefined);
  try {
    localStorage.removeItem('supplier-token'); windowSurface.dispatchEvent(new Event('supplier-session-changed'));
    wait.resolve(product()); await flush(); expect(f.view.form.store_name).toBe(''); expect(f.view.form.slider_image).toEqual(['']);
  } finally { wait.resolve(product()); f.close(); }
});
it('picker cancel never emits a selection; confirm emits only the selected stable references', async () => {
  const f = await mount('Picker'); try {
    f.view.state.toggle(1); f.view.close(); f.view.confirm();
    expect(f.emitted.some(e => e[0] === 'selected')).toBe(false); expect(f.view.state.selected.value).toEqual([]);
  } finally { f.close(); }
  const fresh = await mount('Picker'); try {
    fresh.view.state.toggle(1); fresh.view.state.toggle(2); fresh.view.confirm(); fresh.view.confirm();
    const emitted = fresh.emitted.filter(e => e[0] === 'selected'); expect(emitted).toHaveLength(1);
    expect(emitted[0][1].map((i: any) => i.canonicalUrl)).toEqual(['/api/assets/1', '/api/assets/2']);
    expect(emitted[0][2]).toBe('local-1');
  } finally { fresh.close(); }
});
it('unknown upload sends once, then reads the list and disables repeated upload in that dialog', async () => {
  const f = await mount('Picker', c => { if (c.url === '/file/upload') throw new Error('fixture lost response'); });
  try {
    const target = { files: [new File([new Uint8Array([1, 2, 3])], 'fixture.png', { type: 'image/png' })], value: 'fixture' };
    await f.view.upload({ target }); await f.view.upload({ target });
    expect(f.calls.filter(c => c.url === '/file/upload')).toHaveLength(1); expect(f.view.unknownUpload.value).toBe(true);
    expect(f.calls.filter(c => c.url === '/file/file')).toHaveLength(2); expect(target.value).toBe('');
  } finally { f.close(); }
});
it('invalid upload types and sizes are rejected before any HTTP write', async () => {
  const f = await mount('Picker'); try {
    await f.view.upload({ target: { files: [new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' })], value: 'fixture' } });
    expect(f.calls.filter(c => c.method === 'post')).toEqual([]);
  } finally { f.close(); }
});
it('an expired or mismatched signed preview is unavailable and never becomes a saved reference', () => {
  const canonical = '/api/assets/7', expires = Math.floor(Date.now() / 1000) - 1;
  expect(runtime.media.productImagePreview(canonical, { [canonical]: { status: 'ready', src: ticket(7), expires_at: expires } })).toBeNull();
  expect(runtime.media.productImagePreview(canonical, { [canonical]: { status: 'ready', src: ticket(8), expires_at: expires + 901 } })).toBeNull();
  expect(runtime.media.productDescriptionPreview('<img src="/api/assets/7"><a href="javascript:alert(1)">x</a>', {})).toBe('<span>图片暂不可用</span><a>x</a>');
});
it('rejects a selection receipt for the old dialog context without editing a new target', async () => {
  const f = await mount(); try {
    f.view.openMedia('slider'); const oldContext = f.view.mediaContext.value;
    f.view.openMedia('sku', f.view.form.attrs[0]);
    f.view.receiveMedia([image(1)], oldContext);
    expect(f.view.form.attrs[0].image).toBe(''); expect(f.view.form.slider_image).toEqual(['https://images.invalid/original.png']);
    f.view.receiveMedia([image(2)], f.view.mediaContext.value); expect(f.view.form.attrs[0].image).toBe('/api/assets/2');
    f.view.receiveMedia([image(1)], f.view.mediaContext.value); expect(f.view.form.attrs[0].image).toBe('/api/assets/2');
  } finally { f.close(); }
});
it('context change cancels both dialog reads and cannot resurrect images or emit a selection', async () => {
  const wait = gate(), f = await mount('Picker', c => c.url === '/file/file' ? wait.promise : undefined);
  try {
    f.props.contextKey = 'local-2'; await flush(); expect(f.view.closed.value).toBe(true);
    wait.resolve({ list: [rawImage()], count: 1 }); await flush();
    expect(f.view.state.rows.value).toEqual([]); expect(f.view.state.toggle(1)).toBe(false); f.view.confirm();
    expect(f.emitted.some(e => e[0] === 'selected')).toBe(false);
  } finally { wait.resolve({ list: [], count: 0 }); f.close(); }
});
it('keeps a SKU confirmation pinned to its original product and sends no write after navigation', async () => {
  const f = await mount(), prompt = gate(); runtime.dialog.ElMessageBox.prompt = () => prompt.promise;
  try {
    f.view.selectedActiveSkuIds.value = [1]; const action = f.view.changeSkuLifecycle('retire');
    await f.router.push('/products/6/edit'); await flush(); prompt.resolve({ value: '固定原因' }); await action;
    expect(f.calls.filter(c => c.method === 'post')).toEqual([]); expect(f.view.form.id).toBe(6);
  } finally { prompt.resolve({ value: '固定原因' }); f.close(); }
});
it('ignores a SKU reload that returns after logout, including all private optional product fields', async () => {
  let details = 0; const wait = gate();
  const f = await mount('Form', c => {
    if (c.url.endsWith('/sku/retire')) return { verified: true, changed: 1 };
    if (c.url === '/product/product/5' && ++details > 1) return wait.promise;
    if (c.url === '/product/product/5') return { ...product(), refusal: '私密审核原因', media: { version: 1, previews: { '/api/assets/1': { status: 'ready', src: ticket(1), expires_at: Math.floor(Date.now() / 1000) + 900 } } } };
    return undefined;
  });
  try {
    f.view.selectedActiveSkuIds.value = [1]; const action = f.view.changeSkuLifecycle('retire'); await flush();
    expect(details).toBe(2);
    localStorage.removeItem('supplier-token'); windowSurface.dispatchEvent(new Event('supplier-session-changed'));
    wait.resolve({ ...product(), store_name: '旧私密商品', media: { version: 1, previews: {} } }); await action;
    expect(f.view.form.store_name).toBe(''); expect(f.view.form.media).toBeUndefined(); expect(f.view.form.refusal).toBeUndefined();
    expect(f.view.mediaPreviews.value).toEqual({}); expect(f.view.selectedActiveSkuIds.value).toEqual([]);
    f.view.imagePreviewFailed({ currentTarget: { getAttribute: () => ticket(1) } });
    expect(f.view.failedPreviewSources.value.size).toBe(0);
  } finally { wait.resolve(product()); f.close(); }
});
it('does not apply a specification prompt to a different product after navigation', async () => {
  const f = await mount(), confirm = gate(); runtime.dialog.ElMessageBox.confirm = () => confirm.promise;
  try {
    f.view.ruleTemplates.value = [{ id: 12, rule_name: '旧产品模板', spec: [{ value: '颜色', detail: ['红'] }] }]; f.view.selectedRuleId.value = 12;
    const applying = f.view.applyProductRule(); await f.router.push('/products/6/edit'); await flush(); confirm.resolve(undefined); await applying;
    expect(f.view.form.id).toBe(6); expect(f.view.form.items).toEqual([{ value: '规格', detail: ['默认'] }]);
  } finally { confirm.resolve(undefined); f.close(); }
});
it('shows real image failures as unavailable, retries only the preview map and ignores an old-src error', async () => {
  let updated = false;
  const secondTicket = `/api/assets/1?expires=${Math.floor(Date.now() / 1000) + 901}&signature=${'b'.repeat(43)}`;
  const f = await mount('Form', c => c.url === '/product/product/5' ? { ...product(), slider_image: ['/api/assets/1'], attrs: [{ ...sku(), image: '/api/assets/1' }], media: {
    version: 1, previews: { '/api/assets/1': { status: 'ready', src: updated ? secondTicket : ticket(1), expires_at: Math.floor(Date.now() / 1000) + (updated ? 901 : 900) } },
  } } : undefined);
  try {
    const firstTicket = f.view.previewImage('/api/assets/1');
    f.view.imagePreviewFailed({ currentTarget: { getAttribute: () => firstTicket } });
    expect(f.view.previewImage(f.view.form.slider_image[0])).toBeNull(); expect(f.view.previewImage(f.view.form.attrs[0].image)).toBeNull();
    f.view.form.store_name = '未保存名称'; f.view.form.attrs[0].price = '7.00'; f.view.form.description = '未保存详情';
    updated = true; await f.view.refreshMediaPreview();
    expect(f.view.previewImage('/api/assets/1')).toBe(secondTicket);
    f.view.imagePreviewFailed({ currentTarget: { getAttribute: () => firstTicket } });
    expect(f.view.previewImage('/api/assets/1')).toBe(secondTicket);
    expect(f.view.form.store_name).toBe('未保存名称'); expect(f.view.form.attrs[0].price).toBe('7.00'); expect(f.view.form.description).toBe('未保存详情');
    expect(f.view.form.slider_image).toEqual(['/api/assets/1']); expect(f.view.form.attrs[0].image).toBe('/api/assets/1');
  } finally { f.close(); }
});
it('formatting a plain description preserves literal entities, less-than characters and line breaks outside the selection', async () => {
  const f = await mount(); try {
    f.view.form.description = '词 &copy; < 三\n末尾'; f.view.descriptionCursor.value = { start: 0, end: 1 }; f.view.formatDescription('strong');
    expect(f.view.form.description).toBe('<strong>词</strong> &amp;copy; &lt; 三<br>末尾');
    expect(f.view.descriptionPreview.value).toBe('<strong>词</strong> &amp;copy; &lt; 三<br>末尾');
  } finally { f.close(); }
});
it('rejects malformed projections, normalized alternative paths, fake absolute assets and non-HMAC tickets', () => {
  const reference = '/api/assets/1', expires = Math.floor(Date.now() / 1000) + 900;
  for (const src of ['https://supplier.invalid' + ticket(1), '/foo/../api/assets/1' + ticket(1).slice('/api/assets/1'.length),
    `/api/assets/1?expires=${expires}&signature=x`, ticket(1) + '&signature=' + 'b'.repeat(43)]) {
    expect(runtime.media.productImagePreview(reference, { [reference]: { status: 'ready', src, expires_at: expires } })).toBeNull();
  }
  expect(runtime.media.productImagePreview(reference, null)).toBeNull();
  expect(runtime.media.productImagePreview('https://images.invalid/\\image.png', {})).toBeNull();
});
it('renders legacy bare HTTPS image queries completely through the shared sanitizer', () => {
  expect(runtime.media.productDescriptionPreview('<img src=https://images.example/a.jpg?x=1&y=2>', {}))
    .toBe('<img src="https://images.example/a.jpg?x=1&amp;y=2" width="100%">');
});
