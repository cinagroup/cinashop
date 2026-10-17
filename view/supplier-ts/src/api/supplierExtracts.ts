import { apiRequest } from './http';
import { classifyProductMediaReference } from '../../../common/productMediaReference';

export interface SupplierExtractQuery {
  status: '' | '-1' | '0' | '1'; pay_status: '' | '0' | '1';
  extract_type: '' | 'bank' | 'alipay' | 'weixin'; data: string; page: number; limit: number;
}
export interface SupplierExtractRecord {
  id: number; supplier_id: number; extract_type: 'bank' | 'alipay' | 'weixin';
  bank_code: string; bank_address: string; alipay_account: string; wechat: string; qrcode_url: string;
  extract_price: string; balance: string; supplier_mark: string; status: -1 | 0 | 1; pay_status: 0 | 1;
  admin_id: number; admin_name: string; fail_msg: string; fail_time: string; voucher_image: string;
  voucher_title: string; pay_time: string; add_time: string; revision: string;
}
export interface SupplierExtractStatistics {
  pending_review: string; pending_transfer: string; paid: string; withdrawable: string;
  extract_min_price: string; extract_max_price: string;
}
export interface SupplierExtractHistory extends SupplierExtractQuery {
  version: 'supplier-extract-v1'; selection: 'history'; supplier_id: number; bounded: true;
  list: SupplierExtractRecord[]; count: number; statistics: SupplierExtractStatistics;
}
export interface SupplierExtractMark {
  version: 'supplier-extract-mark-v1'; supplier_id: number; id: number; supplier_mark: string; revision: string; bounded: true;
}
const maximum = 2_147_483_647;
function fact(value: unknown): asserts value { if (!value) throw Error('提现记录无法完整核对，请重新读取'); }
function object(value: unknown): Record<string, unknown> { fact(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>; }
function exact(value: Record<string, unknown>, keys: readonly string[]) { fact(Object.keys(value).sort().join(',') === [...keys].sort().join(',')); }
function integer(value: unknown, min = 0, max = maximum): asserts value is number { fact(typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max); }
function text(value: unknown, limit: number): asserts value is string { fact(typeof value === 'string' && [...value].length <= limit && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)); }
function amount(value: unknown): asserts value is string { fact(typeof value === 'string' && /^-?(?:0|[1-9]\d{0,17})\.\d{2}$/.test(value) && value !== '-0.00'); }
function revision(value: unknown): asserts value is string { fact(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)); }
function time(value: unknown) {
  text(value, 19); if (value === '') return;
  fact(/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value));
  const date = new Date(value.replace(' ', 'T') + 'Z'); fact(!Number.isNaN(date.getTime()) && date.toISOString().slice(0, 19) === value.replace(' ', 'T'));
}
const rowKeys = ['id', 'supplier_id', 'extract_type', 'bank_code', 'bank_address', 'alipay_account', 'wechat', 'qrcode_url',
  'extract_price', 'balance', 'supplier_mark', 'status', 'pay_status', 'admin_id', 'admin_name', 'fail_msg', 'fail_time',
  'voucher_image', 'voucher_title', 'pay_time', 'add_time', 'revision'];
const statisticKeys = ['pending_review', 'pending_transfer', 'paid', 'withdrawable', 'extract_min_price', 'extract_max_price'];
export function parseSupplierExtractHistory(value: unknown, query: SupplierExtractQuery, supplierId: number): SupplierExtractHistory {
  integer(supplierId, 1); integer(query.page, 1); integer(query.limit, 1, 100); fact((query.page - 1) * query.limit <= maximum);
  fact(['', '-1', '0', '1'].includes(query.status) && ['', '0', '1'].includes(query.pay_status) && ['', 'bank', 'alipay', 'weixin'].includes(query.extract_type)); text(query.data, 100);
  const result = object(value); exact(result, ['version', 'selection', 'supplier_id', 'status', 'pay_status', 'extract_type', 'data', 'page', 'limit', 'bounded', 'list', 'count', 'statistics']);
  fact(result.version === 'supplier-extract-v1' && result.selection === 'history' && result.supplier_id === supplierId && result.bounded === true);
  for (const key of ['status', 'pay_status', 'extract_type', 'data', 'page', 'limit'] as const) fact(result[key] === query[key]);
  integer(result.count); fact(Array.isArray(result.list) && result.list.length === Math.min(query.limit, Math.max(0, result.count - (query.page - 1) * query.limit)));
  const stats = object(result.statistics); exact(stats, statisticKeys); for (const key of statisticKeys) { amount(stats[key]); fact(!String(stats[key]).startsWith('-')); }
  let previous = maximum + 1;
  for (const item of result.list) {
    const row = object(item); exact(row, rowKeys); integer(row.id, 1); fact(row.id < previous); previous = row.id;
    fact(row.supplier_id === supplierId && typeof row.extract_type === 'string' && ['bank', 'alipay', 'weixin'].includes(row.extract_type) && typeof row.status === 'number' && [-1, 0, 1].includes(row.status));
    fact(row.pay_status === 0 || row.pay_status === 1); integer(row.admin_id); revision(row.revision);
    fact(query.status === '' || row.status === Number(query.status)); fact(query.pay_status === '' || row.pay_status === Number(query.pay_status)); fact(query.extract_type === '' || row.extract_type === query.extract_type);
    amount(row.extract_price); amount(row.balance); fact(BigInt(row.extract_price.replace('.', '')) > 0n);
    for (const [key, limit] of [['bank_code', 32], ['bank_address', 256], ['alipay_account', 64], ['wechat', 32], ['qrcode_url', 255], ['supplier_mark', 255], ['admin_name', 64], ['fail_msg', 128], ['voucher_image', 256], ['voucher_title', 256]] as const) text(row[key], limit);
    for (const key of ['fail_time', 'pay_time', 'add_time']) time(row[key]);
  }
  fact(new TextEncoder().encode(JSON.stringify(result)).byteLength <= 2 * 1024 * 1024); return value as SupplierExtractHistory;
}
export function parseSupplierExtractMark(value: unknown, supplierId: number, id: number): SupplierExtractMark {
  integer(supplierId, 1); integer(id, 1); const result = object(value); exact(result, ['version', 'supplier_id', 'id', 'supplier_mark', 'revision', 'bounded']);
  fact(result.version === 'supplier-extract-mark-v1' && result.supplier_id === supplierId && result.id === id && result.bounded === true);
  text(result.supplier_mark, 255); revision(result.revision); return value as SupplierExtractMark;
}
export async function getSupplierExtractHistory(query: SupplierExtractQuery, supplierId: number, signal?: AbortSignal) {
  return parseSupplierExtractHistory(await apiRequest<unknown>({ method: 'GET', url: '/finance/supplier_extract/list', params: { selection: 'history', ...query }, signal }), query, supplierId);
}
export async function getSupplierExtractMark(id: number, supplierId: number, signal?: AbortSignal) {
  return parseSupplierExtractMark(await apiRequest<unknown>({ method: 'GET', url: `/finance/supplier_extract/mark/${id}`, params: { selection: 'history' }, signal }), supplierId, id);
}
export async function saveSupplierExtractMark(id: number, supplierId: number, mark: string, expectedRevision: string, signal?: AbortSignal) {
  const result = parseSupplierExtractMark(await apiRequest<unknown>({ method: 'POST', url: `/finance/supplier_extract/mark/${id}`,
    data: { selection: 'history', mark, expected_revision: expectedRevision }, signal }), supplierId, id);
  fact(result.supplier_mark === mark); return result;
}
/** A private attachment needs its own authorized projection. A raw ID or old
 * bearer alias must never become a public image or grant an Admin gallery. */
export function supplierExtractImage(reference: string): string {
  const result = classifyProductMediaReference(reference); return result.kind === 'public' ? result.reference : '';
}
