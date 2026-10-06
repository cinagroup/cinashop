import request, { getData } from '@/utils/request';

export interface IntegralCategoryInput {
  name: string;
  integral_min: number;
  integral_max: number;
  is_show: 0 | 1;
  sort: number;
}
export interface IntegralCategory extends IntegralCategoryInput {
  id: number;
  add_time: string;
  revision: string;
}
export interface IntegralCategoryQuery {
  page: number;
  limit: number;
  name?: string;
  is_show?: '' | 'all' | 0 | 1;
}
export interface IntegralCategoryPage { list: IntegralCategory[]; count: number; page: number; limit: number }
export interface IntegralCategoryMutationKey { request_id: string; revision: string }
export type IntegralCategorySave = IntegralCategoryInput & { request_id: string; revision?: string };

function integer(value: unknown, min = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= 2_147_483_647;
}
export function parseIntegralCategory(value: unknown): IntegralCategory {
  const row = value as IntegralCategory | null;
  if (!row || !integer(row.id, 1) || typeof row.name !== 'string' || typeof row.add_time !== 'string' ||
    !integer(row.integral_min) || !integer(row.integral_max) || !integer(row.sort) || ![0, 1].includes(row.is_show) ||
    typeof row.revision !== 'string' || !/^[a-f0-9]{64}$/u.test(row.revision)) throw new Error('积分分类记录格式错误');
  return row;
}
export function parseIntegralCategoryPage(value: unknown, query: IntegralCategoryQuery): IntegralCategoryPage {
  const result = value as IntegralCategoryPage | null;
  if (!result || !Array.isArray(result.list) || !Number.isSafeInteger(result.count) || result.count < 0 ||
    result.page !== query.page || result.limit !== query.limit || result.list.length > query.limit || result.list.length > result.count) {
    throw new Error('积分分类分页响应格式错误');
  }
  const ids = new Set<number>();
  for (const item of result.list) {
    const row = parseIntegralCategory(item);
    if (ids.has(row.id)) throw new Error('积分分类记录重复');
    ids.add(row.id);
  }
  return result;
}
function mutationResult(value: unknown, expectedId: number): { id: number } {
  const result = value as { id: number } | null;
  if (!result || !integer(result.id, 1) || (expectedId !== 0 && result.id !== expectedId)) {
    throw new Error('操作响应格式错误，请重新读取分类核对结果');
  }
  return result;
}

export async function apiIntegralCategoryList(params: IntegralCategoryQuery, signal?: AbortSignal): Promise<IntegralCategoryPage> {
  return parseIntegralCategoryPage(await getData<unknown>(request.get('/marketing/integral-categories', { params, signal })), params);
}
export async function apiIntegralCategoryDetail(id: number, signal?: AbortSignal): Promise<IntegralCategory> {
  const row = parseIntegralCategory(await getData<unknown>(request.get(`/marketing/integral-categories/${id}`, { signal })));
  if (row.id !== id) throw new Error('积分分类详情与当前记录不一致');
  return row;
}
export async function apiIntegralCategorySave(id: number, data: IntegralCategorySave, signal?: AbortSignal): Promise<{ id: number }> {
  const response = id === 0
    ? request.post('/marketing/integral-categories', data, { signal })
    : request.put(`/marketing/integral-categories/${id}`, data, { signal });
  return mutationResult(await getData<unknown>(response), id);
}
export async function apiIntegralCategoryStatus(id: number, data: IntegralCategoryMutationKey & { is_show: 0 | 1 }, signal?: AbortSignal): Promise<{ id: number }> {
  return mutationResult(await getData<unknown>(request.put(`/marketing/integral-categories/${id}/status`, data, { signal })), id);
}
export async function apiIntegralCategoryDelete(id: number, data: IntegralCategoryMutationKey, signal?: AbortSignal): Promise<{ id: number }> {
  return mutationResult(await getData<unknown>(request.delete(`/marketing/integral-categories/${id}`, { data, signal })), id);
}
