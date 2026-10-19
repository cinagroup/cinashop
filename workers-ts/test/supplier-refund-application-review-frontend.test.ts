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
    import Page from './src/pages/Refunds.vue';
    export {Page}; export const captured={};const setup=Page.setup;Page.setup=(p,c)=>{const value=setup(p,c);captured.view=value;return value;};
    export {http} from './src/api/http';export * as api from './src/api/supplier';export * as session from './src/utils/supplierSession';
    export {createPinia,disposePinia} from 'pinia';export {createRenderer,h,nextTick,provide,inject} from 'vue';
    export {createRouter,createMemoryHistory,RouterView} from 'vue-router';
  ` }, alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_API_BASE_URL': '"/supplierapi"', '__VUE_OPTIONS_API__': 'true', '__VUE_PROD_DEVTOOLS__': 'false', '__VUE_PROD_HYDRATION_MISMATCH_DETAILS__': 'false' },
  plugins: [{ name: 'actual-refund-application-sfc', setup(builder) {
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
  localStorage.setItem('supplier-token', 'refund-application-a'); localStorage.setItem('supplier-user', '{"id":21,"supplier_id":7}');
  localStorage.setItem('supplier-permissions', '["supplier.refund.view","supplier.refund.manage"]'); pinia = runtime.createPinia();
});
afterEach(() => { runtime.disposePinia(pinia); vi.unstubAllGlobals(); });
const detail = (id = 25, changes = {}) => ({ id, store_order_id: id, refund_order_id: `R${id}`, order_id: `O${id}`, real_name: '本地客户', user_phone: '000000',
  is_cancel: 0, apply_type: 2, apply_price: '5.00', refund_type: 0, refund_num: 1, refund_price: '5.00', refunded_price: '0.00', refund_reason: '本地原因',
  refuse_reason: '', remark: '内部备注', add_time: 1700000000, refunded_time: 0, pay_type: 'yue', pay_price: '10.00', refund_explain: '申请说明',
  refund_express: '', refund_express_name: '', refund_phone: '', refund_goods_explain: '', returnImages: [], returnImagesError: '', cartInfo: null, orderInfo: null, ...changes });
const gate = () => { let resolve!: (value?: any) => void; return { promise: new Promise<any>(r => { resolve = r; }), resolve }; };
async function flush() { for (let i = 0; i < 45; i++) { await Promise.resolve(); await runtime.nextTick(); } }
type Node = { tag?: string; text?: string; children: Node[]; props: Record<string, any>; parent?: Node };
function contents(n: Node): string { return [n.text ?? '', ...n.children.map(contents)].join(' '); }
function nodes(n: Node): Node[] { return [n, ...n.children.flatMap(nodes)]; }
async function mount(override: (config: any) => unknown = () => undefined) {
  const calls: any[] = [], host: Node = { children: [], props: {} };
  runtime.http.defaults.adapter = async (config: any) => {
    calls.push(config); const id = Number(config.url.split('/').at(-1));
    const value = await override(config) ?? (config.url === '/refund/list' ? { list: [detail(), detail(32)], count: 2 }
      : config.url === '/refund/reason' ? ['本地原因'] : detail(id));
    return { config, data: { status: 200, data: value }, status: 200, statusText: 'owned', headers: {} };
  };
  const renderer = runtime.createRenderer({ createElement: (tag: string) => ({ tag, children: [], props: {} }), createText: (text: string) => ({ text, children: [], props: {} }), createComment: () => ({ children: [], props: {} }),
    insert(n: Node, p: Node, anchor?: Node) { if (n.parent) n.parent.children = n.parent.children.filter(item => item !== n); n.parent = p; const at = anchor ? p.children.indexOf(anchor) : -1; p.children.splice(at < 0 ? p.children.length : at, 0, n); },
    remove(n: Node) { if (n.parent) n.parent.children = n.parent.children.filter(item => item !== n); }, parentNode: (n: Node) => n.parent,
    nextSibling: (n: Node) => n.parent?.children[n.parent.children.indexOf(n) + 1] ?? null, patchProp(n: Node, key: string, _: unknown, value: unknown) { n.props[key] = value; },
    setText(n: Node, text: string) { n.text = text; }, setElementText(n: Node, text: string) { n.text = text; n.children = []; } });
  const router = runtime.createRouter({ history: runtime.createMemoryHistory(), routes: [{ path: '/refunds', component: runtime.Page }, { path: '/away', component: { render: () => null } }] });
  const app = renderer.createApp({ render: () => runtime.h(runtime.RouterView) }); app.use(pinia); app.use(router);
  const tags = [...['pages/Refunds','components/SupplierRefundApplicationReview'].flatMap(page => [...readFileSync(resolve(root, `src/${page}.vue`), 'utf8').matchAll(/<(el-[a-z-]+)/g)])].map(m => m[1]);
  for (const tag of new Set(tags)) if (!['el-dialog', 'el-drawer', 'el-table', 'el-table-column'].includes(tag)) app.component(tag, { inheritAttrs: false, setup(_: unknown, { slots, attrs }: any) { return () => runtime.h(tag, attrs, slots.default?.()); } });
  for (const tag of ['el-dialog', 'el-drawer']) app.component(tag, { props: ['modelValue'], setup(p: any, { slots, attrs }: any) { return () => p.modelValue ? runtime.h(tag, attrs, [slots.default?.(), slots.footer?.()]) : null; } });
  app.component('el-table', { props: ['data'], setup(p: any, { slots }: any) { runtime.provide('rows', () => p.data ?? []); return () => runtime.h('table', {}, slots.default?.()); } });
  app.component('el-table-column', { props: ['prop'], setup(p: any, { slots }: any) { const rows = runtime.inject('rows'); return () => runtime.h('column', {}, rows().map((row: any) => runtime.h('cell', {}, slots.default ? slots.default({ row }) : String(row[p.prop] ?? '')))); } });
  app.directive('loading', {}); await router.push('/refunds'); app.mount(host); await flush();
  return { get view() { return runtime.captured.view; }, calls, host, router, close: () => app.unmount() };
}

function review(id = 25, changes: any = {}): any {
  return { version: 1, refund_id: id, source_order_id: id, state: 'recorded', basis: 'quantity_claim', error: '',
    items: [{ row_id: 251, cart_id: 'source/251', product_id: 70, product_name: '申请商品历史标签', sku: '旧蓝色 XL', code: 'OLD-CODE',
      is_gift: 1, quantity: 1, settlement_unit: '2.50', settlement_subtotal: '2.50' }],
    order_context: { basis: 'linked_order_record', order_id: `O${id}`, paid: 1, pay_type: 'yue', pay_price: '10.00', pay_time: 1700000001,
      recipient: { name: '本地客户', phone: '000000', address: '订单保存的旧地址\n请走东门' }, mark: '订单保存的留言' }, ...changes };
}
async function open(value = review(), changes = {}) {
  const f = await mount(c => c.url.startsWith('/refund/detail/') ? detail(Number(c.url.split('/').at(-1)), { application_review: value, ...changes }) : undefined);
  await f.view.openRefund({ id: 25 }); await flush(); return f;
}
function button(f: Awaited<ReturnType<typeof mount>>, label: string) {
  const node = nodes(f.host).find(n => n.tag === 'el-button' && contents(n).trim() === label); expect(node).toBeTruthy(); return node!;
}
it('renders requested quantity, SKU/code/gift and settlement references alongside the linked stored order before any decision', async () => {
  localStorage.setItem('supplier-permissions', '["supplier.refund.view"]'); const f = await open();
  try {
    for (const fact of ['申请商品核对', '申请数量来自退款申请', '[赠品]', '申请商品历史标签', '旧蓝色 XL', 'OLD-CODE',
      '申请数量', '结算单价参考', '申请商品结算小计', '¥2.50', '关联订单记录', '订单保存的旧地址', '订单保存的留言', '关联订单已付金额', '¥10.00']) expect(contents(f.host)).toContain(fact);
    expect(contents(f.host)).not.toContain('申请时冻结的地址'); expect(contents(f.host)).not.toContain('采购成本');
    expect(f.calls.every(c => c.method === 'get')).toBe(true); expect(f.calls.some(c => /product|user|address|cart\//.test(c.url))).toBe(false);
    for (const action of ['saveRemark', 'agreeReturnAction', 'openRefuse', 'refundAction']) await f.view[action]();
    expect(f.calls.every(c => c.method === 'get')).toBe(true);
  } finally { f.close(); }
});
it('accepts the PHP selected snapshot and opaque historical cart identity without deriving requested quantity from the full order', async () => {
  const value = review(25, { basis: 'php_legacy_snapshot' }); value.items[0].row_id = null; value.items[0].cart_id = '9007199254740993123456789';
  const f = await open(value); try { expect(contents(f.host)).toContain('旧 PHP 保存的申请快照'); expect(f.view.current.value.application_review.items[0].cart_id).toBe(value.items[0].cart_id); }
  finally { f.close(); }
});
it('retains actual v3 multibyte cart identity rather than treating the 128 character limit as 128 UTF8 bytes', async () => {
  const value = review(); value.items[0].cart_id = '购'.repeat(128); const f = await open(value);
  try { expect(f.view.current.value.application_review.items[0].cart_id).toBe(value.items[0].cart_id); } finally { f.close(); }
});
it('shows missing legacy price as unrecorded and keeps a proven zero price distinct', async () => {
  const value = review(); Object.assign(value.items[0], { settlement_unit: null, settlement_subtotal: null });
  const f = await open(value); try { expect(contents(f.host)).toContain('未记录'); expect(contents(f.host)).not.toContain('¥2.50'); } finally { f.close(); }
  Object.assign(value.items[0], { settlement_unit: '0.00', settlement_subtotal: '0.00' }); const zero = await open(value);
  try { expect(contents(zero.host)).toContain('¥0.00'); expect(contents(zero.host)).not.toContain('已到账金额'); } finally { zero.close(); }
});
it('renders very large exact settlement references without numeric conversion', async () => {
  const value = review(); Object.assign(value.items[0], { settlement_unit: '9007199254740993.01', settlement_subtotal: '9007199254740993.01' });
  const f = await open(value); try { expect(contents(f.host)).toContain('¥9,007,199,254,740,993.01'); } finally { f.close(); }
});
it('renders stored text as text, without creating image/link/script content', async () => {
  const value = review(); value.items[0].product_name = '<img src="https://example.invalid/no">'; value.items[0].sku = '<script>不执行</script>';
  value.order_context.mark = 'https://example.invalid/plain-text'; const f = await open(value);
  try {
    expect(contents(f.host)).toContain(value.items[0].product_name); expect(contents(f.host)).toContain(value.items[0].sku);
    const panel = nodes(f.host).find(n => n.props.class === 'refund-application-review')!; expect(panel).toBeTruthy();
    expect(nodes(panel).some(n => ['img', 'a', 'script', 'iframe'].includes(n.tag ?? '') || n.props.innerHTML)).toBe(false);
  } finally { f.close(); }
});
it('retains an honest unavailable application without filling it from a current cart or raw order', async () => {
  const f = await open(review(25, { state: 'unavailable', basis: null, items: [], error: '原申请商品关联无法核对', order_context: null }),
    { cartInfo: [{ name: '不得使用的当前商品' }], orderInfo: { address: '不得使用的当前地址' }, is_cancel: 1 });
  try { expect(nodes(f.host).some(n => n.props.title === '原申请商品关联无法核对')).toBe(true);
    expect(contents(f.host)).toContain('关联订单的收货与支付记录暂无法核对'); expect(contents(f.host)).not.toContain('不得使用'); expect(f.view.canWrite.value).toBe(false);
  } finally { f.close(); }
});
it('keeps the existing completed archive authoritative and never substitutes a live application item', async () => {
  const f = await open(review(25, { state: 'archived', basis: null, items: [] }), { refund_type: 6,
    refundHistory: { version: 1, refundId: 25, sourceOrderId: 25, physicalOrderId: 33, itemsError: '',
      items: [{ id: 251, cartId: 251, name: '完成时的归档标签', sku: '归档SKU', image: '', quantity: 1 }] } });
  try { expect(contents(f.host)).toContain('此退款已完成'); expect(contents(f.host)).toContain('完成时的归档标签');
    expect(contents(f.host)).not.toContain('申请商品历史标签'); expect(f.view.current.value.refundHistory.physicalOrderId).toBe(33);
  } finally { f.close(); }
});
it('keeps older server details readable with an explicit missing application contract message', async () => {
  const f = await mount(); try { await f.view.openRefund({ id: 25 }); await flush();
    expect(f.view.current.value.id).toBe(25); expect(nodes(f.host).some(n => String(n.props.title).includes('尚未返回申请商品核对信息'))).toBe(true);
  } finally { f.close(); }
});
it('describes an unpaid or missing linked payment timestamp honestly', async () => {
  const value = review(); value.order_context.paid = 0; value.order_context.pay_time = 0; const f = await open(value);
  try { expect(contents(f.host)).toContain('关联订单应付金额'); expect(contents(f.host)).toContain('尚未支付'); expect(contents(f.host)).not.toContain('关联订单已付金额'); } finally { f.close(); }
});
it.each([
  ['different refund', (v: any) => { v.refund_id = 32; }],
  ['different source', (v: any) => { v.source_order_id = 32; }],
  ['unknown version', (v: any) => { v.version = 2; }],
  ['unknown state', (v: any) => { v.state = 'pending'; }],
  ['extra keys', (v: any) => { v.virtualInfo = 'PRIVATE'; }],
  ['unknown basis', (v: any) => { v.basis = 'current_catalog'; }],
  ['false quantity', (v: any) => { v.items[0].quantity = 2; }],
  ['empty items', (v: any) => { v.items = []; }],
  ['duplicate cart', (v: any) => { v.items.push({ ...v.items[0], row_id: 252 }); }],
  ['missing row identity', (v: any) => { v.items[0].row_id = null; }],
  ['extra item keys', (v: any) => { v.items[0].disk_info = 'PRIVATE'; }],
  ['empty product name', (v: any) => { v.items[0].product_name = ''; }],
  ['oversized multibyte name', (v: any) => { v.items[0].product_name = '购'.repeat(2000); }],
  ['unbounded cart identity', (v: any) => { v.items[0].cart_id = 'x'.repeat(129); }],
  ['control cart identity', (v: any) => { v.items[0].cart_id = 'A\nB'; }],
  ['false subtotal', (v: any) => { v.items[0].settlement_subtotal = '2.51'; }],
  ['partial null settlement', (v: any) => { v.items[0].settlement_unit = null; }],
  ['invalid gift flag', (v: any) => { v.items[0].is_gift = 2; }],
  ['another recipient', (v: any) => { v.order_context.recipient.name = '别人的收货人'; }],
  ['another amount', (v: any) => { v.order_context.pay_price = '100.00'; }],
  ['another order number', (v: any) => { v.order_context.order_id = 'OTHER'; }],
  ['another payment method', (v: any) => { v.order_context.pay_type = 'cash'; }],
  ['unavailable with items', (v: any) => { v.state = 'unavailable'; v.error = '故障'; }],
  ['pending mislabeled archived', (v: any) => { v.state = 'archived'; v.basis = null; v.items = []; }],
])('rejects a present %s contract before binding the drawer and permits an explicit fresh retry', async (_, mutate: (v: any) => void) => {
  let value = review(); mutate(value); const f = await mount(c => c.url === '/refund/detail/25' ? detail(25, { application_review: value }) : undefined);
  try { await f.view.openRefund({ id: 25 }); await flush(); expect(f.view.current.value).toBeNull(); expect(f.view.detailError.value).toContain('核对信息');
    expect(contents(f.host)).not.toContain('申请商品历史标签'); await f.view.refundAction(); expect(f.calls.some(c => c.method !== 'get')).toBe(false);
    value = review(); button(f, '刷新详情 / 凭证').props.onClick(); await flush(); expect(contents(f.host)).toContain('申请商品历史标签');
  } finally { f.close(); }
});
it.each([null, undefined])('rejects present %s rather than silently treating it as an older server', async value => {
  const f = await mount(c => c.url === '/refund/detail/25' ? detail(25, { application_review: value }) : undefined);
  try { await f.view.openRefund({ id: 25 }); await flush(); expect(f.view.current.value).toBeNull(); expect(f.view.detailError.value).toContain('核对信息'); } finally { f.close(); }
});
it.each(['switch', 'close', 'session', 'route'])('immediately removes rendered request and recipient data when %s invalidates an opening', async kind => {
  const wait = gate(), f = await mount(c => c.url === '/refund/detail/25' ? detail(25, { application_review: review() })
    : c.url === '/refund/detail/32' ? wait.promise : undefined);
  try {
    await f.view.openRefund({ id: 25 }); await flush(); expect(contents(f.host)).toContain('申请商品历史标签'); const delayed = f.view.openRefund({ id: 32 }); await flush();
    expect(contents(f.host)).not.toContain('申请商品历史标签'); expect(contents(f.host)).not.toContain('订单保存的旧地址');
    if (kind === 'close') f.view.drawerOpen.value = false;
    if (kind === 'session') surface.dispatchEvent(new Event('supplier-session-changed'));
    if (kind === 'route') await f.router.push('/away');
    if (kind === 'switch') await f.view.openRefund({ id: 25 });
    wait.resolve(detail(32, { application_review: review(32) })); await delayed; await flush();
    expect(f.view.current.value?.id).not.toBe(32); expect(f.calls.every(c => c.method === 'get')).toBe(true);
  } finally { f.close(); }
});
