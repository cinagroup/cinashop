/**
 * 购物车 + 订单 API
 */
import { http } from "@/utils/request";
import type {
  CartItem,
  CheckoutCashier,
  CheckoutPaymentMethod,
  CheckoutPaymentResult,
  CreateOrderResult,
  FirstOrderQuote,
  OrderInfo,
  PaymentReadiness,
  PickupStore,
  UserAddress,
  DiscountPackage,
} from "@/types/order";
import type { SystemFormComponent, SystemFormInfo } from "@/types/systemForm";

// ─── 购物车 ─────────────────────────────────────────────────
export function apiCartList(): Promise<CartItem[]> {
  return http.get<CartItem[]>("/cart/list");
}

export function apiCartAdd(params: {
  productId: number;
  unique: string;
  cartNum: number;
  type?: number;
  activityId?: number;
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

/** camelCase → snake_case；递归转换订单、包裹和商品快照字段。 */
function toSnake(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toSnake);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const sk = k.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
    // cart_info is a historical JSON snapshot; its product/SKU payload keeps
    // the legacy camelCase shape consumed by both storefronts.
    out[sk] = sk === "custom_form"
      ? v
      : sk === "cart_info" && !Array.isArray(v)
        ? v
        : toSnake(v);
  }
  return out;
}

export function apiDiscountPackages(productId: number): Promise<DiscountPackage[]> {
  return http.get<DiscountPackage[]>(`/store_discounts/list/${productId}`);
}

export function apiDiscountCartAdd(params: {
  discountId: number;
  discountInfos: Array<{ id: number; product_id: number; unique: string }>;
}): Promise<{ cartId: number[]; cartIds: number[]; cartNum: number; discountId: number }> {
  return http.post("/cart/add", { ...params, type: 5, new: 1 });
}

export function apiOrderCreate(
  key: string,
  params: {
    cartIds: number[];
    realName?: string;
    userPhone?: string;
    province?: string;
    userAddress?: string;
    shippingType?: number;
    storeId?: number;
    /** M17: 优惠券/备注/活动 */
    couponId?: number;
    mark?: string;
    type?: number;
    pinkId?: number;
    combinationId?: number;
    seckillId?: number;
    bargainUserId?: number;
    customForm?: SystemFormComponent[];
  },
): Promise<CreateOrderResult> {
  return http.post<CreateOrderResult>(`/order/create/${key}`, params as Record<string, unknown>);
}

export async function apiOrderList(params: {
  type?: number;
  status?: number;
  page?: number;
  limit?: number;
}): Promise<OrderInfo[]> {
  const list = await http.get<Record<string, unknown>[]>("/order/list", params as Record<string, unknown>);
  return list.map((item) => toSnake(item) as OrderInfo);
}

export function apiFirstOrderQuote(cartIds: number[]): Promise<FirstOrderQuote> {
  return http.post<FirstOrderQuote>("/order/first_order_quote", { cartIds });
}

export function apiPickupStores(): Promise<PickupStore[]> {
  return http.get<PickupStore[]>("/store/list");
}

export interface WriteoffOperatorProfile {
  can_writeoff: boolean;
  staff_stores: Array<{
    id: number;
    store_id: number;
    store_name: string;
    identity_conflict: boolean;
  }>;
  delivery: { id: number; nickname: string } | null;
  delivery_identity_conflict: boolean;
}

export interface OperatorWriteoffCart {
  id: number;
  cart_id: string;
  product_id: number;
  product_type: number;
  write_times: number;
  write_surplus_times: number;
  is_writeoff: number;
  write_start: number;
  write_end: number;
  cart_info: Record<string, unknown> | null;
}

export interface OperatorWriteoffPreview {
  id: number;
  order_id: string;
  store_id: number;
  shipping_type: number;
  delivery_type: string;
  actor_kind: "staff" | "delivery" | "admin";
  real_name: string;
  user_phone: string;
  status: number;
  total_num: number;
  cart_info: OperatorWriteoffCart[];
}

export interface OperatorWriteoffResult {
  order_id: string;
  completed: boolean;
  status: number;
}

export function apiWriteoffOperatorProfile(): Promise<WriteoffOperatorProfile> {
  return http.get<WriteoffOperatorProfile>("/store/operator/profile");
}

export function apiOperatorWriteoffInfo(
  role: "staff" | "delivery",
  code: string,
): Promise<OperatorWriteoffPreview> {
  const prefix = role === "delivery" ? "/delivery" : "/store";
  return http.post<OperatorWriteoffPreview>(`${prefix}/order/writeoff_info`, { code });
}

export function apiOperatorWriteoff(
  role: "staff" | "delivery",
  code: string,
  items: Array<{ order_cart_id: number; quantity: number }>,
): Promise<OperatorWriteoffResult> {
  const prefix = role === "delivery" ? "/delivery" : "/store";
  return http.post<OperatorWriteoffResult>(`${prefix}/order/writeoff`, { code, items });
}

export function apiOrderSystemForm(id: number): Promise<SystemFormInfo> {
  return http.get<SystemFormInfo>(`/order/system_form/${id}`);
}

export async function apiOrderDetail(orderId: string): Promise<OrderInfo> {
  const data = await http.get<Record<string, unknown>>(`/order/detail/${orderId}`);
  return toSnake(data) as OrderInfo;
}

export function apiOrderCashier(orderId: string, type = "order"): Promise<CheckoutCashier> {
  return http.get<CheckoutCashier>(
    `/order/cashier/${encodeURIComponent(orderId)}/${encodeURIComponent(type)}`,
  );
}

export function apiPaymentReadiness(): Promise<PaymentReadiness> {
  return http.get<PaymentReadiness>("/payment/readiness");
}

export function apiOrderPay(
  orderId: string,
  paytype: CheckoutPaymentMethod = "yue",
  from = "h5",
): Promise<CheckoutPaymentResult> {
  return http.post<CheckoutPaymentResult>("/order/pay", { uni: orderId, paytype, from });
}

export function apiRechargePay(orderId: string, from = "h5"): Promise<CheckoutPaymentResult> {
  return http.post<CheckoutPaymentResult>("/recharge/pay", {
    uni: orderId,
    paytype: "weixin",
    from,
  });
}

// ─── 地址 ───────────────────────────────────────────────────
export function apiAddressList(): Promise<UserAddress[]> {
  return http.get<UserAddress[]>("/address/list");
}

export function apiAddressSave(params: Partial<UserAddress>): Promise<{ id: number }> {
  return http.post<{ id: number }>("/address/edit", params as Record<string, unknown>);
}

export interface OrderTrackingPackage {
  orderId: string;
  deliveryStatus: string;
  expressName: string;
  expressCode: string;
  expressNo: string;
  trackingState:
    | "pending"
    | "in_transit"
    | "delivered"
    | "exception"
    | "not_configured"
    | "temporarily_unavailable";
  trackingSource: "merchant" | "carrier" | "cache";
  message: string;
  lastUpdatedAt: number;
  traces: { time: string; content: string; status: string }[];
}

export interface OrderExpressResult extends OrderTrackingPackage {
  packages: OrderTrackingPackage[];
  express: { time: string; status: string }[];
  order: {
    order_id: string;
    delivery_id: string;
    delivery_name: string;
    delivery_code: string;
    delivery_type: string;
  };
}

/** 物流查询；type=refund 与 PHP `/order/express/:uni/refund` 兼容。 */
export function apiOrderExpress(orderId: string, type?: "refund"): Promise<OrderExpressResult> {
  const suffix = type ? `/${type}` : "";
  return http.get(`/order/express/${encodeURIComponent(orderId)}${suffix}`);
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
  pics?: string[];
}): Promise<{ id: number; oid: number; completed: boolean; to_lottery: false }> {
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
