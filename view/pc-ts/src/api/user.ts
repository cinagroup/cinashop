/**
 * 用户 API
 */
import request, { getData } from "@/utils/request";
import type { GoodsItem } from "@/types/product";
import { normalizeCouponPage, type CouponPage } from "./couponWallet";

export interface UserInfo {
  uid: number;
  account?: string;
  phone?: string;
  nickname?: string;
  now_money?: string;
  integral?: number;
  [key: string]: unknown;
}

/** 收藏列表 (GET /api/collect/user) */
export interface CollectListResult {
  list: GoodsItem[];
  count: number;
}

export function apiCollectList(params: {
  page?: number;
  limit?: number;
  category?: string;
} = {}): Promise<CollectListResult> {
  return getData(request.get<CollectListResult>("/collect/user", { params }));
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
export async function apiMyCoupons(types = 0, before?: number): Promise<CouponPage> {
  const response = await request.get(`/coupons/user/${types}`, { params: { limit: 20, ...(before ? { before } : {}) } });
  return normalizeCouponPage(response.data.data, response.headers["x-coupon-next-cursor"]);
}

/** 余额明细 (GET /api/user/balance) */
export function apiBalance(): Promise<unknown> {
  return getData(request.get<unknown>("/user/balance"));
}

/** 用户信息 (GET /api/user/info) */
export function apiUserInfo(): Promise<UserInfo> {
  return getData(request.get<UserInfo>("/user/info"));
}
