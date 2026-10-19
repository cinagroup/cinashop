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
    import Page from './src/pages/Orders.vue'; import Tracking from './src/components/SupplierOrderTracking.vue';
    export {Page}; export const captured={};for(const [name,component] of [['view',Page],['tracking',Tracking]]){const setup=component.setup;component.setup=(p,c)=>{const value=setup(p,c);captured[name]=value;return value;};}
    export {http} from './src/api/http';export * as api from './src/api/orderTracking';export * as session from './src/utils/supplierSession';
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
  localStorage.setItem('supplier-permissions', '["supplier.order.view"]'); pinia = runtime.createPinia();
});
afterEach(() => { runtime.disposePinia(pinia); vi.unstubAllGlobals(); });
const order = (id = 25, overrides = {}) => ({ id, pid: 0, order_id: `TRACK-${id}`, real_name: '本机客户', user_phone: '000000', total_num: 1,
  pay_price: '10.00', paid: 1, status: 1, pay_type: 'yue', refund_status: 0, shipping_type: 1, product_type: 0,
  delivery_type: 'express', delivery_name: '本机快递', delivery_code: 'ZTO', delivery_id: `WAYBILL-${id}`, fictitious_content: '', remark: '', add_time: 1700000000, pay_time: 1700000001, cart_info: [], ...overrides });
function tracking(id = 25, overrides = {}) {
  const value = { orderId: `TRACK-${id}`, expressName: '本机快递', expressCode: 'ZTO', expressNo: `WAYBILL-${id}`, deliveryStatus: '运输中',
    trackingState: 'in_transit', trackingSource: 'carrier', message: '', lastUpdatedAt: 1700000020,
    traces: [{ time: '2026-10-19 01:00:00', content: `承运商真实节点-${id}`, status: '运输中' }], ...overrides };
  const legacy = value.traces.map(t => ({ time: t.time, status: t.content }));
  return { ...value, packages: [{ ...value }], express: legacy, result: legacy, delivery_name: value.expressName, delivery_id: value.expressNo,
    order: { order_id: value.orderId, delivery_name: value.expressName, delivery_code: value.expressCode, delivery_id: value.expressNo, delivery_type: 'express' } };
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
    const value = await override(config) ?? (config.url === '/order/list' ? { list: [order(), order(32, { pid: -1, delivery_type: 'split' })], count: 2 }
      : config.url.startsWith('/order/express/') ? tracking(id)
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
  const tags = [...['pages/Orders', 'components/SupplierOrderTracking'].flatMap(page => [...readFileSync(resolve(root, `src/${page}.vue`), 'utf8').matchAll(/<(el-[a-z-]+)/g)])].map(m => m[1]);
  for (const tag of new Set(tags)) if (!['el-dialog', 'el-drawer', 'el-table', 'el-table-column'].includes(tag)) app.component(tag, { inheritAttrs: false, setup(_: unknown, { slots, attrs }: any) { return () => runtime.h(tag, attrs, slots.default?.()); } });
  for (const tag of ['el-dialog', 'el-drawer']) app.component(tag, { props: ['modelValue'], setup(p: any, { slots, attrs }: any) { return () => p.modelValue ? runtime.h(tag, attrs, [slots.default?.(), slots.footer?.()]) : null; } });
  app.component('el-table', { props: ['data'], setup(p: any, { slots }: any) { runtime.provide('rows', () => p.data ?? []); return () => runtime.h('table', {}, slots.default?.()); } });
  app.component('el-table-column', { props: ['prop'], setup(p: any, { slots }: any) { const rows = runtime.inject('rows'); return () => runtime.h('column', {}, rows().map((row: any) => runtime.h('cell', {}, slots.default ? slots.default({ row }) : String(row[p.prop] ?? '')))); } });
  app.directive('loading', {}); await router.push('/orders'); app.mount(host); await flush();
  return { get view() { return runtime.captured.view; }, get modal() { return runtime.captured.tracking; }, calls, host, router, close: () => app.unmount() };
}
it('renders single and split shipment query entries through actual Orders and GET client while preserving order logs', async () => {
  const f = await mount(); try {
    await f.view.openOrder(order()); await flush();
    const entry = nodes(f.host).find(n => n.tag === 'el-button' && n.props.onClick && contents(n).trim() === '查看物流'); expect(entry).toBeTruthy(); entry!.props.onClick(); await flush();
    expect(contents(f.host)).toContain('承运商真实节点-25'); expect(contents(f.host)).toContain('订单已支付');
    expect(f.calls.filter(c => c.url === '/order/express/25')[0]).toMatchObject({ method: 'get', signal: expect.any(AbortSignal) });
    f.modal.close(); await f.view.openOrder(order(32)); await flush(); expect(f.view.canTrack(f.view.current.value)).toBe(false);
    f.view.openTracking(f.view.shipments.value[1]); await flush(); expect(contents(f.host)).toContain('承运商真实节点-34');
    expect(f.calls.some(c => c.url === '/order/express/32')).toBe(false); expect(f.calls.every(c => c.method === 'get')).toBe(true);
  } finally { f.close(); }
});
it('keeps malformed or non-express shipment headers from starting a logistics request', async () => {
  const f = await mount(); try { await f.view.openOrder(order());
    for (const row of [order(25, { delivery_id: undefined }), order(25, { delivery_code: undefined }), order(25, { delivery_type: 'fictitious' }), order(25, { delivery_id: '' })]) {
      expect(f.view.canTrack(row)).toBe(false); f.view.openTracking(row);
    }
    await flush(); expect(f.calls.some(c => c.url.startsWith('/order/express/'))).toBe(false);
  } finally { f.close(); }
});
it.each(['pending', 'not_configured', 'temporarily_unavailable'])('shows honest %s without fabricated carrier events and allows explicit retry', async state => {
  let first = true; const f = await mount(c => c.url === '/order/express/25' && first ? tracking(25, { trackingState: state, trackingSource: state === 'pending' ? 'carrier' : 'merchant', traces: [], message: '真实服务状态' }) : undefined);
  try { await f.view.openOrder(order()); f.view.openTracking(f.view.current.value); await flush(); expect(f.modal.data.value.traces).toEqual([]); expect(contents(f.host)).not.toContain('承运商真实节点');
    first = false; await f.modal.load(); expect(contents(f.host)).toContain('承运商真实节点-25');
  } finally { f.close(); }
});
it.each(['close', 'drawer', 'route', 'session', 'permission', 'unmount'])('aborts and clears a delayed logistics response after %s', async kind => {
  const wait = gate(), f = await mount(c => c.url === '/order/express/25' ? wait.promise : undefined); let closed = false;
  try { await f.view.openOrder(order()); f.view.openTracking(f.view.current.value); await flush(); const request = f.calls.find(c => c.url === '/order/express/25');
    if (kind === 'close') f.modal.close(); if (kind === 'drawer') f.view.drawerOpen.value = false;
    if (kind === 'route') await f.router.push('/away'); if (kind === 'session') { runtime.session.clearSupplierSession(); localStorage.setItem('supplier-token', 'tracking-a'); localStorage.setItem('supplier-user', '{"id":21,"supplier_id":7}'); localStorage.setItem('supplier-permissions', '["supplier.order.view"]'); }
    if (kind === 'permission') { localStorage.setItem('supplier-permissions', '[]'); surface.dispatchEvent(new Event('supplier-session-changed')); localStorage.setItem('supplier-permissions', '["supplier.order.view"]'); }
    if (kind === 'unmount') { f.close(); closed = true; }
    await flush(); expect(request.signal.aborted).toBe(true); wait.resolve(tracking()); await flush();
    expect(f.modal.data.value).toBeNull(); expect(f.modal.error.value).toBe(''); expect(f.modal.loading.value).toBe(false);
  } finally { wait.resolve(tracking()); if (!closed) f.close(); }
});
it('clears a transport failure and renders only the deliberate retry response', async () => {
  let failed = true; const f = await mount(c => { if (failed && c.url === '/order/express/25') throw Error('Controlled transport failure'); });
  try { await f.view.openOrder(order()); f.view.openTracking(f.view.current.value); await flush(); expect(f.modal.data.value).toBeNull(); expect(f.modal.error.value).toBeTruthy(); expect(f.modal.loading.value).toBe(false);
    failed = false; await f.modal.load(); expect(f.modal.error.value).toBe(''); expect(f.modal.data.value.orderId).toBe('TRACK-25'); expect(f.calls.filter(c => c.url === '/order/express/25')).toHaveLength(2);
  } finally { f.close(); }
});
it('package A -> B -> A cannot accept the first A or stop the newest request loading', async () => {
  const old = gate(), latest = gate(); let a = 0;
  const f = await mount(c => c.url === '/order/express/33' ? (++a === 1 ? old.promise : latest.promise) : undefined);
  try { await f.view.openOrder(order(32)); f.view.openTracking(f.view.shipments.value[0]); await flush(); f.view.openTracking(f.view.shipments.value[1]); await flush();
    expect(f.modal.data.value.orderId).toBe('TRACK-34'); f.view.openTracking(f.view.shipments.value[0]); await flush(); old.resolve(tracking(33)); await flush();
    expect(f.modal.data.value).toBeNull(); expect(f.modal.loading.value).toBe(true); latest.resolve(tracking(33, { trackingSource: 'cache' })); await flush(); expect(f.modal.data.value.trackingSource).toBe('cache');
  } finally { old.resolve(tracking(33)); latest.resolve(tracking(33)); f.close(); }
});
it.each(['wrong-order', 'wrong-number', 'package-count', 'legacy', 'state', 'traces', 'timestamp', 'merchant-traces'])('rejects %s payload before rendering and permits corrected reread', async kind => {
  let broken = true; const f = await mount(c => {
    if (!broken || c.url !== '/order/express/25') return;
    const data: any = tracking(kind === 'wrong-order' ? 34 : 25);
    if (kind === 'wrong-number') data.expressNo = 'OTHER'; if (kind === 'package-count') data.packages.push(data.packages[0]);
    if (kind === 'legacy') data.result = []; if (kind === 'state') data.trackingState = data.packages[0].trackingState = 'invented';
    if (kind === 'traces') data.traces = data.packages[0].traces = [null]; if (kind === 'timestamp') data.lastUpdatedAt = data.packages[0].lastUpdatedAt = -1;
    if (kind === 'merchant-traces') data.trackingSource = data.packages[0].trackingSource = 'merchant'; return data;
  });
  try { await f.view.openOrder(order()); f.view.openTracking(f.view.current.value); await flush(); expect(f.modal.data.value).toBeNull(); expect(f.modal.error.value).toBeTruthy();
    broken = false; await f.modal.load(); expect(f.modal.error.value).toBe(''); expect(f.modal.data.value.orderId).toBe('TRACK-25');
  } finally { f.close(); }
});
