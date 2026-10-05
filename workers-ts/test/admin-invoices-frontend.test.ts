import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../view/admin-ts');
const require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript } = require('@vue/compiler-sfc');
let runtime: any, browser: EventTarget;
const endpoint = '/order/invoices', revision = 'a'.repeat(64);
const grants = ['invoice.view', 'invoice.manage'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
beforeAll(async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal('window', Object.assign(new EventTarget(), { innerWidth: 1280, location: { pathname: '/order/invoice', href: '' } }));
  const result = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    export { default as Page } from './src/pages/order/InvoiceManagement.vue';
    export { default as request } from './src/utils/request';
    export * as api from './src/api/invoiceManagement';
    export { createRenderer, nextTick } from 'vue'; export { createPinia } from 'pinia';
    export { useAuthStore } from './src/stores/auth'; export * as messages from 'element-plus';
  ` }, alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false' }, bundle: true, write: false,
    platform: 'browser', format: 'esm', plugins: [{ name: 'invoice-management-runtime', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({ contents: compileScript(parse(readFileSync(path, 'utf8'), { filename: path }).descriptor, { id: 'invoice-management' }).content, loader: 'ts' }));
      builder.onResolve({ filter: /^element-plus$/ }, () => ({ path: 'messages', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
        export const state = { successes: [], confirmations: [], closed: 0, confirm: () => Promise.resolve() };
        export const ElMessage = { success: value => state.successes.push(value) };
        export const ElMessageBox = { confirm(...args) { state.confirmations.push(args); return state.confirm(...args); }, close() { state.closed++; } };
      ` }));
    } }] });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
});
function row(id = 31, overrides: Record<string, unknown> = {}) {
  return { id, order_db_id: 21, order_number: 'order-21', template_id: 14, uid: 7, is_invoice: 0, invoice_number: '',
    invoice_amount: '12.00', expected_amount: '12.00', remark: '', invoice_time: 0, is_pay: 1, is_refund: 0, is_del: 0,
    add_time: 1790535600, header_type: 2, type: 1, name: '测试公司', duty_number: '91310000', drawer_phone: '13800000000',
    email: 'test@example.com', tell: '02112345678', address: '上海市', bank: '测试银行', card_number: '0123456789',
    order: { id: 21, order_number: 'order-21', pay_price: '12.00', paid: 1, refund_status: 0, status: 0, pid: 0, add_time: 1790535500,
      real_name: '订单张三', user_phone: '13900000000' },
    revision, issues: [], can_process: true, ...overrides };
}
function orderInfo(overrides: Record<string, unknown> = {}) {
  return { invoice_id: 31,
    order: { id: 21, order_number: 'order-21', uid: 7, pid: 0, status: 0, refund_status: 0,
      total_num: 1, total_price: '12.00', pay_postage: '0.00', coupon_price: '0.00', vip_true_price: null,
      deduction_price: '0.00', pay_price: '12.00', add_time: 1790535500, pay_type: 'weixin', mark: '',
      real_name: '订单张三', user_phone: '13900000000', user_address: '上海市测试路' },
    user: { nickname: '昵称', spread_name: '推广人' },
    cart_items: [{ id: 81, product_id: 72, product_name: '旧商品快照', category_name: '红色', sku: 'R',
      unit_price: '12.00', quantity: 1, image: '/product.png' }], ...overrides };
}
const envelope = (data: unknown, status = 200, msg = 'ok') => ({ status, msg, data });
function login(permissions = grants, token = 'invoice-token-a', id = 20) {
  localStorage.setItem('admin_token', token);
  localStorage.setItem('admin_session', JSON.stringify({ userInfo: { id, account: 'operator', level: 1, roles: '' }, menus: [], uniqueAuth: permissions }));
}
beforeEach(() => {
  const values = new Map<string, string>(); browser = new EventTarget();
  vi.stubGlobal('window', Object.assign(browser, { innerWidth: 1280, location: { pathname: '/order/invoice', href: '' } }));
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  runtime.messages.state.successes = []; runtime.messages.state.confirmations = []; runtime.messages.state.closed = 0;
  runtime.messages.state.confirm = () => Promise.resolve();
});
afterEach(() => vi.unstubAllGlobals());
const flush = async () => { for (let i = 0; i < 8; i++) { await new Promise(done => setTimeout(done, 1)); await runtime.nextTick(); } };
function deferred() { let resolve!: (value?: unknown) => void; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function mount(permissions = grants, respond: (config: any) => unknown = () => undefined) {
  login(permissions); const calls: any[] = [];
  runtime.request.defaults.adapter = async (config: any) => {
    calls.push(config);
    const custom = await respond(config), body = config.method === 'post' ? JSON.parse(config.data) : null;
    const data = custom ?? envelope(body ? { ...row(), is_invoice: body.is_invoice, invoice_number: body.invoice_number,
      remark: body.remark, committed: true, request_id: body.request_id, idempotent: false } :
      config.url.endsWith('/31') ? row() : { list: [row()], count: 1, page: config.params.page, limit: 10 });
    return { config, data, status: 200, statusText: 'isolated invoice fixture', headers: {} };
  };
  let view: any;
  const renderer = runtime.createRenderer({ createElement: () => ({ children: [] }), createText: (text: string) => ({ text }), createComment: (text: string) => ({ text }),
    insert(node: any, parent: any) { node.parent = parent; (parent.children ??= []).push(node); }, remove() {}, parentNode: (node: any) => node.parent,
    nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {} });
  const app = renderer.createApp({ setup(props: unknown, context: unknown) { view = runtime.Page.setup(props, context); return () => null; } });
  app.use(runtime.createPinia()); app.mount({ children: [] }); await flush(); return { view, calls, close: () => app.unmount() };
}
const writes = (calls: any[]) => calls.filter(call => call.method !== 'get');

it('exposes the independent invoice menu and queries ten rows without writes', async () => {
  const f = await mount(); try {
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ url: endpoint, params: { page: 1, limit: 10, start_time: '', end_time: '', field: 'all', keyword: '', status: 'all' } });
    expect(f.view.list.value).toHaveLength(1); expect(writes(f.calls)).toEqual([]);
    expect(readFileSync(resolve(root, 'src/router/index.ts'), 'utf8')).toContain('path: "order/invoice"');
    expect(readFileSync(resolve(root, 'src/layouts/AdminLayout.vue'), 'utf8')).toContain('canMenu(\'/order/invoice\')');
  } finally { f.close(); }
});
it('supports minute-precision Shanghai filters, distinct contact fields and stable pagination', async () => {
  const f = await mount(); try {
    f.view.draftDates.value = ['2026-09-28 09:15', '2026-09-28 10:30'];
    f.view.draftField.value = 'user_phone'; f.view.draftKeyword.value = ' 1380000 ';
    f.view.draftStatus.value = 'refunded'; f.view.search(); await flush(); await f.view.load(2);
    expect(f.calls.at(-1).params).toMatchObject({ page: 2, limit: 10, start_time: '2026-09-28 09:15',
      end_time: '2026-09-28 10:30', field: 'user_phone', keyword: '1380000', status: 'refunded' });
    f.view.reset(); await flush(); expect(f.calls.at(-1).params).toMatchObject({ page: 1, status: 'all', field: 'all' });
  } finally { f.close(); }
});
it('keeps the legacy type and header filters scoped to loaded table rows', async () => {
  const f = await mount(); try {
    expect(f.view.filterInvoiceType(1, f.view.list.value[0])).toBe(true);
    expect(f.view.filterInvoiceType(2, f.view.list.value[0])).toBe(false);
    expect(f.view.filterInvoiceHeader(2, f.view.list.value[0])).toBe(true);
    expect(f.view.filterInvoiceHeader(1, f.view.list.value[0])).toBe(false);
    expect(f.calls).toHaveLength(1);
  } finally { f.close(); }
});
it('rejects impossible dates, mixed date granularity, duplicate rows and incomplete data', () => {
  const base = { page: 1, limit: 10, start_time: '', end_time: '', field: 'all', keyword: '', status: 'all' };
  expect(runtime.api.normalizeInvoiceQuery({ ...base, start_time: '2026-09-28 09:15', end_time: '2026-09-28 09:15' })).toMatchObject({ start_time: '2026-09-28 09:15' });
  for (const patch of [{ start_time: '2026-09-28', end_time: '' }, { start_time: '2026-02-30', end_time: '2026-03-01' },
    { start_time: '2026-09-28', end_time: '2026-09-29 10:00' }, { start_time: '2026-09-29 12:00', end_time: '2026-09-28 12:00' },
    { start_time: '2026-01-01', end_time: '2027-01-03' }, { field: 'password' }, { field: 'uid', keyword: 'not-a-number' },
    { limit: 100 }, { status: 3 }]) expect(() => runtime.api.normalizeInvoiceQuery({ ...base, ...patch })).toThrow();
  expect(() => runtime.api.parseInvoicePage({ list: [row(), row()], count: 2, page: 1, limit: 10 }, base)).toThrow('重复');
  expect(() => runtime.api.parseInvoicePage({ list: [row(31, { revision: '' })], count: 1, page: 1, limit: 10 }, base)).toThrow();
});
it('keeps diagnostic historical rows visible but prevents writes without can_process', async () => {
  const diagnostic = row(31, { order_number: null, invoice_amount: 'bad-old', is_invoice: 8, order: null,
    expected_amount: null, issues: ['关联订单不存在', '历史开票状态异常'], can_process: false });
  const f = await mount(grants, c => c.method === 'get' ? envelope(c.url === endpoint ? { list: [diagnostic], count: 1, page: 1, limit: 10 } : diagnostic) : undefined);
  try { expect(f.view.list.value[0].is_invoice).toBe(8); await f.view.openDetail(f.view.list.value[0]);
    expect(f.view.detail.value.issues).toHaveLength(2); expect(f.view.detail.value.can_process).toBe(false);
    await f.view.process(); expect(writes(f.calls)).toEqual([]); expect(runtime.messages.state.confirmations).toEqual([]);
  } finally { f.close(); }
});
it('isolates invoice permission from order and gives view-only roles detail access without writes', async () => {
  const denied = await mount(['order.view', 'order.manage']); try { expect(denied.calls).toEqual([]); await denied.view.load(); expect(denied.calls).toEqual([]); } finally { denied.close(); }
  const viewer = await mount(['invoice.view']); try { await viewer.view.openDetail(viewer.view.list.value[0]);
    expect(viewer.calls.at(-1).url).toBe(`${endpoint}/31`); expect(viewer.view.detail.value.name).toBe('测试公司');
    await viewer.view.process(); expect(writes(viewer.calls)).toEqual([]); expect(viewer.view.canManage.value).toBe(false);
  } finally { viewer.close(); }
  const manager = await mount(['invoice.manage']); try { expect(manager.view.canView.value).toBe(true); } finally { manager.close(); }
});
it('reads the invoice-bound order snapshot with invoice.view and rejects mismatched or malformed detail', async () => {
  const f = await mount(['invoice.view'], c => c.url === `${endpoint}/31/order-info` ? envelope(orderInfo()) : undefined);
  try {
    await f.view.openDetail(f.view.list.value[0]); await f.view.loadOrderInfo();
    expect(f.calls.at(-1)).toMatchObject({ method: 'get', url: `${endpoint}/31/order-info` });
    expect(f.view.orderInfo.value.order.user_address).toBe('上海市测试路');
    expect(f.view.orderInfo.value.cart_items[0].product_name).toBe('旧商品快照');
    expect(writes(f.calls)).toEqual([]);
    f.view.detailVisible.value = false; await flush(); expect(f.view.orderInfo.value).toBeNull();
  } finally { f.close(); }
  const wrong = await mount(['invoice.view'], c => c.url === `${endpoint}/31/order-info`
    ? envelope(orderInfo({ order: { ...orderInfo().order, uid: 8 } })) : undefined);
  try {
    await wrong.view.openDetail(wrong.view.list.value[0]); await wrong.view.loadOrderInfo();
    expect(wrong.view.orderInfo.value).toBeNull(); expect(wrong.view.orderInfoError.value).toContain('归属不一致');
  } finally { wrong.close(); }
  expect(() => runtime.api.parseInvoiceOrderInfo(orderInfo({ cart_items: [{ ...orderInfo().cart_items[0], unit_price: 12 }] }), 31)).toThrow('商品快照');
  expect(() => runtime.api.parseInvoiceOrderInfo(orderInfo({ invoice_id: 32 }), 31)).toThrow();
  expect(runtime.api.invoiceOrderPayTypeLabel('weixin')).toBe('微信支付');
});
it('discards an invoice order-info response after account switch', async () => {
  const delayed = deferred();
  const f = await mount(['invoice.view'], async c => c.url === `${endpoint}/31/order-info`
    ? (await delayed.promise, envelope(orderInfo())) : undefined);
  try {
    await f.view.openDetail(f.view.list.value[0]); const pending = f.view.loadOrderInfo();
    login(['invoice.view'], 'invoice-token-b', 21); browser.dispatchEvent(new Event('admin-session-changed'));
    delayed.resolve(); await pending; await flush();
    expect(f.view.orderInfo.value).toBeNull(); expect(writes(f.calls)).toEqual([]);
  } finally { f.close(); }
});
it('confirms and sends only status, number, remark, revision and one UUID; GET follows success', async () => {
  const f = await mount(); try { await f.view.openDetail(f.view.list.value[0]);
    f.view.formStatus.value = 1; f.view.formNumber.value = '12345678'; f.view.formRemark.value = '已核对'; await f.view.process();
    const submitted = writes(f.calls); expect(submitted).toHaveLength(1); expect(submitted[0]).toMatchObject({ method: 'post', url: `${endpoint}/31/process` });
    expect(JSON.parse(submitted[0].data)).toEqual({ is_invoice: 1, invoice_number: '12345678', remark: '已核对',
      revision, request_id: expect.stringMatching(uuid) });
    expect(runtime.messages.state.confirmations[0][0]).toContain('¥12.00 只读');
    expect(f.calls.at(-1).method).toBe('get'); expect(f.view.uncertainOperation.value).toBeNull();
  } finally { f.close(); }
});
it('guards malformed number, remark and missing version before confirmation or HTTP', async () => {
  const base = { is_invoice: 1, invoice_number: '12345678', remark: '', revision, request_id: crypto.randomUUID() };
  for (const patch of [{ invoice_number: 'abc' }, { invoice_number: '' }, { remark: 'bad\nline' }, { revision: '' },
    { request_id: '' }, { is_invoice: 0, invoice_number: '12345678' }, { invoice_amount: '999.99' }]) {
    if ('invoice_amount' in patch) {
      expect(runtime.api.normalizeInvoiceProcess({ ...base, ...patch })).not.toHaveProperty('invoice_amount');
    } else expect(() => runtime.api.normalizeInvoiceProcess({ ...base, ...patch })).toThrow();
  }
  const f = await mount(); try { await f.view.openDetail(f.view.list.value[0]); f.view.formStatus.value = 1; f.view.formNumber.value = 'bad';
    await f.view.process(); expect(writes(f.calls)).toEqual([]); expect(runtime.messages.state.confirmations).toEqual([]);
  } finally { f.close(); }
});
it('exports exactly the old eight columns from the current page and neutralizes formulas', () => {
  const data = runtime.api.currentInvoicePageCsv([row(31, { order_number: '=HYPERLINK("evil")', name: ' \t+SUM(1,2)',
    is_invoice: -1, order: { ...row().order, order_number: '=HYPERLINK("evil")', pay_price: '12.00' } })]);
  const lines = data.replace(/^\ufeff/u, '').trimEnd().split('\r\n');
  expect(lines).toHaveLength(2); expect(lines[0].split(',')).toHaveLength(8);
  expect(lines[0]).toContain('"订单号","订单金额","发票类型","发票抬头类型","发票抬头名称","下单时间","开票状态","订单状态"');
  expect(lines[1]).toContain("\"'=HYPERLINK(\"\"evil\"\")\"");
  expect(lines[1]).toContain("\"' \t+SUM(1,2)\"");
  expect(lines[1]).toContain('"已拒绝"');
});
it('downloads only the loaded page as an eight-column CSV without another API request', async () => {
  const f = await mount();
  const before = f.calls.length, link = { href: '', download: '', clicked: 0, click() { this.clicked++; }, remove() {} };
  let blob: Blob | undefined;
  const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (value: any) => { blob = value as Blob; return 'blob:invoice-page'; };
  URL.revokeObjectURL = () => {};
  vi.stubGlobal('document', { createElement: () => link, body: { appendChild() {} } });
  try { f.view.exportPage(); expect(link).toMatchObject({ href: 'blob:invoice-page', download: 'invoice-page-1.csv', clicked: 1 });
    expect(f.calls).toHaveLength(before); expect((await blob!.text()).replace(/^\ufeff/u, '').split('\r\n')[0].split(',')).toHaveLength(8);
  } finally { URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; f.close(); }
});
it('does not resend on ambiguous response; requires GET and explicit acknowledgement', async () => {
  let fail = true;
  const f = await mount(grants, c => { if (c.method === 'post' && fail) throw Error('connection reset'); });
  try { await f.view.openDetail(f.view.list.value[0]); f.view.formStatus.value = 1; f.view.formNumber.value = '12345678';
    await f.view.process(); expect(writes(f.calls)).toHaveLength(1); expect(f.view.uncertainOperation.value.body.request_id).toMatch(uuid);
    expect(f.calls.at(-1).method).toBe('get'); await f.view.openDetail(f.view.list.value[0]);
    await f.view.process(); expect(writes(f.calls)).toHaveLength(1);
    fail = false; await f.view.acknowledge(); expect(f.view.uncertainOperation.value).toBeNull();
  } finally { f.close(); }
});
it('does not write if confirmation is canceled or a session changes while it is open', async () => {
  const f = await mount(); try { await f.view.openDetail(f.view.list.value[0]); f.view.formStatus.value = 1; f.view.formNumber.value = '12345678';
    runtime.messages.state.confirm = () => Promise.reject('cancel'); await f.view.process(); expect(writes(f.calls)).toEqual([]);
    const decision = deferred(); runtime.messages.state.confirm = () => decision.promise; const operation = f.view.process();
    login(['invoice.view'], 'invoice-token-b', 21); browser.dispatchEvent(new Event('admin-session-changed'));
    decision.resolve(); await operation; await flush(); expect(writes(f.calls)).toEqual([]); expect(f.view.canManage.value).toBe(false);
  } finally { f.close(); }
});
it('treats a wrong receipt as uncertain and 409 as a definite rejection', async () => {
  const malformed = await mount(grants, c => c.method === 'post' ? envelope({ ...row(), committed: true, request_id: crypto.randomUUID(), idempotent: false }) : undefined);
  try { await malformed.view.openDetail(malformed.view.list.value[0]); malformed.view.formStatus.value = 1; malformed.view.formNumber.value = '12345678';
    await malformed.view.process(); expect(malformed.view.uncertainOperation.value).not.toBeNull();
  } finally { malformed.close(); }
  const rejected = await mount(grants, c => c.method === 'post' ? envelope(null, 409, '版本冲突') : undefined);
  try { await rejected.view.openDetail(rejected.view.list.value[0]); rejected.view.formStatus.value = 1; rejected.view.formNumber.value = '12345678';
    await rejected.view.process(); expect(rejected.view.uncertainOperation.value).toBeNull(); expect(rejected.view.notice.value).toContain('处理未完成');
  } finally { rejected.close(); }
});
it('accepts a matched archived replay receipt without fabricating a current invoice detail', async () => {
  const f = await mount(grants, c => {
    if (c.method !== 'post') return undefined;
    const body = JSON.parse(c.data);
    return envelope({ id: 31, order_db_id: 21, order_number: null, template_id: null,
      is_invoice: 1, revision: 'b'.repeat(64), committed: true, request_id: body.request_id,
      idempotent: true, archived: true, receipt_is_invoice: 1, superseded: false });
  });
  try { await f.view.openDetail(f.view.list.value[0]); f.view.formStatus.value = 1; f.view.formNumber.value = '12345678';
    await f.view.process(); expect(f.view.uncertainOperation.value).toBeNull();
    expect(f.view.notice.value).toContain('已归档'); expect(f.calls.at(-1).method).toBe('get');
  } finally { f.close(); }
});
it('treats an archived receipt for a different submitted state as uncertain', async () => {
  const f = await mount(grants, c => {
    if (c.method !== 'post') return undefined;
    const body = JSON.parse(c.data);
    return envelope({ id: 31, order_db_id: 21, order_number: null, template_id: null,
      is_invoice: -1, revision: 'b'.repeat(64), committed: true, request_id: body.request_id,
      idempotent: true, archived: true, receipt_is_invoice: -1, superseded: false });
  });
  try { await f.view.openDetail(f.view.list.value[0]); f.view.formStatus.value = 1; f.view.formNumber.value = '12345678';
    await f.view.process(); expect(f.view.uncertainOperation.value).not.toBeNull();
  } finally { f.close(); }
});
it('distinguishes original committed state from a later superseding invoice state', async () => {
  const f = await mount(grants, c => {
    if (c.method !== 'post') return undefined;
    const body = JSON.parse(c.data);
    return envelope({ ...row(31, { is_invoice: -1, invoice_number: '' }), committed: true, request_id: body.request_id,
      idempotent: true, receipt_is_invoice: 1, superseded: true });
  });
  try { await f.view.openDetail(f.view.list.value[0]); f.view.formStatus.value = 1; f.view.formNumber.value = '12345678';
    await f.view.process(); expect(f.view.uncertainOperation.value).toBeNull();
    expect(f.view.notice.value).toContain('原请求已提交'); expect(f.view.notice.value).toContain('已拒绝');
  } finally { f.close(); }
});
it('does not accept a superseded receipt for a different original state', async () => {
  const f = await mount(grants, c => {
    if (c.method !== 'post') return undefined;
    const body = JSON.parse(c.data);
    return envelope({ ...row(31, { is_invoice: -1 }), committed: true, request_id: body.request_id,
      idempotent: true, receipt_is_invoice: 0, superseded: true });
  });
  try { await f.view.openDetail(f.view.list.value[0]); f.view.formStatus.value = 1; f.view.formNumber.value = '12345678';
    await f.view.process(); expect(f.view.uncertainOperation.value).not.toBeNull();
  } finally { f.close(); }
});
