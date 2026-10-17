import { apiRequest } from './http';

export type SupplierBillPeriod = 'day' | 'week' | 'month';
export type SupplierBillStatus = '' | '-1' | '0' | '1';
export interface SupplierBillQuery {
  timeType: SupplierBillPeriod; status: SupplierBillStatus; data: string; page: number; limit: number;
}
export interface SupplierBillGroup {
  id: number; period: string; day: string; title: string; add_time: string;
  income_num: string; exp_num: string; entry_num: string; detail_count: number;
}
export interface SupplierBillDetail {
  id: number; supplier_id: number; uid: number; order_id: string; link_id: string;
  pm: 0 | 1; number: string; type: number; pay_type: string; status: number;
  mark: string; remark: string; add_time: string; trade_time: string; finish_time: string;
  user_nickname: string; type_name: string; pay_type_name: string;
}
interface SupplierBillPage<T> extends SupplierBillQuery {
  version: 'supplier-bill-v1'; selection: 'period'; supplier_id: number; bounded: true;
  list: T[]; count: number;
}
export type SupplierBillGroups = SupplierBillPage<SupplierBillGroup>;
export interface SupplierBillDetails extends SupplierBillPage<SupplierBillDetail> { period: string; keyword: string }

const maximum = 2_147_483_647;
const money = /^-?(?:0|[1-9]\d{0,17})\.\d{2}$/;
const failure = () => Error('账单结果无法完整核对，请重新查询');
function fact(value: unknown): asserts value { if (!value) throw failure(); }
function object(value: unknown): Record<string, unknown> {
  fact(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[]) {
  fact(Object.keys(value).sort().join(',') === [...keys].sort().join(','));
}
function integer(value: unknown, minimum = 0, max = maximum): asserts value is number {
  fact(typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= max);
}
function text(value: unknown, max = 2048): asserts value is string {
  fact(typeof value === 'string' && [...value].length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value));
}
function amount(value: unknown): asserts value is string {
  fact(typeof value === 'string' && money.test(value) && value !== '-0.00');
}
function cents(value: string) { return BigInt(value.replace('.', '')); }
function period(value: unknown, type: SupplierBillPeriod): asserts value is string {
  fact(typeof value === 'string');
  if (type === 'week') { fact(/^\d{4}-(?:[0-4]\d|5[0-3])$/.test(value)); return; }
  if (type === 'month') { fact(/^\d{4}-(?:0[1-9]|1[0-2])$/.test(value)); return; }
  fact(/^\d{4}-\d{2}-\d{2}$/.test(value));
  const parsed = new Date(value + 'T00:00:00Z');
  fact(!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value);
}
const pageKeys = ['version', 'selection', 'supplier_id', 'timeType', 'status', 'data', 'list', 'count', 'page', 'limit', 'bounded'];
function page(value: unknown, query: SupplierBillQuery, supplierId: number, detail = false) {
  integer(supplierId, 1); integer(query.page, 1); integer(query.limit, 1, 100);
  fact(['day', 'week', 'month'].includes(query.timeType) && ['', '-1', '0', '1'].includes(query.status));
  fact(typeof query.data === 'string' && query.data.length <= 100);
  fact((query.page - 1) * query.limit <= maximum);
  const row = object(value); exact(row, [...pageKeys, ...(detail ? ['period', 'keyword'] : [])]);
  fact(row.version === 'supplier-bill-v1' && row.selection === 'period' && row.bounded === true && row.supplier_id === supplierId);
  fact(row.timeType === query.timeType && row.status === query.status && row.data === query.data && row.page === query.page && row.limit === query.limit);
  integer(row.count); fact(Array.isArray(row.list));
  fact(row.list.length === Math.min(query.limit, Math.max(0, row.count - (query.page - 1) * query.limit)));
  return row;
}
export function parseSupplierBillGroups(value: unknown, query: SupplierBillQuery, supplierId: number): SupplierBillGroups {
  const result = page(value, query, supplierId), rows = result.list as unknown[], seen = new Set<string>();
  for (const [index, value] of rows.entries()) {
    const row = object(value); exact(row, ['id', 'period', 'day', 'title', 'add_time', 'income_num', 'exp_num', 'entry_num', 'detail_count']);
    integer(row.id, 1); fact(row.id === index + 1); period(row.period, query.timeType);
    fact(!seen.has(row.period)); seen.add(row.period);
    fact(row.day === row.period && row.title === ({ day: '日账单', week: '周账单', month: '月账单' })[query.timeType]);
    fact(row.add_time === (query.timeType === 'week' ? `${row.period.slice(0, 4)}年第${row.period.slice(5)}周` : row.period));
    amount(row.income_num); amount(row.exp_num); amount(row.entry_num); integer(row.detail_count, 1);
    fact(cents(row.income_num) - cents(row.exp_num) === cents(row.entry_num));
    if (index) fact(String(object(rows[index - 1]).period) > row.period);
  }
  return value as SupplierBillGroups;
}
export function parseSupplierBillDetails(value: unknown, query: SupplierBillQuery & { period: string; keyword: string }, supplierId: number): SupplierBillDetails {
  const result = page(value, query, supplierId, true); period(query.period, query.timeType);
  fact(result.period === query.period && result.keyword === query.keyword);
  let previous = maximum + 1;
  for (const value of result.list as unknown[]) {
    const row = object(value); exact(row, ['id', 'supplier_id', 'uid', 'order_id', 'link_id', 'pm', 'number', 'type', 'pay_type', 'status', 'mark', 'remark', 'add_time', 'trade_time', 'finish_time', 'user_nickname', 'type_name', 'pay_type_name']);
    integer(row.id, 1); fact(row.id < previous); previous = row.id;
    fact(row.supplier_id === supplierId && (row.pm === 0 || row.pm === 1)); integer(row.uid); integer(row.type);
    fact([-1, 0, 1].includes(Number(row.status))); fact(typeof row.status === 'number'); amount(row.number);
    fact(query.status === '' || row.status === Number(query.status));
    for (const key of ['order_id', 'link_id', 'pay_type', 'mark', 'remark', 'user_nickname', 'type_name', 'pay_type_name']) text(row[key]);
    for (const key of ['add_time', 'trade_time', 'finish_time']) {
      const value = row[key]; text(value, 19); fact(value === '' || /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value));
    }
    fact(row.type_name === (row.type === 1 ? '支付订单' : row.type === 2 ? '退款订单' : '其他类型'));
  }
  return value as SupplierBillDetails;
}
export function supplierBillDateRange(from: string, to: string): string {
  if (!from && !to) return '';
  try { period(from, 'day'); period(to, 'day'); fact(from <= to); }
  catch { throw Error('请选择完整、有效且顺序正确的起止日期'); }
  return `${from.replaceAll('-', '/')}-${to.replaceAll('-', '/')}`;
}
/** Keep numeric(20,2) text exact even beyond JavaScript's safe integer range. */
export function supplierBillMoney(value: string, direction: 0 | 1 = 1): string {
  amount(value); let minor = cents(value); if (direction === 0) minor = -minor;
  const negative = minor < 0n; if (negative) minor = -minor;
  const whole = String(minor / 100n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '−' : ''}¥${whole}.${String(minor % 100n).padStart(2, '0')}`;
}
export async function getSupplierBillGroups(query: SupplierBillQuery, supplierId: number, signal?: AbortSignal) {
  const expected = { ...query };
  return parseSupplierBillGroups(await apiRequest<unknown>({ method: 'GET', url: '/finance/supplier_flowing_water/fund_record', params: { selection: 'period', ...expected }, signal }), expected, supplierId);
}
export async function getSupplierBillDetails(query: SupplierBillQuery & { period: string; keyword: string }, supplierId: number, signal?: AbortSignal) {
  const expected = { ...query, keyword: query.keyword.trim() };
  return parseSupplierBillDetails(await apiRequest<unknown>({ method: 'GET', url: '/finance/supplier_flowing_water/fund_record_info', params: { selection: 'period', ...expected }, signal }), expected, supplierId);
}
