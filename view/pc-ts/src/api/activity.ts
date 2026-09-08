/**
 * 营销活动 API
 */
import request, { getData } from "@/utils/request";
import { parseSeckillIndex, parseSeckillList, parseSeckillSelection } from "../../../common/seckillPurchase";

export interface DiscountPackageSku {
  id: number;
  unique: string;
  suk: string;
  price: string;
  stock: number;
  image?: string;
  product_price: string;
}

export interface DiscountPackageProduct {
  id: number;
  product_id: number;
  title: string;
  image: string;
  type: number;
  productValue: DiscountPackageSku[];
}

export interface DiscountPackage {
  id: number;
  title: string;
  image: string;
  type: number;
  freeShipping: number;
  isSupportRefund: number;
  min_price: string;
  max_discounts_price: string;
  products: DiscountPackageProduct[];
}

/** 可领取优惠券 (GET /api/coupons) */
export function apiCoupons(): Promise<unknown[]> {
  return getData(request.get<unknown[]>("/coupons"));
}

/** 领取优惠券 (POST /api/coupon/receive) */
export function apiCouponReceive(id: number): Promise<{ couponUserId: number }> {
  return getData(request.post<{ couponUserId: number }>("/coupon/receive", { id }));
}

/** Keep one normalized user-coupon contract for both API entry points. */
export { apiMyCoupons } from "./user";

/** 秒杀时间段 (GET /api/seckill/index) */
export async function apiSeckillIndex() {
  return parseSeckillIndex(await getData(request.get("/seckill/index")));
}

/** 秒杀商品列表 (GET /api/seckill/list/:time) */
export async function apiSeckillList(timeId: number, page = 1, limit = 20) {
  return parseSeckillList(await getData(request.get(`/seckill/list/${timeId}`, { params: { page, limit } })));
}

/** Activity-specific selection only; never fall back to ordinary product SKUs. */
export async function apiSeckillSelection(id: number) {
  return parseSeckillSelection(await getData(request.get(`/seckill/detail/${id}`, { params: { view: "skus" } })), id);
}

/** 拼团列表 (GET /api/combination/list) */
export function apiCombinationList(): Promise<unknown[]> {
  return getData(request.get<unknown[]>("/combination/list"));
}

/** 砍价列表 (GET /api/bargain/list) */
export function apiBargainList(): Promise<unknown[]> {
  return getData(request.get<unknown[]>("/bargain/list"));
}

/** 砍价详情 (GET /api/bargain/detail/:id) */
export function apiBargainDetail(id: number): Promise<unknown> {
  return getData(request.get<unknown>(`/bargain/detail/${id}`));
}

/** 发起砍价 (POST /api/bargain/start) */
export function apiBargainStart(bargainId: number): Promise<{ id: number }> {
  return getData(request.post<{ id: number }>("/bargain/start", { bargain_id: bargainId }));
}

/** 帮砍 (POST /api/bargain/help) */
export function apiBargainHelp(bargainUserId: number): Promise<{ price: string }> {
  return getData(request.post<{ price: string }>("/bargain/help", { bargain_user_id: bargainUserId }));
}

/** 我的砍价列表 (GET /api/bargain/user/list) */
export function apiMyBargains(): Promise<unknown[]> {
  return getData(request.get<unknown[]>("/bargain/user/list"));
}

/** 取消砍价 (POST /api/bargain/user/cancel) */
export function apiBargainCancel(id: number): Promise<void> {
  return getData(request.post<void>("/bargain/user/cancel", { id }));
}

/** 拼团详情 (GET /api/combination/pink/:id) */
export function apiCombinationPink(id: number): Promise<unknown> {
  return getData(request.get<unknown>(`/combination/pink/${id}`));
}

/** 拼团成功人数与头像 (GET /api/pink) */
export function apiPinkStats(type = 1): Promise<{ pink_count: number; avatars: string[] }> {
  return getData(request.get<{ pink_count: number; avatars: string[] }>("/pink", { params: { type } }));
}

/** 商品可购买的固定/任选搭配套餐。 */
export function apiDiscountPackages(productId: number): Promise<DiscountPackage[]> {
  return getData(request.get<DiscountPackage[]>(`/store_discounts/list/${productId}`));
}
