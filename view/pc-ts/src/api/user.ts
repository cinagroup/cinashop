/**
 * 用户 API
 */
import request, { getData } from "@/utils/request";
import type { GoodsItem } from "@/types/product";
import { normalizeCouponPage, normalizeCouponCounts, type CouponPage } from "./couponWallet";
import { captureAuthSession, isCurrentAuthSession, getUid } from "@/utils/auth";

export type WalletFilter = -1 | 0 | 1 | 2 | 3 | null;

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
export async function apiMyCoupons(types = 0, before?: number, filter: WalletFilter = null): Promise<CouponPage> {
  if (![0, 1, 2, 3].includes(types) || (before !== undefined && (!Number.isSafeInteger(before) || before <= 0))) throw new Error("优惠券查询参数无效");
  if (filter !== null && ![-1, 0, 1, 2, 3].includes(filter)) throw new Error("优惠券筛选参数无效");
  const owner = captureAuthSession();
  if (!owner.token || getUid() <= 0) throw new Error("请先登录后查看优惠券");
  const response = await request.get(`/coupons/user/${types}`, { params: { limit: 20, ...(before !== undefined ? { before } : { include_counts: 1 }), ...(filter !== null ? { type: filter } : {}) } });
  if (!isCurrentAuthSession(owner)) throw new Error("登录状态已变化，请重新加载优惠券");
  const page = normalizeCouponPage(response.data.data, response.headers["x-coupon-next-cursor"]);
  const counts = response.headers["x-coupon-counts"];
  if (counts !== undefined && counts !== null && counts !== "") {
    if (typeof counts !== "string" || counts.length > 512) throw new Error("优惠券数量无效");
    page.counts = normalizeCouponCounts(JSON.parse(counts));
  }
  return page;
}

/** 余额明细 (GET /api/user/balance) */
export function apiBalance(): Promise<unknown> {
  return getData(request.get<unknown>("/user/balance"));
}

/** 用户信息 (GET /api/user/info) */
export function apiUserInfo(): Promise<UserInfo> {
  return getData(request.get<UserInfo>("/user/info"));
}
