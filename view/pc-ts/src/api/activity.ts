/**
 * 营销活动 API
 */
import request, { getData } from "@/utils/request";

/** 可领取优惠券 (GET /api/coupons) */
export function apiCoupons(): Promise<unknown[]> {
  return getData(request.get<unknown[]>("/coupons"));
}

/** 领取优惠券 (POST /api/coupon/receive) */
export function apiCouponReceive(id: number): Promise<{ couponUserId: number }> {
  return getData(request.post<{ couponUserId: number }>("/coupon/receive", { id }));
}

/** 我的优惠券 (GET /api/coupons/user/:types) */
export function apiMyCoupons(types = 0): Promise<unknown[]> {
  return getData(request.get<unknown[]>(`/coupons/user/${types}`));
}

/** 秒杀时间段 (GET /api/seckill/index) */
export function apiSeckillIndex(): Promise<unknown[]> {
  return getData(request.get<unknown[]>("/seckill/index"));
}

/** 秒杀商品列表 (GET /api/seckill/list/:time) */
export function apiSeckillList(time: string): Promise<unknown[]> {
  return getData(request.get<unknown[]>(`/seckill/list/${time}`));
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

/** 加入拼团 (POST /api/pink) */
export function apiJoinPink(
  data: { combinationId: number; productId: number; orderId: string },
): Promise<{ pinkId: number; isLeader: boolean }> {
  return getData(
    request.post<{ pinkId: number; isLeader: boolean }>("/pink", {
      combination_id: data.combinationId,
      product_id: data.productId,
      order_id: data.orderId,
    }),
  );
}
