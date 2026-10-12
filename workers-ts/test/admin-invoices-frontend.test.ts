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
const redSnapshot = 'd'.repeat(64), redRecordHash = 'c'.repeat(64);
async function digest(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(n => n.toString(16).padStart(2, '0')).join('');
}
function redInput(overrides: Record<string, unknown> = {}) {
  return { request_id: crypto.randomUUID(), original_document_number: '12345678', original_snapshot_hash: redSnapshot,
    original_amount: '12.00', currency: 'CNY', red_document_number: '87654321', red_amount: '12.00',
    platform_evidence: '税务平台已整票红冲；本地录入仅用于人工核对', ...overrides };
}
async function redRecord(body = redInput(), overrides: Record<string, unknown> = {}) {
  return { id: body.request_id, record_hash: redRecordHash, actor_id: 20, created_time: 1790535600,
    original_document_number: body.original_document_number, original_snapshot_hash: body.original_snapshot_hash,
    original_amount: body.original_amount, currency: body.currency, red_document_number: body.red_document_number,
    red_amount: body.red_amount, platform_evidence: body.platform_evidence,
    platform_evidence_hash: await digest(String(body.platform_evidence)), state: 'RECORDED', review: null, ...overrides };
}
function redNotes(records: any[] = [], overrides: Record<string, unknown> = {}) {
  return { invoice_id: 31, source_order_id: 21, payment_order_id: 21, uid: 7, currency: 'CNY', ready: true, can_record: true, issues: [],
    issued: [{ document_number: '12345678', snapshot_hash: redSnapshot, original_amount: '12.00',
      manual_state: records.some(record => record.state === 'MANUAL_REVIEWED') ? 'MANUAL_REVIEWED' : 'UNCOVERED', records }], ...overrides };
}
async function redReceipt(operation: any, record?: any) {
  const body = operation.body;
  const value = record ?? await redRecord(body);
  const intent = operation.kind === 'record'
    ? ['invoice-manual-red-record-intent-v1', operation.id, 20, body.original_document_number, body.original_snapshot_hash,
      body.original_amount, body.currency, body.red_document_number, body.red_amount, body.platform_evidence]
    : ['invoice-manual-red-review-intent-v1', operation.id, operation.recordId, 20, body.record_hash, body.decision, body.manual_checked, body.review_note];
  return { version: 'invoice-manual-red-operation-v1', request_id: body.request_id, invoice_id: operation.id,
    actor_id: 20, kind: operation.kind, request_hash: await digest(JSON.stringify(intent)), committed: true, idempotent: false, record: value };
}
async function openRed(view: any) {
  await view.openDetail(view.list.value[0]); await view.loadManualRed();
  view.redNumber.value = '87654321'; view.redEvidence.value = '税务平台已整票红冲；本地录入仅用于人工核对';
}

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
it('searches the canonical guest UID without converting it into an unfiltered search', async () => {
  const f = await mount();
  try {
    f.view.draftField.value = 'uid'; f.view.draftKeyword.value = ' 0 ';
    f.view.search(); await flush();
    expect(f.calls.at(-1)).toMatchObject({ method: 'get', url: endpoint,
      params: { field: 'uid', keyword: '0', page: 1, limit: 10 } });
    expect(writes(f.calls)).toEqual([]);
    const base = { page: 1, limit: 10, start_time: '', end_time: '', field: 'uid', status: 'all' };
    expect(runtime.api.normalizeInvoiceQuery({ ...base, keyword: '2147483647' }).keyword).toBe('2147483647');
  } finally { f.close(); }
});
it.each(['00', '+0', '-0', '01', '-1', '1.0', '1e3', '2147483648', '99999999999'])(
  'rejects noncanonical or out-of-range buyer UID %s before a query', keyword => {
    expect(() => runtime.api.normalizeInvoiceQuery({ page: 1, limit: 10, start_time: '', end_time: '',
      field: 'uid', keyword, status: 'all' })).toThrow('查询条件');
  },
);
it('reads a guest invoice order as accountless while preserving the real order and cart snapshots', async () => {
  const guest = orderInfo({ order: { ...orderInfo().order, uid: 0 },
    user: { nickname: '', spread_name: '', is_guest: true } });
  const f = await mount(['invoice.view'], c => c.url === `${endpoint}/31/order-info` ? envelope(guest)
    : c.method === 'get' ? envelope(c.url === endpoint
      ? { list: [row(31, { uid: 0 })], count: 1, page: 1, limit: 10 } : row(31, { uid: 0 })) : undefined);
  try {
    await f.view.openDetail(f.view.list.value[0]); await f.view.loadOrderInfo();
    expect(f.view.orderInfo.value).toMatchObject({ invoice_id: 31,
      order: { uid: 0, real_name: '订单张三', user_address: '上海市测试路' },
      user: { nickname: '', spread_name: '', is_guest: true },
      cart_items: [{ product_name: '旧商品快照', quantity: 1 }] });
    expect(writes(f.calls)).toEqual([]);
    expect(readFileSync(resolve(root, 'src/pages/order/InvoiceManagement.vue'), 'utf8')).toContain('游客');
  } finally { f.close(); }
});
it.each([
  { nickname: '', spread_name: '' },
  { nickname: '', spread_name: '', is_guest: false },
  { nickname: '收货人不是账户', spread_name: '', is_guest: true },
  { nickname: '', spread_name: '伪推广关系', is_guest: true },
  { nickname: '', spread_name: '', is_guest: 'true' },
])('rejects a guest order carrying missing or fabricated account evidence %#', user => {
  expect(() => runtime.api.parseInvoiceOrderInfo(orderInfo({ order: { ...orderInfo().order, uid: 0 }, user }), 31)).toThrow();
});
it('keeps member account responses compatible and rejects the guest flag on a member', () => {
  expect(runtime.api.parseInvoiceOrderInfo(orderInfo(), 31).user).toEqual({ nickname: '昵称', spread_name: '推广人' });
  expect(runtime.api.parseInvoiceOrderInfo(orderInfo({ user: { ...orderInfo().user, is_guest: false } }), 31).user.is_guest).toBe(false);
  expect(() => runtime.api.parseInvoiceOrderInfo(orderInfo({ user: { ...orderInfo().user, is_guest: true } }), 31)).toThrow();
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
it('recovers an unknown process only after confirmation with the original complete body and UUID', async () => {
  let posts = 0;
  const f = await mount(grants, c => { if (c.method === 'post' && ++posts === 1) throw Error('response lost after commit'); });
  try {
    await f.view.openDetail(f.view.list.value[0]); f.view.formStatus.value = 1;
    f.view.formNumber.value = '12345678'; f.view.formRemark.value = '原始人工处理';
    await f.view.process();
    const saved = JSON.parse(JSON.stringify(f.view.uncertainOperation.value));
    expect(writes(f.calls)).toHaveLength(1);
    await f.view.load(); await f.view.openDetail(f.view.list.value[0]);
    f.view.formStatus.value = -1; f.view.formNumber.value = ''; f.view.formRemark.value = '不能替换待核对请求';
    await f.view.process(); expect(writes(f.calls)).toHaveLength(1);
    await f.view.recoverProcess();
    expect(writes(f.calls)).toHaveLength(2);
    expect(writes(f.calls)[1].url).toBe(`${endpoint}/${saved.id}/process`);
    expect(JSON.parse(writes(f.calls)[1].data)).toEqual(saved.body);
    expect(runtime.messages.state.confirmations.at(-1)[0]).toContain(saved.body.request_id);
    expect(f.view.uncertainOperation.value).toBeNull();
    expect(f.view.notice.value).toContain('原请求已提交');
  } finally { f.close(); }
});
it.each(['transport', 'rejected', 'wrong-uuid', 'contradicting-state', 'contradicting-number', 'contradicting-remark'])(
  'preserves an unknown original process when recovery is %s', async failure => {
    let posts = 0;
    const f = await mount(grants, c => {
      if (c.method !== 'post') return undefined;
      if (++posts === 1 || failure === 'transport') throw Error('ambiguous transport');
      if (failure === 'rejected') return envelope(null, 409, '原版本冲突');
      const body = JSON.parse(c.data);
      return envelope({ ...row(), is_invoice: body.is_invoice, invoice_number: body.invoice_number,
        remark: body.remark, committed: true, request_id: failure === 'wrong-uuid' ? crypto.randomUUID() : body.request_id,
        idempotent: true,
        ...(failure === 'contradicting-state' ? { is_invoice: -1, invoice_number: '' } : {}),
        ...(failure === 'contradicting-number' ? { invoice_number: '87654321' } : {}),
        ...(failure === 'contradicting-remark' ? { remark: '不是提交的备注' } : {}) });
    });
    try {
      await f.view.openDetail(f.view.list.value[0]); f.view.formStatus.value = 1;
      f.view.formNumber.value = '12345678'; f.view.formRemark.value = '原备注'; await f.view.process();
      const saved = JSON.parse(JSON.stringify(f.view.uncertainOperation.value));
      await f.view.recoverProcess();
      expect(writes(f.calls)).toHaveLength(2);
      expect(JSON.parse(writes(f.calls)[1].data)).toEqual(saved.body);
      expect(f.view.uncertainOperation.value).toEqual(saved);
      expect(f.view.notice.value).toContain('仍未确认');
      expect(runtime.messages.state.successes).toEqual([]);
    } finally { f.close(); }
  },
);
it('does not send an original process recovery after cancellation or permission changes during confirmation', async () => {
  const f = await mount(grants, c => { if (c.method === 'post') throw Error('unknown original'); });
  try {
    await f.view.openDetail(f.view.list.value[0]); f.view.formStatus.value = 1;
    f.view.formNumber.value = '12345678'; await f.view.process();
    const saved = JSON.parse(JSON.stringify(f.view.uncertainOperation.value));
    runtime.messages.state.confirm = () => Promise.reject('cancel'); await f.view.recoverProcess();
    expect(f.view.uncertainOperation.value).toEqual(saved); expect(writes(f.calls)).toHaveLength(1);
    const decision = deferred(); runtime.messages.state.confirm = () => decision.promise;
    const recovery = f.view.recoverProcess();
    login(['invoice.view'], 'invoice-token-a', 20); browser.dispatchEvent(new Event('admin-session-changed'));
    decision.resolve(); await recovery; await flush();
    expect(writes(f.calls)).toHaveLength(1); expect(f.view.canManage.value).toBe(false);
    expect(f.view.uncertainOperation.value).toBeNull();
  } finally { f.close(); }
});
it('discards a late original process recovery after the Admin account changes', async () => {
  let posts = 0; const response = deferred();
  const f = await mount(grants, async c => {
    if (c.method !== 'post') return undefined;
    if (++posts === 1) throw Error('unknown original');
    await response.promise;
    const body = JSON.parse(c.data);
    return envelope({ ...row(), is_invoice: body.is_invoice, invoice_number: body.invoice_number,
      remark: body.remark, committed: true, request_id: body.request_id, idempotent: true });
  });
  try {
    await f.view.openDetail(f.view.list.value[0]); f.view.formStatus.value = 1;
    f.view.formNumber.value = '12345678'; await f.view.process();
    const recovery = f.view.recoverProcess(); await flush(); expect(writes(f.calls)).toHaveLength(2);
    login([], 'invoice-token-b', 21); browser.dispatchEvent(new Event('admin-session-changed'));
    response.resolve(); await recovery; await flush();
    expect(f.view.list.value).toEqual([]); expect(f.view.detail.value).toBeNull();
    expect(f.view.uncertainOperation.value).toBeNull(); expect(f.view.notice.value).toBe('');
    expect(runtime.messages.state.successes).toEqual([]);
  } finally { f.close(); }
});
it('recovers the original process after the invoice has been archived without recreating a live row', async () => {
  let posts = 0;
  const f = await mount(grants, c => {
    if (c.method !== 'post') return undefined;
    if (++posts === 1) throw Error('response lost');
    const body = JSON.parse(c.data);
    return envelope({ id: 31, order_db_id: 21, order_number: null, template_id: null,
      is_invoice: 1, revision: 'b'.repeat(64), committed: true, request_id: body.request_id,
      idempotent: true, archived: true, receipt_is_invoice: 1, superseded: false });
  });
  try {
    await f.view.openDetail(f.view.list.value[0]); f.view.formStatus.value = 1;
    f.view.formNumber.value = '12345678'; await f.view.process(); await f.view.recoverProcess();
    expect(writes(f.calls)).toHaveLength(2);
    expect(JSON.parse(writes(f.calls)[1].data)).toEqual(JSON.parse(writes(f.calls)[0].data));
    expect(f.view.uncertainOperation.value).toBeNull(); expect(f.view.notice.value).toContain('已归档');
    expect(f.view.detail.value).toBeNull();
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
it('requires whole-ticket equality, canonical identity and bounded UTF8 manual evidence before submission', () => {
  expect(runtime.api.normalizeInvoiceManualRedRecord(redInput())).toMatchObject({ original_amount: '12.00', red_amount: '12.00', currency: 'CNY' });
  for (const patch of [{ red_amount: '1.00' }, { original_amount: '01.00', red_amount: '01.00' }, { red_amount: '-12.00' },
    { currency: 'USD' }, { red_document_number: '12345678' }, { original_snapshot_hash: '' }, { request_id: '' },
    { platform_evidence: '' }, { platform_evidence: '证'.repeat(1366) }, { platform_evidence: 'bad\u0000evidence' }]) {
    expect(() => runtime.api.normalizeInvoiceManualRedRecord(redInput(patch))).toThrow();
  }
  for (const patch of [{ manual_checked: false }, { decision: 'verified' }, { record_hash: '' },
    { review_note: '' }, { review_note: '核'.repeat(342) }]) {
    expect(() => runtime.api.normalizeInvoiceManualRedReview({ request_id: crypto.randomUUID(), record_hash: redRecordHash,
      decision: 'confirm', manual_checked: true, review_note: '逐项核对', ...patch })).toThrow();
  }
});
it('preserves the exact legacy original identifier while keeping explicit red-number and original bounds', async () => {
  const document = '  LEGACY-2020/原票-A  ', body = redInput({ original_document_number: document });
  expect(runtime.api.normalizeInvoiceManualRedRecord(body).original_document_number).toBe(document);
  const stored = await redRecord(body), notes = redNotes([stored], { issued: [{ document_number: document, snapshot_hash: redSnapshot,
    original_amount: '12.00', manual_state: 'UNCOVERED', records: [stored] }] });
  expect(runtime.api.parseInvoiceManualRedNotes(notes, 31).issued[0].document_number).toBe(document);
  expect(runtime.api.parseInvoiceManualRedRecord(stored).original_document_number).toBe(document);
  await expect(runtime.api.verifyInvoiceManualRedReceipt(await redReceipt({ id: 31, kind: 'record', body }, stored),
    { id: 31, kind: 'record', body }, 20)).resolves.toBeUndefined();
  expect(runtime.api.normalizeInvoiceManualRedRecord(redInput({ original_document_number: '旧'.repeat(50) })).original_document_number).toBe('旧'.repeat(50));
  for (const value of ['', '   ', '旧'.repeat(51), 'LEGACY\u0000A', 'LEGACY\nA']) {
    expect(() => runtime.api.normalizeInvoiceManualRedRecord(redInput({ original_document_number: value }))).toThrow();
  }
  expect(() => runtime.api.normalizeInvoiceManualRedRecord(redInput({ red_document_number: document }))).toThrow();
});
it('rejects completed labels without a matching manual review and mismatched original coverage', async () => {
  const recorded = await redRecord();
  expect(runtime.api.parseInvoiceManualRedNotes(redNotes([recorded]), 31).issued[0].manual_state).toBe('UNCOVERED');
  expect(() => runtime.api.parseInvoiceManualRedRecord({ ...recorded, state: 'MANUAL_REVIEWED' })).toThrow('核对记录');
  expect(() => runtime.api.parseInvoiceManualRedNotes(redNotes([{ ...recorded, original_snapshot_hash: 'e'.repeat(64) }]), 31)).toThrow('不一致');
  expect(() => runtime.api.parseInvoiceManualRedNotes(redNotes([recorded, recorded]), 31)).toThrow();
  expect(() => runtime.api.parseInvoiceManualRedNotes(redNotes([], { ready: false, can_record: true }), 31)).toThrow();
});
it('records an externally completed whole-ticket red note without automatically performing manual review', async () => {
  let stored: any;
  const f = await mount(grants, async c => {
    if (c.url === `${endpoint}/31/red-notes`) {
      if (c.method === 'get') return envelope(redNotes(stored ? [stored] : []));
      const body = JSON.parse(c.data); stored = await redRecord(body);
      return envelope(await redReceipt({ id: 31, kind: 'record', body }, stored));
    }
    return undefined;
  });
  try {
    await openRed(f.view); await f.view.recordManualRed(); expect(writes(f.calls)).toEqual([]);
    f.view.redTaxDone.value = true; await f.view.recordManualRed();
    expect(writes(f.calls)).toHaveLength(1);
    expect(writes(f.calls)[0].url).toBe(`${endpoint}/31/red-notes`);
    expect(JSON.parse(writes(f.calls)[0].data)).toEqual({ request_id: expect.stringMatching(uuid), original_document_number: '12345678',
      original_snapshot_hash: redSnapshot, original_amount: '12.00', currency: 'CNY', red_document_number: '87654321', red_amount: '12.00',
      platform_evidence: '税务平台已整票红冲；本地录入仅用于人工核对' });
    expect(f.view.redNotes.value.issued[0]).toMatchObject({ manual_state: 'UNCOVERED', records: [{ state: 'RECORDED', review: null }] });
    expect(f.view.notice.value).toContain('仍须');
    expect(f.calls.filter(c => c.url.endsWith('/review'))).toEqual([]);
    expect(runtime.messages.state.confirmations[0][0]).toContain('本操作不在税务平台办税');
  } finally { f.close(); }
});
it.each(['confirm', 'reject'])('requires explicit human verification and preserves the distinct %s outcome', async decision => {
  let stored: any = await redRecord();
  const f = await mount(grants, async c => {
    if (c.url === `${endpoint}/31/red-notes`) return envelope(redNotes([stored]));
    if (c.url.endsWith('/review')) {
      const body = JSON.parse(c.data); stored = { ...stored, state: decision === 'confirm' ? 'MANUAL_REVIEWED' : 'REJECTED', review: {
        id: body.request_id, review_hash: 'e'.repeat(64), actor_id: 20, created_time: 1790535601,
        decision: body.decision, manual_checked: true, review_note: body.review_note } };
      return envelope(await redReceipt({ id: 31, kind: 'review', recordId: stored.id, body }, stored));
    }
    return undefined;
  });
  try {
    await openRed(f.view); const original = f.view.redNotes.value.issued[0].records[0];
    await f.view.reviewManualRed(original, decision); expect(writes(f.calls)).toEqual([]);
    f.view.redReviewed.value[original.id] = true; await f.view.reviewManualRed(original, decision); expect(writes(f.calls)).toEqual([]);
    f.view.redReviewNotes.value[original.id] = '原票、红票与整票金额已逐项人工核对'; await f.view.reviewManualRed(original, decision);
    expect(writes(f.calls)).toHaveLength(1);
    expect(JSON.parse(writes(f.calls)[0].data)).toEqual({ request_id: expect.stringMatching(uuid), record_hash: redRecordHash,
      decision, manual_checked: true, review_note: '原票、红票与整票金额已逐项人工核对' });
    expect(f.view.redNotes.value.issued[0].records[0].state).toBe(decision === 'confirm' ? 'MANUAL_REVIEWED' : 'REJECTED');
    expect(f.view.notice.value).toContain(decision === 'confirm' ? '仍由服务端' : '仍不放行退款');
  } finally { f.close(); }
});
it('keeps manual records available to invoice.view while blocking all record/review writes', async () => {
  const stored = await redRecord();
  const f = await mount(['invoice.view'], c => c.url === `${endpoint}/31/red-notes` ? envelope(redNotes([stored])) : undefined);
  try {
    await openRed(f.view); f.view.redTaxDone.value = true;
    f.view.redReviewed.value[stored.id] = true; f.view.redReviewNotes.value[stored.id] = '仅查看';
    await f.view.recordManualRed(); await f.view.reviewManualRed(stored, 'confirm');
    expect(f.view.redNotes.value.issued[0].records[0].platform_evidence).toBe(stored.platform_evidence);
    expect(writes(f.calls)).toEqual([]);
  } finally { f.close(); }
});
it.each([400, 403, 404, 409, 422])('keeps the manual form and definite %i error without clearing it through a refresh', async status => {
  const f = await mount(grants, c => c.url === `${endpoint}/31/red-notes`
    ? c.method === 'get' ? envelope(redNotes()) : envelope(null, status, '明确拒绝原人工操作') : undefined);
  try {
    await openRed(f.view); f.view.redTaxDone.value = true;
    const before = f.calls.length; await f.view.recordManualRed();
    expect(f.calls.slice(before)).toHaveLength(1); expect(f.view.uncertainRedOperation.value).toBeNull();
    expect(f.view.redError.value).toContain('操作未完成'); expect(f.view.redNumber.value).toBe('87654321');
    expect(f.view.redEvidence.value).toContain('税务平台'); expect(f.view.redTaxDone.value).toBe(true);
  } finally { f.close(); }
});
it('keeps the original manual record UNKNOWN until a read-only original-UUID receipt is found and checked', async () => {
  let original: any, missing = true;
  const f = await mount(grants, async c => {
    if (c.url === `${endpoint}/31/red-notes`) {
      if (c.method === 'get') return envelope(redNotes());
      original = { id: 31, kind: 'record', body: JSON.parse(c.data) }; throw Error('record reply lost after commit');
    }
    if (c.url.includes('/red-notes/operations/')) return envelope(missing ? null : await redReceipt(original));
    return undefined;
  });
  try {
    await openRed(f.view); f.view.redTaxDone.value = true; await f.view.recordManualRed();
    const saved = JSON.parse(JSON.stringify(f.view.uncertainRedOperation.value));
    expect(saved).toEqual(original); expect(f.view.hasUncertainOperation.value).toBe(true);
    await f.view.process(); await f.view.recordManualRed(); expect(writes(f.calls)).toHaveLength(1);
    await f.view.recoverManualRed(); expect(f.view.uncertainRedOperation.value).toEqual(saved);
    expect(f.calls.at(-1)).toMatchObject({ method: 'get', url: `${endpoint}/31/red-notes/operations/${saved.body.request_id}` });
    missing = false; await f.view.recoverManualRed();
    expect(f.view.uncertainRedOperation.value).toBeNull(); expect(writes(f.calls)).toHaveLength(1);
    expect(f.view.notice.value).toContain('是否完成人工核对');
  } finally { f.close(); }
});
it('offers original-UUID recovery inside the modal and preserves UNKNOWN after the modal closes', async () => {
  const template = readFileSync(resolve(root, 'src/pages/order/InvoiceManagement.vue'), 'utf8');
  const footer = template.match(/<template #footer>([\s\S]*?)<\/template>/)?.[1];
  expect(footer).toMatch(/<el-button\s+v-if="uncertainRedOperation"[^>]*@click="recoverManualRed"[^>]*>读取原人工红字回执<\/el-button>/);
  let original: any, missing = true;
  const f = await mount(grants, async c => {
    if (c.url === `${endpoint}/31/red-notes`) {
      if (c.method === 'get') return envelope(redNotes());
      original = { id: 31, kind: 'record', body: JSON.parse(c.data) }; throw Error('actual submission response unknown');
    }
    if (c.url.includes('/red-notes/operations/')) return envelope(missing ? null : await redReceipt(original));
    return undefined;
  });
  try {
    await openRed(f.view); f.view.redTaxDone.value = true; await f.view.recordManualRed();
    const saved = JSON.parse(JSON.stringify(f.view.uncertainRedOperation.value));
    expect(f.view.detailVisible.value).toBe(true); expect(saved).toEqual(original);
    f.view.detailVisible.value = false; f.view.closeDetail(); await flush();
    expect(f.view.uncertainRedOperation.value).toEqual(saved); expect(f.view.hasUncertainOperation.value).toBe(true);
    expect(f.view.detail.value).toBeNull(); expect(f.view.redNotes.value).toBeNull();
    await f.view.recoverManualRed();
    expect(f.view.uncertainRedOperation.value).toEqual(saved);
    expect(f.calls.at(-1)).toMatchObject({ method: 'get', url: `${endpoint}/31/red-notes/operations/${saved.body.request_id}` });
    expect(writes(f.calls)).toHaveLength(1);
    missing = false; await f.view.recoverManualRed();
    expect(f.view.uncertainRedOperation.value).toBeNull(); expect(f.view.detailVisible.value).toBe(false);
    expect(writes(f.calls)).toHaveLength(1);
  } finally { f.close(); }
});
it.each(['actor', 'kind', 'intent-hash', 'platform-hash', 'original-snapshot', 'red-amount', 'record-uuid'])(
  'preserves manual record UNKNOWN after a matched original UUID carries contradictory %s evidence', async field => {
    let original: any;
    const f = await mount(grants, async c => {
      if (c.url === `${endpoint}/31/red-notes`) {
        if (c.method === 'get') return envelope(redNotes());
        original = { id: 31, kind: 'record', body: JSON.parse(c.data) }; throw Error('response lost');
      }
      if (c.url.includes('/red-notes/operations/')) {
        const receipt = await redReceipt(original);
        if (field === 'actor') receipt.actor_id = 21;
        if (field === 'kind') receipt.kind = 'review';
        if (field === 'intent-hash') receipt.request_hash = 'f'.repeat(64);
        if (field === 'platform-hash') receipt.record.platform_evidence_hash = 'f'.repeat(64);
        if (field === 'original-snapshot') receipt.record.original_snapshot_hash = 'f'.repeat(64);
        if (field === 'red-amount') receipt.record.red_amount = '1.00';
        if (field === 'record-uuid') receipt.record.id = crypto.randomUUID();
        return envelope(receipt);
      }
      return undefined;
    });
    try {
      await openRed(f.view); f.view.redTaxDone.value = true; await f.view.recordManualRed();
      const saved = JSON.parse(JSON.stringify(f.view.uncertainRedOperation.value)); await f.view.recoverManualRed();
      expect(f.view.uncertainRedOperation.value).toEqual(saved); expect(writes(f.calls)).toHaveLength(1);
      expect(f.view.notice.value).toContain('仍未确认'); expect(runtime.messages.state.successes).toEqual([]);
    } finally { f.close(); }
  },
);
it('preserves manual-review UNKNOWN for another review UUID and clears it only for the original checked intent', async () => {
  const recorded = await redRecord(); let original: any, wrong = true;
  const f = await mount(grants, async c => {
    if (c.url === `${endpoint}/31/red-notes`) return envelope(redNotes([recorded]));
    if (c.url.endsWith('/review')) { original = { id: 31, kind: 'review', recordId: recorded.id, body: JSON.parse(c.data) }; throw Error('review response lost'); }
    if (c.url.includes('/red-notes/operations/')) {
      const review = { id: wrong ? crypto.randomUUID() : original.body.request_id, review_hash: 'e'.repeat(64), actor_id: 20,
        created_time: 1790535601, decision: original.body.decision, manual_checked: true, review_note: original.body.review_note };
      return envelope(await redReceipt(original, { ...recorded, state: 'MANUAL_REVIEWED', review }));
    }
    return undefined;
  });
  try {
    await openRed(f.view); f.view.redReviewed.value[recorded.id] = true; f.view.redReviewNotes.value[recorded.id] = '逐项核对整票';
    await f.view.reviewManualRed(recorded, 'confirm'); const saved = JSON.parse(JSON.stringify(f.view.uncertainRedOperation.value));
    await f.view.recoverManualRed(); expect(f.view.uncertainRedOperation.value).toEqual(saved); expect(writes(f.calls)).toHaveLength(1);
    wrong = false; await f.view.recoverManualRed(); expect(f.view.uncertainRedOperation.value).toBeNull();
    expect(writes(f.calls)).toHaveLength(1); expect(f.view.notice.value).toContain('原人工核对请求已提交');
  } finally { f.close(); }
});
it('does not submit a manual record after its form or account changes during confirmation', async () => {
  const f = await mount(grants, c => c.url === `${endpoint}/31/red-notes` ? envelope(redNotes()) : undefined);
  try {
    await openRed(f.view); f.view.redTaxDone.value = true;
    const changed = deferred(); runtime.messages.state.confirm = () => changed.promise;
    const operation = f.view.recordManualRed(); f.view.redNumber.value = '99999999'; changed.resolve(); await operation;
    expect(writes(f.calls)).toEqual([]);
    const switched = deferred(); runtime.messages.state.confirm = () => switched.promise;
    const stale = f.view.recordManualRed(); login([], 'invoice-token-b', 21); browser.dispatchEvent(new Event('admin-session-changed'));
    switched.resolve(); await stale; await flush();
    expect(writes(f.calls)).toEqual([]); expect(f.view.redNotes.value).toBeNull(); expect(f.view.uncertainRedOperation.value).toBeNull();
  } finally { f.close(); }
});
it('discards a late original manual-record recovery after account replacement without exposing its private evidence', async () => {
  const response = deferred(); let original: any;
  const f = await mount(grants, async c => {
    if (c.url === `${endpoint}/31/red-notes`) {
      if (c.method === 'get') return envelope(redNotes());
      original = { id: 31, kind: 'record', body: JSON.parse(c.data) }; throw Error('unknown record');
    }
    if (c.url.includes('/red-notes/operations/')) { await response.promise; return envelope(await redReceipt(original)); }
    return undefined;
  });
  try {
    await openRed(f.view); f.view.redTaxDone.value = true; await f.view.recordManualRed();
    const recovered = f.view.recoverManualRed(); await flush();
    login([], 'invoice-token-b', 21); browser.dispatchEvent(new Event('admin-session-changed'));
    response.resolve(); await recovered; await flush();
    expect(f.view.redNotes.value).toBeNull(); expect(f.view.redEvidence.value).toBe('');
    expect(f.view.uncertainRedOperation.value).toBeNull(); expect(f.view.notice.value).toBe('');
    expect(runtime.messages.state.successes).toEqual([]); expect(writes(f.calls)).toHaveLength(1);
  } finally { f.close(); }
});
