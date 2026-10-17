import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../view/supplier-ts'), require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc');
let runtime: any, pinia: any, surface: EventTarget;
async function loadRuntime(development = false) {
  const bundle = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `import Form from './src/pages/ProductReviews.vue';import Products from './src/pages/Products.vue';
    export {Form,Products};export const captured={};const setup=Form.setup;Form.setup=(p,c)=>{const v=setup(p,c);captured.view=v;return v;};
    const listSetup=Products.setup;Products.setup=(p,c)=>{const v=listSetup(p,c);captured.list=v;return v;};
    export {http} from './src/api/http';export {useAuthStore} from './src/stores/auth';export * as dialogs from 'element-plus';
    export {createPinia,disposePinia} from 'pinia';export {createRenderer,h,nextTick,provide,inject} from 'vue';
    export {createRouter,createMemoryHistory,RouterView} from 'vue-router';` },
    alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': String(development), 'import.meta.env.VITE_API_BASE_URL': '"/supplierapi"',
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
  return await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
}
beforeAll(async () => { runtime = await loadRuntime(); }, 30000);
beforeEach(() => {
  const local = new Map<string, string>(), session = new Map<string, string>(); surface = new EventTarget(); vi.stubGlobal('window', surface);
  const storage = (map: Map<string, string>) => ({ getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => map.set(k, v), removeItem: (k: string) => map.delete(k) });
  vi.stubGlobal('localStorage', storage(local)); vi.stubGlobal('sessionStorage', storage(session));
  localStorage.setItem('supplier-token', 'owned-review-a'); localStorage.setItem('supplier-user', '{"id":21,"supplier_id":20}');
  localStorage.setItem('supplier-permissions', '["supplier.product.view","supplier.product.manage"]');
  pinia = runtime.createPinia(); runtime.dialogs.messages.length = 0;
});
afterEach(() => { runtime.disposePinia(pinia); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const row = (id = 601, product_id = 80, replied = false) => ({ id, product_id, store_name: `本店商品${product_id}`, image: '', nickname: '合成买家', account: '合成买家',
  comment: `原始评价${id}`, sku: '默认', product_score: 5, service_score: 4, delivery_score: 5, score: 4, pics: [], is_reply: replied ? 1 : 0,
  add_time: '2026-10-17 08:00:00', replyComment: replied ? { id: id + 1000, content: '原回复', add_time: '2026-10-17 08:05:00', update_time: '2026-10-17 08:05:00' } : null });
const gate = () => { let resolve!: (value?: any) => void; return { promise: new Promise<any>(done => { resolve = done; }), resolve }; };
async function flush() { for (let i = 0; i < 45; i++) { await Promise.resolve(); await runtime.nextTick(); } }
type Node = { tag?: string; text?: string; children: Node[]; props: Record<string, any>; parent?: Node };
const walk = (n: Node): Node[] => [n, ...n.children.flatMap(walk)];
const content = (n: Node): string => (n.text ?? '') + n.children.map(content).join('');
const writes = (f: any) => f.calls.filter((c: any) => c.method === 'put');
const reads = (f: any) => f.calls.filter((c: any) => c.url === '/product/reply');
async function mount(url = '/product-reviews?product_id=80', override: (config: any, fixture: any) => unknown = () => undefined) {
  const calls: any[] = [], fixture = { reviews: [row(), row(602, 81, true)], list(config: any) {
    const q = config.params;
    const list = fixture.reviews.filter(item => !q.product_id || item.product_id === Number(q.product_id))
      .filter(item => q.is_reply === '' || item.is_reply === Number(q.is_reply))
      .filter(item => !q.store_name || item.store_name.includes(q.store_name))
      .filter(item => !q.account || item.nickname.includes(q.account));
    return structuredClone({ list: list.slice((q.page - 1) * q.limit, q.page * q.limit), count: list.length, page: q.page, limit: q.limit });
  }, apply(config: any) {
    const id = Number(config.url.split('/').at(-1)), target = fixture.reviews.find(item => item.id === id)!;
    target.is_reply = 1; target.replyComment = { id: target.replyComment?.id ?? id + 1000, content: JSON.parse(config.data).content,
      add_time: target.replyComment?.add_time ?? '2026-10-17 09:00:00', update_time: '2026-10-17 09:00:00' };
    return { id, comment_id: target.replyComment.id, is_reply: 1 };
  } };
  runtime.http.defaults.adapter = async (config: any) => {
    calls.push(config); let value = await override(config, fixture);
    if (value === undefined) {
      if (config.url === '/product/product/list') value = { list: [{ id: 80, product_type: 0, store_name: '本店商品80', image: '', price: '12.00', stock: 8, sales: 4, is_show: 1, is_verify: 1, add_time: 100 }], count: 1, page: 1, limit: 20 };
      else if (config.url === '/product/reply') value = fixture.list(config);
      else if (config.method === 'put') value = fixture.apply(config);
      else throw Error('unexpected request ' + config.url);
    }
    return { config, data: { status: 200, msg: 'owned review transport', data: value }, status: 200, statusText: 'owned', headers: {} };
  };
  const host: Node = { children: [], props: {} };
  const renderer = runtime.createRenderer({ createElement: (tag: string) => ({ tag, children: [], props: {} }), createText: (text: string) => ({ text, children: [], props: {} }), createComment: () => ({ children: [], props: {} }),
    insert(n: Node, p: Node, anchor?: Node) { if (n.parent) n.parent.children = n.parent.children.filter(item => item !== n); n.parent = p; const at = anchor ? p.children.indexOf(anchor) : -1; p.children.splice(at < 0 ? p.children.length : at, 0, n); },
    remove(n: Node) { if (n.parent) n.parent.children = n.parent.children.filter(item => item !== n); }, parentNode: (n: Node) => n.parent,
    nextSibling: (n: Node) => n.parent?.children[n.parent.children.indexOf(n) + 1] ?? null, patchProp(n: Node, k: string, _: unknown, v: unknown) { n.props[k] = v; },
    setText(n: Node, v: string) { n.text = v; }, setElementText(n: Node, v: string) { n.text = v; n.children = []; } });
  const router = runtime.createRouter({ history: runtime.createMemoryHistory(), routes: [{ path: '/product-reviews', component: runtime.Form },
    { path: '/products', component: runtime.Products }, { path: '/elsewhere', component: { render: () => null } }] });
  const app = renderer.createApp({ render: () => runtime.h(runtime.RouterView) }); app.use(pinia); app.use(router);
  const tags = [...['ProductReviews', 'Products'].flatMap(page => [...readFileSync(resolve(root, `src/pages/${page}.vue`), 'utf8').matchAll(/<(el-[a-z-]+)/g)])].map(m => m[1]);
  for (const name of new Set(tags)) if (!['el-table', 'el-table-column', 'el-dialog'].includes(name)) app.component(name, { inheritAttrs: false, setup(_: unknown, { slots, attrs }: any) {
    return () => runtime.h(name === 'el-button' ? 'button' : name, attrs, name === 'el-alert' ? [attrs.title, attrs.description] : slots.default?.()); } });
  app.component('el-dialog', { props: ['modelValue'], setup(props: any, { slots, attrs }: any) { return () => props.modelValue ? runtime.h('dialog', attrs, [slots.default?.(), slots.footer?.()]) : null; } });
  app.component('el-table', { props: ['data'], setup(props: any, { slots }: any) { runtime.provide('owned-review-table-rows', () => props.data ?? []); return () => runtime.h('table', {}, slots.default?.()); } });
  app.component('el-table-column', { props: ['prop', 'label'], setup(props: any, { slots }: any) { const rows = runtime.inject('owned-review-table-rows'); return () => runtime.h('column', { label: props.label }, rows().map((row: any) => runtime.h('cell', {}, slots.default ? slots.default({ row }) : String(row[props.prop] ?? '')))); } });
  app.directive('loading', {}); await router.push(url); app.mount(host); await flush();
  return { get view() { return runtime.captured.view; }, get list() { return runtime.captured.list; }, calls, fixture, host, router, close: () => app.unmount() };
}
function loginChange() { localStorage.setItem('supplier-token', 'other'); surface.dispatchEvent(new Event('supplier-session-changed'));
  localStorage.setItem('supplier-token', 'owned-review-a'); surface.dispatchEvent(new Event('supplier-session-changed')); }
function edit(f: any, text = '新的供应商回复') { f.view.openReply(f.view.rows.value[0]); f.view.replyContent.value = text; }

describe('Supplier product to review drill-down, actual rendered Vue/Pinia/Axios', () => {
  it('keeps explicit development preview drill-down and reply functional without a real request', async () => {
    const production = runtime, productionPinia = pinia; let f: Awaited<ReturnType<typeof mount>> | undefined;
    Object.assign(surface, { location: { search: '?preview=1' } });
    try { runtime = await loadRuntime(true); pinia = runtime.createPinia(); f = await mount('/product-reviews?preview=1');
      expect(f.view.fresh.value).toBe(true); expect(f.view.rows.value.map((row: any) => row.product_id)).toEqual([71, 72]);
      await f.router.push('/product-reviews?preview=1&product_id=71&is_reply=0'); await flush();
      expect(f.view.rows.value.map((row: any) => row.id)).toEqual([601]); edit(f, '开发预览回复'); await f.view.submitReply();
      expect(f.view.rows.value).toEqual([]); expect(f.calls).toEqual([]);
      await f.router.push('/product-reviews?preview=1&product_id=71&is_reply=1'); await flush();
      expect(f.view.rows.value[0].replyComment.content).toBe('开发预览回复'); expect(f.calls).toEqual([]);
    } finally { f?.close(); if (runtime !== production) runtime.disposePinia(pinia); runtime = production; pinia = productionPinia; }
  }, 30000);

  it('enters the selected product from the actual list action and requests only that product', async () => {
    const f = await mount('/products'); try {
      const button = walk(f.host).find(n => n.tag === 'button' && content(n) === '查看评价'); expect(button).toBeDefined();
      await button!.props.onClick(); await flush(); expect(f.router.currentRoute.value.fullPath).toBe('/product-reviews?product_id=80');
      expect(f.view.rows.value.map((r: any) => r.id)).toEqual([601]); expect(content(f.host)).toContain('商品 #80'); expect(reads(f)[0].params.product_id).toBe(80); expect(writes(f)).toEqual([]);
    } finally { f.close(); }
  });
  it('allows a view-only product list to drill down but hides reply actions', async () => {
    localStorage.setItem('supplier-permissions', '["supplier.product.view"]'); const f = await mount('/products');
    try { await walk(f.host).find(n => n.tag === 'button' && content(n) === '查看评价')!.props.onClick(); await flush();
      expect(f.view.rows.value).toHaveLength(1); expect(walk(f.host).some(n => n.tag === 'button' && content(n) === '回复')).toBe(false);
      edit(f); await f.view.submitReply(); expect(writes(f)).toEqual([]);
    } finally { f.close(); }
  });
  it('rejects a forged or invalidated product list target', async () => {
    const f = await mount('/products'); try { f.list.viewProductReviews({ ...f.list.rows.value[0], id: 81 }); await flush(); expect(reads(f)).toEqual([]);
      const target = f.list.rows.value[0]; loginChange(); f.list.viewProductReviews(target); await flush(); expect(f.router.currentRoute.value.path).toBe('/products');
    } finally { f.close(); }
  });
  it('consumes the PHP product id alias and unanswered query without broadening to the shop', async () => {
    const f = await mount('/product-reviews?id=80&is_reply=0'); try { expect(reads(f)[0].params).toMatchObject({ product_id: 80, is_reply: '0' });
      expect(f.view.rows.value.map((r: any) => r.id)).toEqual([601]); } finally { f.close(); }
  });
  it.each(['product_id=', 'product_id', 'product_id=0', 'product_id=-1', 'product_id=01', 'product_id=1e2', 'product_id=%2080',
    'product_id=2147483648', 'product_id=80&product_id=81', 'product_id=80&id=80', 'id=0', 'is_reply=2', 'is_reply', 'is_reply=0&is_reply=1', 'supplier_id=99', 'preview=1'])('fails closed for malformed route %s', async query => {
    const f = await mount('/product-reviews?' + query); try { expect(reads(f)).toEqual([]); expect(f.view.rows.value).toEqual([]); expect(content(f.host)).toContain('查询参数无效'); }
    finally { f.close(); }
  });
  it('keeps whole-shop lookup and explicitly clears the product context on return', async () => {
    const f = await mount(); try { await walk(f.host).find(n => n.tag === 'button' && content(n) === '返回全店评价')!.props.onClick(); await flush();
      expect(f.view.rows.value.map((r: any) => r.id)).toEqual([601, 602]); expect(reads(f).at(-1).params).not.toHaveProperty('product_id');
    } finally { f.close(); }
  });
  it('preserves product scope through filters, pagination and a switch to another product', async () => {
    const f = await mount(); try { f.fixture.reviews.push(...Array.from({ length: 17 }, (_, i) => row(700 + i))); f.view.filters.account = '合成'; f.view.search(); await flush();
      f.view.filters.page = 2; await f.view.load(); expect(f.view.rows.value).toHaveLength(3); expect(reads(f).at(-1).params).toMatchObject({ product_id: 80, page: 2, account: '合成' });
      await f.router.push('/product-reviews?product_id=81&is_reply=1'); await flush(); expect(f.view.filters.page).toBe(1); expect(f.view.filters.account).toBe(''); expect(f.view.rows.value.map((r: any) => r.id)).toEqual([602]);
    } finally { f.close(); }
  });
  it('shows an empty foreign or nonexistent product result without offering a reply', async () => {
    const f = await mount('/product-reviews?product_id=999'); try { expect(f.view.fresh.value).toBe(true); expect(f.view.total.value).toBe(0); expect(f.view.rows.value).toEqual([]); expect(writes(f)).toEqual([]); }
    finally { f.close(); }
  });
  it('writes one normalized reply with the existing PUT contract and reads it back', async () => {
    const f = await mount(); try { const original = f.fixture.reviews[0].comment; edit(f, '  感\0谢反馈  '); await f.view.submitReply();
      expect(writes(f)).toHaveLength(1); expect(writes(f)[0].url).toBe('/product/reply/set_reply/601'); expect(JSON.parse(writes(f)[0].data)).toEqual({ content: '感谢反馈', expected_product_id: 80 });
      expect(f.view.rows.value[0].replyComment.content).toBe('感谢反馈'); expect(f.fixture.reviews[0].comment).toBe(original); expect(f.view.replyDialogOpen.value).toBe(false);
    } finally { f.close(); }
  });
  it('modifies an existing official reply and keeps its identity', async () => {
    const f = await mount('/product-reviews?product_id=81'); try { edit(f, '更新回复'); await f.view.submitReply();
      expect(f.view.rows.value[0].replyComment).toMatchObject({ id: 1602, content: '更新回复' }); expect(runtime.dialogs.messages).toContain('回复已更新');
    } finally { f.close(); }
  });
  it('rereads pending filters and clamps an emptied last page after one successful reply', async () => {
    const f = await mount('/product-reviews?product_id=80&is_reply=0'); try { f.fixture.reviews.push(...Array.from({ length: 15 }, (_, i) => row(700 + i)));
      f.view.filters.page = 2; await f.view.load(); expect(f.view.rows.value).toHaveLength(1); edit(f); await f.view.submitReply();
      expect(f.view.filters.page).toBe(1); expect(f.view.rows.value).toHaveLength(15); expect(reads(f).at(-1).params).toMatchObject({ product_id: 80, is_reply: '0', page: 1 }); expect(writes(f)).toHaveLength(1);
    } finally { f.close(); }
  });
  it.each([' \0 ', '评'.repeat(501)])('rejects invalid reply content without a write (%#)', async value => {
    const f = await mount(); try { edit(f, value); await f.view.submitReply(); expect(writes(f)).toEqual([]); expect(f.view.replyDialogOpen.value).toBe(true); }
    finally { f.close(); }
  });
  it('keeps a single write in flight and rejects a second click', async () => {
    const wait = gate(), f = await mount((undefined), (c, fixture) => c.method === 'put' ? wait.promise.then(() => fixture.apply(c)) : undefined);
    try { edit(f); const pending = f.view.submitReply(); await flush(); await f.view.submitReply(); expect(writes(f)).toHaveLength(1); wait.resolve(); await pending; }
    finally { wait.resolve(); f.close(); }
  });
  it('invalidates a reply draft immediately when search inputs change', async () => {
    const f = await mount(); try { edit(f); f.view.filters.account = '另一个人'; await flush(); expect(f.view.current.value).toBeNull(); expect(f.view.replyContent.value).toBe('');
      await f.view.submitReply(); expect(writes(f)).toEqual([]); expect(f.view.rows.value).toEqual([]);
    } finally { f.close(); }
  });
  it('cancels a queued PUT before Axios dispatch when the selected product changes', async () => {
    const wait = gate(), f = await mount(); const interceptor = runtime.http.interceptors.request.use((c: any) => c.method === 'put' ? wait.promise.then(() => c) : c);
    try { edit(f); const pending = f.view.submitReply(); await flush(); await f.router.push('/product-reviews?product_id=81'); await flush(); wait.resolve(); await pending;
      expect(writes(f)).toEqual([]); expect(f.view.rows.value.map((r: any) => r.id)).toEqual([602]); expect(f.view.current.value).toBeNull();
    } finally { wait.resolve(); runtime.http.interceptors.request.eject(interceptor); f.close(); }
  });
  it('discards an old successful PUT reply after switching product A to B to A', async () => {
    const wait = gate(), f = await mount(undefined, (c, fixture) => c.method === 'put' ? wait.promise.then(() => fixture.apply(c)) : undefined);
    try { edit(f); const pending = f.view.submitReply(); await flush(); await f.router.push('/product-reviews?product_id=81'); await flush(); await f.router.push('/product-reviews?product_id=80'); await flush();
      wait.resolve(); await pending; expect(f.view.rows.value[0].replyComment).toBeNull(); expect(f.view.current.value).toBeNull(); expect(runtime.dialogs.messages).not.toContain('回复成功'); expect(writes(f)).toHaveLength(1);
    } finally { wait.resolve(); f.close(); }
  });
  it('ignores a late GET after another product query has completed', async () => {
    const wait = gate(); let held = false;
    const f = await mount(undefined, (c, fixture) => { if (c.url === '/product/reply' && !held) { held = true; const result = fixture.list(c); return wait.promise.then(() => result); } });
    try { expect(f.view.loading.value).toBe(true); await f.router.push('/product-reviews?product_id=81'); await flush(); wait.resolve(); await flush();
      expect(f.view.rows.value.map((r: any) => r.id)).toEqual([602]); expect(f.view.total.value).toBe(1); expect(reads(f)[0].signal.aborted).toBe(true);
    } finally { wait.resolve(); f.close(); }
  });
  it('does not announce an old successful write after its follow-up read spans route A to B to A', async () => {
    const wait = gate(); let applied = false, held = false;
    const f = await mount(undefined, (c, fixture) => {
      if (c.method === 'put') { applied = true; return fixture.apply(c); }
      if (applied && !held && c.url === '/product/reply') { held = true; const result = fixture.list(c); return wait.promise.then(() => result); }
    });
    try { edit(f); const pending = f.view.submitReply(); await flush(); expect(held).toBe(true);
      await f.router.push('/product-reviews?product_id=81'); await flush(); await f.router.push('/product-reviews?product_id=80'); await flush();
      wait.resolve(); await pending; expect(runtime.dialogs.messages).not.toContain('回复成功'); expect(writes(f)).toHaveLength(1);
      expect(f.view.rows.value[0].replyComment.content).toBe('新的供应商回复');
    } finally { wait.resolve(); f.close(); }
  });
  it.each(['read', 'write'])('clears PII and rejects late %s results after a real session A to B to A', async mode => {
    const wait = gate(); let held = false;
    const f = await mount(undefined, (c, fixture) => { if (mode === 'read' && c.url === '/product/reply' && !held) { held = true; return wait.promise.then(() => fixture.list(c)); }
      if (mode === 'write' && c.method === 'put') return wait.promise.then(() => fixture.apply(c)); });
    try { let pending; if (mode === 'write') { edit(f); pending = f.view.submitReply(); await flush(); } loginChange(); wait.resolve(); await pending; await flush();
      expect(f.view.rows.value).toEqual([]); expect(f.view.current.value).toBeNull(); expect(f.view.replyContent.value).toBe(''); expect(content(f.host)).not.toContain('原始评价601'); expect(runtime.dialogs.messages).not.toContain('回复成功');
    } finally { wait.resolve(); f.close(); }
  });
  it('cancels a queued PUT after in-memory manage permission revocation', async () => {
    const wait = gate(), f = await mount(); const interceptor = runtime.http.interceptors.request.use((c: any) => c.method === 'put' ? wait.promise.then(() => c) : c);
    try { edit(f); const pending = f.view.submitReply(); await flush(); runtime.useAuthStore(pinia).permissions = ['supplier.product.view']; await flush(); wait.resolve(); await pending;
      expect(writes(f)).toEqual([]); expect(f.view.current.value).toBeNull(); expect(f.view.canManageProducts.value).toBe(false);
    } finally { wait.resolve(); runtime.http.interceptors.request.eject(interceptor); f.close(); }
  });
  it.each(['session-ABA', 'unmount'])('cancels a queued PUT before dispatch on %s', async mode => {
    const wait = gate(), f = await mount(); let closed = false;
    const interceptor = runtime.http.interceptors.request.use((c: any) => c.method === 'put' ? wait.promise.then(() => c) : c);
    try { edit(f); const pending = f.view.submitReply(); await flush();
      if (mode === 'session-ABA') loginChange(); else { f.close(); closed = true; }
      wait.resolve(); await pending; expect(writes(f)).toEqual([]); expect(f.view.current.value).toBeNull(); expect(f.view.replyContent.value).toBe('');
    } finally { wait.resolve(); runtime.http.interceptors.request.eject(interceptor); if (!closed) f.close(); }
  });
  it('keeps an unknown write blocked until a manual reread and never replays it', async () => {
    const f = await mount(undefined, (c, fixture) => { if (c.method === 'put') { fixture.apply(c); throw Error('response lost'); } });
    try { edit(f); await f.view.submitReply(); expect(f.view.rows.value).toEqual([]); expect(f.view.error.value).toContain('结果未确认'); await f.view.submitReply(); expect(writes(f)).toHaveLength(1);
      f.view.search(); await flush(); expect(f.view.rows.value[0].replyComment.content).toBe('新的供应商回复'); expect(writes(f)).toHaveLength(1);
    } finally { f.close(); }
  });
  it.each([{ id: 602, comment_id: 1601, is_reply: 1 }, { id: 601, comment_id: 0, is_reply: 1 }, { id: 601, comment_id: 1601, is_reply: 0 }, { id: 601, comment_id: 1601, is_reply: 1, extra: true }])('rejects a mismatched write receipt (%#)', async receipt => {
    const f = await mount(undefined, c => c.method === 'put' ? receipt : undefined); try { edit(f); await f.view.submitReply(); expect(f.view.error.value).toContain('结果未确认'); expect(f.view.rows.value).toEqual([]); expect(writes(f)).toHaveLength(1); }
    finally { f.close(); }
  });
  it.each(['product', 'duplicate', 'page', 'count', 'reply', 'status'])('rejects a malformed list response instead of opening a reply (%s)', async defect => {
    const f = await mount(undefined, (c, fixture) => { if (c.url !== '/product/reply') return; const result: any = fixture.list(c);
      if (defect === 'product') result.list[0].product_id = 81; if (defect === 'duplicate') { result.list.push(result.list[0]); result.count = 2; }
      if (defect === 'page') result.page = 2; if (defect === 'count') result.count = -1; if (defect === 'reply') result.list[0].replyComment = { id: 0 }; if (defect === 'status') result.list[0].is_reply = 3; return result; });
    try { expect(f.view.rows.value).toEqual([]); expect(f.view.fresh.value).toBe(false); expect(f.view.error.value).toContain('不符'); expect(writes(f)).toEqual([]); }
    finally { f.close(); }
  });
  it('aborts an unfinished read on unmount without retaining its result', async () => {
    const wait = gate(), f = await mount(undefined, (c, fixture) => c.url === '/product/reply' ? wait.promise.then(() => fixture.list(c)) : undefined);
    f.close(); wait.resolve(); await flush(); expect(reads(f)[0].signal.aborted).toBe(true); expect(f.view.rows.value).toEqual([]);
  });
});
