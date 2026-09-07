import request, { getData } from "@/utils/request";
import { captureAuthSession, isCurrentAuthSession, getUid } from "@/utils/auth";
import { couponProductId, normalizeCouponProducts } from "../../../common/couponProducts";
import { normalizeScopeDescription } from "../../../common/couponScopeDescription";
import { couponSearchOptions, couponSearchCursor, normalizeCouponSearch, type CouponSearchOptions } from "../../../common/couponProductSearch";

export async function apiCouponProductSearch(couponId: number, options: CouponSearchOptions, cursor?: string) {
  couponProductId(couponId); const query = couponSearchOptions(options.keyword, options.sort);
  if (cursor !== undefined) couponSearchCursor(cursor);
  const owner = captureAuthSession();
  if (!owner.token || getUid() <= 0) throw new Error("请先登录后查看券范围商品");
  const data = await getData<unknown>(request.get(`/coupons/user/${couponId}/products`, { params: { view: "search", limit: 20, ...query, ...(cursor !== undefined ? { cursor } : {}) } }));
  if (!isCurrentAuthSession(owner)) throw new Error("登录状态已变化，请重新加载");
  return normalizeCouponSearch(data, couponId, query, cursor);
}

export async function apiCouponScopeDescription(couponId: number, before?: number) {
  couponProductId(couponId); if (before !== undefined) couponProductId(before);
  const owner = captureAuthSession();
  if (!owner.token || getUid() <= 0) throw new Error("请先登录后查看券范围说明");
  const data = await getData<unknown>(request.get(`/coupons/user/${couponId}/products`, { params: { view: "scope", limit: 20, ...(before !== undefined ? { before } : {}) } }));
  if (!isCurrentAuthSession(owner)) throw new Error("登录状态已变化，请重新加载");
  return normalizeScopeDescription(data, couponId, before);
}

export async function apiCouponProducts(couponId: number, before?: number) {
  couponProductId(couponId); if (before !== undefined) couponProductId(before);
  const owner = captureAuthSession();
  if (!owner.token || getUid() <= 0) throw new Error("请先登录后查看券范围商品");
  const data = await getData<unknown>(request.get(`/coupons/user/${couponId}/products`, { params: { limit: 20, ...(before !== undefined ? { before } : {}) } }));
  if (!isCurrentAuthSession(owner)) throw new Error("登录状态已变化，请重新加载");
  return normalizeCouponProducts(data, couponId, before);
}
