import request, { getData } from '@/utils/request';

export type InvoiceStatus = -1 | 0 | 1;
export type InvoiceStatusFilter = 'all' | 'pending' | 'refunded' | InvoiceStatus;
export type InvoiceSearchField = 'all' | 'order_number' | 'uid' | 'real_name' | 'user_phone' | 'invoice_name' | 'drawer_phone';
export interface InvoiceQuery {
  page: number;
  limit: 10;
  start_time: string;
  end_time: string;
  field: InvoiceSearchField;
  keyword: string;
  status: InvoiceStatusFilter;
}
export interface InvoiceOrder {
  id: number;
  order_number: string;
  pay_price: string;
  paid: number;
  refund_status: number;
  status: number;
  pid: number;
  add_time: number;
  real_name: string;
  user_phone: string;
}
export interface AdminInvoice {
  id: number;
  order_db_id: number;
  order_number: string | null;
  template_id: number;
  uid: number;
  is_invoice: number;
  invoice_number: string;
  invoice_amount: string;
  expected_amount: string | null;
  remark: string;
  invoice_time: number;
  is_pay: number;
  is_refund: number;
  is_del: number;
  add_time: number;
  header_type: number;
  type: number;
  name: string;
  duty_number: string;
  drawer_phone: string;
  email: string;
  tell: string;
  address: string;
  bank: string;
  card_number: string;
  order: InvoiceOrder | null;
  revision: string;
  issues: string[];
  can_process: boolean;
}
export interface InvoicePage { list: AdminInvoice[]; count: number; page: number; limit: 10 }
export interface InvoiceOrderInfo {
  invoice_id: number;
  order: {
    id: number; order_number: string; uid: number; pid: number; status: number; refund_status: number;
    total_num: number; total_price: string; pay_postage: string; coupon_price: string;
    vip_true_price: string | null; deduction_price: string; pay_price: string;
    add_time: number; pay_type: string; mark: string; real_name: string; user_phone: string; user_address: string;
  };
  user: { nickname: string; spread_name: string; is_guest?: boolean };
  cart_items: Array<{
    id: number; product_id: number | null; product_name: string; category_name: string | null;
    sku: string; unit_price: string | null; quantity: number; image: string;
  }>;
}
export interface InvoiceProcessInput {
  is_invoice: InvoiceStatus;
  invoice_number: string;
  remark: string;
  revision: string;
  request_id: string;
}
export type InvoiceProcessReceipt = (AdminInvoice & { committed: true; request_id: string; idempotent: boolean; archived?: false;
    receipt_is_invoice?: InvoiceStatus; superseded?: boolean }) |
  { id: number; order_db_id: number; order_number: null; template_id: null; is_invoice: InvoiceStatus; revision: string;
    committed: true; request_id: string; idempotent: true; archived: true; receipt_is_invoice: InvoiceStatus; superseded: false };

export interface InvoiceManualRedRecordInput {
  request_id: string; original_document_number: string; original_snapshot_hash: string; original_amount: string; currency: 'CNY';
  red_document_number: string; red_amount: string; platform_evidence: string;
}
export interface InvoiceManualRedReviewInput {
  request_id: string; record_hash: string; decision: 'confirm' | 'reject'; manual_checked: true; review_note: string;
}
export interface InvoiceManualRedRecord {
  id: string; record_hash: string; actor_id: number; created_time: number;
  original_document_number: string; original_snapshot_hash: string; original_amount: string; currency: 'CNY';
  red_document_number: string; red_amount: string; platform_evidence: string; platform_evidence_hash: string;
  state: 'RECORDED' | 'MANUAL_REVIEWED' | 'REJECTED';
  review: null | { id: string; review_hash: string; actor_id: number; created_time: number;
    decision: 'confirm' | 'reject'; manual_checked: true; review_note: string };
}
export interface InvoiceManualRedNotes {
  invoice_id: number; source_order_id: number; payment_order_id: number; uid: number; currency: 'CNY';
  ready: boolean; can_record: boolean; issues: string[];
  issued: Array<{ document_number: string; snapshot_hash: string; original_amount: string;
    manual_state: 'UNCOVERED' | 'MANUAL_REVIEWED'; records: InvoiceManualRedRecord[] }>;
}
export interface InvoiceManualRedReceipt {
  version: 'invoice-manual-red-operation-v1'; request_id: string; invoice_id: number; actor_id: number;
  kind: 'record' | 'review'; request_hash: string; committed: true; idempotent: boolean; record: InvoiceManualRedRecord;
}
export type InvoiceManualRedOperation = { id: number; kind: 'record'; body: InvoiceManualRedRecordInput } |
  { id: number; kind: 'review'; recordId: string; body: InvoiceManualRedReviewInput };

const revisionPattern = /^[a-f0-9]{64}$/u;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/u;
const minutePattern = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/u;
const fields: readonly InvoiceSearchField[] = ['all', 'order_number', 'uid', 'real_name', 'user_phone', 'invoice_name', 'drawer_phone'];
const statuses: readonly InvoiceStatus[] = [-1, 0, 1];
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const signedInteger = (value: unknown): value is number => Number.isSafeInteger(value);
const string = (value: unknown): value is string => typeof value === 'string';
const buyerUid = (value: string): boolean => /^(?:0|[1-9]\d{0,9})$/u.test(value) && Number(value) <= 2_147_483_647;

function date(value: string): boolean {
  const match = datePattern.exec(value);
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const actual = new Date(Date.UTC(year, month - 1, day));
  return actual.getUTCFullYear() === year && actual.getUTCMonth() + 1 === month && actual.getUTCDate() === day;
}
function minute(value: string): boolean {
  const match = minutePattern.exec(value);
  return !!match && date(value.slice(0, 10)) && Number(match[4]) <= 23 && Number(match[5]) <= 59;
}
function localSeconds(value: string): number {
  const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
  const hour = value.length === 16 ? Number(value.slice(11, 13)) : 0;
  const minuteValue = value.length === 16 ? Number(value.slice(14, 16)) : 0;
  return Date.UTC(year, month - 1, day, hour, minuteValue) / 1000;
}

export function normalizeInvoiceQuery(value: InvoiceQuery): InvoiceQuery {
  if (!Number.isSafeInteger(value.page) || value.page < 1 || value.page > 1000 || value.limit !== 10 ||
    !fields.includes(value.field) || !['all', 'pending', 'refunded', ...statuses].includes(value.status) ||
    typeof value.keyword !== 'string' || Array.from(value.keyword.trim()).length > 100 ||
    /[\u0000-\u001f\u007f]/u.test(value.keyword) ||
    (value.field === 'uid' && value.keyword.trim() !== '' && !buyerUid(value.keyword.trim())) ||
    (value.start_time !== '' && !date(value.start_time) && !minute(value.start_time)) ||
    (value.end_time !== '' && !date(value.end_time) && !minute(value.end_time)) ||
    (!!value.start_time !== !!value.end_time) ||
    (value.start_time !== '' && (value.start_time.length !== value.end_time.length ||
      value.start_time > value.end_time ||
      localSeconds(value.end_time) + (value.start_time.length === 10 ? 86_400 : 60) - localSeconds(value.start_time) > 366 * 86_400))) {
    throw new Error('发票查询条件无效');
  }
  return { ...value, keyword: value.keyword.trim() };
}

export function parseInvoice(value: unknown): AdminInvoice {
  if (!object(value) || !integer(value.id) || value.id === 0 || !signedInteger(value.order_db_id) ||
    !signedInteger(value.template_id) || !signedInteger(value.uid) || !signedInteger(value.is_invoice) ||
    !(value.order_number === null || string(value.order_number)) || !string(value.invoice_number) || !string(value.invoice_amount) ||
    !(value.expected_amount === null || string(value.expected_amount)) ||
    !string(value.remark) || !signedInteger(value.invoice_time) || !signedInteger(value.add_time) ||
    !signedInteger(value.header_type) || !signedInteger(value.type) || !signedInteger(value.is_pay) || !signedInteger(value.is_refund) || !signedInteger(value.is_del) ||
    !['name', 'duty_number', 'drawer_phone', 'email', 'tell', 'address', 'bank', 'card_number'].every(key => string(value[key])) ||
    !string(value.revision) || !revisionPattern.test(value.revision) ||
    !Array.isArray(value.issues) || !value.issues.every(string) || typeof value.can_process !== 'boolean') {
    throw new Error('发票记录响应格式错误');
  }
  if (value.order !== null) {
    const order = value.order;
    if (!object(order) || !signedInteger(order.id) || !string(order.order_number) || !string(order.pay_price) ||
      !signedInteger(order.paid) || !signedInteger(order.refund_status) || !signedInteger(order.status) || !signedInteger(order.pid) || !signedInteger(order.add_time) ||
      !string(order.real_name) || !string(order.user_phone)) {
      throw new Error('发票关联订单响应格式错误');
    }
  }
  return value as unknown as AdminInvoice;
}

export function parseInvoicePage(value: unknown, query: InvoiceQuery): InvoicePage {
  if (!object(value) || !Array.isArray(value.list) || !integer(value.count) || value.page !== query.page || value.limit !== query.limit ||
    value.list.length > query.limit || value.list.length > value.count) throw new Error('发票分页响应格式错误');
  const list = value.list.map(parseInvoice), ids = new Set(list.map(row => row.id));
  if (ids.size !== list.length) throw new Error('发票分页记录重复');
  return { list, count: value.count, page: query.page, limit: 10 };
}

export function parseInvoiceOrderInfo(value: unknown, invoiceId: number): InvoiceOrderInfo {
  if (!object(value) || value.invoice_id !== invoiceId || !object(value.order) || !object(value.user) ||
    !Array.isArray(value.cart_items) || value.cart_items.length > 200) throw new Error('发票订单信息响应格式错误');
  const order = value.order, user = value.user;
  if (!integer(order.id) || order.id === 0 || !string(order.order_number) || !integer(order.uid) ||
    !signedInteger(order.pid) || !signedInteger(order.status) || !signedInteger(order.refund_status) ||
    !integer(order.total_num) || !signedInteger(order.add_time) ||
    !['total_price', 'pay_postage', 'coupon_price', 'deduction_price', 'pay_price', 'pay_type', 'mark',
      'real_name', 'user_phone', 'user_address'].every(key => string(order[key])) ||
    !(order.vip_true_price === null || string(order.vip_true_price)) ||
    !string(user.nickname) || !string(user.spread_name) ||
    (user.is_guest !== undefined && typeof user.is_guest !== 'boolean') ||
    (order.uid === 0 && (user.is_guest !== true || user.nickname !== '' || user.spread_name !== '')) ||
    (order.uid > 0 && user.is_guest === true)) throw new Error('发票关联订单响应格式错误');
  const ids = new Set<number>();
  for (const item of value.cart_items) {
    if (!object(item) || !integer(item.id) || item.id === 0 || ids.has(item.id) ||
      !(item.product_id === null || integer(item.product_id)) || !string(item.product_name) ||
      !(item.category_name === null || string(item.category_name)) || !string(item.sku) ||
      !(item.unit_price === null || string(item.unit_price)) || !integer(item.quantity) || !string(item.image))
      throw new Error('发票订单商品快照响应格式错误');
    ids.add(item.id);
  }
  return value as unknown as InvoiceOrderInfo;
}

export function normalizeInvoiceProcess(value: InvoiceProcessInput): InvoiceProcessInput {
  if (!statuses.includes(value.is_invoice) || !revisionPattern.test(value.revision) || !uuidPattern.test(value.request_id))
    throw new Error('发票处理状态或版本无效，请重新读取详情');
  const invoice_number = value.invoice_number.trim(), remark = value.remark.trim();
  if (Array.from(invoice_number).length > 50 || Array.from(remark).length > 255 || /[\u0000-\u001f\u007f]/u.test(invoice_number) || /[\u0000-\u001f\u007f]/u.test(remark))
    throw new Error('发票号或备注长度、字符无效');
  if (value.is_invoice === 1 && !invoice_number) throw new Error('标记已开票时必须填写发票号');
  if (value.is_invoice === 1 && !/^\d{8,20}$/u.test(invoice_number)) throw new Error('发票号须为 8–20 位数字');
  if (value.is_invoice !== 1 && invoice_number) throw new Error('未开票或已拒绝时不能填写发票号');
  return { is_invoice: value.is_invoice, invoice_number, remark, revision: value.revision, request_id: value.request_id };
}

export async function apiInvoiceList(input: InvoiceQuery, signal?: AbortSignal): Promise<InvoicePage> {
  const query = normalizeInvoiceQuery(input);
  return parseInvoicePage(await getData<unknown>(request.get('/order/invoices', { params: query, signal })), query);
}
export async function apiInvoiceDetail(id: number, signal?: AbortSignal): Promise<AdminInvoice> {
  if (!integer(id) || id === 0) throw new Error('发票 ID 无效');
  const row = parseInvoice(await getData<unknown>(request.get(`/order/invoices/${id}`, { signal })));
  if (row.id !== id) throw new Error('发票详情 ID 不匹配');
  return row;
}
export async function apiInvoiceOrderInfo(id: number, signal?: AbortSignal): Promise<InvoiceOrderInfo> {
  if (!integer(id) || id === 0) throw new Error('发票 ID 无效');
  return parseInvoiceOrderInfo(await getData<unknown>(request.get(`/order/invoices/${id}/order-info`, { signal })), id);
}
export async function apiProcessInvoice(id: number, input: InvoiceProcessInput, signal?: AbortSignal): Promise<InvoiceProcessReceipt> {
  if (!integer(id) || id === 0) throw new Error('发票 ID 无效');
  const body = normalizeInvoiceProcess(input);
  const result = await getData<unknown>(request.post(`/order/invoices/${id}/process`, body, { signal }));
  if (!object(result) || result.committed !== true || result.request_id !== body.request_id || typeof result.idempotent !== 'boolean')
    throw new Error('发票处理回执不完整，结果未确认');
  if (result.archived === true) {
    if (result.id !== id || !signedInteger(result.order_db_id) || result.order_number !== null || result.template_id !== null ||
      result.is_invoice !== body.is_invoice || !string(result.revision) || !revisionPattern.test(result.revision) ||
      result.idempotent !== true || result.receipt_is_invoice !== body.is_invoice || result.superseded !== false)
      throw new Error('归档发票回执不完整，结果未确认');
    return result as InvoiceProcessReceipt;
  }
  const row = parseInvoice(result);
  if (row.id !== id) throw new Error('发票处理回执 ID 不匹配，结果未确认');
  if ('superseded' in result || 'receipt_is_invoice' in result) {
    if (result.idempotent !== true || typeof result.superseded !== 'boolean' || result.receipt_is_invoice !== body.is_invoice)
      throw new Error('发票重放回执不完整，结果未确认');
  }
  if (result.superseded !== true && (row.is_invoice !== body.is_invoice || row.invoice_number !== body.invoice_number || row.remark !== body.remark))
    throw new Error('发票回执与原请求内容不一致，结果未确认');
  return result as unknown as InvoiceProcessReceipt;
}

const manualMoneyPattern = /^(?:0|[1-9]\d{0,9})\.\d{2}$/u;
const manualDocumentPattern = /^\d{8,20}$/u;
const positiveIdentity = (value: unknown): value is number => integer(value) && Number(value) > 0 && Number(value) <= 2_147_483_647;
function manualText(value: unknown, maximum: number): value is string {
  return string(value) && value === value.trim() && value.length > 0 && new TextEncoder().encode(value).length <= maximum &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}
function manualHash(value: unknown): value is string { return string(value) && revisionPattern.test(value); }
function manualUuid(value: unknown): value is string { return string(value) && uuidPattern.test(value); }
function manualMoney(value: unknown): value is string { return string(value) && manualMoneyPattern.test(value); }
function manualDocument(value: unknown): value is string { return string(value) && manualDocumentPattern.test(value); }
function manualOriginalDocument(value: unknown): value is string {
  return string(value) && value.trim().length > 0 && Array.from(value).length <= 50 && !/[\u0000-\u001f\u007f]/u.test(value);
}
export function normalizeInvoiceManualRedRecord(value: InvoiceManualRedRecordInput): InvoiceManualRedRecordInput {
  const input = { ...value, red_document_number: value.red_document_number.trim(), platform_evidence: value.platform_evidence.trim() };
  if (!manualUuid(input.request_id) || !manualOriginalDocument(input.original_document_number) || !manualHash(input.original_snapshot_hash) ||
    !manualMoney(input.original_amount) || input.currency !== 'CNY' || !manualDocument(input.red_document_number) ||
    !manualMoney(input.red_amount) || input.red_amount !== input.original_amount || input.red_document_number === input.original_document_number ||
    !manualText(input.platform_evidence, 4096)) throw new Error('红字票号、整票金额或税务平台人工凭据无效');
  return { request_id: input.request_id, original_document_number: input.original_document_number, original_snapshot_hash: input.original_snapshot_hash,
    original_amount: input.original_amount, currency: 'CNY', red_document_number: input.red_document_number, red_amount: input.red_amount, platform_evidence: input.platform_evidence };
}
export function normalizeInvoiceManualRedReview(value: InvoiceManualRedReviewInput): InvoiceManualRedReviewInput {
  const review_note = value.review_note.trim();
  if (!manualUuid(value.request_id) || !manualHash(value.record_hash) || !['confirm', 'reject'].includes(value.decision) ||
    value.manual_checked !== true || !manualText(review_note, 1024)) throw new Error('请完成人工票据核对并填写核对记录');
  return { request_id: value.request_id, record_hash: value.record_hash, decision: value.decision, manual_checked: true, review_note };
}
export function parseInvoiceManualRedRecord(value: unknown): InvoiceManualRedRecord {
  if (!object(value) || !manualUuid(value.id) || !manualHash(value.record_hash) || !positiveIdentity(value.actor_id) || !positiveIdentity(value.created_time) ||
    !manualOriginalDocument(value.original_document_number) || !manualHash(value.original_snapshot_hash) || !manualMoney(value.original_amount) || value.currency !== 'CNY' ||
    !manualDocument(value.red_document_number) || !manualMoney(value.red_amount) || value.red_amount !== value.original_amount || value.red_document_number === value.original_document_number ||
    !manualText(value.platform_evidence, 4096) || !manualHash(value.platform_evidence_hash) ||
    !['RECORDED', 'MANUAL_REVIEWED', 'REJECTED'].includes(String(value.state))) throw new Error('人工红字票据响应格式错误');
  if (value.review === null) {
    if (value.state !== 'RECORDED') throw new Error('人工红字票据缺少核对记录');
  } else {
    const review = value.review;
    if (!object(review) || !manualUuid(review.id) || !manualHash(review.review_hash) || !positiveIdentity(review.actor_id) || !positiveIdentity(review.created_time) ||
      !['confirm', 'reject'].includes(String(review.decision)) || review.manual_checked !== true || !manualText(review.review_note, 1024) ||
      value.state !== (review.decision === 'confirm' ? 'MANUAL_REVIEWED' : 'REJECTED')) throw new Error('人工红字票据核对状态不一致');
  }
  return value as unknown as InvoiceManualRedRecord;
}
export function parseInvoiceManualRedNotes(value: unknown, invoiceId: number): InvoiceManualRedNotes {
  if (!object(value) || value.invoice_id !== invoiceId || !positiveIdentity(value.source_order_id) || !positiveIdentity(value.payment_order_id) ||
    !integer(value.uid) || Number(value.uid) > 2_147_483_647 || value.currency !== 'CNY' || typeof value.ready !== 'boolean' || typeof value.can_record !== 'boolean' ||
    !Array.isArray(value.issues) || !value.issues.every(string) || !Array.isArray(value.issued) || value.issued.length > 200 ||
    (!value.ready && value.can_record)) throw new Error('原票与人工红字凭据响应格式错误');
  const snapshots = new Set<string>(), records = new Set<string>();
  for (const issued of value.issued) {
    if (!object(issued) || !manualOriginalDocument(issued.document_number) || !manualHash(issued.snapshot_hash) || !manualMoney(issued.original_amount) ||
      !['UNCOVERED', 'MANUAL_REVIEWED'].includes(String(issued.manual_state)) || !Array.isArray(issued.records) || issued.records.length > 200)
      throw new Error('原票证据响应格式错误');
    const key = `${issued.document_number}:${issued.snapshot_hash}`;
    if (snapshots.has(key)) throw new Error('原票证据重复'); snapshots.add(key);
    const rows = issued.records.map(parseInvoiceManualRedRecord);
    for (const row of rows) {
      if (records.has(row.id) || row.original_document_number !== issued.document_number || row.original_snapshot_hash !== issued.snapshot_hash || row.original_amount !== issued.original_amount)
        throw new Error('人工红字凭据与原票不一致');
      records.add(row.id);
    }
    if (rows.filter(row => row.state === 'MANUAL_REVIEWED').length > 1 ||
      (issued.manual_state === 'MANUAL_REVIEWED') !== rows.some(row => row.state === 'MANUAL_REVIEWED')) throw new Error('原票处置状态与人工核对记录不一致');
  }
  return value as unknown as InvoiceManualRedNotes;
}
export function parseInvoiceManualRedReceipt(value: unknown, invoiceId: number, requestId: string): InvoiceManualRedReceipt {
  if (!object(value) || value.version !== 'invoice-manual-red-operation-v1' || value.invoice_id !== invoiceId || value.request_id !== requestId ||
    !positiveIdentity(value.actor_id) || !['record', 'review'].includes(String(value.kind)) || !manualHash(value.request_hash) ||
    value.committed !== true || typeof value.idempotent !== 'boolean') throw new Error('人工红字操作回执不完整，结果未确认');
  parseInvoiceManualRedRecord(value.record);
  return value as unknown as InvoiceManualRedReceipt;
}
export async function apiInvoiceManualRedNotes(id: number, signal?: AbortSignal): Promise<InvoiceManualRedNotes> {
  if (!positiveIdentity(id)) throw new Error('发票 ID 无效');
  return parseInvoiceManualRedNotes(await getData<unknown>(request.get(`/order/invoices/${id}/red-notes`, { signal })), id);
}
export async function apiRecordInvoiceManualRedNote(id: number, input: InvoiceManualRedRecordInput, signal?: AbortSignal): Promise<InvoiceManualRedReceipt> {
  if (!positiveIdentity(id)) throw new Error('发票 ID 无效');
  const body = normalizeInvoiceManualRedRecord(input);
  return parseInvoiceManualRedReceipt(await getData<unknown>(request.post(`/order/invoices/${id}/red-notes`, body, { signal })), id, body.request_id);
}
export async function apiReviewInvoiceManualRedNote(id: number, recordId: string, input: InvoiceManualRedReviewInput, signal?: AbortSignal): Promise<InvoiceManualRedReceipt> {
  if (!positiveIdentity(id) || !manualUuid(recordId)) throw new Error('发票或红字记录 ID 无效');
  const body = normalizeInvoiceManualRedReview(input);
  return parseInvoiceManualRedReceipt(await getData<unknown>(request.post(`/order/invoices/${id}/red-notes/${recordId}/review`, body, { signal })), id, body.request_id);
}
export async function apiInvoiceManualRedOperation(id: number, requestId: string, signal?: AbortSignal): Promise<InvoiceManualRedReceipt | null> {
  if (!positiveIdentity(id) || !manualUuid(requestId)) throw new Error('发票或原请求 ID 无效');
  const value = await getData<unknown>(request.get(`/order/invoices/${id}/red-notes/operations/${requestId}`, { signal }));
  return value === null ? null : parseInvoiceManualRedReceipt(value, id, requestId);
}
async function manualDigest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function verifyInvoiceManualRedReceipt(value: InvoiceManualRedReceipt, operation: InvoiceManualRedOperation, actorId: number): Promise<void> {
  const receipt = parseInvoiceManualRedReceipt(value, operation.id, operation.body.request_id), record = receipt.record;
  if (!positiveIdentity(actorId) || receipt.actor_id !== actorId || receipt.kind !== operation.kind ||
    record.platform_evidence_hash !== await manualDigest(record.platform_evidence)) throw new Error('人工红字回执与原操作人或凭据内容不一致');
  let intent: unknown[];
  if (operation.kind === 'record') {
    const body = normalizeInvoiceManualRedRecord(operation.body);
    if (record.id !== body.request_id || record.actor_id !== actorId || record.original_document_number !== body.original_document_number || record.original_snapshot_hash !== body.original_snapshot_hash ||
      record.original_amount !== body.original_amount || record.currency !== body.currency || record.red_document_number !== body.red_document_number ||
      record.red_amount !== body.red_amount || record.platform_evidence !== body.platform_evidence) throw new Error('人工红字回执与原录入内容不一致');
    intent = ['invoice-manual-red-record-intent-v1', operation.id, actorId, body.original_document_number, body.original_snapshot_hash,
      body.original_amount, body.currency, body.red_document_number, body.red_amount, body.platform_evidence];
  } else {
    const body = normalizeInvoiceManualRedReview(operation.body), review = record.review;
    if (record.id !== operation.recordId || record.record_hash !== body.record_hash || !review || review.actor_id !== actorId ||
      review.id !== body.request_id || review.decision !== body.decision || review.manual_checked !== true || review.review_note !== body.review_note) throw new Error('人工红字回执与原核对内容不一致');
    intent = ['invoice-manual-red-review-intent-v1', operation.id, operation.recordId, actorId, body.record_hash, body.decision, body.manual_checked, body.review_note];
  }
  if (receipt.request_hash !== await manualDigest(JSON.stringify(intent))) throw new Error('人工红字回执与原请求意图不一致');
}

function csvSafe(value: unknown): string {
  const original = String(value ?? '');
  // A quoted field is still evaluated by spreadsheet applications. Neutralize a
  // formula after whitespace or control characters before CSV quoting it.
  const neutral = /^[\u0000-\u0020]*[=+\-@]/u.test(original) || /^[\t\r\n]/u.test(original) ? `'${original}` : original;
  return `"${neutral.replaceAll('"', '""')}"`;
}
export function invoiceStatusLabel(status: number): string { return status === 1 ? '已开票' : status === -1 ? '已拒绝' : status === 0 ? '待开票' : `历史异常状态（${status}）`; }
export function invoiceTypeLabel(type: number): string { return type === 1 ? '电子普通发票' : type === 2 ? '纸质专用发票' : `未知票种（${type}）`; }
export function invoiceHeaderLabel(type: number): string { return type === 1 ? '个人' : type === 2 ? '企业' : `未知抬头类型（${type}）`; }
export function invoiceOrderPayTypeLabel(value: string): string {
  return ({ weixin: '微信支付', alipay: '支付宝支付', yue: '余额支付', cash: '现金支付' } as Record<string, string>)[value] ?? (value || '—');
}
export function invoiceOrderStatusLabel(order: InvoiceOrder | null): string {
  if (!order) return '关联订单异常';
  if (order.refund_status > 0) return order.refund_status === 1 ? '退款中' : '已退款';
  return ({ 0: '未发货', 1: '待收货', 2: '待评价', 3: '已完成' } as Record<number, string>)[order.status] ?? `未知状态（${order.status}）`;
}
export function invoiceTimeLabel(seconds: number): string {
  if (!seconds) return '—';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(seconds * 1000));
}
export function currentInvoicePageCsv(rows: readonly AdminInvoice[]): string {
  const columns = ['订单号', '订单金额', '发票类型', '发票抬头类型', '发票抬头名称', '下单时间', '开票状态', '订单状态'];
  const lines = rows.map(row => [row.order_number, row.order?.pay_price ?? '', invoiceTypeLabel(row.type), invoiceHeaderLabel(row.header_type),
    row.name, row.order ? invoiceTimeLabel(row.order.add_time) : '', invoiceStatusLabel(row.is_invoice), invoiceOrderStatusLabel(row.order)].map(csvSafe).join(','));
  return `\ufeff${columns.map(csvSafe).join(',')}\r\n${lines.join('\r\n')}${lines.length ? '\r\n' : ''}`;
}
