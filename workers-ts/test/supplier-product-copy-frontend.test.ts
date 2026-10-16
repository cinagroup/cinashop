import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../view/supplier-ts'), require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc');
let runtime: any, pinia: any, surface: EventTarget;
beforeAll(async () => {
  const bundle = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `import Form from './src/pages/ProductForm.vue';import Products from './src/pages/Products.vue';
    export {Form,Products};export const captured={};const setup=Form.setup;Form.setup=(p,c)=>{const v=setup(p,c);captured.view=v;return v;};
    const listSetup=Products.setup;Products.setup=(p,c)=>{const v=listSetup(p,c);captured.list=v;return v;};
    export {http} from './src/api/http';export * as api from './src/api/productCopy';export * as dialogs from 'element-plus';
    export {createPinia,disposePinia} from 'pinia';export {createRenderer,h,nextTick,provide,inject} from 'vue';
    export {createRouter,createMemoryHistory,RouterView} from 'vue-router';` },
    alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_API_BASE_URL': '"/supplierapi"',
      '__VUE_OPTIONS_API__': 'true', '__VUE_PROD_DEVTOOLS__': 'false', '__VUE_PROD_HYDRATION_MISMATCH_DETAILS__': 'false' },
    bundle: true, write: false, platform: 'browser', format: 'esm', plugins: [{ name: 'actual-copy-editor-with-transport', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => {
        if (path.includes('/components/')) return { contents: 'export default {render:()=>null}', loader: 'ts' };
        const descriptor = parse(readFileSync(path, 'utf8'), { filename: path }).descriptor;
        const script = compileScript(descriptor, { id: 'owned-copy-editor', genDefaultAs: '__Page' });
        const template = compileTemplate({ source: descriptor.template.content, filename: path, id: 'owned-copy-editor',
          compilerOptions: { bindingMetadata: script.bindings, expressionPlugins: ['typescript'] } });
        if (template.errors.length) throw Error(String(template.errors));
        return { contents: `${script.content}\n${template.code}\n__Page.render=render;export default __Page;`, loader: 'ts' };
      });
      builder.onResolve({ filter: /^element-plus$/ }, () => ({ path: 'dialog', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const messages=[];
        export const ElMessage={success:m=>messages.push(m),error:m=>messages.push(m),warning:m=>messages.push(m)};
        export const ElMessageBox={confirm:async()=>{},prompt:async()=>({value:'owned'})};` }));
    } }] });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
}, 30000);
beforeEach(() => {
  const local = new Map<string, string>(), session = new Map<string, string>(); surface = new EventTarget(); vi.stubGlobal('window', surface);
  const storage = (map: Map<string, string>) => ({ getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => map.set(k, v), removeItem: (k: string) => map.delete(k) });
  vi.stubGlobal('localStorage', storage(local)); vi.stubGlobal('sessionStorage', storage(session));
  localStorage.setItem('supplier-token', 'owned-copy-a'); localStorage.setItem('supplier-user', '{"id":21,"supplier_id":20}');
  localStorage.setItem('supplier-permissions', '["supplier.product.view","supplier.product.manage"]');
  pinia = runtime.createPinia(); runtime.dialogs.messages.length = 0;
});
afterEach(() => { runtime.disposePinia(pinia); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const sku = (card = false) => ({ suk: '默认', detail: { 规格: '默认' }, image: '', price: '12.00', settle_price: '6.00', cost: '3.00',
  ot_price: '14.00', vip_price: '11.00', stock: card ? 0 : 8, bar_code: '', weight: '1.00', volume: '1.00', brokerage: '0.00', brokerage_two: '0.00', code: 'SOURCE', disk_info: '' });
const seed = (id = 80, type = 0) => ({ copy: { source_id: id, token: 'a'.repeat(64), destination: { type: 2, relation_id: 20 } }, product: {
  id: 0, product_type: type, store_name: '来源商品', store_info: '来源简介', keyword: '关键词', unit_name: '件', bar_code: '', cate_id: [1],
  slider_image: ['https://images.invalid/source.png'], description: '<p>来源说明</p>', spec_type: 0, items: [{ value: '规格', detail: ['默认'] }], attrs: [sku(type === 1)],
  retired_attrs: [], freight: 1, postage: '0.00', temp_id: 0, is_postage: 1, is_support_refund: 1, is_limit: 0, limit_type: 0, limit_num: 0,
  sort: 1, ficti: 9, video_link: '', is_show: 0, is_verify: 0, store_label_id: [4], media: { version: 1, previews: {} },
} });
const marker = () => ({ operation_id: '12345678-1234-4123-8123-123456789abc', actor_id: 21, supplier_id: 20, source_id: 80 });
const receipt = (pending: any, state = 'committed') => ({ ...pending, state, result: state === 'committed' ? { id: 100, is_show: 0, is_verify: 0 } : null });
const gate = () => { let resolve!: (value?: any) => void; return { promise: new Promise<any>(done => { resolve = done; }), resolve }; };
async function flush() { for (let i = 0; i < 40; i++) { await Promise.resolve(); await runtime.nextTick(); } }
type Node = { tag?: string; text?: string; children: Node[]; props: Record<string, any>; parent?: Node };
const walk = (n: Node): Node[] => [n, ...n.children.flatMap(walk)];
const content = (n: Node): string => (n.text ?? '') + n.children.map(content).join('');
async function mount(url = '/products/new?copy=80', override: (config: any, fixture: any) => unknown = () => undefined) {
  const calls: any[] = [], fixture = { receipt: null as any, apply(config: any) {
    const body = JSON.parse(config.data); expect(JSON.parse(sessionStorage.getItem('supplier_product_copy_pending_v1:20:21')!).operation_id).toBe(body.operation_id);
    fixture.receipt = receipt({ ...marker(), operation_id: body.operation_id }); return fixture.receipt;
  } };
  runtime.http.defaults.adapter = async (config: any) => {
    calls.push(config); let value = await override(config, fixture);
    if (value === undefined) {
      if (config.url === '/product/category') value = [{ id: 1, cate_name: '本机分类' }];
      else if (config.url === '/product/product/list') value = { list: [{ id: 80, product_type: 0, store_name: '来源商品', image: '', price: '12.00', stock: 8, sales: 4, is_show: 1, is_verify: 1, add_time: 100 }], count: 1, page: 1, limit: 20 };
      else if (config.url === '/product/product/get_rule') value = [];
      else if (config.url.includes('/copy_operations/')) value = fixture.receipt ?? { ...marker(), operation_id: config.url.split('/')[4], source_id: null, state: 'unknown', result: null };
      else if (config.method === 'post') value = fixture.apply(config);
      else value = seed(Number(config.url.split('/').at(-1)));
    }
    return { config, data: { status: 200, msg: 'owned copy transport', data: value }, status: 200, statusText: 'owned', headers: {} };
  };
  const host: Node = { children: [], props: {} };
  const renderer = runtime.createRenderer({ createElement: (tag: string) => ({ tag, children: [], props: {} }), createText: (text: string) => ({ text, children: [], props: {} }), createComment: () => ({ children: [], props: {} }),
    insert(n: Node, p: Node, anchor?: Node) { if (n.parent) n.parent.children = n.parent.children.filter(item => item !== n); n.parent = p; const at = anchor ? p.children.indexOf(anchor) : -1; p.children.splice(at < 0 ? p.children.length : at, 0, n); },
    remove(n: Node) { if (n.parent) n.parent.children = n.parent.children.filter(item => item !== n); }, parentNode: (n: Node) => n.parent,
    nextSibling: (n: Node) => n.parent?.children[n.parent.children.indexOf(n) + 1] ?? null, patchProp(n: Node, k: string, _: unknown, v: unknown) { n.props[k] = v; },
    setText(n: Node, v: string) { n.text = v; }, setElementText(n: Node, v: string) { n.text = v; n.children = []; } });
  const router = runtime.createRouter({ history: runtime.createMemoryHistory(), routes: [{ path: '/products/new', component: runtime.Form },
    { path: '/products/:id/edit', component: runtime.Form }, { path: '/products/copy-result', component: runtime.Form },
    { path: '/products/list-fixture', component: runtime.Products }, { path: '/products', component: { render: () => null } }] });
  const app = renderer.createApp({ render: () => runtime.h(runtime.RouterView) }); app.use(pinia); app.use(router);
  const tags = [...['ProductForm', 'Products'].flatMap(page => [...readFileSync(resolve(root, `src/pages/${page}.vue`), 'utf8').matchAll(/<(el-[a-z-]+)/g)])].map(m => m[1]);
  for (const name of new Set(tags)) if (!['el-table', 'el-table-column'].includes(name)) app.component(name, { inheritAttrs: false, setup(_: unknown, { slots, attrs }: any) { return () => runtime.h(name === 'el-button' ? 'button' : name, attrs, slots.default?.()); } });
  app.component('el-table', { props: ['data'], setup(props: any, { slots }: any) { runtime.provide('owned-copy-table-rows', () => props.data ?? []); return () => runtime.h('table', {}, slots.default?.()); } });
  app.component('el-table-column', { props: ['prop', 'label'], setup(props: any, { slots }: any) { const rows = runtime.inject('owned-copy-table-rows'); return () => runtime.h('column', { label: props.label }, rows().map((row: any) => runtime.h('cell', {}, slots.default ? slots.default({ row }) : String(row[props.prop] ?? '')))); } });
  app.directive('loading', {}); await router.push(url); app.mount(host); await flush();
  return { view: runtime.captured.view, list: runtime.captured.list, calls, fixture, host, router, close: () => app.unmount() };
}
const writes = (f: any) => f.calls.filter((c: any) => c.method === 'post' && !c.url.endsWith('/resolve'));
describe('rendered Supplier copy editor with actual Axios, identity and durable recovery', () => {
  it('enters the independent copy editor from the rendered list action without writing the source', async () => {
    const f = await mount('/products/list-fixture'); try {
      const button = walk(f.host).find(n => n.tag === 'button' && content(n) === '复制'); expect(button).toBeDefined(); await button!.props.onClick(); await flush();
      expect(f.router.currentRoute.value.fullPath).toBe('/products/new?copy=80'); expect(writes(f)).toEqual([]);
    } finally { f.close(); }
  });
  it('omits the copy action for view-only lists and rejects direct stale list handlers', async () => {
    localStorage.setItem('supplier-permissions', '["supplier.product.view"]'); const f = await mount('/products/list-fixture');
    try { expect(walk(f.host).some(n => n.tag === 'button' && content(n) === '复制')).toBe(false); f.list.copyProduct(f.list.rows.value[0]); await flush(); expect(f.router.currentRoute.value.path).toBe('/products/list-fixture'); }
    finally { f.close(); }
  });
  it('loads the explicit trusted copy endpoint, seeds editable fields and renders the copy context', async () => {
    const f = await mount(); try { expect(f.view.copyReady.value).toBe(true); expect(f.view.editing.value).toBe(false);
      expect(content(f.host)).toContain('复制商品 #80'); expect(f.calls.some(c => c.url === '/product/product/80')).toBe(false);
      expect(f.view.form.attrs[0].id).toBeUndefined(); expect(f.view.form.store_name).toBe('来源商品'); } finally { f.close(); }
  });
  it.each([1, 3])('preserves loaded type %s units and freight instead of applying new-product defaults to a copy', async type => {
    const value = seed(80, type); value.product.unit_name = '件'; value.product.freight = 3; value.product.temp_id = 91; value.product.postage = '2.75';
    const f = await mount(undefined, c => c.url === '/product/product/copy/80' ? value : undefined);
    try { expect(f.view.form).toMatchObject({ product_type: type, unit_name: '件', freight: 3, temp_id: 91, postage: '2.75', is_postage: 1 });
      if (type === 1) expect(f.view.form.attrs[0]).toMatchObject({ delivery_mode: 'card', disk_info: '', stock: 0 });
    }
    finally { f.close(); }
  });
  it('preserves existing fixed delivery material when an ordinary card edit loads from the default physical form', async () => {
    const value = { ...seed(81, 1).product, id: 81, attrs: [{ ...sku(true), id: 401, unique: 'owned-card-sku', stock: 4, disk_info: 'OWNED-EXISTING-FIXED-CONTENT' }] };
    const f = await mount('/products/81/edit', c => c.url === '/product/product/81' ? value : undefined);
    try { expect(f.view.form.attrs[0]).toMatchObject({ delivery_mode: 'fixed', disk_info: 'OWNED-EXISTING-FIXED-CONTENT', original_disk_info: 'OWNED-EXISTING-FIXED-CONTENT', stock: 4 }); }
    finally { f.close(); }
  });
  it('persists a minimal marker before one POST and submits only safe edits with the trusted token', async () => {
    const f = await mount(); try { f.view.form.store_name = '独立新商品'; f.view.form.attrs[0].id = 999; f.view.form.attrs[0].disk_info = 'must not cross copy';
      await f.view.submit(); expect(writes(f)).toHaveLength(1); const body = JSON.parse(writes(f)[0].data);
      expect(body.copy_token).toBe('a'.repeat(64)); expect(body.product.store_name).toBe('独立新商品'); expect(body.product.id).toBe(0);
      expect(body.product.attrs[0].id).toBeUndefined(); expect(body.product.attrs[0].disk_info).toBe('');
      for (const key of ['is_show', 'is_verify', 'refusal', 'media', 'retired_attrs', 'store_label_id']) expect(body.product[key]).toBeUndefined();
      expect(f.view.pendingCopy.value).toBeNull(); expect(sessionStorage.getItem('supplier_product_copy_pending_v1:20:21')).toBeNull(); expect(f.router.currentRoute.value.path).toBe('/products');
    } finally { f.close(); }
  });
  it('keeps an acknowledged response loss blocked and recovers by one GET without another create', async () => {
    const f = await mount(undefined, (config, fixture) => { if (config.method === 'post') { fixture.apply(config); throw Error('owned committed acknowledgement lost'); } });
    try { await f.view.submit(); expect(f.view.pendingCopy.value).not.toBeNull(); expect(content(f.host)).toContain('复制结果待确认');
      await f.view.submit(); expect(writes(f)).toHaveLength(1); await f.view.recoverCopy(false); expect(writes(f)).toHaveLength(1);
      expect(f.view.pendingCopy.value).toBeNull(); expect(f.router.currentRoute.value.path).toBe('/products'); } finally { f.close(); }
  });
  it('keeps unknown status pending until the server seals an uncommitted operation', async () => {
    const f = await mount(undefined, (config, fixture) => {
      if (config.url.endsWith('/resolve')) { fixture.receipt = receipt(JSON.parse(sessionStorage.getItem('supplier_product_copy_pending_v1:20:21')!), 'not_applied'); return fixture.receipt; }
      if (config.method === 'post') throw Error('owned not delivered');
    });
    try { await f.view.submit(); await f.view.recoverCopy(false); expect(f.view.pendingCopy.value).not.toBeNull(); await f.view.recoverCopy(true);
      expect(f.view.pendingCopy.value).toBeNull(); expect(f.view.copyNotice.value).toContain('未提交'); expect(writes(f)).toHaveLength(1);
    } finally { f.close(); }
  });
  it('restores the original pending operation on another source route and never resends it', async () => {
    sessionStorage.setItem('supplier_product_copy_pending_v1:20:21', JSON.stringify(marker()));
    const f = await mount('/products/new?copy=81'); try { expect(f.view.pendingCopy.value).toEqual(marker()); await f.view.submit(); expect(writes(f)).toEqual([]);
      expect(content(f.host)).toContain('来源商品 #80'); } finally { f.close(); }
  });
  it('recovers the original receipt after management permission is withdrawn, without reading product data', async () => {
    sessionStorage.setItem('supplier_product_copy_pending_v1:20:21', JSON.stringify(marker()));
    localStorage.setItem('supplier-permissions', '["supplier.product.view"]');
    const f = await mount('/products/copy-result', c => c.url.includes('/copy_operations/') ? receipt(marker()) : undefined);
    try { expect(f.calls).toEqual([]); expect(content(f.host)).toContain('复制操作结果'); await f.view.submit(); expect(writes(f)).toEqual([]);
      await f.view.recoverCopy(false); expect(f.calls).toHaveLength(1); expect(f.calls[0].method).toBe('get'); expect(f.view.pendingCopy.value).toBeNull();
    } finally { f.close(); }
  });
  it('blocks malformed pending storage and refuses to send when persistence fails', async () => {
    sessionStorage.setItem('supplier_product_copy_pending_v1:20:21', '{invalid'); const f = await mount();
    try { await f.view.submit(); expect(writes(f)).toEqual([]); expect(f.view.copyStorageError.value).not.toBe(''); } finally { f.close(); }
    sessionStorage.removeItem('supplier_product_copy_pending_v1:20:21'); const g = await mount();
    try { vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => { throw Error('owned unavailable storage'); }); await g.view.submit(); expect(writes(g)).toEqual([]); } finally { g.close(); }
  });
  it('rejects a malformed success receipt and keeps recovery available without a second create', async () => {
    const f = await mount(undefined, c => c.method === 'post' ? receipt({ ...marker(), operation_id: JSON.parse(c.data).operation_id, supplier_id: 99 }) : undefined);
    try { await f.view.submit(); expect(f.view.pendingCopy.value).not.toBeNull(); await f.view.submit(); expect(writes(f)).toHaveLength(1); } finally { f.close(); }
  });
  it('does not duplicate an in-flight create and excludes its late response after the source route changes', async () => {
    const wait = gate(), f = await mount(undefined, (c, fixture) => c.method === 'post' ? wait.promise.then(() => fixture.apply(c)) : undefined);
    try { const action = f.view.submit(); await flush(); await f.view.submit(); expect(writes(f)).toHaveLength(1); await f.router.push('/products/new?copy=81'); await flush();
      wait.resolve(); await action; expect(f.router.currentRoute.value.fullPath).toBe('/products/new?copy=81'); expect(f.view.pendingCopy.value?.source_id).toBe(80);
    } finally { wait.resolve(); f.close(); }
  });
  it('discards a late source response when the copy query changes without changing the component', async () => {
    const wait = gate(), f = await mount(undefined, c => c.url === '/product/product/copy/80' ? wait.promise : undefined);
    try { await f.router.push('/products/new?copy=81'); await flush(); expect(f.view.copyContext.value.source_id).toBe(81); wait.resolve(seed(80)); await flush(); expect(f.view.copyContext.value.source_id).toBe(81); }
    finally { wait.resolve(seed(80)); f.close(); }
  });
  it('reloads the source only after explicit draft replacement and cancels a stale confirmation', async () => {
    const f = await mount(); try { f.view.form.store_name = '未保存草稿'; await f.view.reloadCopy(); expect(f.view.form.store_name).toBe('来源商品');
      expect(f.calls.filter((c: any) => c.url === '/product/product/copy/80')).toHaveLength(2);
      const wait = gate(); runtime.dialogs.ElMessageBox.confirm = () => wait.promise;
      const pending = f.view.reloadCopy(); await flush(); await f.router.push('/products/new?copy=81'); await flush(); wait.resolve(); await pending;
      expect(f.view.copyContext.value.source_id).toBe(81); expect(f.calls.filter((c: any) => c.url === '/product/product/copy/80')).toHaveLength(2);
    } finally { runtime.dialogs.ElMessageBox.confirm = async () => {}; f.close(); }
  });
  it.each(['session', 'silent', 'permission', 'aba'])('invalidates %s identity before dispatch and never restores old data', async reason => {
    const f = await mount(); try {
      if (reason === 'permission') localStorage.setItem('supplier-permissions', '["supplier.product.view"]'); else localStorage.setItem('supplier-token', 'owned-copy-b');
      if (reason !== 'silent') surface.dispatchEvent(new Event('supplier-session-changed'));
      if (reason === 'aba') localStorage.setItem('supplier-token', 'owned-copy-a'); await f.view.submit(); expect(writes(f)).toEqual([]); expect(f.view.copyContext.value).toBeNull();
    } finally { f.close(); }
  });
  it.each(['/products/new?copy=0', '/products/new?copy=80&copy=81', '/products/80/edit?copy=81', '/products/new?copy=2147483648'])('rejects ambiguous or invalid copy entry %s before source read or write', async url => {
    const f = await mount(url); try { await f.view.submit(); expect(f.calls).toEqual([]); expect(f.view.copyEntry.value.error).not.toBe(''); } finally { f.close(); }
  });
  it('keeps copy unavailable for view-only identity and keeps failed seeds unable to create', async () => {
    localStorage.setItem('supplier-permissions', '["supplier.product.view"]'); const f = await mount();
    try { await f.view.submit(); expect(f.calls).toEqual([]); } finally { f.close(); }
    localStorage.setItem('supplier-permissions', '["supplier.product.view","supplier.product.manage"]');
    const g = await mount(undefined, c => c.url.includes('/copy/') ? Promise.reject(Error('source unavailable')) : undefined);
    try { await g.view.submit(); expect(writes(g)).toEqual([]); expect(g.view.copyReady.value).toBe(false); } finally { g.close(); }
  });
  it('never accepts card credentials, SKU identities, wrong owners or nonzero card inventory from the copy seed', () => {
    for (const alter of [(v: any) => { v.copy.destination.relation_id = 99; }, (v: any) => { v.product.attrs[0].id = 4; },
      (v: any) => { v.product.attrs[0].disk_info = 'private'; }, (v: any) => { v.product.attrs[0].virtual_list = []; },
      (v: any) => { v.product.product_type = 1; v.product.attrs[0].stock = 9; }]) {
      const value = seed(); alter(value); expect(() => runtime.api.parseProductCopySeed(value, 80, 20)).toThrow();
    }
    expect(runtime.api.parseProductCopySeed(seed(80, 1), 80, 20).product.attrs[0].stock).toBe(0);
  });
  it('captures independent nested editable values before dispatch without source identity or review facts', () => {
    const source = seed().product, projected = runtime.api.productCopyPayload(source);
    source.items[0].detail.push('变更'); source.attrs[0].detail.规格 = '变更'; source.slider_image.push('https://images.invalid/changed.png');
    expect(projected.items).toEqual([{ value: '规格', detail: ['默认'] }]); expect(projected.attrs[0].detail).toEqual({ 规格: '默认' });
    expect(projected.slider_image).toEqual(['https://images.invalid/source.png']); expect(projected.is_show).toBeUndefined();
  });
});
