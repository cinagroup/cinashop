/**
 * Admin 营销活动管理 API
 */
import request, { getData } from "@/utils/request";

export interface ActivityItem {
  id: number;
  productId?: number;
  storeName: string;
  image?: string;
  price: string;
  otPrice?: string;
  stock: number;
  sales: number;
  quota?: number;
  status: number;
  sort: number;
  [key: string]: unknown;
}

export interface ActivityListQuery {
  page: number;
  limit: number;
  keyword?: string;
  status?: 0 | 1;
}

export interface ActivityListPage<T extends ActivityItem = ActivityItem> {
  list: T[];
  count: number;
  page: number;
  limit: number;
}

async function activityList<T extends ActivityItem>(response: Parameters<typeof getData>[0], query?: ActivityListQuery): Promise<T[] | ActivityListPage<T>> {
  const result = await getData<T[] | ActivityListPage<T>>(response);
  if (query && (!result || Array.isArray(result) || !Array.isArray(result.list) ||
    !Number.isSafeInteger(result.count) || result.count < 0 || result.page !== query.page || result.limit !== query.limit ||
    result.list.length > query.limit || result.list.length > result.count ||
    result.list.some(item => !item || !Number.isSafeInteger(item.id) || item.id <= 0 || typeof item.storeName !== 'string'))) {
    throw new Error('活动分页响应格式错误');
  }
  return result;
}

/** 秒杀活动列表 (GET /adminapi/activity/seckill) */
export function apiAdminSeckillList(): Promise<ActivityItem[]>;
export function apiAdminSeckillList(query: ActivityListQuery, signal?: AbortSignal): Promise<ActivityListPage>;
export function apiAdminSeckillList(query?: ActivityListQuery, signal?: AbortSignal): Promise<ActivityItem[] | ActivityListPage> {
  return activityList(request.get("/activity/seckill", { params: query, signal }), query);
}

/** 拼团活动列表 (GET /adminapi/activity/combination) */
export function apiAdminCombinationList(): Promise<ActivityItem[]>;
export function apiAdminCombinationList(query: ActivityListQuery, signal?: AbortSignal): Promise<ActivityListPage>;
export function apiAdminCombinationList(query?: ActivityListQuery, signal?: AbortSignal): Promise<ActivityItem[] | ActivityListPage> {
  return activityList(request.get("/activity/combination", { params: query, signal }), query);
}

/** 砍价活动列表 (GET /adminapi/activity/bargain) */
export function apiAdminBargainList(): Promise<ActivityItem[]>;
export function apiAdminBargainList(query: ActivityListQuery, signal?: AbortSignal): Promise<ActivityListPage>;
export function apiAdminBargainList(query?: ActivityListQuery, signal?: AbortSignal): Promise<ActivityItem[] | ActivityListPage> {
  return activityList(request.get("/activity/bargain", { params: query, signal }), query);
}

/** 积分商品列表 (GET /adminapi/activity/integral) */
type IntegralActivityItem = ActivityItem & { integral: number };
export function apiAdminIntegralList(): Promise<IntegralActivityItem[]>;
export function apiAdminIntegralList(query: ActivityListQuery, signal?: AbortSignal): Promise<ActivityListPage<IntegralActivityItem>>;
export function apiAdminIntegralList(query?: ActivityListQuery, signal?: AbortSignal): Promise<IntegralActivityItem[] | ActivityListPage<IntegralActivityItem>> {
  return activityList<IntegralActivityItem>(request.get("/activity/integral", { params: query, signal }), query);
}

/** 活动上下架 (POST /adminapi/activity/status) */
export function apiAdminActivityStatus(
  type: "seckill" | "combination" | "bargain" | "integral",
  id: number,
  status: number,
): Promise<null> {
  return getData(request.post<null>("/activity/status", { type, id, status }));
}

/** 拼团团列表 (GET /adminapi/activity/pink/:combinationId) */
export function apiAdminPinkList(combinationId: number): Promise<
  { id: number; uid: number; orderId: string; people: number; status: number; addTime: number }[]
> {
  return getData(request.get(`/activity/pink/${combinationId}`));
}

/** 砍价参与记录 (GET /adminapi/activity/bargain_users/:bargainId) */
export function apiAdminBargainUsers(bargainId: number): Promise<
  { id: number; uid: number; bargainPrice: string; bargainPriceMin: string; price: string; status: number; addTime: number }[]
> {
  return getData(request.get(`/activity/bargain_users/${bargainId}`));
}

/** 秒杀时段列表 (GET /adminapi/activity/seckill_times) */
export function apiAdminSeckillTimes(): Promise<
  { id: number; startTime: string; endTime: string; status: number }[]
> {
  return getData(request.get("/activity/seckill_times"));
}

/** M20: 活动 CRUD */
export function apiAdminActivitySave(data: Record<string, unknown>): Promise<{ id: number }> {
  return getData(request.post<{ id: number }>("/activity/save", data));
}

export function apiAdminActivityDel(type: string, id: number): Promise<null> {
  return getData(request.delete<null>(`/activity/del/${type}/${id}`));
}

import type { BargainSkuOptions } from './bargainSkuEdit';
export type { BargainSkuOption, BargainSkuOptions } from './bargainSkuEdit';
export function apiAdminBargainSkuOptions(productId: number, activityId?: number): Promise<BargainSkuOptions> {
  return getData(request.get('/activity/bargain/sku-options', { params: { productId, activityId } }));
}
