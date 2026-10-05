import { ValidateException } from '@/utils/errors';

const INT_MAX = 2_147_483_647;
export interface CityDeliveryPage { page: number; limit: number; offset: number; keyword: string }
export interface CityDeliveryRecordFilters extends CityDeliveryPage {
  station_type: 1 | 2 | null; status: number | null; store_id: number | null;
  date_from: number | null; date_to: number | null;
}
export function cityDeliveryQueryKeys(params: URLSearchParams, allowed: readonly string[]) {
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) {
    throw new ValidateException('配送记录查询参数重复或不受支持');
  }
}
export function cityDeliveryInteger(value: string, label: string, minimum = 0, maximum = INT_MAX): number {
  if (!/^(?:0|[1-9]\d*|-[1-9]\d*)$/.test(value) || value.length > 11) throw new ValidateException(`${label}须为规范整数`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new ValidateException(`${label}超出范围`);
  return result;
}
export function cityDeliveryRecordId(value: string): number { return cityDeliveryInteger(value, '配送记录ID', 1); }
function page(params: URLSearchParams, maximum: number): CityDeliveryPage {
  const current = cityDeliveryInteger(params.get('page') ?? '1', '页码', 1);
  const limit = cityDeliveryInteger(params.get('limit') ?? '20', '每页条数', 1, maximum);
  const offset = (current - 1) * limit;
  if (offset > 100_000) throw new ValidateException('配送记录分页偏移不能超过100000');
  const raw = params.get('keyword') ?? '';
  if (/[\u0000-\u001f\u007f]/u.test(raw) || [...raw.trim()].length > 100) throw new ValidateException('关键词须为至多100个非控制字符');
  return { page: current, limit, offset, keyword: raw.trim() };
}
export function cityDeliveryRecordFilters(params: URLSearchParams): CityDeliveryRecordFilters {
  cityDeliveryQueryKeys(params, ['page', 'limit', 'station_type', 'status', 'store_id', 'keyword', 'date_from', 'date_to']);
  const station = params.has('station_type') ? cityDeliveryInteger(params.get('station_type')!, '配送平台', 1, 2) as 1 | 2 : null;
  const status = params.has('status') ? cityDeliveryInteger(params.get('status')!, '配送状态', -2_147_483_648) : null;
  const store = params.has('store_id') ? cityDeliveryInteger(params.get('store_id')!, '门店ID', 1) : null;
  if (params.has('date_from') !== params.has('date_to')) throw new ValidateException('起止时间须同时提供');
  const from = params.has('date_from') ? cityDeliveryInteger(params.get('date_from')!, '起始时间') : null;
  const to = params.has('date_to') ? cityDeliveryInteger(params.get('date_to')!, '结束时间') : null;
  if (from !== null && to !== null && from > to) throw new ValidateException('起始时间不能晚于结束时间');
  return { ...page(params, 100), station_type: station, status, store_id: store, date_from: from, date_to: to };
}
export function cityDeliveryStoreFilters(params: URLSearchParams): CityDeliveryPage {
  cityDeliveryQueryKeys(params, ['page', 'limit', 'keyword']);
  return page(params, 50);
}
/** Literal contains: SQL wildcards and the escape character are data. */
export function cityDeliveryLike(keyword: string): string { return `%${keyword.replace(/[\\%_]/g, '\\$&')}%`; }
/** Money never passes through floating point. PostgreSQL NaN/Infinity remain explicit historical issues. */
export function cityDeliveryMoney(raw: string): string | null { return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw) ? raw : null; }
/** A REAL snapshot is stored in meters; shift its shortest decimal representation, without rounding km through division. */
export function cityDeliveryDistance(raw: number): { meters: number | null; km: string | null } {
  if (!Number.isFinite(raw) || raw < 0) return { meters: null, km: null };
  if (raw === 0) return { meters: 0, km: '0' };
  const [mantissa, exponent = '0'] = String(raw).toLowerCase().split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const digits = whole + fraction, position = whole.length + Number(exponent) - 3;
  const expanded = position <= 0 ? `0.${'0'.repeat(-position)}${digits}`
    : position >= digits.length ? digits + '0'.repeat(position - digits.length)
      : `${digits.slice(0, position)}.${digits.slice(position)}`;
  const normalized = expanded.includes('.') ? expanded.replace(/0+$/, '').replace(/\.$/, '') : expanded;
  return { meters: raw, km: normalized };
}
