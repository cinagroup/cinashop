import { ValidateException } from '@/utils/errors';

export type SupplierOrderQuery = Record<string, string | string[]>;
export type SupplierOrderField = 'legacy' | 'all' | 'order_id' | 'uid' | 'real_name' | 'user_phone' | 'title' | 'total_num';
export interface SupplierOrderListInput {
  page: number; limit: number; keyword: string; field: SupplierOrderField;
  paid: number | null; status: number | null; businessStatus: number | null; type: number | null;
  payType: string; start: number | null; end: number | null;
}
export function supplierOrderParameter(query: SupplierOrderQuery, name: string): string | undefined {
  const value = query[name];
  if (Array.isArray(value)) {
    if (value.length !== 1 || typeof value[0] !== 'string') throw new ValidateException('订单查询参数重复或格式无效');
    return value[0];
  }
  if (value !== undefined && typeof value !== 'string') throw new ValidateException('订单查询参数格式无效');
  return value;
}
function integer(value: string | undefined, fallback: number, min: number, max: number) {
  if (value === undefined || value === '') return fallback;
  if (!/^\d{1,10}$/.test(value)) throw new ValidateException('订单查询参数错误');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new ValidateException('订单查询参数错误');
  return number;
}
function text(value: string | undefined, maximum: number) {
  if (value === undefined) return '';
  if (value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)
    || [...value].some(char => char.length === 1 && char.charCodeAt(0) >= 0xd800 && char.charCodeAt(0) <= 0xdfff))
    throw new ValidateException('订单查询参数错误');
  return value.trim();
}
function epoch(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  if (!/^(?:0|[1-9]\d{0,9})$/.test(value) || Number(value) > 2147483647) throw new ValidateException('订单时间参数无效');
  return Number(value);
}
/** Existing raw status/keyword clients keep their established meaning. The
 * explicit field and business selectors opt into the full PHP list search. */
export function supplierOrderListInput(query: SupplierOrderQuery): SupplierOrderListInput {
  const get = (key: string) => supplierOrderParameter(query, key);
  const page = integer(get('page'), 1, 1, 10000), limit = integer(get('limit'), 20, 1, 100);
  const keyword = text(get('real_name'), 256) || text(get('order'), 256);
  // Validate both fields even when real_name takes precedence.
  text(get('order'), 256);
  const raw = get('status'), paidValue = get('paid'), selector = get('business_status');
  const status = raw === undefined || raw === '' ? null : integer(raw, 0, 0, 5);
  const paid = paidValue === undefined || paidValue === '' ? null : integer(paidValue, 0, 0, 1);
  if (selector !== undefined && selector !== '' && !/^(?:-[1-4]|[0-9])$/.test(selector)) throw new ValidateException('订单业务状态无效');
  const businessStatus = selector === undefined || selector === '' ? null : Number(selector);
  if (businessStatus !== null && status !== null) throw new ValidateException('原始状态与业务状态不能同时筛选');
  const fieldValue = get('field_key');
  const field = fieldValue === undefined ? 'legacy' : fieldValue === '' ? 'all' : fieldValue;
  if (!['legacy', 'all', 'order_id', 'uid', 'real_name', 'user_phone', 'title', 'total_num'].includes(field)
    || fieldValue === 'legacy') throw new ValidateException('订单搜索字段无效');
  if (keyword && (field === 'uid' || field === 'total_num') && (!/^(?:0|[1-9]\d{0,9})$/.test(keyword)
    || Number(keyword) > 2147483647 || field === 'uid' && Number(keyword) === 0)) throw new ValidateException('订单数字搜索值无效');
  const typeValue = get('type');
  if (typeValue !== undefined && typeValue !== '' && !/^(?:[0-8]|105|106|107)$/.test(typeValue)) throw new ValidateException('订单类型无效');
  const type = typeValue === undefined || typeValue === '' ? null : Number(typeValue);
  const payValue = text(get('pay_type'), 32), payments: Record<string, string> = { 1: 'weixin', 2: 'yue', 3: 'offline', 4: 'alipay', 5: 'integral' };
  if (/^\d+$/.test(payValue) && !Object.hasOwn(payments, payValue)) throw new ValidateException('订单支付方式无效');
  const payType = Object.hasOwn(payments, payValue) ? payments[payValue] : payValue;
  const start = epoch(get('start_time')), end = epoch(get('end_time'));
  if (start !== null && end !== null && start > end) throw new ValidateException('订单起始时间不能晚于结束时间');
  return { page, limit, keyword, field: field as SupplierOrderField, paid, status, businessStatus, type, payType, start, end };
}
