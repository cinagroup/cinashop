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
    export {http, ApiError as apiError} from './src/api/http';export * as api from './src/api/orderDistribution';export * as session from './src/utils/supplierSession';
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
  delivery_type: 'express', delivery_name: '本机快递', delivery_code: 'ZTO', delivery_id: `WAYBILL-${id}`, fictitious_content: '', remark: '', add_time: 1700000000, pay_time: 1700000001, cart_info: [], ...overrides });
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
    const value = await override(config) ?? (config.url === '/order/list' ? { list: [order(), order(32, { pid: -1, delivery_type: 'split' })], count: 2 }
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
it('opens an owned shipped order through the rendered entry, saves with revision and refreshes order facts', async () => {
  let saved = false;
  const f = await mount(c => c.url === '/order/distribution/25' && c.method === 'put' ? (saved = true, distribution(25, { delivery_name: '另一快递', delivery_code: 'SF', delivery_id: 'CORRECTED-25', revision: 'b'.repeat(64) }))
    : saved && c.url === '/order/info/25' ? order(25, { delivery_name: '另一快递', delivery_code: 'SF', delivery_id: 'CORRECTED-25' }) : undefined);
  try {
    await f.view.openOrder(order()); await flush();
    const entry = nodes(f.host).find(n => n.tag === 'el-button' && contents(n).trim() === '配送信息'); expect(entry).toBeTruthy(); entry!.props.onClick(); await flush();
    expect(contents(f.host)).toContain('包裹：TRACK-25'); expect(f.modal.data.value.revision).toBe('a'.repeat(64));
    Object.assign(f.modal.form, { delivery_name: '另一快递', delivery_id: ' CORRECTED-25 ' }); await f.modal.save(); await flush();
    const call = f.calls.find(c => c.method === 'put'); expect(call.url).toBe('/order/distribution/25'); expect(JSON.parse(call.data)).toEqual({ expected_revision: 'a'.repeat(64), delivery_name: '另一快递', delivery_id: 'CORRECTED-25', fictitious_content: '' });
    expect(f.view.distributionTarget.value).toBeNull(); expect(f.view.current.value.delivery_id).toBe('CORRECTED-25');
    expect(f.calls.filter(c => c.url === '/order/status/25')).toHaveLength(2);
  } finally { f.close(); }
});
it('targets the selected concrete split shipment and never exposes a split root mutation', async () => {
  const f = await mount(); try {
    await f.view.openOrder(order(32)); await flush(); expect(f.view.canReviseDistribution(f.view.current.value)).toBe(false);
    f.view.openDistribution(f.view.current.value); f.view.openDistribution(f.view.shipments.value[1]); await flush();
    expect(f.modal.data.value.id).toBe(34); expect(f.calls.some(c => c.url === '/order/distribution/32')).toBe(false);
  } finally { f.close(); }
});
it.each([{ paid: 0 }, { status: 0 }, { status: 5 }, { refund_status: 1 }, { refund_status: 3 }, { shipping_type: 2 }, { delivery_type: 'split' }])('rejects an ineligible opening row %j', async patch => {
  const f = await mount(); try { await f.view.openOrder(order()); const row = order(25, patch); expect(f.view.canReviseDistribution(row)).toBe(false); f.view.openDistribution(row); await flush(); expect(f.calls.some(c => c.url.includes('/distribution/'))).toBe(false); } finally { f.close(); }
});
it.each(['express', 'fictitious', 'send'])('sends only the applicable %s fields', async type => {
  let input: any;
  const f = await mount(c => c.url === '/order/info/25' ? order(25, { delivery_type: type, product_type: type === 'fictitious' ? 3 : 0 })
    : c.url === '/order/distribution/25' ? (c.method === 'put' ? (input = JSON.parse(c.data), distribution(25, { delivery_type: type, ...input })) : distribution(25, { delivery_type: type })) : undefined);
  try { await f.view.openOrder(order()); f.view.openDistribution(f.view.current.value); await flush();
    Object.assign(f.modal.form, { delivery_name: type === 'express' ? '本机快递' : '配送姓名', delivery_id: type === 'send' ? '13800138000' : 'NEW-NUMBER', fictitious_content: '交付说明\n第二行' });
    await f.modal.save(); await flush(); expect(input).toEqual({ expected_revision: 'a'.repeat(64), delivery_name: type === 'fictitious' ? '' : type === 'send' ? '配送姓名' : '本机快递', delivery_id: type === 'fictitious' ? '' : type === 'send' ? '13800138000' : 'NEW-NUMBER', fictitious_content: type === 'fictitious' ? '交付说明\n第二行' : '' });
  } finally { f.close(); }
});
it('shows provider-managed facts and their reason without offering a manual write', async () => {
  const f = await mount(c => c.url === '/order/distribution/25' ? distribution(25, { editable: false, reason: '电子面单已签发，请在面单管理核对' }) : undefined);
  try { await f.view.openOrder(order()); f.view.openDistribution(f.view.current.value); await flush(); expect(nodes(f.host).some(n => n.tag === 'el-alert' && n.props.title === '电子面单已签发，请在面单管理核对')).toBe(true);
    expect(nodes(f.host).some(n => n.tag === 'el-button' && contents(n).trim() === '保存配送信息')).toBe(false); await f.modal.save(); expect(f.calls.every(c => c.method === 'get')).toBe(true);
  } finally { f.close(); }
});
it('does not offer an edit entry to a view-only Supplier', async () => {
  localStorage.setItem('supplier-permissions', '["supplier.order.view"]'); const f = await mount();
  try { await f.view.openOrder(order()); expect(f.view.canReviseDistribution(f.view.current.value)).toBe(false); f.view.openDistribution(f.view.current.value); await flush(); expect(f.calls.some(c => c.url.includes('/distribution/'))).toBe(false); } finally { f.close(); }
});
it('requires a fresh read after a server conflict', async () => {
  const f = await mount(c => { if (c.url === '/order/distribution/25' && c.method === 'put') return Promise.reject(new runtime.apiError('订单已变化', 409)); });
  try { await f.view.openOrder(order()); f.view.openDistribution(f.view.current.value); await flush(); f.modal.form.delivery_id = 'NEW'; await f.modal.save(); await flush();
    expect(f.modal.needsRead.value).toBe(true); expect(f.modal.uncertain.value).toBe(false); await f.modal.save(); expect(f.calls.filter(c => c.method === 'put')).toHaveLength(1);
    await f.modal.load(); expect(f.modal.needsRead.value).toBe(false);
  } finally { f.close(); }
});
it.each([true, false])('reconciles an unknown save as current facts (matches=%s) and requires deliberate editing', async matches => {
  let issued = false; const f = await mount(c => {
    if (c.url !== '/order/distribution/25') return;
    if (c.method === 'put') { issued = true; throw Error('Lost response'); }
    return distribution(25, issued && matches ? { delivery_id: 'UNKNOWN-25', revision: 'b'.repeat(64) } : {});
  });
  try { await f.view.openOrder(order()); f.view.openDistribution(f.view.current.value); await flush(); f.modal.form.delivery_id = 'UNKNOWN-25'; await f.modal.save();
    expect(f.modal.uncertain.value).toBe(true); await f.modal.save(); expect(f.calls.filter(c => c.method === 'put')).toHaveLength(1);
    await f.modal.load(); expect(f.modal.reconciled.value).toBe(true); expect(f.modal.notice.value).toContain(matches ? '一致' : '不同');
    await f.modal.save(); expect(f.calls.filter(c => c.method === 'put')).toHaveLength(1); f.modal.continueEditing(); expect(f.modal.uncertain.value).toBe(false); expect(f.modal.form.delivery_id).toBe(matches ? 'UNKNOWN-25' : 'WAYBILL-25');
  } finally { f.close(); }
});
it.each(['close', 'drawer', 'route', 'session', 'permission', 'unmount'])('discards a delayed read after %s even when identity returns', async kind => {
  const wait = gate(), f = await mount(c => c.url === '/order/distribution/25' ? wait.promise : undefined); let closed = false;
  try { await f.view.openOrder(order()); f.view.openDistribution(f.view.current.value); await flush(); const request = f.calls.find(c => c.url === '/order/distribution/25');
    if (kind === 'close') f.modal.close(); if (kind === 'drawer') f.view.drawerOpen.value = false;
    if (kind === 'route') await f.router.push('/away');
    if (kind === 'session') { runtime.session.clearSupplierSession(); localStorage.setItem('supplier-token', 'tracking-a'); localStorage.setItem('supplier-user', '{"id":21,"supplier_id":7}'); }
    if (kind === 'permission') { localStorage.setItem('supplier-permissions', '[]'); surface.dispatchEvent(new Event('supplier-session-changed')); localStorage.setItem('supplier-permissions', '["supplier.order.view","supplier.order.manage"]'); }
    if (kind === 'unmount') { f.close(); closed = true; }
    await flush(); expect(request.signal.aborted).toBe(true); wait.resolve(distribution()); await flush(); expect(f.modal.data.value).toBeNull(); expect(f.modal.error.value).toBe(''); expect(f.modal.loading.value).toBe(false);
  } finally { wait.resolve(distribution()); if (!closed) f.close(); }
});
it('rejects package A -> B -> A delayed data without stopping the latest loading state', async () => {
  const old = gate(), latest = gate(); let a = 0;
  const f = await mount(c => c.url === '/order/distribution/33' ? (++a === 1 ? old.promise : latest.promise) : undefined);
  try { await f.view.openOrder(order(32)); f.view.openDistribution(f.view.shipments.value[0]); await flush(); f.view.openDistribution(f.view.shipments.value[1]); await flush();
    expect(f.modal.data.value.id).toBe(34); f.view.openDistribution(f.view.shipments.value[0]); await flush(); old.resolve(distribution(33)); await flush(); expect(f.modal.data.value).toBeNull(); expect(f.modal.loading.value).toBe(true);
    latest.resolve(distribution(33)); await flush(); expect(f.modal.data.value.id).toBe(33);
  } finally { old.resolve(distribution(33)); latest.resolve(distribution(33)); f.close(); }
});
it.each(['id', 'order_id', 'delivery_type', 'revision', 'editable', 'reason', 'express_companies'])('rejects malformed %s facts and allows a corrected read', async field => {
  let broken = true; const f = await mount(c => { if (c.url !== '/order/distribution/25') return; const row: any = distribution(); if (broken) { row[field] = field === 'id' ? 34 : field === 'editable' ? 'yes' : field === 'reason' ? null : field === 'express_companies' ? [null] : 'wrong'; } return row; });
  try { await f.view.openOrder(order()); f.view.openDistribution(f.view.current.value); await flush(); expect(f.modal.data.value).toBeNull(); expect(f.modal.error.value).toBeTruthy(); broken = false; await f.modal.load(); expect(f.modal.data.value.id).toBe(25); } finally { f.close(); }
});
it('treats a malformed successful save response as unknown, never as success', async () => {
  const f = await mount(c => c.url === '/order/distribution/25' && c.method === 'put' ? distribution(25, { delivery_id: 'WRONG' }) : undefined);
  try { await f.view.openOrder(order()); f.view.openDistribution(f.view.current.value); await flush(); f.modal.form.delivery_id = 'EXPECTED'; await f.modal.save();
    expect(f.modal.uncertain.value).toBe(true); expect(f.view.distributionTarget.value.id).toBe(25); expect(f.calls.filter(c => c.url === '/order/info/25')).toHaveLength(1);
  } finally { f.close(); }
});
it.each(['drawer', 'route', 'session', 'unmount'])('never refreshes or publishes a delayed save after %s', async kind => {
  const wait = gate(), f = await mount(c => c.url === '/order/distribution/25' && c.method === 'put' ? wait.promise : undefined); let closed = false;
  try { await f.view.openOrder(order()); f.view.openDistribution(f.view.current.value); await flush(); f.modal.form.delivery_id = 'LATE'; const saving = f.modal.save(); await flush();
    const request = f.calls.find(c => c.method === 'put'); expect(f.modal.saving.value).toBe(true); await f.modal.save(); expect(f.calls.filter(c => c.method === 'put')).toHaveLength(1);
    if (kind === 'drawer') f.view.drawerOpen.value = false; if (kind === 'route') await f.router.push('/away'); if (kind === 'session') runtime.session.clearSupplierSession(); if (kind === 'unmount') { f.close(); closed = true; }
    await flush(); expect(request.signal.aborted).toBe(true); wait.resolve(distribution(25, { delivery_id: 'LATE' })); await saving; await flush();
    expect(f.calls.filter(c => c.url === '/order/info/25')).toHaveLength(1); expect(f.modal.data.value).toBeNull();
  } finally { wait.resolve(distribution(25, { delivery_id: 'LATE' })); if (!closed) f.close(); }
});
it.each(['missing-number', 'invalid-company', 'control-character'])('blocks %s before a write request', async kind => {
  const f = await mount(); try { await f.view.openOrder(order()); f.view.openDistribution(f.view.current.value); await flush();
    if (kind === 'missing-number') f.modal.form.delivery_id = ' '; if (kind === 'invalid-company') f.modal.form.delivery_name = '客户端伪造公司'; if (kind === 'control-character') f.modal.form.delivery_id = 'NO\nOTHER';
    await f.modal.save(); expect(f.modal.error.value).toBeTruthy(); expect(f.calls.every(c => c.method === 'get')).toBe(true);
  } finally { f.close(); }
});
it('renders a codepoint counter and permits 500 emoji without a UTF-16 maxlength cutting them in half', async () => {
  const f = await mount(c => c.url === '/order/info/25' ? order(25, { delivery_type: 'fictitious', product_type: 3 })
    : c.url === '/order/distribution/25' ? distribution(25, { delivery_type: 'fictitious', ...(c.method === 'put' ? JSON.parse(c.data) : {}) }) : undefined);
  try { await f.view.openOrder(order()); f.view.openDistribution(f.view.current.value); await flush();
    const input = nodes(f.host).find(n => n.tag === 'el-input' && n.props['aria-label'] === '交付备注'); expect(input!.props.maxlength).toBe('1000');
    input!.props['onUpdate:modelValue']('😀'.repeat(500)); await flush(); expect(contents(f.host)).toContain('500 / 500 字'); await f.modal.save(); await flush();
    expect(JSON.parse(f.calls.find(c => c.method === 'put').data).fictitious_content).toBe('😀'.repeat(500));
  } finally { f.close(); }
});
it('shows over-limit Unicode input and blocks it before any write', async () => {
  const f = await mount(c => c.url === '/order/info/25' ? order(25, { delivery_type: 'fictitious', product_type: 3 }) : c.url === '/order/distribution/25' ? distribution(25, { delivery_type: 'fictitious' }) : undefined);
  try { await f.view.openOrder(order()); f.view.openDistribution(f.view.current.value); await flush(); f.modal.form.fictitious_content = '😀'.repeat(501); await flush();
    expect(contents(f.host)).toContain('501 / 500 字'); await f.modal.save(); expect(f.modal.error.value).toContain('500'); expect(f.calls.every(c => c.method === 'get')).toBe(true);
  } finally { f.close(); }
});
