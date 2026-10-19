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
    export * as reviewApi from './src/utils/orderReview';export * as filterApi from './src/utils/orderFilters';export * as formatApi from './src/utils/format';export {http, ApiError as apiError} from './src/api/http';export * as api from './src/api/orderDistribution';export * as session from './src/utils/supplierSession';
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
  const tags = [...['pages/Orders', 'components/SupplierOrderDistribution', 'components/SupplierOrderTracking','components/SupplierOrderReview'].flatMap(page => [...readFileSync(resolve(root, `src/${page}.vue`), 'utf8').matchAll(/<(el-[a-z-]+)/g)])].map(m => m[1]);
  for (const tag of new Set(tags)) if (!['el-dialog', 'el-drawer', 'el-table', 'el-table-column'].includes(tag)) app.component(tag, { inheritAttrs: false, setup(_: unknown, { slots, attrs }: any) { return () => runtime.h(tag, attrs, slots.default?.()); } });
  for (const tag of ['el-dialog', 'el-drawer']) app.component(tag, { props: ['modelValue'], setup(p: any, { slots, attrs }: any) { return () => p.modelValue ? runtime.h(tag, attrs, [slots.default?.(), slots.footer?.()]) : null; } });
  app.component('el-table', { props: ['data'], setup(p: any, { slots }: any) { runtime.provide('rows', () => p.data ?? []); return () => runtime.h('table', {}, slots.default?.()); } });
  app.component('el-table-column', { props: ['prop'], setup(p: any, { slots }: any) { const rows = runtime.inject('rows'); return () => runtime.h('column', {}, rows().map((row: any) => runtime.h('cell', {}, slots.default ? slots.default({ row }) : String(row[p.prop] ?? '')))); } });
  app.directive('loading', {}); await router.push('/orders'); app.mount(host); await flush();
  return { get view() { return runtime.captured.view; }, get modal() { return runtime.captured.distribution; }, calls, host, router, close: () => app.unmount() };
}

function review(overrides: any = {}): any {
  return { version: 1, order_kind: 'order', original_order_id: null,
    recipient: { name: '本机客户', phone: '000000', address: '下单时的历史地址\n请走东门', mark: '下单时留言：请勿折叠' },
    buyer: { uid: 11, nickname: '现在的买家昵称', phone: '13900000000', available: true },
    amounts: { quantity: 1, total_price: '30.00', total_postage: '3.00', pay_postage: '3.00', coupon_price: '2.00',
      deduction_price: '1.00', use_integral: '100.00', promotions_price: '1.00', first_order_price: '0.00', change_price: '-2.00', pay_price: '10.00', refund_price: '0.00' },
    items: [{ id: 251, product_id: 70, product_name: '下单历史商品', sku: '历史蓝色 XL', code: 'CODE-HISTORY', bar_code: 'BAR-HISTORY',
      quantity: 1, refund_quantity: 0, settlement_unit: '2.50', settlement_subtotal: '2.50' }],
    settlement: { items_total: '2.50', postage: '3.00', total: '5.50', availability: 'recorded' },
    form: [{ id: 'gift', title: '礼物祝福', value: '<script>不会执行</script>\n生日快乐', images: [] },
      { id: 'date', title: '期望日期', value: '2026-10-20 - 2026-10-22', images: [] },
      { id: 'photo', title: '定制图片', value: '', images: ['https://images.example.test/owned.png'] }], ...overrides };
}
const detail = (id = 25, value = review(), overrides = {}) => order(id, { review: value, ...overrides });
async function open(value = review(), overrides = {}) {
  const f = await mount(c => c.url.startsWith('/order/info/') ? detail(Number(c.url.split('/').at(-1)), value, overrides) : undefined);
  await f.view.openOrder(order()); await flush(); return f;
}
function button(f: Awaited<ReturnType<typeof mount>>, name: string) {
  const result = nodes(f.host).find(n => n.tag === 'el-button' && contents(n).trim() === name);
  expect(result).toBeTruthy(); return result!;
}
it('renders frozen recipient, buyer requirements, current profile, SKU/code and settlement separately from customer payment for a read-only viewer', async () => {
  localStorage.setItem('supplier-permissions', '["supplier.order.view"]'); const f = await open();
  try {
    const text = contents(f.host);
    for (const fact of ['下单收货地址','下单时的历史地址','下单时留言：请勿折叠','当前买家资料','现在的买家昵称','13900000000','下单历史商品','历史蓝色 XL','CODE-HISTORY','BAR-HISTORY','¥2.50','¥5.50','¥30.00','-¥2.00','结算记录参考不代表已到账']) expect(text).toContain(fact);
    expect(text).not.toContain('采购成本'); expect(text).not.toContain('实际收入');
    expect(nodes(f.host).some(n => n.tag === 'el-button' && contents(n).includes('保存备注'))).toBe(false);
    expect(f.calls.every(c => c.method === 'get')).toBe(true); expect(f.calls.some(c => /product|user|address|form\//.test(c.url))).toBe(false);
  } finally { f.close(); }
});
it('renders custom form history as plain text and previews only the server-admitted images', async () => {
  const f = await open(); try {
    expect(contents(f.host)).toContain('<script>不会执行</script>'); expect(contents(f.host)).toContain('2026-10-20 - 2026-10-22');
    expect(nodes(f.host).some(n => n.props.innerHTML)).toBe(false);
    const images = nodes(f.host).filter(n => n.tag === 'el-image'); expect(images).toHaveLength(1);
    expect(images[0].props.src).toBe('https://images.example.test/owned.png'); expect(images[0].props['preview-src-list']).toEqual(['https://images.example.test/owned.png']);
  } finally { f.close(); }
});
it('labels an unpaid amount as due and does not invent a payment time', async () => {
  const f = await open(review(), { paid: 0, pay_time: 0 });
  try { expect(contents(f.host)).toContain('客户应付金额'); expect(contents(f.host)).toContain('尚未支付'); expect(contents(f.host)).not.toContain('客户已付金额'); }
  finally { f.close(); }
});
it('shows missing legacy settlement as unavailable rather than zero, procurement cost or customer sale price', async () => {
  const value = review(); value.items[0].settlement_unit = null; value.items[0].settlement_subtotal = null;
  value.settlement = { items_total: null, postage: '3.00', total: null, availability: 'incomplete' };
  const f = await open(value); try { expect(contents(f.host)).toContain('未记录'); expect(contents(f.host)).toContain('部分历史记录缺少可确认的结算价'); expect(contents(f.host)).not.toContain('¥5.50'); }
  finally { f.close(); }
});
it('accepts a proven zero settlement price without marking the order as already settled', async () => {
  const value = review(); Object.assign(value.items[0], { settlement_unit: '0.00', settlement_subtotal: '0.00' });
  value.settlement = { items_total: '0.00', postage: '0.00', total: '0.00', availability: 'recorded' };
  const f = await open(value); try { expect(contents(f.host)).toContain('¥0.00'); expect(contents(f.host)).toContain('不代表已到账'); expect(contents(f.host)).not.toContain('缺少可确认'); } finally { f.close(); }
});
it.each([0, 11])('describes guest or unavailable current buyer UID %s without inventing a frozen profile', async uid => {
  const f = await open(review({ buyer: { uid, nickname: '', phone: '', available: false } }));
  try { expect(contents(f.host)).toContain(uid === 0 ? '游客订单，无当前注册买家资料' : '买家 UID 11 的当前资料不可用'); expect(contents(f.host)).toContain('下单时的历史地址'); } finally { f.close(); }
});
it('labels a payment root as a summary and displays only the coherent original-number scalar', async () => {
  const f = await open(review({ order_kind: 'payment_summary', original_order_id: 'ROOT-OWNED' }), { pid: -1 });
  try { expect(contents(f.host)).toContain('付款汇总'); expect(contents(f.host)).toContain('金额勿与子订单重复相加'); expect(contents(f.host)).toContain('原订单号：ROOT-OWNED'); } finally { f.close(); }
});
it('keeps older detail responses readable while reporting missing review facts honestly', async () => {
  const f = await mount(); try { await f.view.openOrder(order()); await flush(); expect(contents(f.host)).toContain('订单核对信息未返回，请重新读取详情'); expect(f.view.current.value.id).toBe(25); } finally { f.close(); }
});
it.each([
  ['different recipient', (v: any) => { v.recipient.name = '其他客户'; }],
  ['different payment', (v: any) => { v.amounts.pay_price = '1000.00'; }],
  ['different quantity', (v: any) => { v.amounts.quantity = 9; }],
  ['wrong root kind', (v: any) => { v.order_kind = 'payment_summary'; }],
  ['unknown version', (v: any) => { v.version = 2; }],
  ['partial null price', (v: any) => { v.items[0].settlement_unit = null; }],
  ['duplicate cart identity', (v: any) => { v.items.push({ ...v.items[0] }); }],
  ['excess refund count', (v: any) => { v.items[0].refund_quantity = 2; }],
  ['negative quantity', (v: any) => { v.items[0].quantity = -1; }],
  ['unbounded row count', (v: any) => { v.items = Array.from({ length: 201 }, (_, i) => ({ ...v.items[0], id: i + 1 })); }],
  ['false known total', (v: any) => { v.settlement.total = null; }],
  ['unsafe image', (v: any) => { v.form[2].images = ['javascript:alert(1)']; }],
  ['unsigned private image', (v: any) => { v.form[2].images = ['/api/assets/1']; }],
  ['image credentials', (v: any) => { v.form[2].images = ['https://private:secret@images.example.test/a']; }],
  ['excess image count', (v: any) => { v.form[2].images = Array(10).fill('https://images.example.test/a'); }],
])('rejects %s before displaying a mismatched or unsafe detail and supports an honest retry', async (_, change: (v: any) => void) => {
  const broken = review(); change(broken); let current = broken;
  const f = await mount(c => c.url === '/order/info/25' ? detail(25, current) : undefined);
  try {
    await f.view.openOrder(order()); await flush(); expect(f.view.current.value).toBeNull(); expect(nodes(f.host).find(n => n.tag === 'el-alert' && String(n.props.title).includes('订单核对信息不完整'))).toBeTruthy(); expect(contents(f.host)).not.toContain('下单时的历史地址');
    current = review(); button(f, '重新读取详情').props.onClick(); await flush(); expect(contents(f.host)).toContain('下单时的历史地址');
  } finally { f.close(); }
});
it('formats large exact amounts without floating-point rounding', () => {
  expect(runtime.reviewApi.reviewMoney('9007199254740993.01')).toBe('¥9,007,199,254,740,993.01');
  expect(runtime.reviewApi.reviewMoney('-2.00')).toBe('-¥2.00'); expect(runtime.reviewApi.reviewMoney(null)).toBe('未记录');
});
it('renders a legal 60-character emoji buyer nickname and 15-character profile phone without rejecting the whole detail', async () => {
  const nickname = '🙂'.repeat(60), phone = '📞'.repeat(15);
  const f = await open(review({ buyer: { uid: 11, available: true, nickname, phone } }));
  try { expect(f.view.detailError.value).toBe(''); expect(contents(f.host)).toContain(nickname); expect(contents(f.host)).toContain(phone); }
  finally { f.close(); }
});
it('renders a coherent original number of 32 Unicode characters without confusing database and UTF-16 length', async () => {
  const number = '📦'.repeat(32), f = await open(review({ original_order_id: number }));
  try { expect(f.view.detailError.value).toBe(''); expect(contents(f.host)).toContain(number); }
  finally { f.close(); }
});
it('accepts signed asset URLs and rejects protocol-relative or malformed private references', () => {
  expect(runtime.reviewApi.reviewImageUrl('/api/assets/15?expires=1792375000&signature=abc_DEF-123')).toBe(true);
  expect(runtime.reviewApi.reviewImageUrl('//foreign.example.test/a')).toBe(false);
  expect(runtime.reviewApi.reviewImageUrl('/api/assets/15?expires=bad&signature=x')).toBe(false);
});
it('preserves list filters and selected rows while closing details, and removes all private review content', async () => {
  const f = await open(); try {
    f.view.filters.order = '保留查询'; f.view.selectOrders([order()]); f.view.drawerOpen.value = false; await flush();
    expect(f.view.filters.order).toBe('保留查询'); expect(f.view.selectedOrders.value.map((r: any) => r.id)).toEqual([25]); expect(f.view.current.value).toBeNull(); expect(contents(f.host)).not.toContain('下单时留言');
  } finally { f.close(); }
});
it('prevents a late A review from replacing a newer B then A detail', async () => {
  const pending = gate(); let hold = true;
  const f = await mount(c => c.url.startsWith('/order/info/') ? c.url === '/order/info/25' && hold ? pending.promise : detail(Number(c.url.split('/').at(-1))) : undefined);
  try {
    const first = f.view.openOrder(order()); await flush(); const old = f.calls.find(c => c.url === '/order/info/25');
    await f.view.openOrder(order(32)); hold = false; await f.view.openOrder(order());
    pending.resolve(detail(25, review({ recipient: { ...review().recipient, address: '过时私有地址' } }))); await first; await flush();
    expect(old.signal.aborted).toBe(true); expect(contents(f.host)).toContain('下单时的历史地址'); expect(contents(f.host)).not.toContain('过时私有地址');
  } finally { pending.resolve(detail()); f.close(); }
});
it.each(['close','route','session'])('erases private review on %s and rejects an in-flight detail response', async action => {
  const pending = gate(); let hold = false;
  const f = await mount(c => c.url === '/order/info/25' ? hold ? pending.promise : detail() : undefined);
  try {
    await f.view.openOrder(order()); hold = true; const reading = f.view.refreshCurrent(); await flush();
    if (action === 'close') f.view.drawerOpen.value = false;
    if (action === 'route') await f.router.push('/away');
    if (action === 'session') for (const token of ['other-account','tracking-a']) { localStorage.setItem('supplier-token',token); const e = new Event('storage'); Object.assign(e,{key:'supplier-token',storageArea:localStorage}); surface.dispatchEvent(e); }
    pending.resolve(detail()); await reading; await flush();
    expect(f.view.current.value).toBeNull(); expect(contents(f.host)).not.toContain('下单时的历史地址'); expect(f.calls.filter(c => c.url === '/order/info/25').at(-1).signal.aborted).toBe(true);
  } finally { pending.resolve(detail()); f.close(); }
});

const invoiceRecord = (overrides: any = {}) => ({ id: 41, order_id: 25, type: 2, header_type: 2,
  name: '申请时企业抬头', duty_number: 'LOCAL-TAX-2026', email: 'invoice@example.invalid', bank: '申请记录开户银行',
  address: '申请记录企业地址\n东侧二层', drawer_phone: '01000000000', recorded_amount: '8.25', issuance_state: 0, archived: false, ...overrides });
const invoiceReview = (overrides: any = {}) => ({ state: 'recorded', reason: '', record: invoiceRecord(), ...overrides });
it('renders all eight PHP invoice facts and labels amount and issuance as application records for a read-only viewer', async () => {
  localStorage.setItem('supplier-permissions', '["supplier.order.view"]');
  const f = await open(review({ invoice: invoiceReview() }));
  try {
    const text = contents(f.host);
    for (const fact of ['发票申请记录','纸质专用发票','企业','申请时企业抬头','LOCAL-TAX-2026','invoice@example.invalid','申请记录开户银行','申请记录企业地址','01000000000','申请记录金额','¥8.25','待开票','不代表税务平台核验结果']) expect(text).toContain(fact);
    expect(text).not.toContain('发送邮件'); expect(text).not.toContain('确认开票');
    expect(nodes(f.host).some(n => n.tag === 'a' && String(n.props.href).startsWith('mailto:'))).toBe(false);
    expect(f.calls.every(c => c.method === 'get')).toBe(true);
    expect(f.calls.some(c => /invoice|user_invoice/.test(c.url))).toBe(false);
  } finally { f.close(); }
});
it.each([{ state: -1, text: '已拒绝' },{ state: 0, text: '待开票' },{ state: 1, text: '已开票' }])
  ('shows issuance record state $state without claiming tax verification', async ({ state, text }) => {
    const f = await open(review({ invoice: invoiceReview({ record: invoiceRecord({ type: 1, header_type: 1, issuance_state: state }) }) }));
    try { expect(contents(f.host)).toContain(text); expect(contents(f.host)).toContain('电子普通发票'); expect(contents(f.host)).toContain('个人'); expect(contents(f.host)).toContain('不代表税务平台核验结果'); }
    finally { f.close(); }
  });
it('keeps a recorded zero application amount and missing optional fiscal fields distinct from no application', async () => {
  const f = await open(review({ invoice: invoiceReview({ record: invoiceRecord({ recorded_amount: '0.00', duty_number: '', email: '', bank: '', address: '', drawer_phone: '' }) }) }));
  try { expect(contents(f.host)).toContain('¥0.00'); expect(contents(f.host)).toContain('未记录'); expect(contents(f.host)).not.toContain('本订单未记录发票申请'); }
  finally { f.close(); }
});
it('labels an exact own payment-root archived application without adding its amount to child applications', async () => {
  const f = await open(review({ order_kind: 'payment_summary', invoice: invoiceReview({ record: invoiceRecord({ archived: true }) }) }), { pid: -1 });
  try { expect(contents(f.host)).toContain('已归档的发票申请记录'); expect(contents(f.host)).toContain('付款汇总的历史申请'); expect(contents(f.host)).toContain('金额勿与子订单重复相加'); }
  finally { f.close(); }
});
it.each([
  { invoice: undefined, expected: '发票申请信息未返回，请重新读取详情', omit: true },
  { invoice: { state: 'none', reason: '', record: null }, expected: '本订单未记录发票申请', omit: false },
  { invoice: { state: 'unavailable', reason: '原支付主单申请待处理归属', record: null }, expected: '原支付主单申请待处理归属', omit: false },
])('distinguishes missing contract, no application and unavailable association: $expected', async ({ invoice, expected, omit }) => {
  const value = review(); if (!omit) value.invoice = invoice;
  const f = await open(value); try { expect(contents(f.host)).toContain(expected); expect(contents(f.host)).toContain('下单时的历史地址'); expect(contents(f.host)).not.toContain('申请时企业抬头'); }
  finally { f.close(); }
});
it('renders long valid Unicode fiscal fields as plain text with no HTML execution', async () => {
  const name = '🏢'.repeat(100), address = '📍'.repeat(255), value = invoiceRecord({ name, address,
    duty_number: '🧾'.repeat(50), email: '<script>stored fiscal text</script>', bank: '🏦'.repeat(50), drawer_phone: '📞'.repeat(30) });
  const f = await open(review({ invoice: invoiceReview({ record: value }) }));
  try { expect(contents(f.host)).toContain(name); expect(contents(f.host)).toContain(address); expect(contents(f.host)).toContain('<script>stored fiscal text</script>'); expect(nodes(f.host).some(n => n.props.innerHTML)).toBe(false); }
  finally { f.close(); }
});
it.each([
  ['foreign physical order', (v: any) => { v.record.order_id = 32; }],
  ['missing association', (v: any) => { delete v.record.order_id; }],
  ['unknown invoice type', (v: any) => { v.record.type = 9; }],
  ['unknown header type', (v: any) => { v.record.header_type = 0; }],
  ['unknown issuance state', (v: any) => { v.record.issuance_state = 2; }],
  ['float amount', (v: any) => { v.record.recorded_amount = 8.25; }],
  ['negative amount', (v: any) => { v.record.recorded_amount = '-8.25'; }],
  ['oversized tax field', (v: any) => { v.record.duty_number = 'x'.repeat(101); }],
  ['forbidden control', (v: any) => { v.record.name = 'bad\u0000title'; }],
  ['extra bank account', (v: any) => { v.record.card_number = 'MUST-NOT-RENDER'; }],
  ['ambiguous unavailable payload', (v: any) => { v.state = 'unavailable'; v.reason = '重复申请'; }],
  ['unexplained unavailable', (v: any) => { v.state = 'unavailable'; v.record = null; }],
  ['none with reason', (v: any) => { v.state = 'none'; v.record = null; v.reason = 'wrong'; }],
  ['array state', (v: any) => { v.state = ['unavailable']; v.record = null; v.reason = '待核对'; }],
  ['null invoice', (_v: any) => {}],
])('rejects %s invoice response before displaying fiscal details and retries the actual detail endpoint', async (name, change: (v: any) => void) => {
  const broken = invoiceReview(); change(broken); let current = name === 'null invoice' ? null : broken;
  const f = await mount(c => c.url === '/order/info/25' ? detail(25, review({ invoice: current })) : undefined);
  try {
    await f.view.openOrder(order()); await flush(); expect(f.view.current.value).toBeNull();
    expect(nodes(f.host).find(n => n.tag === 'el-alert' && String(n.props.title).includes('发票申请信息不完整'))).toBeTruthy();
    expect(contents(f.host)).not.toContain('申请时企业抬头');
    current = invoiceReview(); button(f, '重新读取详情').props.onClick(); await flush();
    expect(contents(f.host)).toContain('申请时企业抬头'); expect(f.calls.filter(c => c.url === '/order/info/25')).toHaveLength(2);
  } finally { f.close(); }
});
it('never revives an old invoice detail after order A to B to A navigation', async () => {
  const pending = gate(); let hold = true;
  const fresh = (id: number) => detail(id, review({ invoice: invoiceReview({ record: invoiceRecord({ order_id: id, name: `当前申请-${id}` }) }), ...(id === 32 ? { order_kind: 'payment_summary' } : {}) }), id === 32 ? { pid: -1, delivery_type: 'split' } : {});
  const f = await mount(c => c.url.startsWith('/order/info/') ? c.url === '/order/info/25' && hold ? pending.promise : fresh(Number(c.url.split('/').at(-1))) : undefined);
  try {
    const reading = f.view.openOrder(order()); await flush(); await f.view.openOrder(order(32)); hold = false; await f.view.openOrder(order());
    pending.resolve(detail(25, review({ invoice: invoiceReview({ record: invoiceRecord({ name: '过时其他发票抬头' }) }) }))); await reading; await flush();
    expect(contents(f.host)).toContain('当前申请-25'); expect(contents(f.host)).not.toContain('过时其他发票抬头'); expect(f.calls.find(c => c.url === '/order/info/25').signal.aborted).toBe(true);
  } finally { pending.resolve(detail()); f.close(); }
});
it.each(['close','route','session'])('clears private invoice facts on %s and rejects the delayed fiscal response', async action => {
  const pending = gate(); let hold = false;
  const value = detail(25, review({ invoice: invoiceReview() }));
  const f = await mount(c => c.url === '/order/info/25' ? hold ? pending.promise : value : undefined);
  try {
    await f.view.openOrder(order()); expect(contents(f.host)).toContain('申请时企业抬头'); hold = true; const reading = f.view.refreshCurrent(); await flush();
    if (action === 'close') f.view.drawerOpen.value = false;
    if (action === 'route') await f.router.push('/away');
    if (action === 'session') for (const token of ['other-account','tracking-a']) { localStorage.setItem('supplier-token',token); const e = new Event('storage'); Object.assign(e,{key:'supplier-token',storageArea:localStorage}); surface.dispatchEvent(e); }
    pending.resolve(value); await reading; await flush(); expect(f.view.current.value).toBeNull(); expect(contents(f.host)).not.toContain('申请时企业抬头');
  } finally { pending.resolve(value); f.close(); }
});

const promotionItem = (overrides: any = {}) => ({ promotion_id: 701, promotion_type: 1, frozen_name: '下单时的活动名称',
  current_title: '当前已改名的活动标题', amount: '1.00', ...overrides });
const promotionsReview = (overrides: any = {}) => ({ order_id: 25, state: 'recorded', reason: '', basis: 'modern', total: '1.00', items: [promotionItem()], ...overrides });
it('renders separate frozen campaign name and current PHP title with exact allocation facts for a read-only viewer', async () => {
  localStorage.setItem('supplier-permissions', '["supplier.order.view"]');
  const f = await open(review({ promotions: promotionsReview() }));
  try {
    const text = contents(f.host);
    for (const fact of ['促销分摊记录参考','活动 #701','下单快照中的活动名称','下单时的活动名称','当前活动标题','当前已改名的活动标题','本单分摊记录','本单促销分摊合计','¥1.00','已与下单快照及订单促销账本核对','不用于重新计算优惠']) expect(text).toContain(fact);
    expect(f.calls.every(c => c.method === 'get')).toBe(true); expect(f.calls.some(c => /promotions|marketing/.test(c.url))).toBe(false);
    expect(text).not.toContain('立即参加'); expect(text).not.toContain('领取优惠');
  } finally { f.close(); }
});
it('shows multiple grouped campaign allocations whose exact cents sum to the recorded header total', async () => {
  const value = promotionsReview({ items: [promotionItem({ amount: '0.34' }),promotionItem({ promotion_id: 702, promotion_type: 3, frozen_name: '另一活动', amount: '0.66' })] });
  const f = await open(review({ promotions: value }));
  try { for (const text of ['活动 #701','活动 #702','¥0.34','¥0.66','¥1.00','另一活动']) expect(contents(f.host)).toContain(text); }
  finally { f.close(); }
});
it('labels a legacy ledger reference without inventing a frozen campaign name or recomputing current discounts', async () => {
  const value = promotionsReview({ basis: 'legacy', items: [promotionItem({ promotion_type: 4, frozen_name: null })] });
  const f = await open(review({ promotions: value }));
  try { expect(contents(f.host)).toContain('历史订单账本参考'); expect(contents(f.host)).toContain('当前已改名的活动标题'); expect(contents(f.host)).not.toContain('下单快照中的活动名称'); expect(contents(f.host)).toContain('¥1.00'); }
  finally { f.close(); }
});
it.each(['modern','legacy'])('keeps %s recorded money readable when the current activity title is unavailable', async basis => {
  const value = promotionsReview({ basis, items: [promotionItem({ current_title: null, frozen_name: basis === 'modern' ? '历史名称仍保留' : null, promotion_type: basis === 'modern' ? 1 : null })] });
  const f = await open(review({ promotions: value }));
  try { expect(contents(f.host)).toContain('当前活动标题不可用'); expect(contents(f.host)).toContain('¥1.00'); expect(contents(f.host)).not.toContain('促销分摊暂无法核对'); }
  finally { f.close(); }
});
it('distinguishes an explicit recorded zero allocation from no ledger record', async () => {
  const value = promotionsReview({ basis: 'legacy', total: '0.00', items: [promotionItem({ frozen_name: null, amount: '0.00' })] });
  const f = await open(review({ promotions: value, amounts: { ...review().amounts, promotions_price: '0.00' } }));
  try { expect(contents(f.host)).toContain('本单促销分摊合计'); expect(contents(f.host)).toContain('¥0.00'); expect(contents(f.host)).not.toContain('本订单未记录促销分摊'); }
  finally { f.close(); }
});
it.each([
  { value: undefined, expected: '促销分摊信息未返回，请重新读取详情', omit: true },
  { value: { order_id: 25, state: 'none', reason: '', basis: null, total: null, items: [] }, expected: '本订单未记录促销分摊', omit: false },
  { value: { order_id: 25, state: 'unavailable', reason: '促销账本与商品记录不一致', basis: null, total: null, items: [] }, expected: '促销账本与商品记录不一致', omit: false },
])('separates old contract, no record and unavailable allocation: $expected', async ({ value, expected, omit }) => {
  const data = review({ amounts: { ...review().amounts, promotions_price: '0.00' } }); if (!omit) data.promotions = value;
  const f = await open(data); try { expect(contents(f.host)).toContain(expected); expect(contents(f.host)).toContain('下单时的历史地址'); expect(contents(f.host)).not.toContain('下单时的活动名称'); }
  finally { f.close(); }
});
it('labels own payment-summary allocations without adding them to physical child amounts', async () => {
  const f = await open(review({ order_kind: 'payment_summary', promotions: promotionsReview() }), { pid: -1 });
  try { expect(contents(f.host)).toContain('付款汇总的历史促销分摊'); expect(contents(f.host)).toContain('勿与各子订单重复相加'); }
  finally { f.close(); }
});
it('supports valid frozen UTF-16 and current database-Unicode title boundaries as safe plain text', async () => {
  const frozen = '🎁'.repeat(127)+'礼', current = '🛍'.repeat(255);
  const value = promotionsReview({ items: [promotionItem({ frozen_name: frozen, current_title: current }),promotionItem({ promotion_id: 702, amount: '0.00', frozen_name: '<script>历史名称</script>', current_title: '<img onerror=alert(1)>' })] });
  const f = await open(review({ promotions: value }));
  try { for (const text of [frozen,current,'<script>历史名称</script>','<img onerror=alert(1)>']) expect(contents(f.host)).toContain(text); expect(nodes(f.host).some(n=>n.props.innerHTML)).toBe(false); }
  finally { f.close(); }
});
it('sums allocation cents exactly at the schema amount boundary without floating-point rounding', async () => {
  const value = promotionsReview({ total: '9999999999.99', items: [promotionItem({ amount: '9999999999.98' }),promotionItem({ promotion_id: 702, amount: '0.01' })] });
  const f = await open(review({ amounts: { ...review().amounts, promotions_price: '9999999999.99' }, promotions: value }));
  try { expect(contents(f.host)).toContain('¥9,999,999,999.99'); expect(contents(f.host)).toContain('¥0.01'); }
  finally { f.close(); }
});
it.each([
  ['array state', (v: any) => { v.state = ['recorded']; }],
  ['wrong physical order', (v: any) => { v.order_id = 32; }],
  ['unknown basis', (v: any) => { v.basis = 'current'; }],
  ['unexplained unavailable', (v: any) => { v.state = 'unavailable'; v.basis = null; v.total = null; v.items = []; }],
  ['unavailable with private rows', (v: any) => { v.state = 'unavailable'; v.reason = '请核对'; }],
  ['none with nonzero header', (v: any) => { v.state = 'none'; v.basis = null; v.total = null; v.items = []; }],
  ['empty recorded list', (v: any) => { v.items = []; }],
  ['duplicate grouped identity', (v: any) => { v.items.push({ ...v.items[0], amount: '0.00' }); }],
  ['row total mismatch', (v: any) => { v.items[0].amount = '0.99'; }],
  ['header total mismatch', (v: any) => { v.total = '2.00'; v.items[0].amount = '2.00'; }],
  ['float amount', (v: any) => { v.items[0].amount = 1; }],
  ['negative amount', (v: any) => { v.items[0].amount = '-1.00'; }],
  ['exponent amount', (v: any) => { v.items[0].amount = '1e0'; }],
  ['missing modern name', (v: any) => { v.items[0].frozen_name = null; }],
  ['oversized frozen name', (v: any) => { v.items[0].frozen_name = '🎁'.repeat(128); }],
  ['oversized current title', (v: any) => { v.items[0].current_title = 'x'.repeat(511); }],
  ['forbidden text control', (v: any) => { v.items[0].current_title = 'bad\u0000title'; }],
  ['modern type from current-only metadata', (v: any) => { v.items[0].promotion_type = 4; }],
  ['invented legacy frozen name', (v: any) => { v.basis = 'legacy'; }],
  ['oversized record list', (v: any) => { v.items = Array.from({ length: 601 },(_,i)=>promotionItem({ promotion_id: i+1, amount: '0.00' })); }],
  ['extra current campaign data', (v: any) => { v.items[0].eligibility = { uid: 999 }; }],
  ['null envelope', (_v: any) => {}],
])('rejects %s promotion response before showing misleading allocation and retries the real detail endpoint', async (name, change: (v: any) => void) => {
  const broken = promotionsReview(); change(broken); let current = name === 'null envelope' ? null : broken;
  const f = await mount(c => c.url === '/order/info/25' ? detail(25, review({ promotions: current })) : undefined);
  try {
    await f.view.openOrder(order()); await flush(); expect(f.view.current.value).toBeNull();
    expect(nodes(f.host).find(n=>n.tag==='el-alert'&&String(n.props.title).includes('促销分摊信息不完整'))).toBeTruthy(); expect(contents(f.host)).not.toContain('下单时的活动名称');
    current = promotionsReview(); button(f,'重新读取详情').props.onClick(); await flush(); expect(contents(f.host)).toContain('下单时的活动名称'); expect(f.calls.filter(c=>c.url==='/order/info/25')).toHaveLength(2);
  } finally { f.close(); }
});
it('does not revive an older named allocation after order A to B to A navigation', async () => {
  const pending=gate(); let hold=true;
  const fresh=(id: number)=>detail(id,review({ promotions: promotionsReview({ order_id: id, items: [promotionItem({ frozen_name:`当前分摊-${id}` })] }),...(id===32?{order_kind:'payment_summary'}:{}) }),id===32?{pid:-1,delivery_type:'split'}:{});
  const f=await mount(c=>c.url.startsWith('/order/info/')?c.url==='/order/info/25'&&hold?pending.promise:fresh(Number(c.url.split('/').at(-1))):undefined);
  try { const reading=f.view.openOrder(order()); await flush(); await f.view.openOrder(order(32)); hold=false; await f.view.openOrder(order());
    pending.resolve(detail(25,review({promotions:promotionsReview({items:[promotionItem({frozen_name:'过时活动分摊'})]})}))); await reading; await flush(); expect(contents(f.host)).toContain('当前分摊-25'); expect(contents(f.host)).not.toContain('过时活动分摊'); expect(f.calls.find(c=>c.url==='/order/info/25').signal.aborted).toBe(true);
  } finally { pending.resolve(detail()); f.close(); }
});
it.each(['close','route','session'])('clears private promotion facts on %s and ignores the delayed detail response', async action => {
  const pending=gate(); let hold=false; const value=detail(25,review({promotions:promotionsReview()}));
  const f=await mount(c=>c.url==='/order/info/25'?hold?pending.promise:value:undefined);
  try { await f.view.openOrder(order()); expect(contents(f.host)).toContain('下单时的活动名称'); hold=true; const reading=f.view.refreshCurrent(); await flush();
    if(action==='close')f.view.drawerOpen.value=false;
    if(action==='route')await f.router.push('/away');
    if(action==='session')for(const token of ['other-account','tracking-a']){localStorage.setItem('supplier-token',token);const e=new Event('storage');Object.assign(e,{key:'supplier-token',storageArea:localStorage});surface.dispatchEvent(e);}
    pending.resolve(value);await reading;await flush();expect(f.view.current.value).toBeNull();expect(contents(f.host)).not.toContain('下单时的活动名称');
  } finally {pending.resolve(value);f.close();}
});

const giftIdentityCart = (id: number, flag: unknown = 0) => ({ id, cart_id: `identity-${id}`, product_id: 70, sku_unique: 'same-sku',
  cart_num: 2, refund_num: 0, surplus_num: 2, product_name: '同款冻结商品', sku: '同款规格', image: '',
  is_gift: flag, cart_info: { is_gift: flag === 1 ? 0 : 1 } });
function giftIdentityReview(flag: unknown): any {
  const base = review(); return { ...base, amounts: { ...base.amounts, quantity: 2 }, items: [
    { ...base.items[0], is_gift: 0, product_name: '同款冻结商品', settlement_unit: '0.00', settlement_subtotal: '0.00' },
    { ...base.items[0], id: 252, is_gift: flag, product_name: '同款冻结商品', settlement_unit: '0.00', settlement_subtotal: '0.00' },
  ] };
}
function giftKindLabels(host: Node) {
  return nodes(host).filter(n => n.tag === 'span' && String(n.props.class).split(' ').includes('order-item-kind')).map(contents).map(s => s.trim());
}
async function giftIdentityMount(surfaceName: 'detail' | 'shipment' | 'delivery', flag: unknown = 1, oldServer = false) {
  const value = giftIdentityReview(flag), carts: any[] = [giftIdentityCart(251, 0), giftIdentityCart(252, flag)];
  if (oldServer) { for (const item of value.items) delete item.is_gift; for (const item of carts) delete item.is_gift; }
  const target = order(25, { status: 0, total_num: 2 });
  const f = await mount(c => c.url.startsWith('/order/info/') ? detail(25, value, { status: 0, total_num: 2 })
    : c.url.startsWith('/order/split_order/') ? [order(25, { status: 0, total_num: 4, cart_info: surfaceName === 'shipment' ? carts : [] })]
    : c.url === '/order/express_list' ? [{ id: 1, name: '本地快递', code: 'LOCAL' }]
    : c.url.startsWith('/order/split_cart_info/') ? carts : undefined);
  if (surfaceName === 'delivery') { await f.view.openDelivery(target); f.view.deliveryMode.value = 'partial'; }
  else await f.view.openOrder(target);
  await flush(); return { ...f, carts };
}
it('renders protected purchase and gift identities separately even for the same product and zero settlement', async () => {
  const f = await giftIdentityMount('detail'); try {
    expect(f.view.detailError.value).toBe(''); const table = nodes(f.host).find(n => n.tag === 'table' && n.props['aria-label'] === '下单商品结算明细')!;
    expect(giftKindLabels(table)).toEqual(['购买商品','赠品']); expect(contents(table)).toContain('同款冻结商品');
    expect(contents(table)).toContain('¥0.00'); expect(f.calls.every(c => c.method === 'get')).toBe(true);
  } finally { f.close(); }
});
it('renders purchase and gift labels on each historical shipment without deriving them from forged snapshot fields', async () => {
  const f = await giftIdentityMount('shipment'); try {
    const shipment = nodes(f.host).find(n => String(n.props.class).includes('shipment-section'))!;
    expect(giftKindLabels(shipment)).toEqual(['购买商品','赠品']); expect(contents(shipment)).toContain('同款规格');
    expect(f.calls.every(c => c.method === 'get')).toBe(true);
  } finally { f.close(); }
});
it('identifies the exact gift cart in the actual partial-delivery selector without submitting a delivery', async () => {
  const f = await giftIdentityMount('delivery'); try {
    expect(f.view.deliveryError.value).toBe(''); expect(giftKindLabels(f.host)).toEqual(['购买商品','赠品']);
    f.view.toggleSplitItem(f.carts[1], true); await flush(); expect(f.view.selectedQuantities['identity-252']).toBe(1);
    expect(f.view.selectedQuantities['identity-251'] ?? 0).toBe(0); expect(f.view.selectedQuantity.value).toBe(1);
    expect(f.calls.every(c => c.method === 'get')).toBe(true);
  } finally { f.close(); }
});
it.each(['detail','shipment','delivery'] as const)('keeps missing old-server gift identity honestly unknown in %s instead of inferring a purchase or gift', async surfaceName => {
  const f = await giftIdentityMount(surfaceName, 1, true); try {
    expect(giftKindLabels(f.host).length).toBeGreaterThan(0); expect(giftKindLabels(f.host).every(v => v === '商品性质未返回')).toBe(true);
    expect(f.calls.every(c => c.method === 'get')).toBe(true);
  } finally { f.close(); }
});
it.each((['detail','shipment','delivery'] as const).flatMap(surfaceName => [true,'1','0',null,undefined,-1,2,0.5,[],{}].map(flag => ({ surfaceName, flag }))))
  ('rejects present malformed gift flag in $surfaceName: $flag and permits an explicit correct reread', async ({ surfaceName, flag }) => {
    let malformed = true; const carts = [giftIdentityCart(251, 0),giftIdentityCart(252,1)];
    const f = await mount(c => c.url.startsWith('/order/info/') ? detail(25,giftIdentityReview(surfaceName === 'detail' && malformed ? flag : 1),{status:0,total_num:2})
      : c.url.startsWith('/order/split_order/') ? [order(25,{status:0,total_num:4,cart_info: surfaceName === 'shipment' ? carts.map((item,i)=>({...item,is_gift:i===1 && malformed ? flag:item.is_gift})) : []})]
      : c.url === '/order/express_list' ? [{id:1,name:'本地快递',code:'LOCAL'}]
      : c.url.startsWith('/order/split_cart_info/') ? carts.map((item,i)=>({...item,is_gift:i===1 && malformed ? flag:item.is_gift})) : undefined);
    try {
      const target=order(25,{status:0,total_num:2});
      if(surfaceName==='delivery') await f.view.openDelivery(target); else await f.view.openOrder(target);
      await flush(); expect(surfaceName==='delivery'?f.view.deliveryError.value:f.view.detailError.value).toBeTruthy();
      expect(giftKindLabels(f.host)).toEqual([]); malformed=false;
      if(surfaceName==='delivery'){await f.view.retryDelivery();f.view.deliveryMode.value='partial';}else await f.view.refreshCurrent();
      await flush(); expect(giftKindLabels(f.host)).toContain('赠品'); expect(f.calls.every(c=>c.method==='get')).toBe(true);
    } finally { f.close(); }
  });
it.each(['drawer','route','session'] as const)('does not restore a late gift identity after %s invalidates detail and shipments', async why => {
  const wait=gate(),f=await mount(c=>c.url==='/order/info/25'?wait.promise:undefined);
  try {
    const pending=f.view.openOrder(order());await flush();
    if(why==='drawer')f.view.drawerOpen.value=false;
    if(why==='route')await f.router.push('/away');
    if(why==='session'){localStorage.setItem('supplier-token','identity-b');surface.dispatchEvent(new Event('supplier-session-changed'));localStorage.setItem('supplier-token','tracking-a');surface.dispatchEvent(new Event('supplier-session-changed'));}
    wait.resolve(detail(25,giftIdentityReview(1),{total_num:2}));await pending;await flush();
    expect(f.view.current.value).toBeNull();expect(f.view.shipments.value).toEqual([]);expect(giftKindLabels(f.host)).toEqual([]);
  } finally {wait.resolve();f.close();}
});
it.each(['dialog','route','session'] as const)('does not restore late gift selection rows after %s invalidates delivery', async why => {
  const wait=gate(),f=await mount(c=>c.url==='/order/express_list'?[{id:1,name:'本地快递',code:'LOCAL'}]
    :c.url==='/order/split_cart_info/25'?wait.promise:undefined);
  try {
    const pending=f.view.openDelivery(order(25,{status:0}));await flush();
    if(why==='dialog')f.view.deliveryDialogOpen.value=false;
    if(why==='route')await f.router.push('/away');
    if(why==='session'){localStorage.setItem('supplier-token','identity-b');surface.dispatchEvent(new Event('supplier-session-changed'));localStorage.setItem('supplier-token','tracking-a');surface.dispatchEvent(new Event('supplier-session-changed'));}
    wait.resolve([giftIdentityCart(252,1)]);await pending;await flush();expect(f.view.splitItems.value).toEqual([]);expect(giftKindLabels(f.host)).toEqual([]);
    expect(f.calls.every(c=>c.method==='get')).toBe(true);
  } finally {wait.resolve();f.close();}
});
