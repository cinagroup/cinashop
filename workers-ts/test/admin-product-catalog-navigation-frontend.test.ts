import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../view/admin-ts');
const require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc');
const catalog = '/product/product', header = `${catalog}/type_header`, replies = '/product/reply';
const filterPaths = { categories: '/product/category/cascader_list/1', brands: '/product/brand/cascader_list/2', labels: '/product/product_label', suppliers: '/supplier/list' };
const filterFixtures = {
  categories: [{ value: 11, label: '一级分类', pid: 0, children: [{ value: 12, label: '二级分类', pid: 11 }] }],
  brands: [{ value: 21, label: '一级品牌', pid: 0, children: [{ value: 22, label: '二级品牌', pid: 21, children: [{ value: 23, label: '三级品牌', pid: 22 }] }] }],
  labels: [{ id: 71, label_name: '标签组', type: 0, relation_id: 0, children: [31,32].map(id => ({ id, label_cate: 71, type: 0, relation_id: 0, label_name: `标签 ${id}` })) }],
  suppliers: [{ id: 20, supplier_name: '停用但未删除供应商' }, { id: 19, supplier_name: '启用供应商' }],
};
let runtime: any, browser: EventTarget, values: Map<string, string>;

beforeAll(async () => {
  // Import Vue/Router without a DOM, then provide only document.title for the
  // actual registry guard. The renderer below supplies the host implementation.
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { pathname: '/product', href: '', search: '' } }));
  const bundle = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    import ProductPage from './src/pages/product/ProductList.vue';
    import ReplyPage from './src/pages/reply/ReplyList.vue';
    export {default as router} from './src/router';
    export {default as request} from './src/utils/request';
    export * as productApi from './src/api/product';
    export * as filterApi from './src/api/productCatalogFilters';
    export * as dialogs from 'element-plus';
    export {createPinia,disposePinia} from 'pinia';
    export {createRenderer,nextTick,h,provide,inject,watch} from 'vue';
    export {RouterView} from 'vue-router';
    export const views={};
    for(const [name,page] of [['product',ProductPage],['reply',ReplyPage]]) {
      const original=page.setup;page.setup=(props,context)=>{
        const value=original(props,context);views[name]=value;return value;
      };
    }` }, alias: { '@': resolve(root, 'src') },
    define: { 'import.meta.env.DEV': 'false', '__VUE_OPTIONS_API__': 'true', '__VUE_PROD_DEVTOOLS__': 'false', '__VUE_PROD_HYDRATION_MISMATCH_DETAILS__': 'false' },
    bundle: true, write: false, platform: 'browser', format: 'esm', plugins: [{ name: 'actual-catalog-reply-registry-and-pages', setup(builder) {
      builder.onLoad({ filter: /\/router\/index\.ts$/ }, ({ path }) => ({
        // Keep every real route/redirect/guard; replace just its history host.
        contents: readFileSync(path, 'utf8').replace(/\bcreateWebHistory\b/g, 'createMemoryHistory'), loader: 'ts', resolveDir: resolve(path, '..'),
      }));
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => {
        if (path.endsWith('/layouts/AdminLayout.vue')) return { contents: `import {h} from 'vue';import {RouterView} from 'vue-router';export default {render:()=>h(RouterView)};`, loader: 'ts', resolveDir: root };
        if (!path.endsWith('/product/ProductList.vue') && !path.endsWith('/reply/ReplyList.vue')) {
          // Other lazy pages and the already separately tested creation dialog
          // are layout-only substitutes, never navigation or API substitutes.
          return { contents: `export default {render:()=>null};`, loader: 'ts' };
        }
        const descriptor = parse(readFileSync(path, 'utf8'), { filename: path }).descriptor;
        const id = path.endsWith('ProductList.vue') ? 'catalog-runtime' : 'reply-navigation-runtime';
        const script = compileScript(descriptor, { id, genDefaultAs: '__Page' });
        const template = compileTemplate({ source: descriptor.template.content, filename: path, id,
          compilerOptions: { bindingMetadata: script.bindings, expressionPlugins: ['typescript'] } });
        if (template.errors.length) throw Error(String(template.errors));
        return { contents: `${script.content}\n${template.code}\n__Page.render=render;export default __Page;`, loader: 'ts' };
      });
      builder.onResolve({ filter: /^element-plus$/ }, () => ({ path: 'dialogs', namespace: 'fixture' }));
      builder.onLoad({ filter: /dialogs/, namespace: 'fixture' }, () => ({ contents: `
        export const state={successes:[],errors:[],warnings:[],confirmations:[],confirm:async()=>{}};
        export const ElMessage={success:m=>state.successes.push(m),error:m=>state.errors.push(m),warning:m=>state.warnings.push(m)};
        export const ElMessageBox={confirm(...args){state.confirmations.push(args);return state.confirm(...args)}};` }));
    } }] });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
}, 30000);

beforeEach(() => {
  values = new Map(); browser = new EventTarget();
  vi.stubGlobal('window', Object.assign(browser, { location: { pathname: '/product', href: '', search: '' } }));
  vi.stubGlobal('document', { title: '' });
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  for (const value of Object.values(runtime.dialogs.state) as any[]) if (Array.isArray(value)) value.length = 0;
  runtime.dialogs.state.confirm = async () => {};
  runtime.views.product = runtime.views.reply = undefined;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function login(permissions = ['product.view', 'reply.view'], token = 'catalog-admin-a', id = 20) {
  values.set('admin_token', token); values.set('admin_session', JSON.stringify({ userInfo: { id, account: 'catalog-reader', head_pic: '', real_name: 'Catalog reader', level: 1, roles: '7' }, menus: [], uniqueAuth: permissions }));
}
const product = (id = 51, stock: number | null = 12) => ({ id, type: 2, relation_id: 20, product_type: 0,
  store_name: `供应商商品 ${id}`, image: '', price: '29.90', stock, sales: 4, is_show: 1, is_del: 0, is_verify: 1 });
const review = (productId = 51, comment = `商品 ${productId} 的评价`) => ({ id: productId + 100, uid: 31, oid: 101, type: 2, relation_id: 20,
  product_id: productId, sku: '红色', product_score: 5, service_score: 4, delivery_score: 3, reply_score: 3, score: '4',
  comment, pics: [], add_time: '2026-10-14 09:00:00', nickname: '顾客快照', account: '顾客快照', avatar: '',
  store_name: `供应商商品 ${productId}`, is_reply: 0, status: 1, replyComment: null });
const headerRows = () => [
  { type: 1, name: '销售中', count: 31 }, { type: 2, name: '仓库中', count: 6 },
  { type: 4, name: '已售罄', count: 4 }, { type: 5, name: '库存预警', count: 2 },
  { type: 6, name: '回收站', count: 3 }, { type: 0, name: '待审核', count: 8 },
  { type: -1, name: '审核未通过', count: 1 }, { type: -2, name: '强制下架', count: 9 },
];
const gate = () => { let resolve!: (value?: any) => void; return { promise: new Promise<any>(done => { resolve = done; }), resolve }; };
async function flush() { for (let i = 0; i < 45; i++) { await Promise.resolve(); await runtime.nextTick(); } }
type Node = { tag?: string; text?: string; children: Node[]; props: Record<string, any>; parent?: Node };
const walk = (node: Node): Node[] => [node, ...node.children.flatMap(walk)];
const textOf = (node: Node): string => `${node.text ?? ''}${node.children.map(textOf).join('')}`;

function controls(app: any) {
  const pass = (tag: string) => ({ inheritAttrs: false, setup(_: unknown, { attrs, slots }: any) { return () => runtime.h(tag, attrs, slots.default?.()); } });
  for (const [name, tag] of Object.entries({ 'el-card': 'card', 'el-form': 'form', 'el-form-item': 'field', 'el-button': 'button', 'el-option': 'option', 'el-tag': 'tag', 'el-image': 'image', 'el-text': 'text',
    'el-checkbox-group': 'checkbox-group', 'el-checkbox': 'checkbox', 'el-radio-group': 'radio-group', 'el-radio-button': 'radio-button' })) app.component(name, pass(tag));
  app.component('el-input', { inheritAttrs: false, props: ['modelValue', 'type'], emits: ['update:modelValue'], setup(props: any, { attrs, emit }: any) { return () => runtime.h(props.type === 'textarea' ? 'textarea' : 'input', { ...attrs, value: props.modelValue, onInput: (event: any) => emit('update:modelValue', event.target.value) }); } });
  app.component('el-cascader', { inheritAttrs: false, props: ['modelValue', 'options', 'props'], emits: ['update:modelValue'], setup(props: any, { attrs, emit }: any) { return () => runtime.h('cascader', { ...attrs, value: props.modelValue, options: props.options, choiceProps: props.props, onChange: (value: any) => { emit('update:modelValue', value); attrs.onChange?.(value); } }); } });
  app.component('el-select', { inheritAttrs: false, props: ['modelValue'], emits: ['update:modelValue'], setup(props: any, { attrs, emit, slots }: any) { return () => runtime.h('select', { ...attrs, value: props.modelValue, onChange: (value: any) => { emit('update:modelValue', value); attrs.onChange?.(value); } }, slots.default?.()); } });
  app.component('el-input-number', { inheritAttrs: false, props: ['modelValue'], emits: ['update:modelValue'], setup(props: any, { attrs, emit }: any) { return () => runtime.h('number', { ...attrs, value: props.modelValue, onInput: (value: number) => emit('update:modelValue', value) }); } });
  app.component('el-date-picker', { inheritAttrs: false, props: ['modelValue'], emits: ['update:modelValue'], setup(props: any, { attrs, emit }: any) { return () => runtime.h('date-range', { ...attrs, value: props.modelValue, onChange: (value: any) => emit('update:modelValue', value) }); } });
  app.component('el-pagination', { inheritAttrs: false, props: ['currentPage', 'pageSize', 'total', 'disabled'], emits: ['current-change', 'update:currentPage'], setup(props: any, { emit }: any) {
    // Behavioral fixture for Element Plus' total/currentPage clamp, previously
    // observed in Chrome; this is not a browser/layout assertion.
    runtime.watch(() => [props.currentPage, props.total, props.pageSize], () => {
      const maximum = Math.max(1, Math.ceil(props.total / props.pageSize));
      if (props.currentPage > maximum) { emit('update:currentPage', maximum); emit('current-change', maximum); }
    });
    return () => runtime.h('pagination', { ...props, onPage: (page: number) => { emit('update:currentPage', page); emit('current-change', page); } }, `总计 ${props.total}`);
  } });
  app.component('el-dialog', { inheritAttrs: false, props: ['modelValue', 'title'], setup(props: any, { slots }: any) { return () => props.modelValue ? runtime.h('dialog', { title: props.title }, [slots.default?.(), slots.footer?.()]) : null; } });
  app.component('el-alert', { props: ['title', 'type'], setup(props: any) { return () => runtime.h('alert', { type: props.type }, props.title); } });
  app.component('el-empty', { props: ['description'], setup(props: any) { return () => runtime.h('empty', {}, props.description); } });
  app.component('el-table', { props: ['data'], setup(props: any, { attrs, slots }: any) { runtime.provide('catalog-navigation-rows', () => props.data); return () => runtime.h('table', attrs, slots.default?.()); } });
  app.component('el-table-column', { props: ['prop', 'label'], setup(props: any, { slots }: any) { const rows = runtime.inject('catalog-navigation-rows'); return () => runtime.h('column', { label: props.label }, rows().map((value: any) => runtime.h('cell', { row: value.id }, slots.default ? slots.default({ row: value }) : String(value[props.prop] ?? '')))); } });
  app.directive('loading', {});
}

async function mount(path = '/product', permissions = ['product.view', 'reply.view'], override: (config: any, fixture: any) => unknown = () => undefined) {
  login(permissions); const calls: any[] = [], fixture = {
    products: Array.from({ length: 31 }, (_, index) => product(51 + index, index === 0 ? null : 12)), count: 31, headers: headerRows(),
    respond(config: any) {
      for (const [key, path] of Object.entries(filterPaths)) if (config.method === 'get' && config.url === path) return structuredClone(filterFixtures[key as keyof typeof filterFixtures]);
      if (config.method !== 'get') throw Error(`Unexpected navigation mutation ${config.method} ${config.url}`);
      if (config.url === catalog) {
        const limit = Number(config.params.limit), page = fixture.count <= limit ? 1 : Number(config.params.page);
        return { list: structuredClone(fixture.products.slice((page - 1) * limit, page * limit)), count: fixture.count };
      }
      if (config.url === header) return { list: structuredClone(fixture.headers) };
      if (config.url === replies) return { list: [review(config.params.product_id || 51)], count: 1 };
      if (/^\/product\/reply\/get_reply\/\d+$/.test(config.url)) return { content: '原平台回复' };
      if (/^\/product\/reply\/comment\/\d+$/.test(config.url)) return { list: [], count: 0 };
      throw Error(`Unexpected navigation API ${config.url}`);
    },
  };
  runtime.request.defaults.adapter = async (config: any) => {
    calls.push(config); const custom = await override(config, fixture), data = custom === undefined ? fixture.respond(config) : custom;
    return { config, data: { status: 200, msg: 'catalog-navigation-owned-fixture', data }, status: 200, statusText: 'fixture', headers: {} };
  };
  const node = (tag?: string, text?: string): Node => ({ tag, text, props: {}, children: [] });
  const renderer = runtime.createRenderer({ createElement: (tag: string) => node(tag), createText: (text: string) => node('#text', text), createComment: (text: string) => node('#comment', text),
    insert(child: Node, parent: Node, anchor?: Node) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; if (index < 0) parent.children.push(child); else parent.children.splice(index, 0, child); },
    remove(child: Node) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = undefined; },
    parentNode: (child: Node) => child.parent, nextSibling: (child: Node) => child.parent?.children[child.parent.children.indexOf(child) + 1] ?? null,
    patchProp(child: Node, key: string, _previous: any, value: any) { child.props[key] = value; }, setText(child: Node, text: string) { child.text = text; }, setElementText(child: Node, text: string) { child.text = text; child.children = []; } });
  await runtime.router.push(path); await runtime.router.isReady();
  const app = renderer.createApp({ render: () => runtime.h(runtime.RouterView) }), pinia = runtime.createPinia(), surface = node('root');
  app.use(pinia); app.use(runtime.router); controls(app); app.mount(surface); await flush();
  return { fixture, calls, surface, nodes: () => walk(surface), text: () => textOf(surface),
    get view() { return runtime.router.currentRoute.value.path === '/product' ? runtime.views.product : runtime.views.reply; },
    async navigate(next: any) { await runtime.router.push(next); await flush(); },
    close() { app.unmount(); runtime.disposePinia(pinia); },
  };
}
const reads = (f: any, url: string) => f.calls.filter((config: any) => config.method === 'get' && config.url === url);
function button(f: any, label: string): Node { const result = f.nodes().find((node: Node) => node.tag === 'button' && textOf(node).trim() === label); if (!result) throw Error(`Missing rendered button: ${label}`); return result; }
async function click(f: any, label: string) { const control = button(f, label); if (control.props.disabled || control.props.loading) throw Error(`Disabled rendered button ${label}`); await control.props.onClick(); await flush(); }
async function input(f: any, placeholder: string, value: string) { const control = f.nodes().find((node: Node) => node.tag === 'input' && node.props.placeholder === placeholder); if (!control) throw Error(`Missing rendered input ${placeholder}`); control.props.onInput({ target: { value } }); await flush(); }

describe('actual Admin catalog pages, counted Axios consumers and real Router registry', () => {
  it('uses the main catalog endpoint, independent eight-state header and actual count without inventing stock for NULL SUM', async () => {
    const f = await mount(); try {
      expect(reads(f, catalog)).toHaveLength(1); expect(reads(f, header)).toHaveLength(1);
      expect(reads(f, catalog)[0]).toMatchObject({ method: 'get', baseURL: '/adminapi', params: { page: 1, limit: 10, type: 1 } });
      expect(reads(f, catalog)[0].headers['Authori-zation']).toBe('Bearer catalog-admin-a');
      expect(f.calls.some((config: any) => config.url === `${catalog}/list`)).toBe(false);
      expect(f.view.list.value[0].stock).toBeNull(); expect(f.view.total.value).toBe(31);
      expect(f.nodes().find((node: Node) => node.tag === 'pagination')?.props.total).toBe(31);
      expect(f.view.headers.value.map((row: any) => row.type)).toEqual([1, 2, 4, 5, 6, 0, -1, -2]);
      for (const row of f.fixture.headers) expect(button(f, `${row.name} (${row.count})`)).toBeTruthy();
      const inventory = f.nodes().find((node: Node) => node.tag === 'column' && node.props.label === '库存')!;
      expect(textOf(inventory.children[0])).toBe('—');
    } finally { f.close(); }
  });

  it('retains server count through delayed page two and uses the source count-at-most-limit first-page fallback', async () => {
    const wait = gate(), f = await mount('/product', undefined, (config, fixture) => config.url === catalog && config.params.page === 2 ? wait.promise.then(() => fixture.respond(config)) : undefined);
    try {
      f.nodes().find((node: Node) => node.tag === 'pagination')!.props.onPage(2); await flush();
      expect(f.view.query.page).toBe(2); expect(f.view.total.value).toBe(31); expect(reads(f, catalog)).toHaveLength(2);
      wait.resolve(); await flush(); expect(f.view.query.page).toBe(2); expect(f.text()).toContain('供应商商品 61');
      f.fixture.products = f.fixture.products.slice(0, 7); f.fixture.count = 7;
      f.nodes().find((node: Node) => node.tag === 'pagination')!.props.onPage(4); await flush();
      expect(f.view.query.page).toBe(1); expect(f.view.total.value).toBe(7);
      expect(reads(f, catalog).map((config: any) => config.params.page)).toEqual([1, 2, 4]);
      expect(f.text()).toContain('供应商商品 51');
    } finally { wait.resolve(); f.close(); }
  });

  it('sends rendered keyword and source state controls through the counted main list and preserves unrelated route query/hash', async () => {
    const f = await mount('/product?type=0&source=legacy#catalog'); try {
      expect(reads(f, catalog)[0].params.type).toBe(0);
      await input(f, '请输入商品名称', '供应商'); await click(f, '搜索');
      expect(reads(f, catalog).at(-1).params).toMatchObject({ page: 1, limit: 10, store_name: '供应商', type: 0 });
      await click(f, '强制下架 (9)');
      expect(reads(f, catalog).at(-1).params.type).toBe(-2);
      expect(runtime.router.currentRoute.value).toMatchObject({ path: '/product', query: { type: '-2', source: 'legacy' }, hash: '#catalog' });
      await click(f, '重置'); expect(reads(f, catalog).at(-1).params.store_name ?? '').toBe('');
      expect(reads(f, header).at(-1).params.store_name ?? '').toBe('');
    } finally { f.close(); }
  });

  it('requires a separate reply capability for the rendered product entry and mounts the real counted reply page after navigation', async () => {
    const f = await mount('/product', ['product.view']); try {
      expect(f.nodes().filter((node: Node) => node.tag === 'button' && textOf(node).trim() === '查看评价')).toHaveLength(0);
      login(['product.view', 'reply.view']); browser.dispatchEvent(new Event('admin-session-changed')); await flush();
      expect(button(f, '查看评价')).toBeTruthy(); await click(f, '查看评价');
      expect(runtime.router.currentRoute.value).toMatchObject({ path: '/reply', query: { product_id: '51' } });
      expect(reads(f, replies).at(-1).params).toMatchObject({ product_id: 51, is_reply: '', page: 1, limit: 15 });
      expect(f.text()).toContain('商品 51 的评价'); expect(f.text()).toContain('仅查看');
      expect(f.nodes().filter((node: Node) => node.tag === 'button' && textOf(node).trim() === '平台回复')).toHaveLength(0);
      expect(f.calls.filter((config: any) => config.method !== 'get')).toHaveLength(0);
    } finally { f.close(); }
  });

  it('executes the real legacy redirects preserving query/hash and makes a nonempty path product ID authoritative over duplicate query IDs', async () => {
    const f = await mount('/admin/product/product_list?type=6&source=old#list'); try {
      expect(runtime.router.currentRoute.value).toMatchObject({ path: '/product', query: { type: '6', source: 'old' }, hash: '#list' });
      expect(reads(f, catalog)[0].params.type).toBe(6);
      await f.navigate('/admin/product/product_reply/52?product_id=51&product_id=53&is_reply=0&source=old#reply');
      expect(runtime.router.currentRoute.value).toMatchObject({ path: '/reply', query: { product_id: '52', is_reply: '0', source: 'old' }, hash: '#reply' });
      expect(reads(f, replies).at(-1).params).toMatchObject({ product_id: 52, is_reply: 0 });
      await f.navigate('/admin/product/product_reply?product_id=53&is_reply=1&source=menu#all');
      expect(runtime.router.currentRoute.value).toMatchObject({ path: '/reply', query: { product_id: '53', is_reply: '1', source: 'menu' }, hash: '#all' });
      expect(reads(f, replies).at(-1).params).toMatchObject({ product_id: 53, is_reply: 1 });
      await f.navigate('/admin/product/product_reply'); expect(reads(f, replies).at(-1).params).toMatchObject({ product_id: 0, is_reply: '' });
    } finally { f.close(); }
  });

  it('rejects malformed or repeated catalog states and reply IDs/statuses before API requests, clearing prior rows', async () => {
    const f = await mount(); try {
      for (const path of ['/product?type=8', '/product?type=1&type=2', '/product?type=01', '/product?type=bad']) {
        const before = f.calls.length; await f.navigate(path); expect(f.calls).toHaveLength(before); expect(f.view.list.value).toEqual([]); expect(f.text()).toContain('状态');
      }
      await f.navigate('/reply?product_id=51&is_reply=0'); expect(reads(f, replies).at(-1).params.is_reply).toBe(0);
      for (const path of ['/reply?product_id=51&product_id=52', '/reply?product_id=2147483648', '/admin/product/product_reply/01', '/reply?product_id=51&is_reply=0&is_reply=1', '/reply?is_reply=2']) {
        const before = f.calls.length; await f.navigate(path); expect(f.calls).toHaveLength(before); expect(f.view.list.value).toEqual([]); expect(f.nodes().some((node: Node) => node.tag === 'alert' && node.props.type === 'error')).toBe(true);
      }
    } finally { f.close(); }
  });

  it('preserves is_reply zero on query-only navigation, closes an open reply editor and suppresses the canceled previous product response', async () => {
    const wait = gate(), f = await mount('/reply?product_id=51&is_reply=0', ['reply.view', 'reply.manage'], config => config.url === replies && config.params.product_id === 52 ? wait.promise.then(() => ({ list: [review(52, '不可恢复的旧结果')], count: 1 })) : undefined);
    try {
      expect(reads(f, replies)[0].params.is_reply).toBe(0); await click(f, '平台回复');
      expect(f.nodes().some((node: Node) => node.tag === 'dialog')).toBe(true);
      await f.navigate('/reply?product_id=52&is_reply=0'); const previous = reads(f, replies).at(-1);
      expect(previous.params).toMatchObject({ product_id: 52, is_reply: 0 }); expect(f.view.list.value).toEqual([]);
      expect(f.nodes().filter((node: Node) => node.tag === 'dialog')).toHaveLength(0);
      await f.navigate('/reply?product_id=53&is_reply=1'); expect(previous.signal.aborted).toBe(true);
      wait.resolve(); await flush(); expect(f.view.query).toMatchObject({ product_id: 53, is_reply: 1, page: 1 });
      expect(f.text()).toContain('商品 53 的评价'); expect(f.text()).not.toContain('不可恢复的旧结果');
    } finally { wait.resolve(); f.close(); }
  });

  it('cancels pending catalog data on permission withdrawal and uses the replacement token for a fresh authorized session', async () => {
    const wait = gate(); let defer = false;
    const f = await mount('/product', ['product.view', 'reply.view'], (config, fixture) => defer && [catalog, header].includes(config.url) ? wait.promise.then(() => fixture.respond(config)) : undefined);
    try {
      defer = true; await input(f, '请输入商品名称', '旧会话'); button(f, '搜索').props.onClick(); await flush();
      const pending = f.calls.filter((config: any) => config.signal && !config.signal.aborted).slice(-2);
      login(['reply.view'], 'catalog-admin-b', 21); browser.dispatchEvent(new Event('admin-session-changed')); await flush();
      expect(pending).toHaveLength(2); expect(pending.every((config: any) => config.signal.aborted)).toBe(true);
      expect(f.view.list.value).toEqual([]); expect(f.view.total.value).toBe(0); expect(f.text()).toContain('权限');
      wait.resolve(); await flush(); expect(f.view.list.value).toEqual([]); expect(f.text()).not.toContain('供应商商品 51');
      defer = false; login(['product.view'], 'catalog-admin-c', 22); browser.dispatchEvent(new Event('admin-session-changed')); await flush();
      expect(reads(f, catalog).at(-1).headers['Authori-zation']).toBe('Bearer catalog-admin-c'); expect(f.text()).toContain('供应商商品 51');
      expect(f.nodes().filter((node: Node) => node.tag === 'button' && textOf(node).trim() === '查看评价')).toHaveLength(0);
    } finally { wait.resolve(); f.close(); }
  });

  it('validates counted DTO boundaries in the real Axios helpers, keeping NULL stock and rejecting string counts or malformed headers', async () => {
    const f = await mount(); try {
      runtime.request.defaults.adapter = async (config: any) => ({ config, status: 200, statusText: 'fixture', headers: {}, data: { status: 200, msg: 'DTO-fixture', data: config.url === catalog ? { list: [product(51, null)], count: '31' } : { list: f.fixture.headers } } });
      await expect(runtime.productApi.apiAdminProductList({ page: 1, limit: 10, type: 1 })).rejects.toThrow('计数');
      runtime.request.defaults.adapter = async (config: any) => ({ config, status: 200, statusText: 'fixture', headers: {}, data: { status: 200, msg: 'DTO-fixture', data: config.url === catalog ? { list: [product(51, null)], count: 31 } : { list: f.fixture.headers.slice().reverse() } } });
      await expect(runtime.productApi.apiAdminProductList({ page: 1, limit: 10, type: 1 })).resolves.toMatchObject({ list: [{ stock: null }], count: 31 });
      await expect(runtime.productApi.apiAdminProductTypeHeader({})).rejects.toThrow('状态计数');
      runtime.request.defaults.adapter = async (config: any) => ({ config, status: 200, statusText: 'fixture', headers: {}, data: { status: 200, msg: 'DTO-fixture', data: { list: [product(51, -1)], count: 31 } } });
      // The target schema has signed stock; a read can expose negative target
      // state for reconciliation. PHP's unsigned source cannot produce it.
      await expect(runtime.productApi.apiAdminProductList({ page: 1, limit: 10, type: 1 })).resolves.toMatchObject({ list: [{ stock: -1 }], count: 31 });
      for (const stock of [Number.NaN, 0.5]) {
        runtime.request.defaults.adapter = async (config: any) => ({ config, status: 200, statusText: 'fixture', headers: {}, data: { status: 200, msg: 'DTO-fixture', data: { list: [product(51, stock)], count: 31 } } });
        await expect(runtime.productApi.apiAdminProductList({ page: 1, limit: 10, type: 1 })).rejects.toThrow('商品列表');
      }
    } finally { f.close(); }
  });

  it('shows independent list/header failures without invented rows or state counts and can refresh both sources', async () => {
    let failed = 'header';
    const f = await mount('/product', ['product.view'], (config) => {
      if (failed === 'header' && config.url === header) throw Error('独立状态计数读取失败');
      if (failed === 'list' && config.url === catalog) throw Error('独立主列表读取失败');
      return undefined;
    });
    try {
      expect(f.view.list.value).toHaveLength(10); expect(f.view.total.value).toBe(31); expect(f.view.headers.value).toEqual([]);
      expect(f.text()).toContain('独立状态计数读取失败'); expect(f.text()).toContain('供应商商品 51');
      expect(f.nodes().filter((node: Node) => node.tag === 'button' && textOf(node).includes('销售中'))).toHaveLength(0);
      failed = 'list'; await click(f, '搜索'); expect(f.view.list.value).toEqual([]); expect(f.view.total.value).toBe(0);
      expect(f.view.headers.value).toHaveLength(8); expect(f.text()).toContain('独立主列表读取失败');
      expect(f.text()).not.toContain('供应商商品 51'); expect(button(f, '销售中 (31)')).toBeTruthy();
      failed = ''; await click(f, '搜索'); expect(f.view.list.value).toHaveLength(10); expect(f.view.total.value).toBe(31);
      expect(f.view.readError.value).toBe(''); expect(f.view.headerError.value).toBe(''); expect(f.view.headers.value).toHaveLength(8);
    } finally { f.close(); }
  });

  it('does not reopen a batch editor or dispatch a confirmed deletion after capability, session or catalog-state changes', async () => {
    // Each await boundary must retain its own authorization and page stamp.
    // These three probes remain one definition, not three counted tests.
    for (const changed of ['capability', 'session', 'state', 'filter']) {
      const options = gate(), confirmation = gate();
      const candidates = { categories: [{ id: 91, name: '旧上下文候选' }], brands: [], product_labels: [], user_labels: [], gift_coupons: [], system_forms: [], shipping_templates: [], ensures: [], parameter_templates: [], sku_rule_templates: [] };
      const f = await mount('/product?type=1', ['product.view', 'product.manage', 'reply.view'], config => config.url === '/product/editor/options' ? options.promise.then(() => structuredClone(candidates)) : undefined);
      const originalProducts = structuredClone(f.fixture.products);
      const changeContext = async () => {
        if (changed === 'state') await f.navigate('/product?type=6');
        else if (changed === 'filter') { f.view.query.supplier_id = 20; await f.view.reload(); await flush(); }
        else {
          const current = JSON.parse(values.get('admin_session')!);
          login(changed === 'capability' ? ['product.view', 'reply.view'] : ['product.view', 'product.manage', 'reply.view'],
            changed === 'capability' ? values.get('admin_token')! : `${values.get('admin_token')}-replacement`,
            changed === 'capability' ? current.userInfo.id : current.userInfo.id + 1);
          browser.dispatchEvent(new Event('admin-session-changed')); await flush();
        }
      };
      try {
        f.nodes().find((node: Node) => node.tag === 'table')!.props.onSelectionChange([f.view.list.value[0]]); await flush();
        const opening = button(f, '批量操作').props.onClick(); await flush();
        expect(reads(f, '/product/editor/options')).toHaveLength(1); expect(f.view.batchDialogVisible.value).toBe(false);
        await changeContext(); const afterBatchChange = f.calls.length;
        options.resolve(); await opening; await flush();
        expect(f.view.batchDialogVisible.value).toBe(false); expect(f.view.batchOptionsLoaded.value).toBe(false);
        expect(f.view.batchOptions.categories).toEqual([]); expect(f.text()).not.toContain('旧上下文候选');
        expect(f.calls).toHaveLength(afterBatchChange); expect(f.view.list.value[0].stock).toBeNull();

        login(['product.view', 'product.manage', 'reply.view'], `catalog-admin-restored-${changed}`, 20);
        browser.dispatchEvent(new Event('admin-session-changed')); await flush();
        await f.navigate('/product?type=1'); runtime.dialogs.state.confirm = () => confirmation.promise;
        const deleting = button(f, '移入回收站').props.onClick(); await flush();
        expect(f.view.recycleProduct.value.store_name).toBe('供应商商品 51'); expect(f.view.recycleVisible.value).toBe(true);
        expect(f.calls.filter((config: any) => config.method !== 'get')).toHaveLength(0);
        await changeContext(); const afterDeleteChange = f.calls.length;
        confirmation.resolve(); await deleting; await flush();
        expect(f.view.recycleVisible.value).toBe(false); expect(f.view.recycleProduct.value).toBeNull();
        expect(f.calls).toHaveLength(afterDeleteChange); expect(f.calls.filter((config: any) => config.method !== 'get')).toHaveLength(0);
        expect(f.view.list.value[0].stock).toBeNull(); expect(f.fixture.products).toEqual(originalProducts);
        expect(f.view.canManage.value).toBe(changed !== 'capability'); expect(f.view.canMutateState.value).toBe(['session', 'filter'].includes(changed));
      } finally { options.resolve(); confirmation.resolve(); runtime.dialogs.state.confirm = async () => {}; f.close(); }
    }
  });

  it('keeps the replacement batch busy when an old session request completes and blocks repeated pending submissions', async () => {
    const oldResponse = gate(), replacementResponse = gate(), submissions: Promise<unknown>[] = [];
    const candidates = { categories: [], brands: [], product_labels: [], user_labels: [], gift_coupons: [], system_forms: [], shipping_templates: [], ensures: [], parameter_templates: [], sku_rule_templates: [] };
    const f = await mount('/product?type=1', ['product.view', 'product.manage'], config => {
      if (config.url === '/product/editor/options') return structuredClone(candidates);
      if (config.method === 'post' && config.url === '/product/set_show') {
        const token = config.headers['Authori-zation'];
        if (token === 'Bearer catalog-admin-a') return oldResponse.promise.then(() => ({ changed: 1, verified: true }));
        if (token === 'Bearer catalog-admin-b') return replacementResponse.promise.then(() => ({ changed: 1, verified: true }));
        throw Error(`Unexpected batch actor ${token}`);
      }
      return undefined;
    });
    const posts = () => f.calls.filter((config: any) => config.method === 'post' && config.url === '/product/set_show');
    const select = async (index: number) => {
      f.nodes().find((node: Node) => node.tag === 'table')!.props.onSelectionChange([f.view.list.value[index]]); await flush();
      await click(f, '批量操作');
    };
    // Dispatch a saved rendered handler twice to exercise the handler's own
    // guard, including events already queued before loading reached the DOM.
    const dispatch = (handler: () => Promise<unknown>) => { const result = handler(); submissions.push(result); return result; };
    try {
      await select(0);
      f.nodes().find((node: Node) => node.tag === 'select' && node.props.value === 'show')!.props.onChange('hide'); await flush();
      const oldConfirm = button(f, '确认执行').props.onClick;
      const oldSubmission = dispatch(oldConfirm); await flush();
      expect(posts()).toHaveLength(1); expect(JSON.parse(posts()[0].data)).toEqual({ ids: [51], is_show: 0 });
      expect(posts()[0].headers['Authori-zation']).toBe('Bearer catalog-admin-a');
      expect(button(f, '确认执行').props.loading).toBe(true);
      dispatch(oldConfirm); await flush(); expect(posts()).toHaveLength(1);
      await button(f, '批量操作').props.onClick(); await flush();
      expect(f.nodes().find((node: Node) => node.tag === 'select' && node.props.value === 'hide')!.props.value).toBe('hide');
      expect(reads(f, '/product/editor/options')).toHaveLength(1);

      login(['product.view', 'product.manage'], 'catalog-admin-b', 21);
      browser.dispatchEvent(new Event('admin-session-changed')); await flush();
      expect(f.nodes().filter((node: Node) => node.tag === 'dialog')).toHaveLength(0);
      await select(1);
      const replacementConfirm = button(f, '确认执行').props.onClick;
      const replacementSubmission = dispatch(replacementConfirm); await flush();
      expect(posts()).toHaveLength(2); expect(JSON.parse(posts()[1].data)).toEqual({ ids: [52], is_show: 1 });
      expect(posts()[1].headers['Authori-zation']).toBe('Bearer catalog-admin-b');
      expect(reads(f, '/product/editor/options')).toHaveLength(2);
      expect(button(f, '确认执行').props.loading).toBe(true);
      dispatch(replacementConfirm); await flush(); expect(posts()).toHaveLength(2);

      const beforeOldCompletion = f.calls.length;
      oldResponse.resolve(); await oldSubmission; await flush();
      expect(button(f, '确认执行').props.loading).toBe(true);
      expect(f.nodes().filter((node: Node) => node.tag === 'dialog')).toHaveLength(1);
      expect(runtime.dialogs.state.successes).toEqual([]); expect(runtime.dialogs.state.errors).toEqual([]);
      expect(f.calls).toHaveLength(beforeOldCompletion);
      dispatch(replacementConfirm); await flush(); expect(posts()).toHaveLength(2);

      const beforeReplacementReads = reads(f, catalog).length;
      replacementResponse.resolve(); await replacementSubmission; await flush();
      expect(f.view.batchSubmitting.value).toBe(false);
      expect(f.nodes().filter((node: Node) => node.tag === 'dialog')).toHaveLength(0);
      expect(runtime.dialogs.state.successes).toEqual(['已处理 1 个商品']);
      expect(runtime.dialogs.state.errors).toEqual([]); expect(posts()).toHaveLength(2);
      expect(reads(f, catalog)).toHaveLength(beforeReplacementReads + 1);
      expect(reads(f, catalog).at(-1).headers['Authori-zation']).toBe('Bearer catalog-admin-b');
      expect(f.view.list.value).toHaveLength(10); expect(f.view.total.value).toBe(31);
    } finally {
      oldResponse.resolve(); replacementResponse.resolve(); await Promise.allSettled(submissions); await flush(); f.close();
    }
  });
});

describe('actual counted catalogue four-dimensional filter consumption', () => {
  async function selectFilter(f: any, placeholder: string, value: unknown) {
    const control = f.nodes().find((node: Node) => ['select', 'cascader'].includes(node.tag ?? '') && node.props.placeholder === placeholder);
    if (!control || control.props.disabled) throw Error(`Missing or disabled filter ${placeholder}`);
    control.props.onChange(value); await flush();
  }

  it('loads the genuine four selector routes for product readers and exposes category multi-selection, full brand paths, grouped labels and Supplier names', async () => {
    const f = await mount('/product', ['product.view']); try {
      for (const path of Object.values(filterPaths)) expect(reads(f, path)).toHaveLength(1);
      expect(f.calls.some((config: any) => ['/supplier/supplier', '/product/editor/options', '/product/all_label'].includes(config.url))).toBe(false);
      const categories = f.nodes().find((node: Node) => node.props.placeholder === '请选择商品分类')!;
      expect(categories.props.choiceProps).toEqual({ emitPath: false, multiple: true, checkStrictly: true });
      expect(categories.props.options).toEqual(filterFixtures.categories);
      const brands = f.nodes().find((node: Node) => node.props.placeholder === '请选择商品品牌')!;
      expect(brands.props.choiceProps).toEqual({ emitPath: true, checkStrictly: true });
      expect(brands.props.options[0].children[0].children[0].value).toBe(23);
      expect(f.view.filterOptions.labels).toEqual([31,32].map(id => ({ id, label_name: `标签 ${id}`, group_name: '标签组' })));
      expect(f.nodes().some((node: Node) => node.tag === 'option' && node.props.label === '停用但未删除供应商' && node.props.value === 20)).toBe(true);
      expect(f.view.filterError.value).toBe(''); expect(f.view.canManage.value).toBe(false);
      expect(f.nodes().some((node: Node) => node.tag === 'button' && textOf(node) === '批量操作')).toBe(false);
    } finally { f.close(); }
  });

  it('sends all four rendered choices as immutable Axios bracket arrays to both list and header, retaining filters on pagination and state changes and clearing all on reset', async () => {
    const f = await mount('/product?type=1&source=legacy#filters', ['product.view']); try {
      await selectFilter(f, '请选择商品分类', [11,12]);
      await selectFilter(f, '请选择供应商', 20);
      await selectFilter(f, '请选择商品品牌', [21,22,23]);
      await selectFilter(f, '请选择商品标签', [31,32]);
      const expected = { cate_id: [11,12], supplier_id: 20, brand_id: [21,22,23], store_label_id: [31,32] };
      const last = reads(f, catalog).at(-1);
      expect(last.params).toMatchObject({ page: 1, ...expected });
      expect(reads(f, header).at(-1).params).toEqual(last.params);
      const wire = new URL(runtime.request.getUri(last), 'https://local.invalid');
      expect(wire.pathname).toBe('/adminapi/product/product');
      expect(wire.searchParams.getAll('cate_id[]')).toEqual(['11','12']);
      expect(wire.searchParams.getAll('brand_id[]')).toEqual(['21','22','23']);
      expect(wire.searchParams.getAll('store_label_id[]')).toEqual(['31','32']);
      expect(wire.searchParams.get('supplier_id')).toBe('20');
      f.nodes().find((node: Node) => node.tag === 'pagination')!.props.onPage(2); await flush();
      expect(reads(f, catalog).at(-1).params).toMatchObject({ page: 2, ...expected });
      await click(f, '回收站 (3)');
      expect(reads(f, catalog).at(-1).params).toMatchObject({ page: 1, type: 6, ...expected });
      expect(runtime.router.currentRoute.value).toMatchObject({ query: { type: '6', source: 'legacy' }, hash: '#filters' });
      for (const path of Object.values(filterPaths)) expect(reads(f, path)).toHaveLength(1);
      await selectFilter(f, '请选择商品分类', [12]);
      expect(last.params.cate_id).toEqual([11,12]);
      await click(f, '重置');
      expect(reads(f, catalog).at(-1).params).toMatchObject({ page: 1, type: 6, cate_id: [], brand_id: [], store_label_id: [], supplier_id: '', store_name: '' });
      expect(reads(f, header).at(-1).params).toEqual(reads(f, catalog).at(-1).params);
      await selectFilter(f, '请选择商品品牌', undefined);
      await selectFilter(f, '请选择供应商', undefined);
      expect(reads(f, catalog).at(-1).params).toMatchObject({ brand_id: [], supplier_id: '' });
    } finally { f.close(); }
  });

  it('discards earlier filtered list/header responses, closes mutation dialogs and preserves server category count/list asymmetry', async () => {
    const old = gate(); let delayed = false;
    const f = await mount('/product', ['product.view', 'product.manage'], config => {
      if ([catalog,header].includes(config.url) && config.params.supplier_id === 19 && delayed) return old.promise.then(() => config.url === catalog ? { list: [product(999)], count: 999 } : { list: headerRows().map(row => ({ ...row, count: 999 })) });
      if (config.url === catalog && config.params.cate_id?.length) return { list: [], count: 4 };
      return undefined;
    });
    try {
      delayed = true; await selectFilter(f, '请选择供应商', 19);
      await selectFilter(f, '请选择供应商', 20);
      old.resolve(); await flush();
      expect(f.view.list.value.some((row: any) => row.id === 999)).toBe(false); expect(f.view.total.value).toBe(31);
      expect(f.view.headers.value.every((row: any) => row.count !== 999)).toBe(true);
      await click(f, '移入回收站'); expect(f.view.recycleVisible.value).toBe(true);
      await selectFilter(f, '请选择商品分类', [11]);
      expect(f.view.recycleVisible.value).toBe(false); expect(f.view.recycleProduct.value).toBeNull();
      expect(f.view.list.value).toEqual([]); expect(f.view.total.value).toBe(4);
      expect(f.nodes().find((node: Node) => node.tag === 'pagination')!.props.total).toBe(4);
      expect(f.calls.filter((config: any) => config.method !== 'get')).toEqual([]);
    } finally { old.resolve(); f.close(); }
  });

  it('keeps successful filter sources and counted reads usable after one candidate source fails, retries without clearing selected IDs and never replays a mutation', async () => {
    let fail = true;
    const f = await mount('/product', ['product.view'], config => {
      if (config.url === filterPaths.suppliers && fail) throw Error('独立供应商读取失败');
      return undefined;
    }); try {
      expect(f.view.filterOptions.suppliers).toEqual([]); expect(f.view.filterOptions.categories).toHaveLength(1);
      expect(f.text()).toContain('供应商筛选资料读取失败'); expect(f.view.list.value).toHaveLength(10);
      await selectFilter(f, '请选择商品分类', [12]);
      expect(reads(f, catalog).at(-1).params.cate_id).toEqual([12]);
      fail = false; await click(f, '重试筛选资料');
      expect(f.view.filterOptions.suppliers).toEqual(filterFixtures.suppliers); expect(f.view.filterError.value).toBe('');
      expect(f.view.query.cate_id).toEqual([12]);
      expect(f.calls.filter((config: any) => config.method !== 'get')).toEqual([]);
    } finally { f.close(); }
  });

  it('aborts and ignores old candidate results across session replacement and permission withdrawal, resetting all previous selections', async () => {
    const old = gate(); let first = true;
    const f = await mount('/product', ['product.view'], config => Object.values(filterPaths).includes(config.url) && first ? old.promise.then(() => structuredClone(filterFixtures[Object.keys(filterPaths).find(key => filterPaths[key as keyof typeof filterPaths] === config.url) as keyof typeof filterFixtures])) : undefined);
    try {
      const requests = f.calls.filter((config: any) => Object.values(filterPaths).includes(config.url));
      expect(requests).toHaveLength(4); expect(f.view.filterLoading.suppliers).toBe(true);
      f.view.query.supplier_id = 20; f.view.query.cate_id = [11];
      first = false; login(['product.view'], 'catalog-replacement', 21); browser.dispatchEvent(new Event('admin-session-changed')); await flush();
      expect(requests.every((config: any) => config.signal.aborted)).toBe(true);
      expect(f.view.query).toMatchObject({ supplier_id: '', cate_id: [], brand_id: [], store_label_id: [] });
      login(['reply.view'], 'catalog-withdrawn', 22); browser.dispatchEvent(new Event('admin-session-changed')); await flush();
      const count = f.calls.length; expect(f.view.filterOptions.suppliers).toEqual([]); expect(f.view.list.value).toEqual([]);
      old.resolve(); await flush(); expect(f.calls).toHaveLength(count);
      expect(f.view.filterOptions.categories).toEqual([]); expect(f.view.filterError.value).toBe('');
    } finally { old.resolve(); f.close(); }
  });

  it('rejects malformed filter DTOs and duplicate or oversize selections without retaining actionable old rows', async () => {
    const f = await mount('/product', ['product.view']); try {
      const cases: Array<[string, unknown]> = [
        ['apiCatalogFilterCategories', [{ value: 1, label: 'foreign parent', pid: 3 }]],
        ['apiCatalogFilterBrands', [{ value: 1, label: 'root', pid: 0, children: [{ value: 1, label: 'duplicate', pid: 1 }] }]],
        ['apiCatalogFilterLabels', [{ id: 71, label_name: '组', type: 0, relation_id: 0, children: [{ id: 31, label_name: '孤儿', label_cate: 72, type: 0, relation_id: 0 }] }]],
        ['apiCatalogFilterSuppliers', [{ id: 20, supplier_name: 'one' }, { id: 20, supplier_name: 'copy' }]],
      ];
      for (const [method, data] of cases) {
        runtime.request.defaults.adapter = async (config: any) => ({ config, status: 200, statusText: 'fixture', headers: {}, data: { status: 200, msg: 'malformed filter fixture', data } });
        await expect(runtime.filterApi[method]()).rejects.toThrow('候选');
      }
      for (const value of [[11,11], Array.from({ length: 101 }, (_, i) => i + 1), [0], [2_147_483_648]]) {
        const count = f.calls.length; f.view.query.cate_id = value; await f.view.reload(); await flush();
        expect(f.calls).toHaveLength(count); expect(f.view.list.value).toEqual([]); expect(f.view.total.value).toBe(0);
        expect(f.view.readError.value).toContain('筛选条件');
      }
    } finally { f.close(); }
  });
});

describe('filter changes during an existing batch request', () => {
  it('keeps the in-flight batch guard through valid and invalid filter changes and ignores the old completion', async () => {
    const pending = gate();
    const f = await mount('/product', ['product.view', 'product.manage'], config => {
      if (config.url === '/product/editor/options') return { categories: [], brands: [], product_labels: [], user_labels: [], gift_coupons: [], system_forms: [], shipping_templates: [], ensures: [], parameter_templates: [], sku_rule_templates: [] };
      if (config.method === 'post' && config.url === '/product/set_show') return pending.promise.then(() => ({ changed: 1, verified: true }));
      return undefined;
    });
    let writing: Promise<unknown> | undefined;
    try {
      f.nodes().find((node: Node) => node.tag === 'table')!.props.onSelectionChange([f.view.list.value[0]]); await flush();
      await click(f, '批量操作'); writing = button(f, '确认执行').props.onClick(); await flush();
      expect(f.view.batchSubmitting.value).toBe(true);
      f.view.query.supplier_id = 20; await f.view.reload(); await flush();
      expect(f.view.batchSubmitting.value).toBe(true); expect(f.view.selectedRows.value).toEqual([]);
      f.nodes().find((node: Node) => node.tag === 'table')!.props.onSelectionChange([f.view.list.value[0]]); await flush();
      await f.view.openBatch(); expect(f.view.batchDialogVisible.value).toBe(false);
      f.view.query.cate_id = [11,11]; await f.view.reload(); await flush();
      expect(f.view.batchSubmitting.value).toBe(true); expect(f.view.list.value).toEqual([]);
      pending.resolve(); await writing; await flush();
      expect(f.view.batchSubmitting.value).toBe(false); expect(runtime.dialogs.state.successes).toEqual([]);
      expect(f.calls.filter((config: any) => config.method !== 'get')).toHaveLength(1);
    } finally { pending.resolve(); await writing; f.close(); }
  });
});
