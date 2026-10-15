import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../view/admin-ts');
const require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc');
const catalog = '/product/product', header = `${catalog}/type_header`, erp = '/api/admin/erp/config';
const markerKey = 'admin_moderation_unconfirmed_v1';
let runtime: any, browser: EventTarget, values: Map<string, string>;

beforeAll(async () => {
  // Import Vue/Router without a DOM, then provide only document.title for the
  // actual registry guard. The renderer below supplies the host implementation.
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { pathname: '/product', href: '', search: '' } }));
  const bundle = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    import ProductPage from './src/pages/product/ProductList.vue';
    import StockPage from './src/pages/product/ProductModerationDialog.vue';
    export {default as router} from './src/router';
    export {default as request} from './src/utils/request';
    export * as moderationApi from './src/api/productModeration';
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
    bundle: true, write: false, platform: 'browser', format: 'esm', plugins: [{ name: 'actual-moderation-dialog-catalog-and-registry', setup(builder) {
      builder.onLoad({ filter: /\/router\/index\.ts$/ }, ({ path }) => ({
        // Keep every real route/redirect/guard; replace just its history host.
        contents: readFileSync(path, 'utf8').replace(/\bcreateWebHistory\b/g, 'createMemoryHistory'), loader: 'ts', resolveDir: resolve(path, '..'),
      }));
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => {
        if (path.endsWith('/layouts/AdminLayout.vue')) return { contents: `import {h} from 'vue';import {RouterView} from 'vue-router';export default {render:()=>h(RouterView)};`, loader: 'ts', resolveDir: root };
        if (!path.endsWith('/product/ProductList.vue') && !path.endsWith('/product/ProductModerationDialog.vue')) {
          // Other lazy pages and the already separately tested creation dialog
          // are layout-only substitutes, never navigation or API substitutes.
          return { contents: `export default {render:()=>null};`, loader: 'ts' };
        }
        const descriptor = parse(readFileSync(path, 'utf8'), { filename: path }).descriptor;
        const id = path.endsWith('ProductList.vue') ? 'catalog-runtime' : 'moderation-dialog-runtime';
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
  app.component('el-cascader', { inheritAttrs: false, props: ['modelValue', 'options', 'props'], emits: ['update:modelValue'], setup(props: any, { attrs, emit }: any) { return () => runtime.h('cascader', { ...attrs, value: props.modelValue, options: props.options, onChange: (value: any) => { emit('update:modelValue', value); attrs.onChange?.(value); } }); } });
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
      if (config.method === 'get' && ['/product/category/cascader_list/1', '/product/brand/cascader_list/2', '/product/product_label', '/supplier/list'].includes(config.url)) return [];
      if (config.method === 'get' && config.url === catalog) return { list: structuredClone(fixture.products), count: fixture.count };
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


const posts = (f: any) => f.calls.filter((config: any) => config.method === 'post' && /\/set_verify\//.test(config.url));
const dialog = (f: any) => f.nodes().filter((node: Node) => node.tag === 'dialog');
async function open(f: any, id = 51, mode = 'verify') {
  const column = f.nodes().find((node:Node) => node.tag === 'column' && node.props.label === '操作');
  const cell = column?.children.find((node:Node) => node.props.row === id);
  const action = cell && walk(cell).find(node => node.tag === 'button' && textOf(node).trim() === (mode === 'verify' ? '审核' : '强制下架'));
  if (!action) throw Error(`Missing genuine moderation entry ${mode} ${id}`);
  await action.props.onClick(); await flush();
}
async function session(permissions: string[], token = 'stock-admin-a', id = 20) { login(permissions, token, id); browser.dispatchEvent(new Event('admin-session-changed')); await flush(); }

describe('actual Admin moderation dialog, catalog recovery and session-scoped Axios decisions', () => {
  it('uses the real review row entry and GET form/preflight then exact POST payload, refreshing list and counts', async () => {
    const f = await mount(); try {
      expect(f.text()).toContain('审核'); await open(f);
      expect(dialog(f)[0].props.title).toBe('商品审核');
      expect(reads(f, `${catalog}/verify/51`)).toHaveLength(1);
      f.dialog.show.value = 1; await flush(); await click(f, '提交审核');
      expect(reads(f, `${catalog}/get_verify/51`)).toHaveLength(1);
      expect(runtime.dialogs.state.confirmations[0][0]).toContain('售价低于结算价');
      expect(posts(f)).toHaveLength(1);
      expect(posts(f)[0]).toMatchObject({ method: 'post', url: `${catalog}/set_verify/51`, baseURL: '/adminapi', headers: { 'Authori-zation': 'Bearer stock-admin-a' } });
      expect(JSON.parse(posts(f)[0].data)).toEqual({ is_verify: 1, refusal: '', is_show: 1, auto_on_time: '' });
      expect(reads(f, catalog)).toHaveLength(2); expect(reads(f, header)).toHaveLength(2);
      expect(dialog(f)).toHaveLength(0); expect(JSON.parse(values.get(markerKey)!)).toEqual([]);
    } finally { f.close(); }
  });
  it('requires a schedule time and a refusal/removal reason, sends Shanghai datetime unchanged, and clears schedules on force removal', async () => {
    const f = await mount(); try {
      await open(f); f.dialog.show.value = 2; await flush(); await click(f, '提交审核');
      expect(f.text()).toContain('请选择定时上架时间'); expect(posts(f)).toHaveLength(0);
      f.dialog.onTime.value = '2026-11-15 13:25:00'; await click(f, '提交审核');
      expect(JSON.parse(posts(f)[0].data)).toEqual({ is_verify: 1, refusal: '', is_show: 2, auto_on_time: '2026-11-15 13:25:00' });
      await open(f); f.dialog.decision.value = -1; await flush(); await click(f, '提交审核'); expect(posts(f)).toHaveLength(1);
      f.dialog.reason.value = '价格需核实'; await click(f, '提交审核'); expect(JSON.parse(posts(f)[1].data)).toMatchObject({ is_verify: -1, refusal: '价格需核实', is_show: 0, auto_on_time: '' });
      await f.navigate('/product?type=1'); await open(f,52,'remove'); expect(dialog(f)[0].props.title).toBe('强制下架');
      expect(reads(f,`${catalog}/remove/52`)).toHaveLength(1); f.dialog.reason.value = '违规商品'; await click(f, '确认强制下架');
      expect(JSON.parse(posts(f)[2].data)).toEqual({ is_verify: -2, refusal: '违规商品', is_show: 0, auto_on_time: '' });
      expect(reads(f,`${catalog}/get_verify/52`)).toHaveLength(0);
    } finally { f.close(); }
  });
  it('does not submit a cancelled price warning, and discards confirmation after route/session or permission changes', async () => {
    const f = await mount(); try {
      await open(f); runtime.dialogs.state.confirm = async () => { throw Error('cancel'); }; await click(f,'提交审核'); expect(posts(f)).toHaveLength(0);
      for (const change of ['route','session','permission']) {
        await f.navigate('/product?type=0'); await session(['product.view','product.manage']); await open(f);
        const confirmation = gate(); runtime.dialogs.state.confirm = () => confirmation.promise;
        const saving = click(f,'提交审核'); await flush();
        if (change === 'route') await f.navigate('/product?type=2');
        else await session(change === 'permission' ? ['product.view'] : ['product.view','product.manage'], 'replacement-' + change, 21);
        confirmation.resolve(); await saving; expect(posts(f)).toHaveLength(0); expect(dialog(f)).toHaveLength(0);
      }
    } finally { f.close(); }
  });
  it('keeps unknown outcomes across close/reopen, requires a later catalog read and manual acknowledgement, and starts an empty new decision', async () => {
    let fail = true;
    const f = await mount(undefined, undefined, config => { if (fail && config.method === 'post') return envelope(500,'response lost after commit'); });
    try {
      await open(f); await click(f,'提交审核'); expect(posts(f)).toHaveLength(1); expect(f.text()).toContain('审核结果未确认');
      expect(button(f,'提交审核').props.disabled).toBe(true); expect(button(f,'已核对，开始新的审核').props.disabled).toBe(true);
      await click(f,'取消审核'); await open(f); expect(button(f,'已核对，开始新的审核').props.disabled).toBe(true);
      await click(f,'重新读取商品'); await open(f); expect(button(f,'已核对，开始新的审核').props.disabled).toBe(false);
      expect(Object.keys(JSON.parse(values.get(markerKey)!)[0]).sort()).toEqual(['owner','product','run']);
      await click(f,'已核对，开始新的审核'); expect(f.dialog.show.value).toBe(0); expect(f.dialog.reason.value).toBe('');
      fail = false; await click(f,'提交审核'); expect(posts(f)).toHaveLength(2);
    } finally { f.close(); }
  });
  it('keeps pending requests fenced and rejects stale reads begun before or during a write as recovery evidence', async () => {
    const pending = gate(), f = await mount(undefined, undefined, config => config.method === 'post' ? pending.promise : undefined);
    try {
      const early = await runtime.moderationApi.beginModerationRead();
      const writing = runtime.moderationApi.apiAdminProductSetVerify(51,{is_verify:1,refusal:'',is_show:0,auto_on_time:''}); await flush();
      await expect(runtime.moderationApi.acknowledgeModerationRead(51)).rejects.toThrow('尚未结束');
      await expect(runtime.moderationApi.apiAdminProductSetVerify(51,{is_verify:1,refusal:'',is_show:0,auto_on_time:''})).rejects.toThrow('尚未结束');
      const during = await runtime.moderationApi.beginModerationRead();
      pending.resolve(envelope(500,'unknown')); await expect(writing).rejects.toThrow('unknown');
      early([51]); during([51]); expect(runtime.moderationApi.canAcknowledgeModeration(51)).toBe(false);
      await runtime.productApi.apiAdminProductList({page:1,limit:10,type:'',store_name:''});
      expect(runtime.moderationApi.canAcknowledgeModeration(51)).toBe(true); await runtime.moderationApi.acknowledgeModerationRead(51);
      expect(posts(f)).toHaveLength(1);
    } finally { f.close(); }
  });
  it('keeps manager-only controls out of read-only views and rechecks identity immediately before Axios dispatch', async () => {
    const f = await mount('/product?type=0', ['product.view']); try {
      expect(f.nodes().filter((node:Node)=>node.tag==='button' && textOf(node).trim()==='审核')).toHaveLength(0);
      await session(['product.view','product.manage']);
      // Request interceptors run before transformRequest; replacement bearer must never dispatch old intent.
      const interceptor = runtime.request.interceptors.request.use((config:any) => { login(['product.view','product.manage'],'changed-before-dispatch', 21); return config; });
      try { await expect(runtime.moderationApi.apiAdminProductSetVerify(51,{is_verify:1,refusal:'',is_show:0,auto_on_time:''})).rejects.toThrow('登录身份已变化'); }
      finally { runtime.request.interceptors.request.eject(interceptor); }
      expect(posts(f)).toHaveLength(0); expect(JSON.parse(values.get(markerKey)!)).toEqual([]);
    } finally { f.close(); }
  });
});
