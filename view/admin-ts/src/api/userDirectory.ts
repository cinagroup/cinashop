import request, { getData } from '@/utils/request';
import type { AdminUser } from '@/types/admin';
import { validId, type DirectoryOption, type OptionKind, type UserDirectoryQuery } from '@/utils/userDirectoryFilters';
export interface UserDirectoryPage { list: AdminUser[]; count: number; page: number; limit: number }
export interface UserFilterOptionPage { list: DirectoryOption[]; count: number; page: number; limit: number; selected: DirectoryOption[]; missing_ids: number[] }
export interface UserFilterRegion { id: number; name: string; children?: [] }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('用户目录响应格式错误');
  return value as Record<string, unknown>;
}
function integer(value: unknown, minimum: number): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum; }
function page(value: unknown): Record<string, unknown> {
  const data = record(value);
  if (!Array.isArray(data.list) || !integer(data.count, 0) || !integer(data.page, 1) || data.page > 10000 ||
    !integer(data.limit, 1) || data.limit > 100 || data.list.length !== Math.min(data.limit, Math.max(0, data.count - (data.page - 1) * data.limit))) throw Error('用户目录分页响应错误');
  return data;
}
export function parseUserDirectoryPage(value: unknown): UserDirectoryPage {
  const data = page(value), seen = new Set<number>();
  const list = (data.list as unknown[]).map(entry => {
    const row = record(entry);
    if (!validId(row.uid) || seen.has(row.uid) || !['account', 'nickname', 'phone', 'avatar', 'now_money'].every(key => typeof row[key] === 'string') ||
      !/^-?\d{1,10}(?:\.\d{1,2})?$/.test(row.now_money as string) || (!integer(row.integral, -2147483648) || row.integral > 2_147_483_647) ||
      !validId(row.level, 0) || ![0, 1].includes(row.status as number) || (!integer(row.add_time, -2147483648) || row.add_time > 2_147_483_647) || !validId(row.spread_uid, 0)) throw Error('用户目录记录响应错误');
    seen.add(row.uid);
    // Retain only the explicit UI fields; no detail/private extras survive this boundary.
    return { uid: row.uid, account: row.account, nickname: row.nickname, phone: row.phone, avatar: row.avatar,
      now_money: row.now_money, integral: row.integral, level: row.level, status: row.status,
      add_time: row.add_time, spread_uid: row.spread_uid } as AdminUser;
  });
  return { list, count: data.count as number, page: data.page as number, limit: data.limit as number };
}
function options(value: unknown): DirectoryOption[] {
  if (!Array.isArray(value) || value.length > 100) throw Error('筛选选项响应错误');
  const seen = new Set<number>();
  return value.map(entry => {
    const row = record(entry);
    if (!validId(row.id) || seen.has(row.id) || typeof row.name !== 'string' || [...row.name].length > 255) throw Error('筛选选项记录错误');
    seen.add(row.id); return { id: row.id, name: row.name.trim() ? row.name : `未命名 #${row.id}` };
  });
}
export function parseUserFilterOptionPage(value: unknown): UserFilterOptionPage {
  const data = page(value), list = options(data.list), selected = options(data.selected);
  if (!Array.isArray(data.missing_ids) || data.missing_ids.length > 100 || data.missing_ids.some(id => !validId(id)) || new Set(data.missing_ids).size !== data.missing_ids.length || data.missing_ids.some(id => selected.some(row => row.id === id))) throw Error('已选条件响应错误');
  return { list, selected, missing_ids: data.missing_ids as number[], count: data.count as number, page: data.page as number, limit: data.limit as number };
}
export async function apiUserDirectory(query: UserDirectoryQuery, signal?: AbortSignal): Promise<UserDirectoryPage> {
  return parseUserDirectoryPage(await getData<unknown>(request.get('/user/list', { params: query, signal })));
}
export async function apiUserFilterOptions(query: { kind: OptionKind; page: number; limit: number; keyword?: string; selected_ids?: string }, signal?: AbortSignal): Promise<UserFilterOptionPage> {
  const data = parseUserFilterOptionPage(await getData<unknown>(request.get('/user/filter_options', { params: query, signal })));
  if (data.page !== query.page || data.limit !== query.limit) throw Error('筛选选项分页与请求不一致');
  const ids = query.selected_ids ? query.selected_ids.split(',').map(Number) : [];
  if (data.selected.length + data.missing_ids.length !== ids.length || [...data.selected.map(row => row.id), ...data.missing_ids].some(id => !ids.includes(id))) throw Error('已选筛选条件与请求不一致');
  return data;
}
export async function apiUserFilterRegions(pid: number, signal?: AbortSignal): Promise<UserFilterRegion[]> {
  if (!validId(pid, 0)) throw Error('地区ID无效');
  const data = await getData<unknown>(request.get('/user/filter_regions', { params: { pid }, signal }));
  if (!Array.isArray(data) || data.length > 1000) throw Error('地区选项响应错误');
  const seen = new Set<number>();
  return data.map(value => { const row = record(value);
    if (!validId(row.id) || seen.has(row.id) || typeof row.name !== 'string' || !row.name.trim() || [...row.name].length > 100 || row.children !== undefined && (!Array.isArray(row.children) || row.children.length)) throw Error('地区记录响应错误');
    seen.add(row.id); return { id: row.id, name: row.name, ...(row.children ? { children: [] as [] } : {}) };
  });
}
