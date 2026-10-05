import request, { getData } from '@/utils/request';

export type RechargePaidFilter = 'all' | 0 | 1;
export interface RechargeOrderQuery {
  page: number;
  limit: 20;
  paid: RechargePaidFilter;
  start_time: string;
  end_time: string;
  keyword: string;
}
export interface RechargeOrderRow {
  id: number; uid: number; order_id: string; price: string; give_price: string; refund_price: string;
  paid: number; paid_type: string; recharge_type: string; recharge_type_label: string;
  add_time: number; pay_time: number; nickname: string; avatar: string;
  user_deleted: boolean; user_missing: boolean; issues: string[];
}
export interface RechargeOrderDetail extends RechargeOrderRow {
  trade_no: string; channel_type: string; store_id: number; staff_id: number;
  remarks: string; phone: string; real_name: string;
}
export interface RechargeOrderPage { list: RechargeOrderRow[]; count: number; page: number; limit: 20 }
export interface RechargeOrderStats {
  sum_price: string; sum_refund_price: string; sum_routine_price: string; sum_weixin_price: string;
}

const obj = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const signedInteger = (value: unknown): value is number => Number.isSafeInteger(value);
const string = (value: unknown): value is string => typeof value === 'string';
const minutePattern = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/u;
function shanghaiMinute(value: string): number {
  const match = minutePattern.exec(value);
  if (!match) throw new Error('充值时间须为上海时间 YYYY-MM-DD HH:mm');
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  if (year < 1970 || year > 2038 || hour > 23 || minute > 59) throw new Error('充值时间无效');
  const utc = Date.UTC(year, month - 1, day, hour, minute);
  const date = new Date(utc);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) throw new Error('充值日期无效');
  const seconds = Math.floor((utc - 8 * 3600_000) / 1000);
  if (seconds < 0 || seconds + 60 > 2_147_483_648) throw new Error('充值时间超出可查询范围');
  return seconds;
}
export function normalizeRechargeOrderQuery(value: RechargeOrderQuery): RechargeOrderQuery {
  if (!Number.isSafeInteger(value.page) || value.page < 1 || value.page > 501 || value.limit !== 20 ||
    !['all', 0, 1].includes(value.paid) || !string(value.keyword) || [...value.keyword.trim()].length > 80 ||
    /[\u0000-\u001f\u007f]/u.test(value.keyword) || (!!value.start_time !== !!value.end_time))
    throw new Error('充值订单查询条件无效');
  if (value.start_time) {
    const start = shanghaiMinute(value.start_time), end = shanghaiMinute(value.end_time);
    if (end < start || end - start > 366 * 86_400) throw new Error('充值订单时间范围无效');
  }
  return { ...value, keyword: value.keyword.trim() };
}
export function parseRechargeOrder(value: unknown): RechargeOrderRow {
  if (!obj(value) || !integer(value.id) || value.id === 0 || !signedInteger(value.uid) || !signedInteger(value.paid) ||
    !signedInteger(value.add_time) || !signedInteger(value.pay_time) ||
    !['order_id', 'price', 'give_price', 'refund_price', 'paid_type', 'recharge_type', 'recharge_type_label',
      'nickname', 'avatar'].every(key => string(value[key])) ||
    typeof value.user_deleted !== 'boolean' || typeof value.user_missing !== 'boolean' ||
    !Array.isArray(value.issues) || !value.issues.every(string)) throw new Error('充值订单响应格式错误');
  return value as unknown as RechargeOrderRow;
}
export function parseRechargeOrderPage(value: unknown, query: RechargeOrderQuery): RechargeOrderPage {
  if (!obj(value) || !Array.isArray(value.list) || !integer(value.count) || value.page !== query.page ||
    value.limit !== 20 || value.list.length > 20 || value.list.length > value.count) throw new Error('充值订单分页格式错误');
  const list = value.list.map(parseRechargeOrder);
  if (new Set(list.map(row => row.id)).size !== list.length) throw new Error('充值订单分页重复');
  return { list, count: value.count, page: query.page, limit: 20 };
}
export function parseRechargeOrderDetail(value: unknown, id: number): RechargeOrderDetail {
  const row = parseRechargeOrder(value);
  if (row.id !== id || !obj(value) || !['trade_no', 'channel_type', 'remarks', 'phone', 'real_name'].every(key => string(value[key])) ||
    !signedInteger(value.store_id) || !signedInteger(value.staff_id)) throw new Error('充值订单详情格式错误');
  return value as unknown as RechargeOrderDetail;
}
export function parseRechargeOrderStats(value: unknown): RechargeOrderStats {
  if (!obj(value) || !['sum_price', 'sum_refund_price', 'sum_routine_price', 'sum_weixin_price'].every(key => string(value[key])))
    throw new Error('充值统计响应格式错误');
  return value as unknown as RechargeOrderStats;
}
export async function apiRechargeOrderList(input: RechargeOrderQuery, signal?: AbortSignal): Promise<RechargeOrderPage> {
  const query = normalizeRechargeOrderQuery(input);
  return parseRechargeOrderPage(await getData<unknown>(request.get('/finance/recharge-orders', { params: query, signal })), query);
}
export async function apiRechargeOrderStats(input: RechargeOrderQuery, signal?: AbortSignal): Promise<RechargeOrderStats> {
  const query = normalizeRechargeOrderQuery(input);
  return parseRechargeOrderStats(await getData<unknown>(request.get('/finance/recharge-orders/stats', { params: query, signal })));
}
export async function apiRechargeOrderDetail(id: number, signal?: AbortSignal): Promise<RechargeOrderDetail> {
  if (!integer(id) || id === 0) throw new Error('充值订单 ID 无效');
  return parseRechargeOrderDetail(await getData<unknown>(request.get(`/finance/recharge-orders/${id}`, { signal })), id);
}
export function rechargeOrderTime(seconds: number): string {
  if (!seconds) return '—';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(seconds * 1000));
}
