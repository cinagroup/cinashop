import request, { getData } from '@/utils/request';
import { buildCombinationCsv } from '@/utils/combinationCsv';
import type { CombinationQuery } from './combination';
import { orderNumber } from '@/utils/orderRead';
export interface CombinationGlobalHead { participant_record_count: number; success_count: number }
export interface CombinationStatisticsHead { id: number; store_name: string; activity_deleted: boolean; people_count: number; spread_count: number; start_count: number; success_count: number; pay_price: string; pay_count: number }
export interface CombinationGroup {
  id: number; combination_id: number; product_id: number; uid: number; nickname: string; avatar_preview: string; title: string;
  people: number; member_count_raw: number; participant_record_count: number; active_real_count: number; virtual_count: number;
  status: number; status_raw: number; is_refund: number; expired_pending: boolean; add_time: number; stop_time: string | null;
  deleted_user: boolean; missing_user: boolean; activity_deleted: boolean; activity_missing: boolean; issues: string[];
}
export interface CombinationMember {
  pink_id: number; combination_id: number; product_id: number; uid: number; nickname: string; avatar_preview: string;
  is_leader: boolean; is_virtual: number; is_refund: number; price: string; add_time: number; status_raw: number;
  deleted_user: boolean; missing_user: boolean; order_id: string; order_db_id: number | null;
  order_id_snapshot: string; order_key_snapshot: string; order_deleted: boolean; detail_available: boolean; issues: string[];
}
export interface CombinationStatisticsOrder {
  id: number; order_id: string; uid: number; real_name: string; user_phone: string; nickname: string; pay_price: string;
  total_num: number; add_time: number; pay_time: number; status: string; status_raw: number; shipping_type: number;
  refund_status: number; refund_type: number; parent_id: number; deleted: boolean; detail_available: boolean; issues: string[];
}
export interface CombinationReadPage<T> { list: T[]; count: number; page: number; limit: number }
export interface CombinationMembersPage extends CombinationReadPage<CombinationMember> { group_id: number; combination_id: number; replacement_leader_id: number | null }
export interface CombinationGroupQuery { page: number; limit: number; keyword: string; status: '' | 1 | 2 | 3; start_day?: string; end_day?: string; combination_id?: number }
export interface CombinationOrderQuery { page: number; limit: number; keyword: string; status: '' | 0 | 1 | 2 | 3 | 4 | 5 }
const root = '/activity', id = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const numeric = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value);
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const issues = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === 'string');
function requireId(value: number) { if (!id(value)) throw Error('拼团或团记录ID无效'); }
function query(value: { page: number; limit: number; keyword?: string }) {
  if (!id(value.page) || !id(value.limit) || value.limit > 100 || (value.page - 1) * value.limit > 10000 || (value.keyword !== undefined && (typeof value.keyword !== 'string' || [...value.keyword].length > 100))) throw Error('拼团查询超限或无效');
}
function fields(value: unknown, text: string[], numbers: string[], flags: string[]) {
  const row = value as Record<string, unknown>;
  if (!row || typeof row !== 'object' || text.some(key => typeof row[key] !== 'string') || numbers.some(key => !numeric(row[key])) || flags.some(key => typeof row[key] !== 'boolean') || !issues(row.issues)) throw Error('拼团历史记录响应不完整');
  return row;
}
function group(value: unknown): CombinationGroup {
  const row = fields(value, ['nickname','avatar_preview','title'], ['id','combination_id','product_id','uid','people','member_count_raw','participant_record_count','active_real_count','virtual_count','status','status_raw','is_refund','add_time'], ['expired_pending','deleted_user','missing_user','activity_deleted','activity_missing']);
  if (!(row.stop_time === null || typeof row.stop_time === 'string' && Number.isFinite(Date.parse(row.stop_time)))) throw Error('团记录响应无效');
  return value as CombinationGroup;
}
function member(value: unknown): CombinationMember {
  const row = fields(value, ['nickname','avatar_preview','price','order_id','order_id_snapshot','order_key_snapshot'], ['pink_id','combination_id','product_id','uid','is_virtual','is_refund','add_time','status_raw'], ['is_leader','deleted_user','missing_user','order_deleted','detail_available']);
  if (!(row.order_db_id === null || numeric(row.order_db_id))) throw Error('团成员响应无效');
  return value as CombinationMember;
}
function order(value: unknown): CombinationStatisticsOrder {
  fields(value, ['order_id','real_name','user_phone','nickname','pay_price','status'], ['id','uid','total_num','add_time','pay_time','status_raw','shipping_type','refund_status','refund_type','parent_id'], ['deleted','detail_available']);
  return value as CombinationStatisticsOrder;
}
function page<T>(value: unknown, request: { page: number; limit: number }, parse: (value: unknown) => T, key: (value: T) => number): CombinationReadPage<T> {
  const result = value as CombinationReadPage<T>;
  if (!result || !Array.isArray(result.list) || !count(result.count) || result.page !== request.page || result.limit !== request.limit || result.list.length > request.limit || result.list.length > result.count) throw Error('拼团分页响应不完整');
  result.list.forEach(parse);
  if (new Set(result.list.map(key)).size !== result.list.length) throw Error('拼团分页身份重复');
  return result;
}
export function combinationReadId(value: unknown) { const text = String(value ?? ''); return /^[1-9]\d*$/u.test(text) && id(Number(text)) ? Number(text) : 0; }
export function combinationGroupStatus(row: Pick<CombinationGroup, 'status' | 'expired_pending'>) {
  if (row.expired_pending && row.status === 1) return '已到期，待结算';
  return ({ 1: '进行中', 2: '已成团', 3: '未成团' } as Record<number,string>)[row.status] ?? '未知状态 #' + row.status;
}
export function combinationReadOrderAvailable(row: { order_id: string; detail_available: boolean; deleted?: boolean; order_deleted?: boolean }) {
  if (!row.detail_available || row.deleted || row.order_deleted || row.order_id === '0') return false;
  try { orderNumber(row.order_id); return true; } catch { return false; }
}
export function combinationReadDays(start: string, end: string) {
  for (const value of [start, end]) if (value && (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || new Date(value + 'T00:00:00Z').toISOString().slice(0,10) !== value)) throw Error('日期须为有效上海日历日期');
  if (start && end && start > end) throw Error('开始日期不能晚于结束日期');
  return { ...(start ? { start_day: start } : {}), ...(end ? { end_day: end } : {}) };
}
export async function apiCombinationGlobalHead(signal?: AbortSignal): Promise<CombinationGlobalHead> {
  const result = await getData(request.get(root + '/combination-groups/head', { signal })) as CombinationGlobalHead;
  if (!result || !count(result.participant_record_count) || !count(result.success_count)) throw Error('全局汇总响应无效');
  return result;
}
export async function apiCombinationGroups(value: CombinationGroupQuery, signal?: AbortSignal) {
  query(value);
  return page(await getData(request.get(root + '/combination-groups', { params: value, signal })), value, group, row => row.id);
}
export async function apiCombinationMembers(groupId: number, value: { page: number; limit: number }, signal?: AbortSignal, activityId?: number) {
  requireId(groupId); query(value); if (activityId !== undefined) requireId(activityId);
  const path = activityId === undefined ? root + '/combination-groups/' + groupId + '/members' : root + '/combination-statistics/' + activityId + '/groups/' + groupId + '/members';
  const result = page(await getData(request.get(path, { params: value, signal })), value, member, row => row.pink_id) as CombinationMembersPage;
  if (result.group_id !== groupId || !numeric(result.combination_id) || (activityId !== undefined && result.combination_id !== activityId) || !(result.replacement_leader_id === null || id(result.replacement_leader_id)) || result.list.some(row => row.combination_id !== result.combination_id)) throw Error('团成员活动范围不一致');
  return result;
}
export async function apiCombinationStatisticsHead(activityId: number, signal?: AbortSignal): Promise<CombinationStatisticsHead> {
  requireId(activityId);
  const result = await getData(request.get(root + '/combination-statistics/' + activityId + '/head', { signal })) as CombinationStatisticsHead;
  if (!result || result.id !== activityId || typeof result.store_name !== 'string' || typeof result.activity_deleted !== 'boolean' || typeof result.pay_price !== 'string' || ![result.people_count,result.spread_count,result.start_count,result.success_count,result.pay_count].every(count)) throw Error('活动汇总响应无效');
  return result;
}
export async function apiCombinationStatisticsGroups(activityId: number, value: Omit<CombinationGroupQuery,'combination_id'>, signal?: AbortSignal) {
  requireId(activityId); query(value);
  const result = page(await getData(request.get(root + '/combination-statistics/' + activityId + '/groups', { params: value, signal })), value, group, row => row.id);
  if (result.list.some(row => row.combination_id !== activityId)) throw Error('团记录活动范围不一致');
  return result;
}
export async function apiCombinationStatisticsOrders(activityId: number, value: CombinationOrderQuery, signal?: AbortSignal) {
  requireId(activityId); query(value);
  const data = await getData(request.get(root + '/combination-statistics/' + activityId + '/orders', { params: value, signal })) as CombinationReadPage<CombinationStatisticsOrder> & { id: number; combination_id: number };
  if (data?.id !== activityId || data.combination_id !== activityId) throw Error('订单活动范围不一致');
  const result = page(data, value, order, row => row.id);
  return result;
}
export const combinationExportHeaders = ['编号','拼团名称','划线价','拼团价','库存','开团数','参与记录数','成团数量','销量','商品状态','结束时间'] as const;
export const combinationExportKeys = ['id','title','ot_price','price','stock','people','count_people_all','count_people_pink','sales','is_show','stop_time'] as const;
export interface CombinationExportManifest {
  header: string[]; filekey: string[]; export: Record<(typeof combinationExportKeys)[number],string>[];
  filename: string; count: number; page: number; limit: number; has_more: boolean; snapshot: string; csv_bytes: number;
  max_rows: number; max_bytes: number; timezone: string;
}
export type CombinationExportQuery = Pick<CombinationQuery,'keyword'|'phase'|'status'> & { page: number; limit: number; snapshot?: string };
export async function apiCombinationExport(value: CombinationExportQuery, signal?: AbortSignal): Promise<CombinationExportManifest> {
  if (!id(value.page) || !id(value.limit) || value.limit > 1000 || value.page > 100000 || (value.page > 1 && !/^[a-f0-9]{64}$/u.test(value.snapshot ?? ''))) throw Error('导出分页或快照无效');
  const result = await getData(request.get(root + '/combinations/export', { params: value, signal })) as CombinationExportManifest;
  const offset = (value.page - 1) * value.limit;
  if (!result || JSON.stringify(result.header) !== JSON.stringify(combinationExportHeaders) || JSON.stringify(result.filekey) !== JSON.stringify(combinationExportKeys) ||
    !Array.isArray(result.export) || result.export.some(row => !row || combinationExportKeys.some(key => typeof row[key] !== 'string')) ||
    !count(result.count) || result.count > 100000 || result.page !== value.page || result.limit !== value.limit ||
    result.export.length !== Math.min(value.limit, Math.max(0,result.count-offset)) || result.has_more !== (offset + result.export.length < result.count) ||
    !/^[a-f0-9]{64}$/u.test(result.snapshot) || (value.snapshot !== undefined && value.snapshot !== result.snapshot) ||
    !count(result.csv_bytes) || result.csv_bytes > 16777216 || result.max_rows !== 100000 || result.max_bytes !== 16777216 ||
    result.filename !== '拼团商品导出' || result.timezone !== 'Asia/Shanghai' ||
    result.export.some(row => /^[\s\u200b\ufeff]*[=+\-@]/u.test(row.title) || /^[\t\r\n]/u.test(row.title))) throw Error('导出清单不完整或快照已变化，请重新导出');
  return result;
}
export async function collectCombinationExport(value: Pick<CombinationQuery,'keyword'|'phase'|'status'>, signal: AbortSignal, progress: (read: number, total: number) => void) {
  const rows: CombinationExportManifest['export'] = [], seen = new Set<string>();
  let first: CombinationExportManifest | null = null;
  for (let next = 1; next <= 100; next++) {
    if (signal.aborted) throw new DOMException('导出已取消','AbortError');
    const result = await apiCombinationExport({ ...value, page: next, limit: 1000, ...(first ? { snapshot: first.snapshot } : {}) }, signal);
    if (signal.aborted) throw new DOMException('导出已取消','AbortError');
    if (!first) first = result;
    if (result.count !== first.count || result.csv_bytes !== first.csv_bytes || result.snapshot !== first.snapshot) throw Error('导出期间数据发生变化，请重试');
    for (const row of result.export) {
      if (!/^[1-9]\d*$/u.test(row.id) || seen.has(row.id)) throw Error('导出记录身份重复或无效');
      seen.add(row.id); rows.push(row);
    }
    progress(rows.length, first.count);
    if (!result.has_more) {
      if (rows.length !== first.count) throw Error('导出结果不完整');
      const csv = buildCombinationCsv(first.header, rows.map(row => first!.filekey.map(key => row[key as keyof typeof row])), first.max_bytes, true);
      if (new TextEncoder().encode(csv).byteLength !== first.csv_bytes) throw Error('导出文件字节数与完整清单不一致');
      return { csv, filename: first.filename };
    }
  }
  throw Error('导出超过完整容量，请缩小筛选范围');
}
