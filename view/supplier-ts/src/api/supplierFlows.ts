import { apiRequest } from './http';
import type { SupplierBillDetail } from './supplierBills';
import type { LegacyExportManifest } from '@/types';

export interface SupplierFlowQuery { type: '' | '1' | '2'; keyword: string; data: string; page: number; limit: number }
export interface SupplierFlow extends SupplierBillDetail { revision: string; is_del: 0 }
export interface SupplierFlows extends SupplierFlowQuery {
  version: 'supplier-flow-v1'; selection: 'ledger'; supplier_id: number; bounded: true; list: SupplierFlow[]; count: number;
}
export interface SupplierFlowMark { version: 'supplier-flow-mark-v1'; supplier_id: number; id: number; mark: string; revision: string; bounded: true }
const maximum = 2_147_483_647;
function fact(value: unknown): asserts value { if (!value) throw Error('流水结果无法完整核对，请重新读取'); }
function object(value: unknown): Record<string, unknown> { fact(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>; }
function exact(value: Record<string, unknown>, keys: readonly string[]) { fact(Object.keys(value).sort().join(',') === [...keys].sort().join(',')); }
function integer(value: unknown, min = 0, max = maximum): asserts value is number { fact(typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max); }
function text(value: unknown, limit = 2048): asserts value is string { fact(typeof value === 'string' && [...value].length <= limit && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)); }
function amount(value: unknown): asserts value is string { fact(typeof value === 'string' && /^-?(?:0|[1-9]\d{0,17})\.\d{2}$/.test(value) && value !== '-0.00'); }
function revision(value: unknown): asserts value is string { fact(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)); }
function time(value: unknown) {
  text(value, 19); if (value === '') return;
  fact(/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value));
  const parsed = new Date(value.replace(' ', 'T') + 'Z'); fact(!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value.replace(' ', 'T'));
}
const rowKeys = ['id', 'supplier_id', 'uid', 'order_id', 'link_id', 'pm', 'number', 'type', 'pay_type', 'status', 'mark', 'remark', 'add_time', 'trade_time', 'finish_time', 'user_nickname', 'type_name', 'pay_type_name', 'revision', 'is_del'];
export function parseSupplierFlows(value: unknown, query: SupplierFlowQuery, supplierId: number): SupplierFlows {
  integer(supplierId, 1); integer(query.page, 1); integer(query.limit, 1, 100);
  fact(['', '1', '2'].includes(query.type) && query.keyword === query.keyword.trim()); text(query.keyword, 80); text(query.data, 100);
  fact((query.page - 1) * query.limit <= maximum);
  const result = object(value); exact(result, ['version', 'selection', 'supplier_id', 'type', 'keyword', 'data', 'page', 'limit', 'bounded', 'list', 'count']);
  fact(result.version === 'supplier-flow-v1' && result.selection === 'ledger' && result.supplier_id === supplierId && result.bounded === true);
  for (const key of ['type', 'keyword', 'data', 'page', 'limit'] as const) fact(result[key] === query[key]);
  integer(result.count); fact(Array.isArray(result.list) && result.list.length === Math.min(query.limit, Math.max(0, result.count - (query.page - 1) * query.limit)));
  let previous = maximum + 1;
  for (const value of result.list) {
    const row = object(value); exact(row, rowKeys); integer(row.id, 1); fact(row.id < previous); previous = row.id;
    fact(row.supplier_id === supplierId && row.is_del === 0); integer(row.uid); integer(row.type, 0, 32767);
    fact(row.pm === 0 || row.pm === 1); amount(row.number); fact(typeof row.status === 'number' && [-1, 0, 1].includes(row.status));
    fact(query.type === '' || row.type === Number(query.type)); revision(row.revision);
    for (const key of ['order_id', 'link_id', 'pay_type', 'mark', 'remark', 'user_nickname', 'type_name', 'pay_type_name']) text(row[key]);
    text(row.mark, 255); text(row.remark, 512); text(row.user_nickname, 500);
    for (const key of ['add_time', 'trade_time', 'finish_time']) time(row[key]);
    fact(row.type_name === (row.type === 1 ? '支付订单' : row.type === 2 ? '退款订单' : '其他类型'));
    fact(['微信支付', '余额支付', '线下支付', '支付宝支付', '现金支付', '自动转账', '其他方式'].includes(String(row.pay_type_name)));
  }
  fact(new TextEncoder().encode(JSON.stringify(result)).byteLength <= 2 * 1024 * 1024);
  return value as SupplierFlows;
}
export function parseSupplierFlowMark(value: unknown, supplierId: number, id: number): SupplierFlowMark {
  integer(supplierId, 1); integer(id, 1); const result = object(value);
  exact(result, ['version', 'supplier_id', 'id', 'mark', 'revision', 'bounded']);
  fact(result.version === 'supplier-flow-mark-v1' && result.supplier_id === supplierId && result.id === id && result.bounded === true);
  text(result.mark, 255); revision(result.revision); return value as SupplierFlowMark;
}
export async function getSupplierFlows(query: SupplierFlowQuery, supplierId: number, signal?: AbortSignal) {
  const value = await apiRequest<unknown>({ method: 'GET', url: '/finance/supplier_flowing_water/list', params: { selection: 'ledger', ...query }, signal });
  return parseSupplierFlows(value, query, supplierId);
}
export async function getSupplierFlowMark(id: number, supplierId: number, signal?: AbortSignal) {
  return parseSupplierFlowMark(await apiRequest<unknown>({ method: 'GET', url: `/finance/supplier_flowing_water/mark/${id}`, params: { selection: 'ledger' }, signal }), supplierId, id);
}
export async function saveSupplierFlowMark(id: number, supplierId: number, mark: string, expectedRevision: string, signal?: AbortSignal) {
  const result = parseSupplierFlowMark(await apiRequest<unknown>({ method: 'POST', url: `/finance/supplier_flowing_water/mark/${id}`,
    data: { selection: 'ledger', mark, expected_revision: expectedRevision }, signal }), supplierId, id);
  fact(result.mark === mark); return result;
}
export async function getSupplierFlowExport(rows: readonly SupplierFlow[], signal?: AbortSignal): Promise<LegacyExportManifest> {
  fact(rows.length > 0 && rows.length <= 100 && new Set(rows.map(row => row.id)).size === rows.length);
  const selected = [...rows].sort((a, b) => b.id - a.id);
  const value = object(await apiRequest<unknown>({ method: 'GET', url: '/export/financeRecord', params: { ids: selected.map(row => row.id).join(','), page: 1 }, signal }));
  exact(value, ['header', 'filekey', 'export', 'filename', 'limit', 'has_more', 'bounded']);
  fact(value.bounded === true && value.has_more === false && Array.isArray(value.export) && value.export.length === selected.length);
  const keys = ['order_id', 'link_id', 'trade_time', 'number', 'pm', 'user_nickname', 'type_name', 'pay_type_name'];
  fact(JSON.stringify(value.filekey) === JSON.stringify(keys));
  for (const [index, item] of value.export.entries()) {
    const row = object(item); exact(row, keys); amount(row.number);
    const source = selected[index]; fact(row.number === source.number && row.pm === (source.pm === 1 ? '收入' : '支出'));
    // Legacy export neutralizes formula text on the server.
    const safe = (s: string) => /^[\s\u0000-\u001f\u007f-\u009f]*[=+\-@]/.test(s) ? "'" + s : s;
    fact(row.order_id === safe(source.order_id) && row.link_id === safe(source.link_id));
  }
  return value as unknown as LegacyExportManifest;
}
