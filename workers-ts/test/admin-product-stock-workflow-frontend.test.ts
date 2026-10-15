import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../view/admin-ts');
const require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc');
const catalog = '/product/product', header = `${catalog}/type_header`, erp = '/api/admin/erp/config';
const attrsUrl = (id = 51) => `${catalog}/attrs/${id}`, saveUrl = (id = 51) => `${catalog}/saveStocks/${id}`;
const markerKey = 'admin_stock_unconfirmed_v1';
let runtime: any, browser: EventTarget, values: Map<string, string>;

beforeAll(async () => {
  // Import Vue/Router without a DOM, then provide only document.title for the
  // actual registry guard. The renderer below supplies the host implementation.
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { pathname: '/product', href: '', search: '' } }));
  const bundle = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    import ProductPage from './src/pages/product/ProductList.vue';
    import StockPage from './src/pages/product/ProductStockDialog.vue';
    export {default as router} from './src/router';
    export {default as request} from './src/utils/request';
    export * as stockApi from './src/api/productStock';
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
    bundle: true, write: false, platform: 'browser', format: 'esm', plugins: [{ name: 'actual-stock-dialog-catalog-and-registry', setup(builder) {
      builder.onLoad({ filter: /\/router\/index\.ts$/ }, ({ path }) => ({
        // Keep every real route/redirect/guard; replace just its history host.
        contents: readFileSync(path, 'utf8').replace(/\bcreateWebHistory\b/g, 'createMemoryHistory'), loader: 'ts', resolveDir: resolve(path, '..'),
      }));
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => {
        if (path.endsWith('/layouts/AdminLayout.vue')) return { contents: `import {h} from 'vue';import {RouterView} from 'vue-router';export default {render:()=>h(RouterView)};`, loader: 'ts', resolveDir: root };
        if (!path.endsWith('/product/ProductList.vue') && !path.endsWith('/product/ProductStockDialog.vue')) {
          // Other lazy pages and the already separately tested creation dialog
          // are layout-only substitutes, never navigation or API substitutes.
          return { contents: `export default {render:()=>null};`, loader: 'ts' };
        }
        const descriptor = parse(readFileSync(path, 'utf8'), { filename: path }).descriptor;
        const id = path.endsWith('ProductList.vue') ? 'catalog-runtime' : 'stock-dialog-runtime';
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
    'el-checkbox-group': 'checkbox-group', 'el-checkbox': 'checkbox', 'el-radio-group': 'radio-group', 'el-radio-button': 'radio-button' })) app.component(name, pass(tag));
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

async function mount(path = '/product', permissions = ['product.view', 'product.manage'], override: (config: any, fixture: any) => unknown = () => undefined) {
  login(permissions); const calls: any[] = [], fixture = {
    products: [product(51), product(52, 1), product(53)], count: 3, headers: headerRows(), enabled: false,
    skus: new Map([[51, [sku(101, 51, 5), sku(102, 51, 7), sku(103, 51, 0, 1)]], [53, [sku(201, 53, 12)]]]),
    respond(config: any) {
      if (config.method === 'get' && config.url === catalog) return { list: structuredClone(fixture.products), count: fixture.count };
      if (config.method === 'get' && config.url === header) return { list: structuredClone(fixture.headers) };
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
    async navigate(next: any) { await runtime.router.push(next); await flush(); },
    close() { app.unmount(); runtime.disposePinia(pinia); },
  };
}
const reads = (f: any, url: string) => f.calls.filter((config: any) => config.method === 'get' && config.url === url);
function button(f: any, label: string): Node { const result = f.nodes().find((node: Node) => node.tag === 'button' && textOf(node).trim() === label); if (!result) throw Error(`Missing rendered button: ${label}`); return result; }
async function click(f: any, label: string) { const control = button(f, label); if (control.props.disabled || control.props.loading) throw Error(`Disabled rendered button ${label}`); await control.props.onClick(); await flush(); }

const puts = (f: any, productId?: number) => f.calls.filter((config: any) => config.method === 'put' && (productId === undefined ? /^\/product\/product\/saveStocks\//.test(config.url) : config.url === saveUrl(productId)));
const dialogs = (f: any) => f.nodes().filter((node: Node) => node.tag === 'dialog' && node.props.title === '库存管理');
function rowButton(f: any, productId: number, label = '库存管理'): Node | undefined {
  const column = f.nodes().find((node: Node) => node.tag === 'column' && node.props.label === '操作');
  const cell = column?.children.find((node: Node) => node.props.row === productId);
  return cell ? walk(cell).find(node => node.tag === 'button' && textOf(node).trim() === label) : undefined;
}
async function open(f: any, productId = 51) {
  const action = rowButton(f, productId); if (!action) throw Error(`Missing rendered stock entry ${productId}`);
  await action.props.onClick(); await flush();
}
function field(f: any, tag: string, name: string): Node {
  const node = f.nodes().find((node: Node) => node.tag === tag && node.props['aria-label'] === name);
  if (!node) throw Error(`Missing rendered ${tag} ${name}`); return node;
}
async function direction(f: any, name: string, value: 0 | 1) {
  const node = field(f, 'select', name); if (node.props.disabled) throw Error(`Disabled ${name}`);
  node.props.onChange(value); await flush();
}
async function quantity(f: any, name: string, value: number | undefined) {
  const node = field(f, 'number', name); if (node.props.disabled) throw Error(`Disabled ${name}`);
  node.props.onInput(value); await flush();
}
async function session(permissions: string[], token = 'stock-admin-a', id = 20) {
  login(permissions, token, id); browser.dispatchEvent(new Event('admin-session-changed')); await flush();
}

describe('actual Admin catalog stock dialog, relative Axios writes and persistent outcome recovery', () => {
  it('opens the genuine row entry after the independent ERP gate and renders complete ordinary rows including retired identity fields', async () => {
    const f = await mount('/admin/product/product_list?type=6#stock'); try {
      expect(runtime.router.currentRoute.value).toMatchObject({ path: '/product', query: { type: '6' }, hash: '#stock' });
      expect(reads(f, erp)).toHaveLength(1); expect(reads(f, erp)[0]).toMatchObject({ baseURL: '', headers: { 'Authori-zation': 'Bearer stock-admin-a' } });
      expect(rowButton(f, 51)).toBeTruthy(); expect(rowButton(f, 52)).toBeUndefined();
      await open(f); expect(dialogs(f)).toHaveLength(1);
      expect(reads(f, attrsUrl())).toHaveLength(1); expect(reads(f, attrsUrl())[0]).toMatchObject({ method: 'get', baseURL: '/adminapi', headers: { 'Authori-zation': 'Bearer stock-admin-a' } });
      const content = textOf(dialogs(f)[0]);
      for (const value of ['规格 101', '规格 102', '规格 103', 'BAR-101', 'ERP-101', '退役']) expect(content).toContain(value);
      expect(f.nodes().some((node: Node) => node.tag === 'image' && node.props.src === 'https://img.example/stock-101.png')).toBe(true);
      expect(field(f, 'number', '库存数量 101').props.value).toBe(0);
      expect(field(f, 'select', '库存方向 101').props.value).toBe(1);
      expect(field(f, 'number', '库存数量 103').props.disabled).toBe(true);
      expect(field(f, 'select', '库存方向 103').props.disabled).toBe(true);
      expect(puts(f)).toHaveLength(0);
    } finally { f.close(); }
  });

  it('does not expose stock writes under ERP enabled, failed or malformed capability reads or a read-only product role', async () => {
    for (const state of ['enabled', 'failure', 'malformed', 'read-only']) {
      const f = await mount('/product', state === 'read-only' ? ['product.view'] : undefined, config => {
        if (config.url !== erp) return undefined;
        if (state === 'enabled') return { open_erp: true };
        if (state === 'failure') throw Error('ERP开关当前不可读取');
        if (state === 'malformed') return { open_erp: 'false' };
        return undefined;
      });
      try {
        expect(rowButton(f, 51)).toBeUndefined(); expect(dialogs(f)).toHaveLength(0); expect(reads(f, attrsUrl())).toHaveLength(0); expect(puts(f)).toHaveLength(0);
        if (state === 'read-only') expect(reads(f, erp)).toHaveLength(0);
        if (['failure', 'malformed'].includes(state)) expect(f.text()).toContain('库存开关读取失败');
        expect(f.text()).toContain('供应商商品 51');
      } finally { f.close(); }
    }
  });

  it('submits individual outbound direction and every zero row, then applies batch quantities only to editable rows and refreshes main rows plus status counts', async () => {
    const f = await mount(); try {
      await open(f); await direction(f, '库存方向 101', 0); await quantity(f, '库存数量 101', 7);
      expect(textOf(dialogs(f)[0])).toContain('= 0');
      const listReads = reads(f, catalog).length, counts = reads(f, header).length;
      await click(f, '提交库存调整');
      expect(puts(f)).toHaveLength(1);
      expect(JSON.parse(puts(f)[0].data)).toEqual({ attrs: [
        { unique: 'SKU00101', pm: 0, stock: 7 }, { unique: 'SKU00102', pm: 1, stock: 0 }, { unique: 'SKU00103', pm: 1, stock: 0 },
      ] });
      expect(puts(f)[0].headers['Authori-zation']).toBe('Bearer stock-admin-a');
      expect(dialogs(f)).toHaveLength(0); expect(reads(f, catalog)).toHaveLength(listReads + 1); expect(reads(f, header)).toHaveLength(counts + 1);
      expect(f.view.list.value[0].stock).toBe(5); expect(button(f, '库存预警 (3)')).toBeTruthy();
      await open(f); await direction(f, '批量库存方向', 0); await quantity(f, '批量库存数量', 4); await click(f, '应用到全部可调整规格');
      expect(field(f, 'number', '库存数量 101').props.value).toBe(4); expect(field(f, 'number', '库存数量 102').props.value).toBe(4); expect(field(f, 'number', '库存数量 103').props.value).toBe(0);
      await click(f, '提交库存调整');
      expect(JSON.parse(puts(f)[1].data)).toEqual({ attrs: [
        { unique: 'SKU00101', pm: 0, stock: 4 }, { unique: 'SKU00102', pm: 0, stock: 4 }, { unique: 'SKU00103', pm: 1, stock: 0 },
      ] });
      expect(f.view.list.value[0].stock).toBe(0); expect(runtime.dialogs.state.successes).toEqual(['库存已调整', '库存已调整']);
      expect(JSON.parse(values.get(markerKey)!)).toEqual([]);
    } finally { f.close(); }
  });

  it('sends unchanged all-zero old-modal submissions and rejects malformed quantity input before any relative write', async () => {
    const f = await mount(); try {
      await open(f);
      for (const invalid of [undefined, -1, 0.5, Number.NaN, 2_147_483_648]) {
        await quantity(f, '库存数量 101', invalid); await click(f, '提交库存调整');
        expect(puts(f)).toHaveLength(0); expect(f.text()).toContain('入出库数量须为');
      }
      await quantity(f, '库存数量 101', 0); await direction(f, '库存方向 101', 0); await click(f, '提交库存调整');
      expect(JSON.parse(puts(f)[0].data).attrs.map((row: any) => [row.pm, row.stock])).toEqual([[0, 0], [1, 0], [1, 0]]);
      expect(f.view.list.value[0].stock).toBe(12);
    } finally { f.close(); }
  });

  it('guards double clicks before and after loading reaches the rendered submit button', async () => {
    const response = gate(), pending: Promise<unknown>[] = [];
    const f = await mount('/product', undefined, config => config.url === saveUrl() ? response.promise.then(() => ({ stock: '14' })) : undefined);
    try {
      await open(f); await quantity(f, '库存数量 101', 2);
      const submit = button(f, '提交库存调整').props.onClick;
      pending.push(submit(), submit()); await flush();
      expect(puts(f)).toHaveLength(1); expect(button(f, '提交库存调整').props.loading).toBe(true);
      expect(button(f, '取消库存调整').props.disabled).toBe(true); expect(button(f, '重新读取库存').props.disabled).toBe(true);
      pending.push(submit()); await flush(); expect(puts(f)).toHaveLength(1);
      const markers = JSON.parse(values.get(markerKey)!);
      expect(markers).toHaveLength(1); expect(markers[0]).toEqual({ owner: 20, product: 51, run: expect.any(String) });
      expect(Object.keys(markers[0]).sort()).toEqual(['owner', 'product', 'run']);
      expect(values.get(markerKey)).not.toContain('SKU00101'); expect(values.get(markerKey)).not.toContain('stock-admin-a');
      response.resolve(); await Promise.all(pending); await flush(); expect(dialogs(f)).toHaveLength(0); expect(runtime.dialogs.state.successes).toEqual(['库存已调整']);
    } finally { response.resolve(); await Promise.allSettled(pending); f.close(); }
  });

  it('persists an unknown outcome across close/reopen, requires a fresh read and manual acknowledgement and starts new quantities at zero', async () => {
    let unknown = true;
    const f = await mount('/product', undefined, config => { if (config.url === saveUrl() && unknown) throw Error('响应连接已中断'); return undefined; });
    try {
      await open(f); await quantity(f, '库存数量 101', 3); await click(f, '提交库存调整');
      expect(f.text()).toContain('库存调整结果未确认'); expect(button(f, '提交库存调整').props.disabled).toBe(true); expect(puts(f)).toHaveLength(1);
      const marker = values.get(markerKey); expect(JSON.parse(marker!)).toEqual([{ owner: 20, product: 51, run: expect.any(String) }]);
      const staleSubmit = button(f, '提交库存调整').props.onClick; await staleSubmit(); await flush(); expect(puts(f)).toHaveLength(1);
      await click(f, '取消库存调整'); expect(dialogs(f)).toHaveLength(0); expect(values.get(markerKey)).toBe(marker);
      await open(f); expect(reads(f, attrsUrl())).toHaveLength(2); expect(f.text()).toContain('上次调整结果尚未确认');
      expect(field(f, 'number', '库存数量 101').props.value).toBe(0); expect(button(f, '提交库存调整').props.disabled).toBe(true);
      await click(f, '已核对，开始新的调整'); expect(JSON.parse(values.get(markerKey)!)).toEqual([]);
      expect(button(f, '提交库存调整').props.disabled).toBe(false); expect(field(f, 'number', '库存数量 101').props.value).toBe(0);
      unknown = false; await quantity(f, '库存数量 102', 1); await click(f, '提交库存调整');
      expect(puts(f)).toHaveLength(2); expect(JSON.parse(puts(f)[1].data).attrs.map((row: any) => row.stock)).toEqual([0, 1, 0]);
      expect(runtime.dialogs.state.successes).toEqual(['库存已调整']);
    } finally { f.close(); }
  });

  it('keeps an unknown outcome through a real component remount and isolates recovery markers by current owner and product', async () => {
    let f = await mount('/product', undefined, config => { if (config.url === saveUrl()) throw Error('transport result unknown'); return undefined; });
    try {
      await open(f); await click(f, '提交库存调整'); expect(puts(f)).toHaveLength(1); f.close();
      f = await mount(); await open(f); expect(f.text()).toContain('上次调整结果尚未确认');
      expect(button(f, '提交库存调整').props.disabled).toBe(true); expect(puts(f)).toHaveLength(0);
      await click(f, '取消库存调整'); await open(f, 53); expect(button(f, '提交库存调整').props.disabled).toBe(false);
      await click(f, '取消库存调整'); await session(['product.view', 'product.manage'], 'stock-admin-b', 21); await open(f);
      expect(button(f, '提交库存调整').props.disabled).toBe(false); await click(f, '提交库存调整');
      expect(JSON.parse(values.get(markerKey)!)).toEqual([{ owner: 20, product: 51, run: expect.any(String) }]);
    } finally { f.close(); }
  });

  it('treats a known 409 as a rejected write, clears old editor rows, and requires re-reading before any new adjustment', async () => {
    let reject = true;
    const f = await mount('/product', undefined, config => config.url === saveUrl() && reject ? envelope(409, '商品库存正在变化') : undefined);
    try {
      await open(f); await quantity(f, '库存数量 101', 2); await click(f, '提交库存调整');
      expect(f.text()).toContain('库存调整未完成'); expect(f.text()).toContain('商品库存正在变化'); expect(button(f, '提交库存调整').props.disabled).toBe(true);
      expect(f.nodes().filter((node: Node) => node.tag === 'number' && /^库存数量 /.test(node.props['aria-label'] ?? ''))).toHaveLength(0);
      expect(JSON.parse(values.get(markerKey)!)).toEqual([]); expect(f.text()).not.toContain('上次调整结果尚未确认');
      reject = false; await click(f, '重新读取库存'); expect(field(f, 'number', '库存数量 101').props.value).toBe(0);
      await click(f, '提交库存调整'); expect(puts(f)).toHaveLength(2); expect(JSON.parse(puts(f)[1].data).attrs.every((row: any) => row.stock === 0)).toBe(true);
    } finally { f.close(); }
  });

  it('discards canceled GETs after catalog state, current session or view capability changes and never restores stale SKU rows', async () => {
    for (const change of ['state', 'session', 'capability']) {
      const response = gate();
      const f = await mount('/product', undefined, config => config.url === attrsUrl() ? response.promise.then(() => [sku(999, 51, 99)]) : undefined);
      try {
        await open(f); const old = reads(f, attrsUrl())[0]; expect(dialogs(f)).toHaveLength(1);
        if (change === 'state') await f.navigate('/product?type=6');
        else await session(change === 'capability' ? ['reply.view'] : ['product.view', 'product.manage'], `stock-admin-${change}`, 21);
        expect(old.signal.aborted).toBe(true); expect(dialogs(f)).toHaveLength(0);
        if (change !== 'capability') await open(f, 53);
        response.resolve(); await flush(); expect(f.text()).not.toContain('规格 999'); expect(f.text()).not.toContain('BAR-999');
        if (change !== 'capability') { expect(dialogs(f)).toHaveLength(1); expect(f.text()).toContain('规格 201'); }
        expect(puts(f)).toHaveLength(0);
      } finally { response.resolve(); f.close(); }
    }
  });

  it('does not clear the replacement request busy state or apply a late successful PUT from a previous Admin session', async () => {
    const old = gate(), replacement = gate(), pending: Promise<unknown>[] = [];
    const f = await mount('/product', undefined, config => {
      if (config.url !== saveUrl()) return undefined;
      return (config.headers['Authori-zation'] === 'Bearer stock-admin-a' ? old : replacement).promise.then(() => ({ stock: '17' }));
    });
    try {
      await open(f); await quantity(f, '库存数量 101', 5); pending.push(button(f, '提交库存调整').props.onClick()); await flush();
      expect(puts(f)).toHaveLength(1); await session(['product.view', 'product.manage'], 'stock-admin-b', 21);
      expect(dialogs(f)).toHaveLength(0); await open(f); await quantity(f, '库存数量 102', 2);
      const submit = button(f, '提交库存调整').props.onClick; pending.push(submit()); await flush(); expect(puts(f)).toHaveLength(2);
      expect(button(f, '提交库存调整').props.loading).toBe(true); const before = f.calls.length;
      old.resolve(); await pending[0]; await flush();
      expect(dialogs(f)).toHaveLength(1); expect(button(f, '提交库存调整').props.loading).toBe(true); expect(f.calls).toHaveLength(before);
      expect(runtime.dialogs.state.successes).toEqual([]); expect(JSON.parse(values.get(markerKey)!)).toEqual([{ owner: 21, product: 51, run: expect.any(String) }]);
      pending.push(submit()); await flush(); expect(puts(f)).toHaveLength(2);
      replacement.resolve(); await Promise.all(pending); await flush(); expect(dialogs(f)).toHaveLength(0); expect(runtime.dialogs.state.successes).toEqual(['库存已调整']);
      expect(JSON.parse(values.get(markerKey)!)).toEqual([]); expect(reads(f, catalog).at(-1).headers['Authori-zation']).toBe('Bearer stock-admin-b');
    } finally { old.resolve(); replacement.resolve(); await Promise.allSettled(pending); f.close(); }
  });

  it('does not present a late rejection or unknown PUT outcome after management withdrawal or a catalog state change', async () => {
    for (const change of ['capability', 'state']) {
      values.delete(markerKey); // Independent unknown-outcome scenarios.
      const response = gate();
      const f = await mount('/product', undefined, config => config.url === saveUrl() ? response.promise.then(() => { throw Error('old outcome unknown'); }) : undefined);
      let pending: Promise<unknown> | undefined;
      try {
        await open(f); pending = button(f, '提交库存调整').props.onClick(); await flush(); expect(puts(f)).toHaveLength(1);
        if (change === 'state') await f.navigate('/product?type=2'); else await session(['product.view']);
        expect(dialogs(f)).toHaveLength(0); const before = f.calls.length;
        response.resolve(); await pending; await flush(); expect(dialogs(f)).toHaveLength(0); expect(f.calls).toHaveLength(before);
        expect(runtime.dialogs.state.successes).toEqual([]); expect(runtime.dialogs.state.errors).toEqual([]); expect(f.text()).not.toContain('old outcome unknown');
        expect(JSON.parse(values.get(markerKey)!)).toEqual([{ owner: 20, product: 51, run: expect.any(String) }]);
      } finally { response.resolve(); await pending; f.close(); }
    }
  });

  it('cannot acknowledge or repeat an in-flight relative write after a same-owner catalog state round trip', async () => {
    const response = gate(); let pending: Promise<unknown> | undefined;
    const f = await mount('/product', undefined, config => config.url === saveUrl() ? response.promise.then(() => { throw Error('outcome unknown'); }) : undefined);
    try {
      await open(f); await quantity(f, '库存数量 101', 2);
      pending = button(f, '提交库存调整').props.onClick(); await flush();
      expect(puts(f)).toHaveLength(1);
      await f.navigate('/product?type=6'); await f.navigate('/product?type=1'); await open(f);
      expect(dialogs(f)).toHaveLength(1); expect(button(f, '已核对，开始新的调整').props.disabled).toBe(true);
      await expect(runtime.stockApi.acknowledgeStockRead(51)).rejects.toThrow('尚未结束');
      await button(f, '已核对，开始新的调整').props.onClick(); await button(f, '提交库存调整').props.onClick(); await flush();
      expect(puts(f)).toHaveLength(1); expect(runtime.stockApi.hasUnconfirmedStock(51)).toBe(true);
      response.resolve(); await pending; await flush();
      await click(f, '重新读取库存'); await click(f, '已核对，开始新的调整');
      expect(runtime.stockApi.hasUnconfirmedStock(51)).toBe(false);
      expect(field(f, 'number', '库存数量 101').props.value).toBe(0);
    } finally { response.resolve(); await pending; f.close(); }
  });

  it('cannot send the previous owner intent with a replacement bearer while marker locking or Axios authentication is pending', async () => {
    for (const boundary of ['markers', 'axios']) {
      const f = await mount(), held = gate(); let interceptor: number | undefined;
      try {
        if (boundary === 'markers') vi.stubGlobal('navigator', { locks: { request: (name: string, options: unknown, callback?: Function) => {
          if (name === 'cinashop:product-stock-markers') return held.promise.then(() => (options as Function)({}));
          return callback?.({});
        } } });
        else interceptor = runtime.request.interceptors.request.use((config: any) => { login(['product.view', 'product.manage'], 'replacement-token', 21); return config; });
        const adjustment = runtime.stockApi.apiAdminProductSaveStocks(51, [{ unique: 'SKU00101', pm: 1, stock: 2 }]);
        if (boundary === 'markers') { await flush(); login(['product.view', 'product.manage'], 'replacement-token', 21); held.resolve(); }
        await expect(adjustment).rejects.toThrow('登录身份已变化');
        expect(puts(f)).toHaveLength(0);
        expect(JSON.parse(values.get(markerKey) ?? '[]')).toEqual([]);
      } finally {
        held.resolve(); if (interceptor !== undefined) runtime.request.interceptors.request.eject(interceptor);
        f.close(); vi.unstubAllGlobals();
        // Restore the lightweight host for the next independent boundary.
        vi.stubGlobal('window', Object.assign(browser, { location: { pathname: '/product', href: '', search: '' } }));
        vi.stubGlobal('document', { title: '' });
        vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
      }
    }
  });

  it('rejects invalid full DTOs and write receipts through actual Axios helpers without clearing an unknown-result marker', async () => {
    const f = await mount(); try {
      for (const invalid of [[], [sku(101, 52, 1)], [sku(101, 51, 1), sku(101, 51, 1)], [{ ...sku(101, 51, 1), code: null }]]) {
        runtime.request.defaults.adapter = async (config: any) => ({ config, status: 200, statusText: 'fixture', headers: {}, data: { status: 200, msg: 'DTO-fixture', data: invalid } });
        if (!invalid.length) await expect(runtime.stockApi.apiAdminProductStockAttrs(51)).resolves.toEqual([]);
        else await expect(runtime.stockApi.apiAdminProductStockAttrs(51)).rejects.toThrow('库存规格响应无效');
      }
      runtime.request.defaults.adapter = async (config: any) => ({ config, status: 200, statusText: 'fixture', headers: {}, data: { status: 200, msg: 'DTO-fixture', data: { stock: 17 } } });
      await expect(runtime.stockApi.apiAdminProductSaveStocks(51, [{ unique: 'SKU00101', pm: 1, stock: 2 }])).rejects.toThrow('库存写入响应无效');
      expect(runtime.stockApi.hasUnconfirmedStock(51)).toBe(true);
      await expect(runtime.stockApi.apiAdminProductSaveStocks(51, [{ unique: 'SKU00101', pm: 1, stock: 2 }])).rejects.toThrow('上次库存调整结果尚未确认');
    } finally { f.close(); }
  });

  it('requires a new SKU read when a current-product stock notification invalidates the open inventory preview', async () => {
    const f = await mount(); try {
      await open(f); await quantity(f, '库存数量 101', 2);
      const submit = button(f, '提交库存调整').props.onClick;
      browser.dispatchEvent(Object.assign(new Event('cinashop:product-stock-changed'), { detail: { productId: 53 } })); await flush();
      expect(button(f, '提交库存调整').props.disabled).toBe(false);
      const before = reads(f, catalog).length;
      browser.dispatchEvent(Object.assign(new Event('cinashop:product-stock-changed'), { detail: { productId: 51 } })); await flush();
      expect(dialogs(f)).toHaveLength(1); expect(f.text()).toContain('库存数据已更新，请重新读取后调整');
      expect(button(f, '提交库存调整').props.disabled).toBe(true); await submit(); await flush(); expect(puts(f)).toHaveLength(0);
      // Notification preserves the open editor and requires an explicit read,
      // rather than replacing the user's relative quantity underneath them.
      expect(reads(f, catalog)).toHaveLength(before); expect(reads(f, attrsUrl())).toHaveLength(1);
      await click(f, '重新读取库存'); expect(reads(f, attrsUrl())).toHaveLength(2); expect(field(f, 'number', '库存数量 101').props.value).toBe(0);
      expect(button(f, '提交库存调整').props.disabled).toBe(false);
      await click(f, '取消库存调整');
      browser.dispatchEvent(Object.assign(new Event('cinashop:product-stock-changed'), { detail: { productId: 0 } })); await flush();
      expect(reads(f, catalog)).toHaveLength(before + 1); expect(reads(f, header)).toHaveLength(before + 1);
    } finally { f.close(); }
  });
});
