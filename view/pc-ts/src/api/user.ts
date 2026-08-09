/**
 * 用户 API
 */
import request, { getData } from "@/utils/request";

/** 收藏列表 (GET /api/collect/user) */
export function apiCollectList(): Promise<number[]> {
  return getData(request.get<number[]>("/collect/user"));
}

/** 收藏商品 (POST /api/collect/add) */
export function apiCollectAdd(ids: number[]): Promise<{ count: number }> {
  return getData(request.post<{ count: number }>("/collect/add", { ids }));
}

/** 取消收藏 (POST /api/collect/del) */
export function apiCollectDel(ids: number[]): Promise<null> {
  return getData(request.post<null>("/collect/del", { ids }));
}

/** 我的优惠券 (GET /api/coupons/user/:types) */
export function apiMyCoupons(types = 0): Promise<unknown[]> {
  return getData(request.get<unknown[]>(`/coupons/user/${types}`));
}

/** 余额明细 (GET /api/user/balance) */
export function apiBalance(): Promise<unknown> {
  return getData(request.get<unknown>("/user/balance"));
}

/** 用户信息 (GET /api/user/info) */
export function apiUserInfo(): Promise<unknown> {
  return getData(request.get("/user/info"));
}
