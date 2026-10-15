import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../view/admin-ts');
const require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc');
const catalog = '/product/product', header = `${catalog}/type_header`, erp = '/api/admin/erp/config';
const markerKey = 'admin_recycle_unconfirmed_v1';
let runtime: any, browser: EventTarget, values: Map<string, string>;

beforeAll(async () => {
  // Import Vue/Router without a DOM, then provide only document.title for the
  // actual registry guard. The renderer below supplies the host implementation.
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { pathname: '/product', href: '', search: '' } }));
  const bundle = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    import ProductPage from './src/pages/product/ProductList.vue';
    import StockPage from './src/pages/product/ProductRecycleDialog.vue';
    export {default as router} from './src/router';
    export {default as request} from './src/utils/request';
    export * as recycleApi from './src/api/productRecycle';
    export * as productApi from './src/api/product';
    export * as dialogs from 'element-plus';
    export {createPinia,disposePinia} from 'pinia';
    export {createRenderer,nextTick,h,provide,inject,watch} from 'vue';
    export {RouterView} from 'vue-router';
    export const views={};
    for(const [name,page] of [['product',ProductPage],['stock',StockPage]]) {
      const original=page.setup;page.setup=(props,context)=>{
        const value=original(props,context);views[name]=value;return value;
      };
    }` }, alias: { '@': resolve(root, 'src') },
    define: { 'import.meta.env.DEV': 'false', '__VUE_OPTIONS_API__': 'true', '__VUE_PROD_DEVTOOLS__': 'false', '__VUE_PROD_HYDRATION_MISMATCH_DETAILS__': 'false' },
    bundle: true, write: false, platform: 'browser', format: 'esm', plugins: [{ name: 'actual-recycle-dialog-catalog-and-registry', setup(builder) {
      builder.onLoad({ filter: /\/router\/index\.ts$/ }, ({ path }) => ({
        // Keep every real route/redirect/guard; replace just its history host.
        contents: readFileSync(path, 'utf8').replace(/\bcreateWebHistory\b/g, 'createMemoryHistory'), loader: 'ts', resolveDir: resolve(path, '..'),
      }));
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => {
        if (path.endsWith('/layouts/AdminLayout.vue')) return { contents: `import {h} from 'vue';import {RouterView} from 'vue-router';export default {render:()=>h(RouterView)};`, loader: 'ts', resolveDir: root };
        if (!path.endsWith('/product/ProductList.vue') && !path.endsWith('/product/ProductRecycleDialog.vue')) {
          // Other lazy pages and the already separately tested creation dialog
          // are layout-only substitutes, never navigation or API substitutes.
          return { contents: `export default {render:()=>null};`, loader: 'ts' };
        }
        const descriptor = parse(readFileSync(path, 'utf8'), { filename: path }).descriptor;
        const id = path.endsWith('ProductList.vue') ? 'catalog-runtime' : 'recycle-dialog-runtime';
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
  // This DOM-free renderer supplies only its declared browser hosts. Node's
  // experimental native LockManager is not the browser scheduling fixture;
  // independent-tab tests below exercise an explicit Web Locks host instead.
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('window', Object.assign(browser, { location: { pathname: '/product', href: '', search: '' } }));
  vi.stubGlobal('document', { title: '' });
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  for (const value of Object.values(runtime.dialogs.state) as any[]) if (Array.isArray(value)) value.length = 0;
  runtime.dialogs.state.confirm = async () => {};
  runtime.views.product = runtime.views.stock = undefined;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function login(permissions = ['product.view', 'product.manage'], token = 'stock-admin-a', id = 20) {
  values.set('admin_token', token); values.set('admin_session', JSON.stringify({ userInfo: { id, account: 'stock-manager', head_pic: '', real_name: 'Stock manager', level: 1, roles: '7' }, menus: [], uniqueAuth: permissions }));
}
const product = (id = 51, productType = 0) => ({ id, type: 2, relation_id: 20, product_type: productType, spec_type: 1,
  store_name: `供应商商品 ${id}`, image: '', price: '29.90', stock: 12, sales: 4, is_show: 1, is_del: 0, is_verify: 1 });
const sku = (id: number, productId: number, stock: number, retired = 0) => ({ id, product_id: productId, product_type: 0,
  unique: `SKU${String(id).padStart(5, '0')}`, suk: `规格 ${id}`, stock, sum_stock: stock + 3, sales: 2,
  price: '29.90', cost: '3.25', settle_price: '5.20', image: id === 101 ? 'https://img.example/stock-101.png' : '',
  bar_code: `BAR-${id}`, code: `ERP-${id}`, type: 0, disk_info: null, write_times: 1, is_retired: retired,
  retired_at: retired ? 100 : 0, retired_by: retired ? 20 : 0, retire_reason: retired ? '保留历史' : '' });
const envelope = (status: number, msg: string) => ({ fixtureEnvelope: { status, msg, data: null } });
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
    'el-radio-group': 'radio-group', 'el-radio-button': 'radio-button', 'el-checkbox-group': 'checkbox-group', 'el-checkbox': 'checkbox' })) app.component(name, pass(tag));
  app.component('el-input', { inheritAttrs: false, props: ['modelValue', 'type'], emits: ['update:modelValue'], setup(props: any, { attrs, emit }: any) { return () => runtime.h(props.type === 'textarea' ? 'textarea' : 'input', { ...attrs, value: props.modelValue, onInput: (event: any) => emit('update:modelValue', event.target.value) }); } });
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

async function mount(path = '/product?type=0', permissions = ['product.view', 'product.manage'], override: (config: any, fixture: any) => unknown = () => undefined) {
  login(permissions); const calls: any[] = [], fixture = {
    products: [product(51), product(52, 1), product(53)], count: 3, headers: headerRows(), enabled: false,
    skus: new Map([[51, [sku(101, 51, 5), sku(102, 51, 7), sku(103, 51, 0, 1)]], [53, [sku(201, 53, 12)]]]),
    respond(config: any) {
      if (config.method === 'get' && config.url === catalog) { const list = fixture.products.filter(row => Number(config.params?.type) === 6 ? row.is_del === 1 : row.is_del === 0); return { list: structuredClone(list), count: list.length }; }
      if (config.method === 'delete' && /^\/product\/product\/\d+$/.test(config.url)) { const row = fixture.products.find(row => row.id === Number(config.url.split('/').at(-1)))!; if (config.params.expected_is_del !== row.is_del) return envelope(409,'changed'); row.is_del = row.is_del === 1 ? 0 : 1; if (row.is_del) row.is_show=0; return []; }
      if (config.method === 'get' && config.url === header) return { list: structuredClone(fixture.headers) };
      if (config.method === 'get' && /\/product\/product\/(verify|remove)\/\d+$/.test(config.url)) return { title: config.url.includes('/remove/') ? '强制下架' : '商品审核', action: 'product/product/set_verify/' + config.url.split('/').at(-1), method: 'POST', rules: [] };
      if (config.method === 'get' && /\/get_verify\/\d+$/.test(config.url)) return { verify: 1 };
      if (config.method === 'post' && /\/set_verify\/\d+$/.test(config.url)) {
        const row = fixture.products.find(row => row.id === Number(config.url.split('/').at(-1)))!;
        const body = JSON.parse(config.data); row.is_verify = body.is_verify; row.is_show = body.auto_on_time ? 0 : body.is_show; return [];
      }
      if (config.method === 'get' && config.url === erp) return { open_erp: fixture.enabled };
      const reading = /^\/product\/product\/attrs\/(\d+)$/.exec(config.url);
      if (config.method === 'get' && reading) return structuredClone(fixture.skus.get(Number(reading[1])) ?? []);
      const writing = /^\/product\/product\/saveStocks\/(\d+)$/.exec(config.url);
      if (config.method === 'put' && writing) {
        const productId = Number(writing[1]), updates = JSON.parse(config.data).attrs;
        const rows = fixture.skus.get(productId) ?? [], original = structuredClone(rows); let net = 0;
        for (const update of updates) {
          const row = rows.find(item => item.unique === update.unique), before = original.find(item => item.unique === update.unique);
          if (!row || !before) continue;
          const delta = update.pm === 1 ? update.stock : -update.stock; net += delta;
          row.stock = Math.max(0, before.stock + delta); row.sum_stock = before.sum_stock + delta;
        }
        const parent = fixture.products.find(item => item.id === productId)!;
        parent.stock = Math.max(0, parent.stock + net); fixture.headers[3].count = 3;
        return { stock: parent.stock ? String(parent.stock) : 0 };
      }
      throw Error(`Unexpected stock workflow API ${config.method} ${config.url}`);
    },
  };
  runtime.request.defaults.adapter = async (config: any) => {
    calls.push(config); const custom = await override(config, fixture), data = custom === undefined ? fixture.respond(config) : custom;
    return { config, data: (data as any)?.fixtureEnvelope ?? { status: 200, msg: 'stock-workflow-owned-fixture', data }, status: 200, statusText: 'fixture', headers: {} };
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
    get view() { return runtime.views.product; },
    get dialog() { return runtime.views.stock; },
    async navigate(next: any) { await runtime.router.push(next); await flush(); },
    close() { app.unmount(); runtime.disposePinia(pinia); },
  };
}
const reads = (f: any, url: string) => f.calls.filter((config: any) => config.method === 'get' && config.url === url);
function button(f: any, label: string): Node { const result = f.nodes().find((node: Node) => node.tag === 'button' && textOf(node).trim() === label); if (!result) throw Error(`Missing rendered button: ${label}`); return result; }
async function click(f: any, label: string) { const control = button(f, label); if (control.props.disabled || control.props.loading) throw Error(`Disabled rendered button ${label}`); await control.props.onClick(); await flush(); }

const writes = (f: any) => f.calls.filter((config: any) => config.method === 'delete');
const dialogs = (f: any) => f.nodes().filter((node: Node) => node.tag === 'dialog');
async function open(f: any, id = 51) { f.view.openRecycle(f.view.list.value.find((row: any) => row.id === id)); await flush(); }
describe('actual Admin recycle and restore entry, dialog and owner-scoped Axios', () => {
  it('moves into recycle then restores from state six through the canonical guarded DELETE, refreshing list and counters', async () => {
    const f = await mount('/product?type=1'); try {
      await open(f); expect(dialogs(f)[0].props.title).toBe('移入回收站'); expect(f.text()).toContain('全部购物车记录失效');
      await click(f,'确认移入回收站');
      expect(writes(f)).toHaveLength(1); expect(writes(f)[0]).toMatchObject({url:`${catalog}/51`,params:{expected_is_del:0},headers:{'Authori-zation':'Bearer stock-admin-a'}});
      expect(writes(f)[0].data).toBeUndefined(); expect(f.fixture.products[0]).toMatchObject({is_del:1,is_show:0});
      expect(reads(f,catalog)).toHaveLength(2); expect(reads(f,header)).toHaveLength(2); expect(dialogs(f)).toHaveLength(0);
      await f.navigate('/product?type=6'); expect(f.view.canMutateState.value).toBe(false); await open(f);
      expect(f.text()).toContain('上架状态保持原值'); await click(f,'确认恢复');
      expect(writes(f)[1].params).toEqual({expected_is_del:1}); expect(f.fixture.products[0]).toMatchObject({is_del:0,is_show:0});
      expect(JSON.parse(values.get(markerKey)!)).toEqual([]);
    } finally { f.close(); }
  });
  it('persists a lost toggle result, blocks replay, and requires a later read plus manual acknowledgement before a new opposite operation', async () => {
    let fail=true;
    const f=await mount('/product?type=1',undefined,(config,fixture)=>{if(fail&&config.method==='delete'){fail=false;fixture.products[0].is_del=1;fixture.products[0].is_show=0;return envelope(500,'response lost after commit');}});
    try {
      await open(f); await click(f,'确认移入回收站'); expect(f.text()).toContain('操作结果未确认'); expect(writes(f)).toHaveLength(1);
      await expect(runtime.recycleApi.apiAdminProductRecycle(51,0)).rejects.toThrow('尚未确认'); expect(writes(f)).toHaveLength(1);
      expect(button(f,'已核对，开始新的操作').props.disabled).toBe(true);
      await click(f,'取消'); await f.navigate('/product?type=6'); await open(f);
      expect(button(f,'已核对，开始新的操作').props.disabled).toBe(false); await click(f,'已核对，开始新的操作');
      expect(writes(f)).toHaveLength(1); await click(f,'确认恢复'); expect(writes(f)).toHaveLength(2); expect(writes(f)[1].params).toEqual({expected_is_del:1});
    } finally { f.close(); }
  });
  it('clears an explicitly rejected stale-direction result and makes no mutation for a viewer', async () => {
    const rejected=await mount('/product?type=1',undefined,config=>config.method==='delete'?envelope(409,'商品状态已变化'):undefined);
    try { await open(rejected); await click(rejected,'确认移入回收站'); expect(rejected.text()).toContain('商品状态已变化'); expect(JSON.parse(values.get(markerKey)!)).toEqual([]); } finally { rejected.close(); }
    const viewer=await mount('/product?type=1',['product.view']);
    try { expect(viewer.text()).not.toContain('移入回收站'); viewer.view.openRecycle(viewer.view.list.value[0]); await flush(); expect(dialogs(viewer)).toHaveLength(0); expect(writes(viewer)).toHaveLength(0); } finally { viewer.close(); }
  });
  it('drops dialogs on route or owner replacement and ignores late old-owner results without refreshing the replacement context', async () => {
    const pending=gate(); const f=await mount('/product?type=1',undefined,config=>config.method==='delete'?pending.promise:undefined);
    try {
      await open(f); const writing=click(f,'确认移入回收站'); await flush();
      expect(writes(f)).toHaveLength(1); login(['product.view','product.manage'],'replacement-owner',21);browser.dispatchEvent(new Event('admin-session-changed'));await flush();
      const count=f.calls.length; expect(dialogs(f)).toHaveLength(0); pending.resolve([]);await writing;expect(f.calls).toHaveLength(count);
      await open(f); await f.navigate('/product?type=6'); expect(dialogs(f)).toHaveLength(0);
    } finally { pending.resolve([]);f.close(); }
  });
  it('keeps a pending recycle decision visible when an inventory push requests a background refresh', async()=>{
    const pending=gate(),f=await mount('/product?type=1',undefined,config=>config.method==='delete'?pending.promise:undefined);
    try{
      await open(f);const writing=click(f,'确认移入回收站');await flush();const readsBefore=reads(f,catalog).length;
      browser.dispatchEvent(new CustomEvent('cinashop:product-stock-changed',{detail:{productId:51}}));await flush();
      expect(dialogs(f)).toHaveLength(1);expect(reads(f,catalog)).toHaveLength(readsBefore);expect(writes(f)).toHaveLength(1);
      pending.resolve(envelope(500,'lost pending result'));await writing;expect(f.text()).toContain('操作结果未确认');expect(dialogs(f)).toHaveLength(1);
    }finally{pending.resolve([]);f.close();}
  });
});
