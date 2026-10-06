import request, { getData } from '@/utils/request';
import axios from 'axios';

export interface CityDeliveryQuery {
  page: number; limit: number; station_type?: 1 | 2; status?: number; store_id?: number;
  keyword?: string; date_from?: number; date_to?: number;
}
export interface CityDeliveryStoreQuery { page: number; limit: number; keyword?: string }
export interface CityDeliveryOwner {
  kind: 'platform' | 'store' | 'supplier' | 'unknown'; id: number | null; label: string;
  image: string | null; is_show: number | null; is_del: number | null;
}
export interface CityDeliveryRecord {
  id: number; type: number; relation_id: number; uid: number; oid: number;
  station_type: number; provider_label: string; status: number; status_label: string;
  order_id: string; delivery_no: string; from_address: string; to_address: string; mark: string;
  add_time: number; owner: CityDeliveryOwner;
  origin_order: { id: number; order_id: string; pid: number; status: number; is_del: number } | null;
  distance_meters: number | null; distance_km: string | null;
  cargo_price: string | null; fee: string | null; deduct_fee: string | null;
  invalid_values: Record<string, string>; issues: string[];
}
export interface CityDeliveryStore { id: number; label: string; is_show: number; is_del: number; issues: string[] }
export interface CityDeliveryPage<T> { items: T[]; total: number; page: number; limit: number }
export interface CityDeliveryDetail {
  record: CityDeliveryRecord;
  metadata: { city_code: string; mer_id: number; mark: string; reason: string;
    receiver_name: string; receiver_phone: string; from_address: string; to_address: string };
}

const endpoint = '/city_delivery';
const maxInt = 2_147_483_647, minInt = -2_147_483_648;
const signed = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= minInt && value <= maxInt;
const positive = (value: unknown): value is number => signed(value) && value > 0;
const text = (value: unknown): value is string => typeof value === 'string';
const decimal = (value: unknown): value is string => text(value) && /^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('同城配送响应格式错误');
  return value as Record<string, unknown>;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every(text)) throw Error('同城配送诊断信息格式错误');
  return [...value];
}
function integer(value: unknown, min: number, max: number, label: string): number {
  if (!(typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0)
    || typeof value === 'string' && /^(?:0|-?[1-9]\d*)$/u.test(value))) throw Error(`${label}须为规范整数`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw Error(`${label}超出范围`);
  return result;
}
function keyword(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!text(value) || [...value.trim()].length > 100 || /[\u0000-\u001f\u007f]/u.test(value)) throw Error('关键词不超过100字，不能包含控制字符');
  return value.trim() || undefined;
}
function pagination(row: Record<string, unknown>, maxLimit: number): { page: number; limit: number } {
  const page = integer(row.page === undefined ? 1 : row.page, 1, maxInt, '页码'), limit = integer(row.limit === undefined ? 20 : row.limit, 1, maxLimit, '每页条数');
  if ((page - 1) * limit > 100_000) throw Error('分页偏移不能超过100000条，请缩小筛选范围');
  return { page, limit };
}
const absent = (value: unknown) => value === undefined || value === '';
/** Build only documented keys. Zero timestamps and status zero must not disappear. */
export function normalizeCityDeliveryQuery(input: unknown): CityDeliveryQuery {
  const row = object(input);
  if (Object.keys(row).some(key => !['page', 'limit', 'station_type', 'status', 'store_id', 'keyword', 'date_from', 'date_to'].includes(key))) throw Error('同城配送查询包含未知条件');
  const result: CityDeliveryQuery = pagination(row, 100), search = keyword(row.keyword);
  if (search !== undefined) result.keyword = search;
  if (!absent(row.station_type)) result.station_type = integer(row.station_type, 1, 2, '配送平台') as 1 | 2;
  if (!absent(row.status)) result.status = integer(row.status, minInt, maxInt, '配送状态');
  if (!absent(row.store_id)) result.store_id = integer(row.store_id, 1, maxInt, '门店ID');
  if (absent(row.date_from) !== absent(row.date_to)) throw Error('配送时间须同时填写起止值');
  if (!absent(row.date_from)) {
    result.date_from = integer(row.date_from, 0, maxInt, '开始时间'); result.date_to = integer(row.date_to, 0, maxInt, '结束时间');
    if (result.date_from > result.date_to) throw Error('结束时间不能早于开始时间');
  }
  return result;
}
export function normalizeCityDeliveryStoreQuery(input: unknown): CityDeliveryStoreQuery {
  const row = object(input);
  if (Object.keys(row).some(key => !['page', 'limit', 'keyword'].includes(key))) throw Error('门店查询包含未知条件');
  const result: CityDeliveryStoreQuery = pagination(row, 50), search = keyword(row.keyword);
  if (search !== undefined) result.keyword = search;
  return result;
}
/** Datetime picker text is Shanghai wall time; neither browser locale nor DST can shift it. */
export function cityDeliveryShanghaiSeconds(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/u.exec(value);
  if (!match) throw Error('配送时间须为上海时间，精确到秒');
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const utc = Date.UTC(year, month - 1, day, hour, minute, second), date = new Date(utc);
  if (year < 1970 || year > 2038 || date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month
    || date.getUTCDate() !== day || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) throw Error('配送时间无效');
  return integer((utc - 8 * 3_600_000) / 1000, 0, maxInt, '配送时间');
}
export function cityDeliveryTime(seconds: number, missingZero = true): string {
  if (!signed(seconds) || seconds < 0) return '时间无效';
  if (seconds === 0 && missingZero) return '未记录';
  const parts = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(seconds * 1000));
  const part = (type: string) => parts.find(item => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`;
}
/** Preserve decimal text; display never rounds historical fees or shifts metres a second time. */
export function cityDeliveryMoney(value: string | null): string { return value !== null && decimal(value) ? `¥${value}` : '未记录或历史值无效'; }
export function cityDeliveryDistance(value: string | null): string { return value !== null && decimal(value) ? `${value} km` : '未记录或历史值无效'; }
export function cityDeliveryOwnerLabel(owner: CityDeliveryOwner): string {
  const kind = { platform: '平台', store: '门店', supplier: '供应商', unknown: '未知归属' }[owner.kind];
  return `${kind}：${owner.label}${owner.id === null ? '' : `（#${owner.id}）`}`;
}
export function cityDeliveryStoreLabel(store: CityDeliveryStore): string {
  return `${store.label}（#${store.id}）${store.is_show === 0 ? ' · 已隐藏' : ''}${store.is_del === 1 ? ' · 已删除' : ''}${![0, 1].includes(store.is_show) || ![0, 1].includes(store.is_del) ? ' · 状态异常' : ''}`;
}
export function cityDeliveryOriginLabel(record: CityDeliveryRecord): string {
  if (record.origin_order) return record.origin_order.order_id || `订单 #${record.origin_order.id}`;
  if (record.issues.includes('origin_owner_unverified')) return '原订单归属无法核实';
  if (record.issues.includes('origin_uid_mismatch') || record.issues.includes('origin_owner_mismatch')) return '原订单关联不匹配';
  return record.issues.includes('origin_order_missing') ? '原订单已不存在' : '原订单无法核实';
}
export function cityDeliveryImage(value: string | null): string | undefined {
  if (!value || /[\u0000-\u0020\u007f\\]/u.test(value) || !(value.startsWith('/') && !value.startsWith('//') || /^https?:\/\//iu.test(value))) return undefined;
  return value;
}
export function cityDeliveryIssueLabel(value: string): string {
  const labels: Record<string, string> = { owner_relation_invalid: '归属类型与关联ID异常', owner_missing: '归属门店或供应商已不存在',
    owner_label_empty: '归属名称为空', owner_hidden: '归属已隐藏或显示标记异常', owner_deleted: '归属已删除或删除标记异常',
    owner_type_unknown: '归属类型无法识别', provider_unknown: '配送平台代码无法识别', status_unknown: '配送状态代码无法识别',
    status_ambiguous: '历史状态1的含义需核对', status_legacy_ambiguous: '历史状态1的含义需核对', origin_order_missing: '原订单已不存在', origin_uid_mismatch: '原订单用户与配送记录不匹配',
    origin_owner_mismatch: '原订单归属与配送记录不匹配', origin_owner_unverified: '原单当前站点与历史归属无法核实', origin_order_deleted: '原订单已删除', distance_invalid: '保存的配送距离无效',
    cargo_price_invalid: '保存的货物金额无效', fee_invalid: '保存的配送费用无效', deduct_fee_invalid: '保存的扣除费用无效' };
  return labels[value] ?? `历史诊断：${value}`;
}
export function cityDeliveryReadError(reason: unknown): string {
  if (axios.isAxiosError(reason)) {
    const data: unknown = reason.response?.data;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const message = (data as Record<string, unknown>).msg;
      if (typeof message === 'string' && message.trim() && [...message].length <= 500 && !/[\u0000-\u001f\u007f]/u.test(message)) return message;
    }
    return reason.code === 'ECONNABORTED' ? '读取超时，请重新读取' : '读取失败，请重新读取';
  }
  return reason instanceof Error ? reason.message : '请求失败，请重试';
}

function parseOwner(value: unknown): CityDeliveryOwner {
  const row = object(value);
  if (!text(row.kind) || !['platform', 'store', 'supplier', 'unknown'].includes(row.kind) || !text(row.label)
    || !(row.id === null || signed(row.id)) || !(row.image === null || text(row.image))
    || !(row.is_show === null || signed(row.is_show)) || !(row.is_del === null || signed(row.is_del))) throw Error('配送归属响应格式错误');
  return { kind: row.kind as CityDeliveryOwner['kind'], id: row.id as number | null, label: row.label,
    image: row.image as string | null, is_show: row.is_show as number | null, is_del: row.is_del as number | null };
}
export function parseCityDeliveryRecord(value: unknown): CityDeliveryRecord {
  const row = object(value);
  if (!positive(row.id) || !['type', 'relation_id', 'uid', 'oid', 'station_type', 'status', 'add_time'].every(key => signed(row[key]))
    || !['provider_label', 'status_label', 'order_id', 'delivery_no', 'from_address', 'to_address', 'mark'].every(key => text(row[key]))
    || !(row.distance_meters === null || typeof row.distance_meters === 'number' && Number.isFinite(row.distance_meters) && row.distance_meters >= 0)
    || !['distance_km', 'cargo_price', 'fee', 'deduct_fee'].every(key => row[key] === null || decimal(row[key]))) throw Error('配送记录响应格式错误');
  let origin_order: CityDeliveryRecord['origin_order'] = null;
  if (row.origin_order !== null) {
    const order = object(row.origin_order);
    if (!positive(order.id) || order.id !== row.oid || !text(order.order_id) || !['pid', 'status', 'is_del'].every(key => signed(order[key]))) throw Error('配送原订单响应格式错误');
    origin_order = { id: order.id, order_id: order.order_id, pid: order.pid as number, status: order.status as number, is_del: order.is_del as number };
  }
  const invalid = object(row.invalid_values), invalid_values: Record<string, string> = {};
  for (const [key, raw] of Object.entries(invalid)) {
    if (!text(raw)) throw Error('配送历史值诊断格式错误');
    if (['distance', 'distance_meters', 'cargo_price', 'fee', 'deduct_fee', 'add_time', 'type', 'relation_id', 'uid', 'oid', 'station_type', 'status', 'store_id', 'supplier_id'].includes(key)) invalid_values[key] = raw;
  }
  // Explicit projection excludes finish codes, provider raw payloads and future unreviewed metadata.
  return { id: row.id, type: row.type as number, relation_id: row.relation_id as number, uid: row.uid as number, oid: row.oid as number,
    station_type: row.station_type as number, provider_label: row.provider_label as string, status: row.status as number, status_label: row.status_label as string,
    order_id: row.order_id as string, delivery_no: row.delivery_no as string, from_address: row.from_address as string, to_address: row.to_address as string,
    mark: row.mark as string, add_time: row.add_time as number, owner: parseOwner(row.owner), origin_order,
    distance_meters: row.distance_meters as number | null, distance_km: row.distance_km as string | null,
    cargo_price: row.cargo_price as string | null, fee: row.fee as string | null, deduct_fee: row.deduct_fee as string | null,
    invalid_values, issues: strings(row.issues) };
}
function parseStore(value: unknown): CityDeliveryStore {
  const row = object(value);
  if (!positive(row.id) || !text(row.label) || !signed(row.is_show) || !signed(row.is_del)) throw Error('门店选择响应格式错误');
  return { id: row.id, label: row.label, is_show: row.is_show, is_del: row.is_del, issues: strings(row.issues) };
}
function parsePage<T>(value: unknown, query: { page: number; limit: number }, parse: (row: unknown) => T, id: (row: T) => number): CityDeliveryPage<T> {
  const row = object(value);
  if (!Array.isArray(row.items) || row.items.length > query.limit || !Number.isSafeInteger(row.total) || Number(row.total) < 0
    || row.items.length > Number(row.total) || row.page !== query.page || row.limit !== query.limit) throw Error('配送分页响应与请求不一致');
  const items = row.items.map(parse);
  if (new Set(items.map(id)).size !== items.length) throw Error('配送分页含重复记录ID');
  return { items, total: row.total as number, page: query.page, limit: query.limit };
}
export function parseCityDeliveryPage(value: unknown, query: CityDeliveryQuery): CityDeliveryPage<CityDeliveryRecord> {
  return parsePage(value, query, parseCityDeliveryRecord, row => row.id);
}
export function parseCityDeliveryStores(value: unknown, query: CityDeliveryStoreQuery): CityDeliveryPage<CityDeliveryStore> {
  return parsePage(value, query, parseStore, row => row.id);
}
export function parseCityDeliveryDetail(value: unknown, id: number): CityDeliveryDetail {
  const row = object(value), metadata = object(row.metadata), record = parseCityDeliveryRecord(row.record);
  if (record.id !== id || !signed(metadata.mer_id)
    || !['city_code', 'mark', 'reason', 'receiver_name', 'receiver_phone', 'from_address', 'to_address'].every(key => text(metadata[key]))) throw Error('配送详情响应与所选记录不一致');
  return { record, metadata: { city_code: metadata.city_code as string, mer_id: metadata.mer_id,
    mark: metadata.mark as string, reason: metadata.reason as string, receiver_name: metadata.receiver_name as string,
    receiver_phone: metadata.receiver_phone as string, from_address: metadata.from_address as string, to_address: metadata.to_address as string } };
}
export async function apiCityDeliveryRecords(input: CityDeliveryQuery, signal?: AbortSignal): Promise<CityDeliveryPage<CityDeliveryRecord>> {
  const query = normalizeCityDeliveryQuery(input);
  return parseCityDeliveryPage(await getData<unknown>(request.get(`${endpoint}/records`, { params: query, signal })), query);
}
export async function apiCityDeliveryDetail(id: number, signal?: AbortSignal): Promise<CityDeliveryDetail> {
  if (!positive(id)) throw Error('配送记录ID无效');
  return parseCityDeliveryDetail(await getData<unknown>(request.get(`${endpoint}/records/${id}`, { signal })), id);
}
export async function apiCityDeliveryStores(input: CityDeliveryStoreQuery, signal?: AbortSignal): Promise<CityDeliveryPage<CityDeliveryStore>> {
  const query = normalizeCityDeliveryStoreQuery(input);
  return parseCityDeliveryStores(await getData<unknown>(request.get(`${endpoint}/stores`, { params: query, signal })), query);
}

export interface CityDeliveryReadJob { controller: AbortController; identity: string; generation: number }
/** The page uses separate channels, and every completion is bound to its actor and request generation. */
export function createCityDeliveryReadGuard(identity: () => string | null) {
  let generation = 0, alive = true;
  const jobs = new Map<string, CityDeliveryReadJob>();
  function reset() { generation++; for (const job of jobs.values()) job.controller.abort(); jobs.clear(); }
  function cancel(channel: string) { jobs.get(channel)?.controller.abort(); jobs.delete(channel); }
  function begin(channel: string): CityDeliveryReadJob | null {
    const actor = identity(); if (!alive || actor === null) return null;
    cancel(channel); const job = { controller: new AbortController(), identity: actor, generation }; jobs.set(channel, job); return job;
  }
  function current(channel: string, job: CityDeliveryReadJob) {
    return alive && jobs.get(channel) === job && job.generation === generation && job.identity === identity() && !job.controller.signal.aborted;
  }
  function finish(channel: string, job: CityDeliveryReadJob) { const accepted = current(channel, job); if (jobs.get(channel) === job) jobs.delete(channel); return accepted; }
  return { begin, current, finish, cancel, reset, dispose() { alive = false; reset(); } };
}
