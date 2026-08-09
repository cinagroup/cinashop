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

/** 秒杀活动列表 (GET /adminapi/activity/seckill) */
export function apiAdminSeckillList(): Promise<ActivityItem[]> {
  return getData(request.get<ActivityItem[]>("/activity/seckill"));
}

/** 拼团活动列表 (GET /adminapi/activity/combination) */
export function apiAdminCombinationList(): Promise<ActivityItem[]> {
  return getData(request.get<ActivityItem[]>("/activity/combination"));
}

/** 砍价活动列表 (GET /adminapi/activity/bargain) */
export function apiAdminBargainList(): Promise<ActivityItem[]> {
  return getData(request.get<ActivityItem[]>("/activity/bargain"));
}

/** 积分商品列表 (GET /adminapi/activity/integral) */
export function apiAdminIntegralList(): Promise<
  (ActivityItem & { integral: number })[]
> {
  return getData(request.get("/activity/integral"));
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
  { id: number; startTime: string; endTime: string; continuedTime: number; status: number }[]
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
