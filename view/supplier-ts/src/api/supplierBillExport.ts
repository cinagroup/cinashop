import { apiRequest } from './http';
import type { SupplierBillPeriod, SupplierBillStatus } from './supplierBills';

export interface SupplierBillExportQuery { timeType: SupplierBillPeriod; status: SupplierBillStatus; data: string; period: string }
export const supplierBillExportHeader = ['交易单号', '关联订单', '交易时间', '交易金额', '支出收入', '交易人', '交易类型', '支付方式'] as const;
export const supplierBillExportFilekey = ['order_id', 'link_id', 'trade_time', 'number', 'pm', 'user_nickname', 'type_name', 'pay_type_name'] as const;
export interface SupplierBillExportRow {
  id: number; order_id: string; link_id: string; trade_time: string; number: string; pm: '收入' | '支出';
  user_nickname: string; type_name: string; pay_type_name: string;
}
export interface SupplierBillExport extends SupplierBillExportQuery {
  version: 'supplier-bill-export-v1'; selection: 'period'; supplier_id: number;
  header: string[]; filekey: string[]; export: SupplierBillExportRow[]; filename: string; count: number;
  income_num: string; exp_num: string; entry_num: string; complete: true; bounded: true;
}
const maximum = 2_147_483_647, capacity = 16 * 1024 * 1024;
function fact(value: unknown): asserts value { if (!value) throw Error('账期导出无法完整核对，未下载文件，请重新查询'); }
function object(value: unknown): Record<string, unknown> {
  fact(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[]) { fact(Object.keys(value).sort().join(',') === [...keys].sort().join(',')); }
function integer(value: unknown, minimum = 0): asserts value is number { fact(typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum); }
function amount(value: unknown): asserts value is string { fact(typeof value === 'string' && /^-?(?:0|[1-9]\d{0,17})\.\d{2}$/.test(value) && value !== '-0.00'); }
function text(value: unknown, limit = 2049): asserts value is string {
  fact(typeof value === 'string' && value.length <= limit && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value));
}
const cents = (value: string) => BigInt(value.replace('.', ''));
function date(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
export function parseSupplierBillExport(value: unknown, query: SupplierBillExportQuery, supplierId: number): SupplierBillExport {
  integer(supplierId, 1); fact(['day', 'week', 'month'].includes(query.timeType) && ['', '-1', '0', '1'].includes(query.status));
  text(query.data, 100); text(query.period, 10);
  fact(query.timeType === 'day' ? date(query.period) : query.timeType === 'month' ? /^\d{4}-(?:0[1-9]|1[0-2])$/.test(query.period) : /^\d{4}-(?:[0-4]\d|5[0-3])$/.test(query.period));
  const result = object(value);
  exact(result, ['version', 'selection', 'supplier_id', 'timeType', 'status', 'data', 'period', 'header', 'filekey', 'export', 'filename', 'count', 'income_num', 'exp_num', 'entry_num', 'complete', 'bounded']);
  fact(result.version === 'supplier-bill-export-v1' && result.selection === 'period' && result.supplier_id === supplierId && result.complete === true && result.bounded === true);
  for (const key of ['timeType', 'status', 'data', 'period'] as const) fact(result[key] === query[key]);
  fact(Array.isArray(result.header) && JSON.stringify(result.header) === JSON.stringify(supplierBillExportHeader));
  fact(Array.isArray(result.filekey) && JSON.stringify(result.filekey) === JSON.stringify(supplierBillExportFilekey));
  fact(result.filename === `账单导出_${query.timeType}_${query.period}_${query.status || 'all'}`);
  integer(result.count); fact(Array.isArray(result.export) && result.export.length === result.count);
  amount(result.income_num); amount(result.exp_num); amount(result.entry_num);
  let income = 0n, expense = 0n, previous = maximum + 1;
  const encoder = new TextEncoder();
  // Bound the response without allocating a second full-size copy per row.
  let bytes = encoder.encode(JSON.stringify({ ...result, export: [] })).byteLength;
  fact(bytes <= capacity);
  for (const [index, value] of result.export.entries()) {
    const row = object(value); exact(row, ['id', ...supplierBillExportFilekey]);
    integer(row.id, 1); fact(row.id < previous); previous = row.id;
    for (const key of supplierBillExportFilekey) text(row[key], key === 'user_nickname' ? 501 : 2049);
    amount(row.number); fact(row.pm === '收入' || row.pm === '支出');
    fact(row.trade_time === '' || /^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(row.trade_time as string) && date(String(row.trade_time).slice(0, 10)));
    fact(['支付订单', '退款订单', '其他类型'].includes(String(row.type_name)));
    fact(['微信支付', '余额支付', '线下支付', '支付宝支付', '现金支付', '自动转账', '其他方式'].includes(String(row.pay_type_name)));
    if (row.pm === '收入') income += cents(row.number); else expense += cents(row.number);
    bytes += encoder.encode(JSON.stringify(row)).byteLength + (index ? 1 : 0); fact(bytes <= capacity);
  }
  fact(income === cents(result.income_num) && expense === cents(result.exp_num) && income - expense === cents(result.entry_num));
  return value as SupplierBillExport;
}
export async function getSupplierBillExport(query: SupplierBillExportQuery, supplierId: number, signal?: AbortSignal) {
  const result = await apiRequest<unknown>({ method: 'get', url: '/export/financeRecord',
    params: { selection: 'period', timeType: query.timeType, status: query.status, data: query.data, period: query.period }, timeout: 30_000, signal });
  return parseSupplierBillExport(result, query, supplierId);
}

function csvText(value: string, numeric = false) {
  // Only validated canonical decimal amounts may remain numeric. Text with a
  // formula prefix stays text even after whitespace/control characters.
  const safe = !numeric && /^[\s\u0000-\u001f\u007f-\u009f]*[=+\-@]/u.test(value) ? "'" + value : value;
  return '"' + safe.replace(/"/g, '""') + '"';
}
export function supplierBillExportCsv(value: unknown, query: SupplierBillExportQuery, supplierId: number): Blob {
  const manifest = parseSupplierBillExport(value, query, supplierId);
  const lines = [supplierBillExportHeader.map(value => csvText(value)).join(',')];
  for (const row of manifest.export) lines.push(supplierBillExportFilekey.map(key => csvText(row[key], key === 'number')).join(','));
  const blob = new Blob(['\uFEFF', lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  fact(blob.size <= 32 * 1024 * 1024); return blob;
}
export function downloadSupplierBillExport(value: unknown, query: SupplierBillExportQuery, supplierId: number, isCurrent: () => boolean): boolean {
  const blob = supplierBillExportCsv(value, query, supplierId);
  if (!isCurrent()) return false;
  const url = URL.createObjectURL(blob);
  let anchor: HTMLAnchorElement | undefined;
  try {
    if (!isCurrent()) return false;
    anchor = document.createElement('a'); anchor.href = url;
    anchor.download = `账单导出_${query.timeType}_${query.period}_${query.status || 'all'}.csv`;
    anchor.style.display = 'none'; document.body.appendChild(anchor);
    if (!isCurrent()) return false;
    anchor.click(); return true;
  } finally { anchor?.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 0); }
}
