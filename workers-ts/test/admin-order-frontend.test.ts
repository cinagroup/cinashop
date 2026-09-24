import { beforeAll, beforeEach, afterEach, it, expect, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

// Compile the actual SFC setup, Vue/router and axios. Only dialogs and the
// HTTP adapter are fixtures; these are frontend lifecycle tests, not SQL tests.
let runtime: any, surface: EventTarget;
const root = resolve(import.meta.dirname, '../../view/admin-ts'), require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript } = require('@vue/compiler-sfc');
beforeAll(async () => {
  const result = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    export { default as List } from './src/pages/order/OrderList.vue';
    export { default as Detail } from './src/pages/order/OrderDetail.vue';
    export * as api from './src/api/order'; export * as transport from './src/utils/orderRequest';
    export * as read from './src/utils/orderRead'; export * as auth from './src/utils/auth'; export * as dialog from 'element-plus';
    export { createRenderer, h, nextTick } from 'vue'; export { createRouter, createMemoryHistory, RouterView } from 'vue-router';
  ` }, alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false' }, bundle: true, write: false, platform: 'browser', format: 'esm',
    plugins: [{ name: 'actual-admin-orders', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({ contents: compileScript(parse(readFileSync(path, 'utf8'), { filename: path }).descriptor, { id: 'admin-orders' }).content, loader: 'ts' }));
      builder.onResolve({ filter: /^element-plus$/ }, () => ({ path: 'dialogs', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const state={confirm:async()=>{},messages:[]};
        export const ElMessage={success:m=>state.messages.push(['success',m]),warning:m=>state.messages.push(['warning',m]),error:m=>state.messages.push(['error',m])};
        export const ElMessageBox={confirm:(...a)=>state.confirm(...a)};` }));
    } }] });
  runtime = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
});
function login(readOnly = false) {
  localStorage.setItem('admin_token', 'local-token-a');
  localStorage.setItem('admin_session', JSON.stringify({ userInfo: { id: 100, level: 1 }, menus: [], uniqueAuth: readOnly ? ['order.view'] : ['order.view', 'order.manage', 'refund.manage'] }));
}
beforeEach(() => {
  const values = new Map<string, string>(); surface = new EventTarget();
  vi.stubGlobal('window', Object.assign(surface, { location: { search: '', pathname: '/order', href: '' }, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) }));
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  login(); runtime.dialog.state.messages = []; runtime.dialog.state.confirm = async () => {};
});
afterEach(() => vi.unstubAllGlobals());
const order = (id = 25, changes: Record<string, unknown> = {}) => ({ id, orderId: 'O' + id, pid: 0, uid: 11, paid: 1, status: 0, refundStatus: 0, refundType: 0,
  totalNum: 1, payPrice: '8.00', totalPrice: '8.00', shippingType: 2, productType: 0, deliveryType: '', realName: '本地测试', userPhone: '000000',
  payType: 'yue', addTime: 1700000000, remark: '', isDel: 0, isSystemDel: 0, province: '', userAddress: '本地地址', totalPostage: '0.00', payIntegral: 0, useIntegral: '0.00', deductionPrice: '0.00', gainIntegral: '0.00', mark: '',
  splitOrders: [], cartInfo: [{ id: id + 100, oid: id, uid: 11, cartId: String(id + 200), cartNum: 1, cartInfo: { product: { storeName: '测试商品' }, sku: { suk: '蓝色', price: '8.00' }, sum_price: '8.00' } }], ...changes });
const list = (page = 1, total = 21) => ({ list: Array.from({ length: Math.max(0, Math.min(10, total - (page - 1) * 10)) }, (_, i) => order(25 + i + (page - 1) * 10)), page, limit: 10, total });
const chart = () => ({ all: 21, unpaid: 4, unshipped: 5, untake: 3, unevaluate: 2, complete: 1 });
const preview = () => ({ id: 25, order_id: 'O25', actor_kind: 'admin', cart_info: [{ id: 125, cart_id: '225', write_surplus_times: 2, write_times: 2 }] });
const envelope = (data: unknown) => ({ status: 200, data });
const gate = () => { let resolve!: (value?: unknown) => void; return { promise: new Promise(r => { resolve = r; }), resolve }; };
const flush = async () => { for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 1)); await runtime.nextTick(); } };
async function mount(path = '/order/O25', override: (config: any) => unknown = () => undefined) {
  const calls: any[] = []; let view: any;
  runtime.transport.orderRequest.defaults.adapter = async (config: any) => {
    calls.push(config);
    const value = await override(config) ?? envelope(config.url === '/order/list' ? list(config.params.page) : config.url === '/order/chart' ? chart() : config.url === '/order/writeoff_info' ? preview()
      : config.url === '/order/writeoff' ? { order_id: 'O25', completed: true, status: 2 } : config.url === '/order/delivery/list' ? { list: [], count: 0 }
      : config.url === '/express/list' ? [] : order(Number(config.url.split('/').at(-1).slice(1))));
    return { config, data: value, status: 200, statusText: 'frontend fixture', headers: {} };
  };
  const component = (name: string) => ({ setup(p: unknown, c: unknown) { view = runtime[name].setup(p, c); return () => null; } });
  const router = runtime.createRouter({ history: runtime.createMemoryHistory(), routes: [{ path: '/order', component: component('List') }, { path: '/order/:orderId', component: component('Detail') }, { path: '/away', component: { render: () => null } }] });
  const renderer = runtime.createRenderer({ createElement: () => ({ children: [] }), createText: (text: string) => ({ text }), createComment: (text: string) => ({ text }),
    insert(n: any, p: any) { n.parent = p; (p.children ??= []).push(n); }, remove() {}, parentNode: (n: any) => n.parent, nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {} });
  const app = renderer.createApp({ render: () => runtime.h(runtime.RouterView) }); app.use(router); await router.push(path); app.mount({ children: [] }); await flush();
  return { get view() { return view; }, calls, router, writes: () => calls.filter(c => c.method === 'post' && c.url !== '/order/writeoff_info'), close: () => app.unmount() };
}
it('consumes exact total on full, last and beyond-last pages; never invents page*limit+1', async () => {
  const f = await mount('/order'); try { expect(f.view.total.value).toBe(21); expect(f.view.list.value).toHaveLength(10);
    f.view.query.page = 3; await f.view.fetch(); expect(f.view.total.value).toBe(21); expect(f.view.list.value).toHaveLength(1);
    f.view.query.page = 4; await f.view.fetch(); expect(f.view.total.value).toBe(21); expect(f.view.list.value).toEqual([]);
  } finally { f.close(); }
});
it('renders all six status numbers once on entry and retains them through paging and search', async () => {
  const delayed = gate(), f = await mount('/order', c => c.url === '/order/list' && c.params?.page === 2 ? delayed.promise : undefined);
  try {
    expect(readFileSync(resolve(root, 'src/pages/order/OrderList.vue'), 'utf8')).toContain('v-for="item in chartCards"');
    expect(f.view.chartCards.value).toEqual([
      { label: '全部', count: 21 }, { label: '未支付', count: 4 }, { label: '未发货', count: 5 },
      { label: '待收货', count: 3 }, { label: '待评价', count: 2 }, { label: '交易完成', count: 1 },
    ]);
    expect(f.calls.filter(c => c.url === '/order/chart')).toHaveLength(1);
    f.view.query.page = 2; const paging = f.view.fetch(); await flush();
    expect(f.view.loading.value).toBe(true);
    expect(f.view.chartCards.value.map((item: { count: number }) => item.count)).toEqual([21, 4, 5, 3, 2, 1]);
    expect(f.view.chartLoading.value).toBe(false);
    delayed.resolve(envelope(list(2))); await paging;
    f.view.query.order_id = 'O25'; f.view.reload(); await flush();
    expect(f.view.chartCards.value.map((item: { count: number }) => item.count)).toEqual([21, 4, 5, 3, 2, 1]);
    expect(f.calls.filter(c => c.url === '/order/chart')).toHaveLength(1);
  } finally { f.close(); }
});
it.each(['missing-count', 'negative', 'exceeds-all'] as const)('rejects malformed %s chart and retries only the chart', async kind => {
  const bad: any = chart();
  if (kind === 'missing-count') delete bad.complete;
  if (kind === 'negative') bad.unpaid = -1;
  if (kind === 'exceeds-all') bad.all = 1;
  let broken = true;
  const f = await mount('/order', c => c.url === '/order/chart' && broken ? envelope(bad) : undefined);
  try {
    expect(f.view.chart.value).toBeNull(); expect(f.view.chartError.value).toBeTruthy();
    expect(f.view.list.value).toHaveLength(10);
    broken = false; await f.view.fetchChart();
    expect(f.view.chartError.value).toBe(''); expect(f.view.chart.value).toEqual(chart());
    expect(f.calls.filter(c => c.url === '/order/chart')).toHaveLength(2);
    expect(f.calls.filter(c => c.url === '/order/list')).toHaveLength(1);
  } finally { f.close(); }
});
it.each(['session', 'route'] as const)('ignores delayed chart after %s invalidation', async kind => {
  const delayed = gate(), f = await mount('/order', c => c.url === '/order/chart' ? delayed.promise : undefined);
  const view = f.view, request = f.calls.find(c => c.url === '/order/chart');
  try {
    expect(view.chartLoading.value).toBe(true); expect(view.list.value).toHaveLength(10);
    if (kind === 'session') runtime.auth.setToken('token-b');
    else await f.router.push('/away');
    expect(request.signal.aborted).toBe(true);
    delayed.resolve(envelope({ ...chart(), all: 999 })); await flush();
    expect(view.chart.value).toBeNull(); expect(view.chartLoading.value).toBe(false);
  } finally { f.close(); }
});
it('clears stale rows and ignores a delayed list after a newer filter', async () => {
  const delayed = gate(), f = await mount('/order', c => c.params?.order_id === 'OLD' ? delayed.promise : undefined);
  try { f.view.query.order_id = 'OLD'; const old = f.view.fetch(); await flush(); expect(f.view.list.value).toEqual([]);
    expect(f.view.loading.value).toBe(true); expect(f.view.total.value).toBe(21); // Don't trigger Element Plus's page-to-1 clamp while loading.
    f.view.query.order_id = 'NEW'; await f.view.fetch(); delayed.resolve(envelope(list(1, 0))); await old; expect(f.view.total.value).toBe(21);
  } finally { f.close(); }
});
it('same-component A -> B -> A navigation never restores the old header or carts', async () => {
  const delayed = gate(); let count = 0;
  const f = await mount('/order/O25', c => c.url === '/order/detail/O25' && ++count === 1 ? delayed.promise : undefined);
  try { const original = f.view; expect(f.view.order.value).toBeNull(); await f.router.push('/order/O26'); await flush(); expect(f.view).toBe(original); expect(f.view.order.value.id).toBe(26);
    await f.router.push('/order/O25'); await flush(); delayed.resolve(envelope(order(25, { mark: 'STALE' }))); await flush(); expect(f.view.order.value.mark).toBe(''); expect(f.view.order.value.cartInfo[0].sku).toBe('蓝色');
  } finally { f.close(); }
});
it.each(['wrong-number', 'foreign-cart', 'foreign-child', 'duplicate-child', 'child-on-leaf', 'missing-carts', 'missing-children', 'deleted'])('rejects %s detail and permits explicit retry without old data', async kind => {
  let bad = true; const source: any = order(25);
  if (kind === 'wrong-number') source.orderId = 'O26';
  if (kind === 'foreign-cart') source.cartInfo[0].uid = 12;
  if (kind === 'foreign-child') { source.pid = -1; source.splitOrders = [order(26, { pid: 25, uid: 12 })]; }
  if (kind === 'duplicate-child') { source.pid = -1; source.splitOrders = [order(26, { pid: 25 }), order(26, { pid: 25 })]; }
  if (kind === 'child-on-leaf') source.splitOrders = [order(26, { pid: 25 })];
  if (kind === 'missing-carts') delete source.cartInfo;
  if (kind === 'missing-children') delete source.splitOrders;
  if (kind === 'deleted') source.isDel = 1;
  const f = await mount('/order/O25', () => bad ? envelope(source) : undefined);
  try { expect(f.view.order.value).toBeNull(); expect(f.view.readError.value).toBeTruthy(); bad = false; await f.view.loadOrder(); expect(f.view.order.value.id).toBe(25); expect(f.view.readError.value).toBe(''); } finally { f.close(); }
});
it.each(['missing-total', 'wrong-page', 'root-in-list', 'partial-list', 'duplicate-row'])('rejects malformed %s list without treating it as an empty success', async kind => {
  const value: any = list(); if (kind === 'missing-total') delete value.total; if (kind === 'wrong-page') value.page = 2;
  if (kind === 'root-in-list') value.list[0].pid = -1; if (kind === 'partial-list') value.list.pop(); if (kind === 'duplicate-row') value.list[1] = value.list[0];
  const f = await mount('/order', () => envelope(value)); try { expect(f.view.total.value).toBe(0); expect(f.view.readError.value).toBeTruthy(); expect(f.view.list.value).toEqual([]); } finally { f.close(); }
});
it('keeps root historical snapshots separate from current children and disallows fulfillment', async () => {
  const f = await mount('/order/O25', () => envelope(order(25, { pid: -1, splitOrders: [order(26, { pid: 25, refundStatus: 2, refundType: 6 })] })));
  try { expect(f.view.order.value.splitOrders[0].orderId).toBe('O26'); expect(f.view.order.value.cartInfo[0].cartId).toBe('225'); expect(f.view.canAdminWriteoff.value).toBe(false);
    expect(runtime.read.adminOrderStatus(f.view.order.value)).toBe('已拆分支付单'); expect(runtime.read.adminOrderStatus(f.view.order.value.splitOrders[0])).toBe('已退款');
  } finally { f.close(); }
});
it.each(['/order', '/order/O25'])('sticky account A -> B -> A invalidation clears %s and prevents reads or writes', async path => {
  const f = await mount(path); try { runtime.auth.setToken('token-b'); runtime.auth.setToken('local-token-a'); const count = f.calls.length;
    if (path === '/order') { expect(f.view.list.value).toEqual([]); await f.view.fetch(); } else { expect(f.view.order.value).toBeNull(); await f.view.loadOrder(); await f.view.previewWriteoff(); }
    expect(f.view.sessionValid.value).toBe(false); expect(f.calls).toHaveLength(count); expect(f.writes()).toHaveLength(0);
  } finally { f.close(); }
});
it('late expired response cannot clear a replacement session, even after token A -> B -> A', async () => {
  const delayed = gate(), f = await mount('/order/O25', () => delayed.promise);
  try { runtime.auth.setToken('token-b'); runtime.auth.setToken('local-token-a'); delayed.resolve({ status: 410001, msg: 'old expired' }); await flush();
    expect(localStorage.getItem('admin_token')).toBe('local-token-a'); expect(f.view.order.value).toBeNull();
  } finally { f.close(); }
});
it('captures credentials before axios dispatch and refuses an already-aborted request', async () => {
  const f = await mount(); try { const pending = runtime.api.apiAdminOrderDelivery('O25', { delivery_type: 'send', delivery_uid: 2 }); runtime.auth.setToken('token-b'); await expect(pending).rejects.toThrow();
    expect(f.writes().every(c => c.headers['Authori-zation'] === 'Bearer local-token-a')).toBe(true);
    const controller = new AbortController(); controller.abort(); const count = f.calls.length; await expect(runtime.api.apiAdminOrderDetail('O25', controller.signal)).rejects.toThrow(); expect(f.calls).toHaveLength(count);
  } finally { f.close(); }
});
it.each(['route', 'refresh', 'code', 'close', 'session', 'quantity', 'unmount'])('does not submit a writeoff after confirmation is invalidated by %s', async kind => {
  const confirmation = gate(), f = await mount(); runtime.dialog.state.confirm = () => confirmation.promise;
  try { f.view.writeoffCode.value = '123456789012'; await f.view.previewWriteoff(); const pending = f.view.executeWriteoff(false); await flush();
    if (kind === 'route') { await f.router.push('/order/O26'); await f.router.push('/order/O25'); }
    if (kind === 'refresh') await f.view.loadOrder(); if (kind === 'code') f.view.writeoffCode.value = '111111111111'; if (kind === 'close') f.view.writeoffVisible.value = false;
    if (kind === 'session') surface.dispatchEvent(new Event('admin-session-changed')); if (kind === 'quantity') f.view.writeoffQuantities.value[125] = 1; if (kind === 'unmount') f.close();
    confirmation.resolve(); await pending; expect(f.writes()).toHaveLength(0);
  } finally { if (kind !== 'unmount') f.close(); }
});
it('submits exactly once with the reviewed code and quantities, then rereads the order', async () => {
  const confirmation = gate(), f = await mount(); runtime.dialog.state.confirm = () => confirmation.promise;
  try { f.view.writeoffCode.value = '123456789012'; await f.view.previewWriteoff(); f.view.writeoffQuantities.value[125] = 1;
    const action = f.view.executeWriteoff(false); await f.view.executeWriteoff(true); confirmation.resolve(); await action;
    expect(f.writes()).toHaveLength(1); expect(JSON.parse(f.writes()[0].data)).toEqual({ code: '123456789012', items: [{ order_cart_id: 125, quantity: 1 }] });
    expect(f.calls.filter(c => c.url === '/order/detail/O25')).toHaveLength(2); expect(f.view.writeoffVisible.value).toBe(false);
  } finally { f.close(); }
});
it('readonly role cannot enter fulfillment, printing or refund actions', async () => {
  login(true); const f = await mount(); try { expect(f.view.canRefund.value).toBe(false); expect(f.view.canAdminWriteoff.value).toBe(false); f.view.writeoffCode.value = '123456789012'; await f.view.previewWriteoff(); expect(f.calls).toHaveLength(1);
    await f.router.push('/order'); await flush(); const row = f.view.list.value[0]; await f.view.printOrder(row); await f.view.deliver(row); expect(f.view.canManage.value).toBe(false); expect(f.writes()).toHaveLength(0);
  } finally { f.close(); }
});
it('a late delivery-options response cannot reopen a closed dialog or act on an old row', async () => {
  const delayed = gate(), f = await mount('/order', c => c.url === '/order/list' ? envelope({ ...list(), list: list().list.map(row => ({ ...row, shippingType: 1 })) }) : c.url === '/order/delivery/list' ? delayed.promise : undefined);
  try { const row = f.view.list.value[0], pending = f.view.deliver(row); await flush(); f.view.deliveryVisible.value = false;
    delayed.resolve(envelope({ list: [{ id: 1, uid: 7, nickname: 'stale', phone: '' }], count: 1 })); await pending;
    expect(f.view.deliveryOrder.value).toBeNull(); expect(f.view.deliveryOptions.value).toEqual([]); await f.view.submitDelivery(); expect(f.writes()).toHaveLength(0);
    await f.view.fetch(); await f.view.printOrder(row); expect(f.writes()).toHaveLength(0);
  } finally { f.close(); }
});
it('unknown snapshot price stays unknown; modern and legacy SKU sources are supported', () => {
  const base = order(); const row = base.cartInfo[0];
  const value = runtime.read.parseAdminOrderDetail({ ...base, cartInfo: [{ ...row, cartInfo: { productInfo: { store_name: '旧格式', attrInfo: { suk: '绿色' } } } }] }, 'O25');
  expect(value.cartInfo[0]).toMatchObject({ name: '旧格式', sku: '绿色', price: null });
});
it.each(['/order', '/order/O25'])('unmounting %s cancels reads and ignores their later responses', async path => {
  const delayed = gate(), f = await mount(path, () => delayed.promise), view = f.view, request = f.calls[0];
  f.close(); expect(request.signal.aborted).toBe(true); delayed.resolve(envelope(path === '/order' ? list() : order())); await flush();
  expect(path === '/order' ? view.list.value : view.order.value).toEqual(path === '/order' ? [] : null);
  expect(view.loading.value).toBe(false);
});
it.each(['missing', 'wrong-id', 'foreign-cart'])('invalid %s writeoff preview never enables confirmation', async kind => {
  const value = kind === 'missing' ? null : kind === 'wrong-id' ? { ...preview(), id: 26 } : { ...preview(), cart_info: [{ id: 999, cart_id: '225', write_surplus_times: 2 }] };
  const f = await mount('/order/O25', c => c.url === '/order/writeoff_info' ? envelope(value) : undefined);
  try { f.view.writeoffCode.value = '123456789012'; await f.view.previewWriteoff(); expect(f.view.writeoffVisible.value).toBe(false); await f.view.executeWriteoff(true); expect(f.writes()).toHaveLength(0); } finally { f.close(); }
});
it.each([0, 1, 2, 3])('renders refund summary %s without offering fulfillment on processing/refunded orders', refundStatus => {
  const value = runtime.read.parseAdminOrderDetail(order(25, { refundStatus }), 'O25');
  expect(runtime.read.isCurrentFulfillment(value)).toBe([0, 3].includes(refundStatus));
  expect(runtime.read.adminOrderStatus(value)).toBe(['待到店核销', '退款处理中', '已退款', '待到店核销'][refundStatus]);
});
it('keeps ordinary point deductions distinct from integral-product payment', () => {
  const value = runtime.read.parseAdminOrderDetail(order(25, { useIntegral: '100.00', deductionPrice: '1.00', payIntegral: 0 }), 'O25');
  expect(value).toMatchObject({ useIntegral: '100.00', deductionPrice: '1.00', payIntegral: 0 });
});
it.each(['useIntegral', 'deductionPrice'])('does not fabricate zero when %s is absent', field => {
  expect(() => runtime.read.parseAdminOrderDetail(order(25, { [field]: undefined }), 'O25')).toThrow();
});
