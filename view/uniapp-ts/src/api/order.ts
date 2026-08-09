/**
 * 购物车 + 订单 API
 */
import { http } from "@/utils/request";
import type { CartItem, OrderInfo, CreateOrderResult, UserAddress } from "@/types/order";

// ─── 购物车 ─────────────────────────────────────────────────
export function apiCartList(): Promise<CartItem[]> {
  return http.get<CartItem[]>("/cart/list");
}

export function apiCartAdd(params: {
  productId: number;
  unique: string;
  cartNum: number;
}): Promise<{ id: number; cartNum: number }> {
  return http.post<{ id: number; cartNum: number }>("/cart/add", params as Record<string, unknown>);
}

export function apiCartNum(id: number, cartNum: number): Promise<null> {
  return http.post<null>("/cart/num", { id, cartNum });
}

export function apiCartDel(ids: number[]): Promise<null> {
  return http.post<null>("/cart/del", { ids });
}

export function apiCartCount(): Promise<{ count: number }> {
  return http.get<{ count: number }>("/cart/count");
}

// ─── 订单 ───────────────────────────────────────────────────

/** camelCase → snake_case (后端返回驼峰, 前端类型用下划线) */
function toSnake(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const sk = k.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
    out[sk] = v;
  }
  return out;
}

export function apiOrderCreate(
  key: string,
  params: {
    cartIds: number[];
    realName?: string;
    userPhone?: string;
    province?: string;
    userAddress?: string;
    /** M17: 优惠券/备注/活动 */
    couponId?: number;
    mark?: string;
    type?: number;
    pinkId?: number;
    combinationId?: number;
    seckillId?: number;
    bargainUserId?: number;
  },
): Promise<CreateOrderResult> {
  return http.post<CreateOrderResult>(`/order/create/${key}`, params as Record<string, unknown>);
}

export async function apiOrderList(params: {
  type?: number;
  page?: number;
  limit?: number;
}): Promise<OrderInfo[]> {
  const list = await http.get<Record<string, unknown>[]>("/order/list", params as Record<string, unknown>);
  return list.map(toSnake) as unknown as OrderInfo[];
}

export async function apiOrderDetail(orderId: string): Promise<OrderInfo> {
  const data = await http.get<Record<string, unknown>>(`/order/detail/${orderId}`);
  return toSnake(data) as unknown as OrderInfo;
}

export function apiOrderPay(orderId: string): Promise<{ paid: boolean }> {
  return http.post<{ paid: boolean }>("/order/pay", { uni: orderId, paytype: "yue" });
}

// ─── 地址 ───────────────────────────────────────────────────
export function apiAddressList(): Promise<UserAddress[]> {
  return http.get<UserAddress[]>("/address/list");
}

export function apiAddressSave(params: Partial<UserAddress>): Promise<{ id: number }> {
  return http.post<{ id: number }>("/address/edit", params as Record<string, unknown>);
}

/** 物流查询 (GET /api/order/express/:orderId) */
export function apiOrderExpress(orderId: string): Promise<{
  orderId: string;
  deliveryStatus: string;
  expressName: string;
  expressNo: string;
  traces: { time: string; content: string; status: string }[];
}> {
  return http.get(`/order/express/${orderId}`);
}

/** 评价统计 (GET /api/reply/config/:productId) */
export function apiReplyConfig(productId: number): Promise<{
  total: number;
  avgScore: string;
  goodRate: number;
  picsCount: number;
}> {
  return http.get(`/reply/config/${productId}`);
}

/** 评价列表 (GET /api/reply/list/:productId) */
export function apiReplyList(productId: number, page = 1): Promise<unknown[]> {
  return http.get(`/reply/list/${productId}`, { page, limit: 10 });
}

/** 提交评价 (POST /api/reply/submit) */
export function apiReplySubmit(params: {
  unique: string;
  comment: string;
  productScore: number;
  serviceScore: number;
  logisticsScore: number;
}): Promise<{ id: number }> {
  return http.post(`/reply/submit`, params);
}

/** 取消订单 (POST /api/order/cancel) */
export function apiOrderCancel(orderId: string): Promise<null> {
  return http.post<null>("/order/cancel", { order_id: orderId });
}

/** 退款申请 (POST /api/order/refund/apply/:orderId) */
export function apiRefundApply(
  orderId: string,
  params: { refundReason: string; refundExplain?: string; applyType?: number; cartIds?: number[] },
): Promise<{ id: number }> {
  return http.post(`/order/refund/apply/${orderId}`, params);
}

/** 取消退款 (POST /api/order/refund/cancel/:id) */
export function apiRefundCancel(id: number): Promise<null> {
  return http.post<null>(`/order/refund/cancel/${id}`);
}

/** 退款列表 (GET /api/order/refund/list) */
export function apiRefundList(): Promise<unknown[]> {
  return http.get<unknown[]>("/order/refund/list");
}

/** 删除地址 (POST /api/address/del) */
export function apiAddressDel(id: number): Promise<null> {
  return http.post<null>("/address/del", { id });
}
