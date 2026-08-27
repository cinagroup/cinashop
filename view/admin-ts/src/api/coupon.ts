/**
 * Admin 优惠券管理 API
 */
import request, { getData } from "@/utils/request";

const previewMode =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";

export interface CouponItem {
  id: number;
  couponTitle: string;
  couponPrice: string;
  useMinPrice: string;
  day: number;
  status: number;
  sort: number;
  totalCount: number;
  remainCount: number;
  type: number;
}

/** 优惠券列表 (GET /adminapi/coupon/list) */
export function apiAdminCouponList(page = 1, limit = 10): Promise<CouponItem[]> {
  return getData(request.get<CouponItem[]>("/coupon/list", { params: { page, limit } }));
}

/** 新增/编辑优惠券 (POST /adminapi/coupon/save) */
export function apiAdminCouponSave(params: {
  id?: number;
  title: string;
  coupon_price: string;
  use_min_price: string;
  day?: number;
  status?: number;
}): Promise<{ id: number }> {
  return getData(request.post<{ id: number }>("/coupon/save", params));
}

/** 上架/下架 (POST /adminapi/coupon/status/:id) */
export function apiAdminCouponStatus(id: number, status: number): Promise<null> {
  return getData(request.post<null>(`/coupon/status/${id}`, { status }));
}

/** 删除优惠券 (DELETE /adminapi/coupon/del/:id) */
export function apiAdminCouponDel(id: number): Promise<null> {
  return getData(request.delete<null>(`/coupon/del/${id}`));
}

/** 统计概览 (GET /adminapi/statistic/overview) */
export function apiAdminStatisticOverview(): Promise<{
  today: { orderCount: number; sales: string };
  yesterday: { orderCount: number; sales: string };
  total: { orderCount: number; sales: string; productCount: number; userCount: number; refundCount: number };
}> {
  if (previewMode) {
    return Promise.resolve({
      today: { orderCount: 19, sales: "2687.20" },
      yesterday: { orderCount: 16, sales: "2148.80" },
      total: { orderCount: 1286, sales: "186420.50", productCount: 71, userCount: 368, refundCount: 12 },
    });
  }
  return getData(request.get("/statistic/overview"));
}
