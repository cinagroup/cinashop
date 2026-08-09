/**
 * 营销活动 API (秒杀/砍价/拼团)
 */
import { http } from "@/utils/request";

/** 秒杀时间段 (GET /api/seckill/index) */
export function apiSeckillIndex(): Promise<unknown[]> {
  return http.get<unknown[]>("/seckill/index");
}

/** 秒杀商品列表 (GET /api/seckill/list/:time) */
export function apiSeckillList(time: string): Promise<unknown[]> {
  return http.get<unknown[]>(`/seckill/list/${time}`);
}

/** 砍价列表 (GET /api/bargain/list) */
export function apiBargainList(): Promise<unknown[]> {
  return http.get<unknown[]>("/bargain/list");
}

/** 发起砍价 (POST /api/bargain/start) */
export function apiBargainStart(bargainId: number): Promise<{ id: number }> {
  return http.post<{ id: number }>("/bargain/start", { bargain_id: bargainId });
}

/** 我的砍价列表 (GET /api/bargain/user/list) */
export function apiMyBargains(): Promise<unknown[]> {
  return http.get<unknown[]>("/bargain/user/list");
}

/** 拼团列表 (GET /api/combination/list) */
export function apiCombinationList(): Promise<unknown[]> {
  return http.get<unknown[]>("/combination/list");
}
