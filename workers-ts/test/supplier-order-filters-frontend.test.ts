import { beforeAll, beforeEach, afterEach, it, expect, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../view/supplier-ts');
const require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc');
let runtime: any, pinia: any, surface: EventTarget;
beforeAll(async () => {
  const output = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    import Page from './src/pages/Orders.vue'; import Distribution from './src/components/SupplierOrderDistribution.vue';
    export {Page}; export const captured={};for(const [name,component] of [['view',Page],['distribution',Distribution]]){const setup=component.setup;component.setup=(p,c)=>{const value=setup(p,c);captured[name]=value;return value;};}
    export * as filterApi from './src/utils/orderFilters';export * as formatApi from './src/utils/format';export {http, ApiError as apiError} from './src/api/http';export * as api from './src/api/orderDistribution';export * as session from './src/utils/supplierSession';
    export {createPinia,disposePinia} from 'pinia';export {createRenderer,h,nextTick,provide,inject} from 'vue';
    export {createRouter,createMemoryHistory,RouterView} from 'vue-router';
  ` }, alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_API_BASE_URL': '"/supplierapi"', '__VUE_OPTIONS_API__': 'true', '__VUE_PROD_DEVTOOLS__': 'false', '__VUE_PROD_HYDRATION_MISMATCH_DETAILS__': 'false' },
  plugins: [{ name: 'actual-tracking-sfc', setup(builder) {
    builder.onLoad({ filter: /\.vue$/ }, ({ path }) => {
      const descriptor = parse(readFileSync(path, 'utf8'), { filename: path }).descriptor;
      const script = compileScript(descriptor, { id: 'tracking', genDefaultAs: '__Page' });
      const template = compileTemplate({ source: descriptor.template.content, filename: path, id: 'tracking', compilerOptions: { bindingMetadata: script.bindings, expressionPlugins: ['typescript'] } });
      if (template.errors.length) throw Error(String(template.errors));
      return { contents: `${script.content}\n${template.code}\n__Page.render=render;export default __Page;`, loader: 'ts' };
    });
    builder.onResolve({ filter: /^element-plus$/ }, () => ({ path: 'messages', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const ElMessage={success(){},warning(){},error(){}};export const ElMessageBox={close(){},confirm:async()=>{}};' }));
  } }], bundle: true, write: false, platform: 'browser', format: 'esm' });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
}, 30000);
beforeEach(() => {
  const values = new Map<string, string>(); surface = new EventTarget();
  vi.stubGlobal('window', surface); vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  localStorage.setItem('supplier-token', 'tracking-a'); localStorage.setItem('supplier-user', '{"id":21,"supplier_id":7}');
  localStorage.setItem('supplier-permissions', '["supplier.order.view","supplier.order.manage"]'); pinia = runtime.createPinia();
});
afterEach(() => { runtime.disposePinia(pinia); vi.unstubAllGlobals(); });
const order = (id = 25, overrides = {}) => ({ id, pid: 0, order_id: `TRACK-${id}`, real_name: '本机客户', user_phone: '000000', total_num: 1,
  pay_price: '10.00', paid: 1, status: 1, pay_type: 'yue', refund_status: 0, shipping_type: 1, product_type: 0,
  delivery_type: 'express', delivery_name: '本机快递', delivery_code: 'ZTO', delivery_id: `WAYBILL-${id}`, fictitious_content: '', remark: '', add_time: 1700000000, pay_time: 1700000001, cart_info: [], type: 0, is_del: 0, ...overrides });
function distribution(id = 25, overrides = {}) {
  return { id, order_id: `TRACK-${id}`, delivery_type: 'express', delivery_name: '本机快递', delivery_code: 'ZTO', delivery_id: `WAYBILL-${id}`,
    fictitious_content: '', revision: 'a'.repeat(64), editable: true, reason: '', express_companies: [{id: 1,name:'本机快递',code:'ZTO'},{id:2,name:'另一快递',code:'SF'}], ...overrides };
}
const gate = () => { let resolve!: (value?: any) => void; return { promise: new Promise<any>(r => { resolve = r; }), resolve }; };
async function flush() { for (let i = 0; i < 45; i++) { await Promise.resolve(); await runtime.nextTick(); } }
type Node = { tag?: string; text?: string; children: Node[]; props: Record<string, any>; parent?: Node };
function contents(n: Node): string { return [n.text ?? '', ...n.children.map(contents)].join(' '); }
function nodes(n: Node): Node[] { return [n, ...n.children.flatMap(nodes)]; }
async function mount(override: (config: any) => unknown = () => undefined) {
  const calls: any[] = [], host: Node = { children: [], props: {} };
  runtime.http.defaults.adapter = async (config: any) => {
    calls.push(config); const id = Number(config.url.split('/').at(-1));
    const value = await override(config) ?? (config.url === '/order/list' ? { list: [order(), order(32, { type: 7, status: 4, refund_status: 3 })], count: 2 }
      : config.url.startsWith('/order/distribution/') ? distribution(id)
      : config.url.startsWith('/order/status/') ? [{ id, oid: id, changeTime: 1700000001, changeMessage: '订单已支付', changeType: 'pay' }]
      : config.url.startsWith('/order/split_order/') ? id === 32 ? [order(33, { pid: 32 }), order(34, { pid: 32 })] : [order(id)] : order(id, id === 32 ? { pid: -1, delivery_type: 'split' } : {}));
    return { config, data: { status: 200, data: value }, status: 200, statusText: 'owned', headers: {} };
  };
  const renderer = runtime.createRenderer({ createElement: (tag: string) => ({ tag, children: [], props: {} }), createText: (text: string) => ({ text, children: [], props: {} }), createComment: () => ({ children: [], props: {} }),
    insert(n: Node, p: Node, anchor?: Node) { if (n.parent) n.parent.children = n.parent.children.filter(item => item !== n); n.parent = p; const at = anchor ? p.children.indexOf(anchor) : -1; p.children.splice(at < 0 ? p.children.length : at, 0, n); },
    remove(n: Node) { if (n.parent) n.parent.children = n.parent.children.filter(item => item !== n); }, parentNode: (n: Node) => n.parent,
    nextSibling: (n: Node) => n.parent?.children[n.parent.children.indexOf(n) + 1] ?? null, patchProp(n: Node, key: string, _: unknown, value: unknown) { n.props[key] = value; },
    setText(n: Node, text: string) { n.text = text; }, setElementText(n: Node, text: string) { n.text = text; n.children = []; } });
  const router = runtime.createRouter({ history: runtime.createMemoryHistory(), routes: [{ path: '/orders', component: runtime.Page }, { path: '/away', component: { render: () => null } }] });
  const app = renderer.createApp({ render: () => runtime.h(runtime.RouterView) }); app.use(pinia); app.use(router);
  const tags = [...['pages/Orders', 'components/SupplierOrderDistribution', 'components/SupplierOrderTracking'].flatMap(page => [...readFileSync(resolve(root, `src/${page}.vue`), 'utf8').matchAll(/<(el-[a-z-]+)/g)])].map(m => m[1]);
  for (const tag of new Set(tags)) if (!['el-dialog', 'el-drawer', 'el-table', 'el-table-column'].includes(tag)) app.component(tag, { inheritAttrs: false, setup(_: unknown, { slots, attrs }: any) { return () => runtime.h(tag, attrs, slots.default?.()); } });
  for (const tag of ['el-dialog', 'el-drawer']) app.component(tag, { props: ['modelValue'], setup(p: any, { slots, attrs }: any) { return () => p.modelValue ? runtime.h(tag, attrs, [slots.default?.(), slots.footer?.()]) : null; } });
  app.component('el-table', { props: ['data'], setup(p: any, { slots }: any) { runtime.provide('rows', () => p.data ?? []); return () => runtime.h('table', {}, slots.default?.()); } });
  app.component('el-table-column', { props: ['prop'], setup(p: any, { slots }: any) { const rows = runtime.inject('rows'); return () => runtime.h('column', {}, rows().map((row: any) => runtime.h('cell', {}, slots.default ? slots.default({ row }) : String(row[p.prop] ?? '')))); } });
  app.directive('loading', {}); await router.push('/orders'); app.mount(host); await flush();
  return { get view() { return runtime.captured.view; }, get modal() { return runtime.captured.distribution; }, calls, host, router, close: () => app.unmount() };
}
function filterControl(f: Awaited<ReturnType<typeof mount>>, label: string) {
  const result = nodes(f.host).find(n => n.props['aria-label'] === label);
  expect(result, label).toBeTruthy(); return result!;
}
function button(f: Awaited<ReturnType<typeof mount>>, label: string) {
  const result = nodes(f.host).find(n => n.tag === 'el-button' && contents(n).trim() === label);
  expect(result, label).toBeTruthy(); return result!;
}
const listCalls = (f: Awaited<ReturnType<typeof mount>>) => f.calls.filter(c => c.url === '/order/list');
it('renders all real search fields, nine order types, business statuses, payments and local datetime controls', async () => {
  const f = await mount(); try {
    for (const name of ['搜索字段', '订单搜索', '订单类型', '订单状态', '支付状态', '支付方式', '下单开始时间', '下单结束时间']) filterControl(f, name);
    expect(contents(f.host)).toContain('部分发货'); expect(contents(f.host)).toContain('新人订单');
    expect(nodes(filterControl(f, '搜索字段')).filter(n => n.tag === 'el-option').map(n => n.props.value)).toEqual(['all', 'order_id', 'uid', 'real_name', 'user_phone', 'title', 'total_num']);
    expect(nodes(filterControl(f, '订单类型')).filter(n => n.tag === 'el-option').map(n => n.props.value)).toEqual(['0','1','2','3','4','5','6','7','8']);
    expect(filterControl(f, '下单开始时间').props.type).toBe('datetime-local');
    expect(f.calls.every(c => c.method === 'get')).toBe(true);
  } finally { f.close(); }
});
it('submits exact field, type, payment, business status and inclusive epoch bounds from the rendered query action', async () => {
  const f = await mount(); try {
    Object.assign(f.view.filters, { page: 4, field_key: 'order_id', order: '  ORIGINAL-ORDER  ', type: '7', paid: '1', business_status: '1', pay_type: 'yue', start_time: '2026-10-18T00:00:00', end_time: '2026-10-19T23:59:59' });
    button(f, '查询').props.onClick(); await flush();
    expect(listCalls(f).at(-1).params).toEqual({ page: 1, limit: 20, order: 'ORIGINAL-ORDER', field_key: 'order_id', type: '7', paid: '1', status: '', business_status: '1', pay_type: 'yue', start_time: String(new Date(2026,9,18,0,0,0).getTime()/1000), end_time: String(new Date(2026,9,19,23,59,59).getTime()/1000) });
    expect(f.view.filters.order).toBe('  ORIGINAL-ORDER  '); expect(f.calls.every(c => c.method === 'get')).toBe(true);
  } finally { f.close(); }
});
it.each([['0','未支付'],['1','未发货'],['2','待收货 / 待核销'],['3','待评价'],['4','交易完成'],['-4','用户已删除']])('uses the business selector %s for rendered %s while preserving the raw status slot', async (value, label) => {
  const f = await mount(); try {
    const select = filterControl(f, '订单状态');
    expect(nodes(select).some(n => n.tag === 'el-option' && n.props.label === label && n.props.value === value)).toBe(true);
    f.view.filters.page = 7; select.props['onUpdate:modelValue'](value); select.props.onChange(value); await flush();
    expect(listCalls(f).at(-1).params).toMatchObject({ page: 1, business_status: value, status: '' });
  } finally { f.close(); }
});
it('switches the actual field control and sends a full exact numeric UID without partial parsing', async () => {
  const f = await mount(); try {
    filterControl(f, '搜索字段').props['onUpdate:modelValue']('uid');
    filterControl(f, '订单搜索').props['onUpdate:modelValue']('2147483647');
    button(f, '查询').props.onClick(); await flush();
    expect(listCalls(f).at(-1).params).toMatchObject({ field_key: 'uid', order: '2147483647' });
    filterControl(f, '订单搜索').props['onUpdate:modelValue']('12-tail');
    const before = listCalls(f).length; button(f, '查询').props.onClick(); await flush();
    expect(listCalls(f)).toHaveLength(before); expect(f.view.rows.value).toEqual([]); expect(f.view.listError.value).toContain('整数');
  } finally { f.close(); }
});
it.each(['2026-02-30T12:00:00', '2026-13-01T12:00:00', '2026-10-19T25:00:00', '2026-10-19', '2039-01-01T00:00:00'])('rejects invalid or out-of-range local datetime %s before HTTP', async value => {
  const f = await mount(); try {
    const before = listCalls(f).length; f.view.filters.start_time = value; button(f, '查询').props.onClick(); await flush();
    expect(listCalls(f)).toHaveLength(before); expect(f.view.listError.value).toContain('时间'); expect(f.view.rows.value).toEqual([]);
  } finally { f.close(); }
});
it('rejects a reversed range, then clears the error when an open-ended range is explicitly queried', async () => {
  const f = await mount(); try {
    Object.assign(f.view.filters, { start_time: '2026-10-19T00:00:00', end_time: '2026-10-18T00:00:00' });
    const before = listCalls(f).length; button(f, '查询').props.onClick(); await flush();
    expect(listCalls(f)).toHaveLength(before); expect(f.view.listError.value).toContain('晚于');
    f.view.filters.end_time = ''; button(f, '查询').props.onClick(); await flush();
    expect(listCalls(f).at(-1).params.end_time).toBe(''); expect(f.view.listError.value).toBe(''); expect(f.view.rows.value).toHaveLength(2);
  } finally { f.close(); }
});
it('resets every filter and page, closes old detail, and clears selected exports before reloading', async () => {
  const f = await mount(); try {
    await f.view.openOrder(order()); f.view.selectOrders([order()]);
    Object.assign(f.view.filters, { page: 8, order: '客户私有查找', field_key: 'real_name', business_status: '-4', type: '8', paid: '1', pay_type: 'cash', start_time: '2026-10-18T00:00:00', end_time: '2026-10-19T00:00:00' });
    button(f, '重置').props.onClick(); await flush();
    expect({ ...f.view.filters }).toEqual(runtime.filterApi.emptyOrderFilters()); expect(f.view.drawerOpen.value).toBe(false); expect(f.view.current.value).toBeNull(); expect(f.view.selectedOrders.value).toEqual([]);
    expect(listCalls(f).at(-1).params).toEqual(runtime.filterApi.supplierOrderFilterQuery(runtime.filterApi.emptyOrderFilters()));
  } finally { f.close(); }
});
it('aborts an old filtered request and keeps only the later filter result, including A to B to A', async () => {
  const waiting = gate(); let hold = true;
  const f = await mount(c => c.url === '/order/list' && c.params.order === 'A' && hold ? waiting.promise : undefined);
  try {
    f.view.filters.order = 'A'; const first = f.view.load(); await flush(); const old = listCalls(f).at(-1);
    f.view.filters.order = 'B'; await f.view.load(); hold = false; f.view.filters.order = 'A'; await f.view.load();
    waiting.resolve({ status: 200, data: { list: [order(999)], count: 1 } }); await first; await flush();
    expect(old.signal.aborted).toBe(true); expect(f.view.rows.value.map((r: any) => r.id)).toEqual([25,32]);
  } finally { waiting.resolve({ status: 200, data: { list: [], count: 0 } }); f.close(); }
});
it('clears all sensitive filter drafts on session A to B to A and rejects the late result', async () => {
  const waiting = gate(); const f = await mount(c => c.url === '/order/list' && c.params.order === 'PRIVATE' ? waiting.promise : undefined);
  try {
    Object.assign(f.view.filters, { order: 'PRIVATE', field_key: 'user_phone', type: '7', business_status: '2', pay_type: 'weixin', start_time: '2026-10-18T00:00:00' });
    const pending = f.view.load(); await flush(); const request = listCalls(f).at(-1);
    for (const token of ['other-account', 'tracking-a']) { localStorage.setItem('supplier-token',token); const event = new Event('storage'); Object.assign(event,{key:'supplier-token',storageArea:localStorage}); surface.dispatchEvent(event); }
    waiting.resolve({ status: 200, data: { list: [order(999)], count: 1 } }); await pending; await flush();
    expect({ ...f.view.filters }).toEqual(runtime.filterApi.emptyOrderFilters()); expect(request.signal.aborted).toBe(true); expect(f.view.rows.value).toEqual([]);
    const count = listCalls(f).length; button(f,'查询').props.onClick(); await flush(); expect(listCalls(f)).toHaveLength(count);
  } finally { waiting.resolve({ status: 200, data: { list: [], count: 0 } }); f.close(); }
});
it('clears new filter fields and aborts pending reads when leaving the route', async () => {
  const waiting = gate(); const f = await mount(c => c.url === '/order/list' && c.params.order === 'LEAVE' ? waiting.promise : undefined);
  try {
    Object.assign(f.view.filters,{order:'LEAVE',field_key:'title',business_status:'1',type:'6',pay_type:'offline',end_time:'2026-10-19T00:00:00'});
    const pending=f.view.load();await flush();const request=listCalls(f).at(-1);await f.router.push('/away');
    waiting.resolve({status:200,data:{list:[order(999)],count:1}});await pending;
    expect(request.signal.aborted).toBe(true);expect({...f.view.filters}).toEqual(runtime.filterApi.emptyOrderFilters());expect(f.view.rows.value).toEqual([]);
  }finally{waiting.resolve({status:200,data:{list:[],count:0}});f.close();}
});
it('renders new filters for view-only accounts and performs no order or export writes',async()=>{
  localStorage.setItem('supplier-permissions','["supplier.order.view"]');const f=await mount();try{
    expect(filterControl(f,'订单类型')).toBeTruthy();filterControl(f,'订单搜索').props['onUpdate:modelValue']('商品');button(f,'查询').props.onClick();await flush();
    expect(f.view.rows.value).toHaveLength(2);expect(nodes(f.host).some(n=>n.tag==='el-button'&&contents(n).trim()==='导出订单清单')).toBe(false);expect(f.calls.every(c=>c.method==='get')).toBe(true);
  }finally{f.close();}
});
it('distinguishes partial refunds from rejection and labels partial fulfillment, pickup and deletion facts',()=>{
  const status=(overrides:any)=>runtime.formatApi.orderStatus(order(25,overrides)).label;
  expect(status({refund_status:3,status:0})).toBe('部分退款 · 待发货');expect(status({refund_status:3,status:4})).toBe('部分退款 · 部分发货');
  expect(status({shipping_type:2,status:0})).toBe('待核销');expect(status({shipping_type:2,status:5})).toBe('部分核销');
  expect(status({shipping_type:1,status:5})).toBe('部分收货');expect(status({shipping_type:3,status:5})).toBe('部分收货');expect(status({shipping_type:99,status:5})).toBe('处理中');
  expect(status({is_del:1})).toBe('用户已删除');expect(status({refund_status:2})).toBe('已退款');
  expect(status({refund_status:4})).toBe('售后中');expect(runtime.formatApi.payType('cash')).toBe('现金支付');expect(runtime.formatApi.payType('integral')).toBe('积分支付');
  for(const value of ['constructor','__proto__','toString'])expect(runtime.formatApi.payType(value)).toBe(value);
});
