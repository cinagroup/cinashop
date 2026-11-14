import { orderDetailId } from './orderDetailIdentity';

export interface BuyerInvoiceFields {
  headerType: 1 | 2; type: 1 | 2; name: string; dutyNumber: string; drawerPhone: string;
  email: string; tell: string; address: string; bank: string; cardNumber: string;
}
export interface BuyerInvoiceTitle extends BuyerInvoiceFields {
  id: number; uid: number; revision: string; isDefault: boolean; addTime: string;
}
export interface BuyerInvoiceRecord extends BuyerInvoiceFields {
  id: number; uid: number; orderId: number; orderNo: string; titleId: number;
  state: -1 | 0 | 1; paid: boolean; refunded: boolean; amount: string | null;
  invoiceNumber: string; remark: string; addTime: string; invoiceTime: string;
  product: { name: string; image: string } | null;
}
export interface BuyerInvoiceCapabilities { enabled: boolean; special: boolean }
export interface BuyerInvoiceQuery { kind: 'titles' | 'records'; cursor: string | null; limit: number }
export interface BuyerInvoicePage {
  version: 1; uid: number; query: BuyerInvoiceQuery; capabilities: BuyerInvoiceCapabilities;
  items: BuyerInvoiceTitle[] | BuyerInvoiceRecord[]; nextCursor: string | null;
}
export interface BuyerInvoiceOrder {
  version: 1; uid: number; orderId: number; orderNo: string; revision: string;
  paid: boolean; status: number; pid: number; capabilities: BuyerInvoiceCapabilities;
  invoice: BuyerInvoiceRecord | null; amount: string | null; canApply: boolean; reason: string;
}
export interface BuyerInvoiceDraft extends BuyerInvoiceFields { id: number; revision: string; isDefault: boolean }
export type BuyerInvoiceAction = 'save' | 'delete' | 'default' | 'apply';
export interface BuyerInvoiceAck { version: 1; uid: number; action: BuyerInvoiceAction; id: number }
const invalid = (): never => { throw Error('发票资料与当前账号或页面不一致，请重新读取'); };
const limits = { name: 100, dutyNumber: 50, drawerPhone: 30, email: 100, tell: 30, address: 255, bank: 50, cardNumber: 50 } as const;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function object(v: unknown): Record<string, unknown> { return isRecord(v) ? v : invalid(); }
function text(v: unknown, max: number): string { return typeof v === 'string' && [...v].length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v) ? v : invalid(); }
function integer(v: unknown, zero = false): number { return typeof v === 'number' && Number.isInteger(v) && v >= (zero ? 0 : 1) && v <= 2147483647 ? v : invalid(); }
function bool(v: unknown): boolean { return typeof v === 'boolean' ? v : invalid(); }
export function buyerInvoiceId(v: unknown): number { if (typeof v !== 'string' || !/^[1-9]\d{0,9}$/.test(v)) return invalid(); return integer(Number(v)); }
export function buyerInvoiceRevision(v: unknown): string { return typeof v === 'string' && /^[a-f0-9]{64}$/.test(v) ? v : invalid(); }
function amount(v: unknown): string | null { if (v === null) return null; return typeof v === 'string' && /^\d{1,10}\.\d{2}$/.test(v) ? v : invalid(); }
function date(v: unknown): string { const value = text(v, 32); return value === '' || /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? value : invalid(); }
function fields(v: Record<string, unknown>): BuyerInvoiceFields {
  if (![1, 2].includes(v.headerType as number) || ![1, 2].includes(v.type as number)) return invalid();
  return { headerType: v.headerType as 1 | 2, type: v.type as 1 | 2,
    ...Object.fromEntries(Object.entries(limits).map(([key, max]) => [key, text(v[key], max)])) } as BuyerInvoiceFields;
}
function capabilities(v: unknown): BuyerInvoiceCapabilities { const row = object(v), enabled = bool(row.enabled), special = bool(row.special); if (special && !enabled) return invalid(); return { enabled, special }; }
export function parseBuyerInvoiceTitle(value: unknown, uid: number): BuyerInvoiceTitle {
  const row = object(value); if (row.uid !== uid) return invalid();
  return { ...fields(row), id: integer(row.id), uid: integer(uid), revision: buyerInvoiceRevision(row.revision), isDefault: bool(row.isDefault), addTime: date(row.addTime) };
}
export function parseBuyerInvoiceRecord(value: unknown, uid: number): BuyerInvoiceRecord {
  const row = object(value); if (row.uid !== uid || ![-1, 0, 1].includes(row.state as number)) return invalid();
  let product: BuyerInvoiceRecord['product'] = null;
  if (row.product !== null) { const p = object(row.product), image = text(p.image, 4096); if (image && !/^(?:https?:\/\/|\/(?!\/))/.test(image)) return invalid(); product = { name: text(p.name, 4096), image }; }
  const remark = text(row.remark, 255); if (row.state !== -1 && remark) return invalid();
  return { ...fields(row), id: integer(row.id), uid: integer(uid), orderId: integer(row.orderId), orderNo: orderDetailId(row.orderNo), titleId: integer(row.titleId, true),
    state: row.state as -1 | 0 | 1, paid: bool(row.paid), refunded: bool(row.refunded), amount: amount(row.amount),
    invoiceNumber: text(row.invoiceNumber, 50), remark, addTime: date(row.addTime), invoiceTime: date(row.invoiceTime), product };
}
export function buyerInvoiceQuery(kind: unknown, cursor: unknown = null, limit: unknown = 20): BuyerInvoiceQuery {
  if ((kind !== 'titles' && kind !== 'records') || typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 20) return invalid();
  return { kind, cursor: cursor === null ? null : text(cursor, 512) || invalid(), limit };
}
export function parseBuyerInvoicePage(value: unknown, expected: BuyerInvoiceQuery, uid: number): BuyerInvoicePage {
  const row = object(value), query = object(row.query);
  if (row.version !== 1 || row.uid !== uid || query.kind !== expected.kind || query.cursor !== expected.cursor || query.limit !== expected.limit
    || !Array.isArray(row.items) || row.items.length > expected.limit) return invalid();
  const items = row.items.map(item => expected.kind === 'titles' ? parseBuyerInvoiceTitle(item, uid) : parseBuyerInvoiceRecord(item, uid));
  if (new Set(items.map(item => item.id)).size !== items.length || (expected.kind === 'records' && (items as BuyerInvoiceRecord[]).some(item => !item.paid || item.refunded))) return invalid();
  const nextCursor = row.nextCursor === null ? null : text(row.nextCursor, 512) || invalid();
  if (nextCursor && (nextCursor === expected.cursor || items.length !== expected.limit)) return invalid();
  return { version: 1, uid: integer(uid), query: { ...expected }, capabilities: capabilities(row.capabilities), items: items as BuyerInvoicePage['items'], nextCursor };
}
export function parseBuyerInvoiceOrder(value: unknown, reference: string, uid: number): BuyerInvoiceOrder {
  const row = object(value), orderNo = orderDetailId(row.orderNo);
  if (row.version !== 1 || row.uid !== uid || orderNo !== orderDetailId(reference) || typeof row.status !== 'number' || !Number.isInteger(row.status)
    || row.status < -32768 || row.status > 32767 || typeof row.pid !== 'number' || !Number.isInteger(row.pid) || row.pid < -2147483648 || row.pid > 2147483647) return invalid();
  const invoice = row.invoice === null ? null : parseBuyerInvoiceRecord(row.invoice, uid), orderId = integer(row.orderId), policy = capabilities(row.capabilities), canApply = bool(row.canApply), remaining = amount(row.amount), reason = text(row.reason, 1000);
  if (invoice && (invoice.orderId !== orderId || invoice.orderNo !== orderNo)) return invalid();
  if (canApply && (invoice || !policy.enabled || !remaining || /^0+\.00$/.test(remaining) || row.pid < 0 || ![0, 1, 2, 3].includes(row.status) || reason)) return invalid();
  return { version: 1, uid: integer(uid), orderId, orderNo, revision: buyerInvoiceRevision(row.revision), paid: bool(row.paid), status: row.status, pid: row.pid,
    capabilities: policy, invoice, amount: remaining, canApply, reason };
}
export function emptyBuyerInvoiceDraft(): BuyerInvoiceDraft {
  return { id: 0, revision: '', headerType: 1, type: 1, name: '', dutyNumber: '', drawerPhone: '', email: '', tell: '', address: '', bank: '', cardNumber: '', isDefault: false };
}
export function buyerInvoiceDraft(title?: BuyerInvoiceTitle): BuyerInvoiceDraft {
  return title ? { ...fields(title as unknown as Record<string, unknown>), id: title.id, revision: title.revision, isDefault: title.isDefault } : emptyBuyerInvoiceDraft();
}
/** Explicit new-client contract; historical values remain readable until edited. */
export function validateBuyerInvoiceDraft(value: unknown): BuyerInvoiceDraft {
  const row = object(value), allowed = ['id', 'revision', 'headerType', 'type', ...Object.keys(limits), 'isDefault'];
  if (Object.keys(row).some(key => !allowed.includes(key)) || Object.keys(row).length !== allowed.length) throw Error('发票表单参数无效');
  const id = integer(row.id, true), revision = id ? buyerInvoiceRevision(row.revision) : row.revision === '' ? '' : invalid();
  let f = fields(row); f = Object.fromEntries(Object.entries(f).map(([key, v]) => [key, typeof v === 'string' ? v.trim() : v])) as unknown as BuyerInvoiceFields;
  if (!f.name || (f.headerType === 1 ? !/^[^\x00-\x7F]{2,60}$/u.test(f.name) : !/^[0-9A-Za-z&()（）\p{L}\p{N}]{2,100}$/u.test(f.name))) throw Error('请填写正确的发票抬头');
  if (!/^1[3-9]\d{9}$/.test(f.drawerPhone)) throw Error('请填写正确的开票手机号');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) throw Error('请填写正确的联系邮箱');
  if (f.headerType === 1) { if (f.type !== 1) throw Error('专用发票请选择企业抬头'); f = { ...f, dutyNumber: '', tell: '', address: '', bank: '', cardNumber: '' }; }
  else {
    f.dutyNumber = f.dutyNumber.toUpperCase();
    if (!/^(?:[A-Z0-9]{15}|[A-Z0-9]{17}|[A-Z0-9]{18}|[A-Z0-9]{20})$/.test(f.dutyNumber)) throw Error('请填写正确的发票税号');
    if (f.type === 2 && [f.bank, f.cardNumber, f.address, f.tell].some(v => !v)) throw Error('请完整填写专用发票的开户行、账号、地址和电话');
  }
  return { ...f, id, revision, isDefault: bool(row.isDefault) };
}
export function parseBuyerInvoiceAck(value: unknown, action: BuyerInvoiceAction, uid: number, expectedId?: number): BuyerInvoiceAck {
  const row = object(value), id = integer(row.id);
  if (row.version !== 1 || row.uid !== uid || row.action !== action || (expectedId !== undefined && id !== expectedId)) return invalid();
  return { version: 1, uid: integer(uid), action, id };
}
