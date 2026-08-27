/**
 * 订单 API
 */
import request, { getData } from "@/utils/request";
import type {
  CheckoutCashier,
  CheckoutPaymentMethod,
  CheckoutPaymentResult,
  CreateOrderResult,
  FirstOrderQuote,
  OrderInfo,
  PaymentReadiness,
  PickupStore,
  UserAddress,
} from "@/types/order";
import type { SystemFormComponent, SystemFormInfo } from "@/types/systemForm";

function toSnake(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toSnake);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    // cart_info is a historical JSON snapshot; its product/SKU payload keeps
    // the legacy camelCase shape consumed by both storefronts.
    out[normalized] = normalized === "custom_form"
      ? child
      : normalized === "cart_info" && !Array.isArray(child)
        ? child
        : toSnake(child);
  }
  return out;
}

/** 创建订单 (POST /api/order/create/:key) */
export function apiOrderCreate(key: string, params: {
  cartIds: number[];
  realName?: string;
  userPhone?: string;
  province?: string;
  userAddress?: string;
  mark?: string;
  shippingType?: number;
  storeId?: number;
  type?: number;
  pinkId?: number;
  combinationId?: number;
  seckillId?: number;
  bargainUserId?: number;
  customForm?: SystemFormComponent[];
}): Promise<CreateOrderResult> {
  return getData(request.post<CreateOrderResult>(`/order/create/${key}`, params));
}

/** 订单列表 (GET /api/order/list) */
export async function apiOrderList(params: {
  type?: number;
  status?: number;
  page?: number;
  limit?: number;
}): Promise<OrderInfo[]> {
  const list = await getData<Record<string, unknown>[]>(
    request.get<Record<string, unknown>[]>("/order/list", { params }),
  );
  return list.map((item) => toSnake(item) as OrderInfo);
}

export function apiFirstOrderQuote(cartIds: number[]): Promise<FirstOrderQuote> {
  return getData(request.post<FirstOrderQuote>("/order/first_order_quote", { cartIds }));
}

export function apiPickupStores(): Promise<PickupStore[]> {
  return getData(request.get<PickupStore[]>("/store/list"));
}

export function apiOrderSystemForm(id: number): Promise<SystemFormInfo> {
  return getData(request.get<SystemFormInfo>(`/order/system_form/${id}`));
}

export function apiOrderFormImageUpload(file: File): Promise<{ url: string; src: string }> {
  const data = new FormData();
  data.append("file", file);
  data.append("pid", "0");
  return getData(request.post("/upload/image", data));
}

/** 订单详情 (GET /api/order/detail/:uni) */
export async function apiOrderDetail(orderId: string): Promise<OrderInfo> {
  const order = await getData<Record<string, unknown>>(
    request.get<Record<string, unknown>>(`/order/detail/${orderId}`),
  );
  return toSnake(order) as OrderInfo;
}

export function apiOrderCashier(orderId: string, type = "order"): Promise<CheckoutCashier> {
  return getData(request.get<CheckoutCashier>(
    `/order/cashier/${encodeURIComponent(orderId)}/${encodeURIComponent(type)}`,
  ));
}

export function apiPaymentReadiness(): Promise<PaymentReadiness> {
  return getData(request.get<PaymentReadiness>("/payment/readiness"));
}

/** Server-authoritative payment dispatch (POST /api/order/pay). */
export function apiOrderPay(
  orderId: string,
  paytype: CheckoutPaymentMethod = "yue",
  from = "pc",
): Promise<CheckoutPaymentResult> {
  return getData(request.post<CheckoutPaymentResult>("/order/pay", { uni: orderId, paytype, from }));
}

export function apiRechargePay(orderId: string, from = "pc"): Promise<CheckoutPaymentResult> {
  return getData(request.post<CheckoutPaymentResult>("/recharge/pay", {
    uni: orderId,
    paytype: "weixin",
    from,
  }));
}

/** 取消订单 */
export function apiOrderCancel(orderId: string): Promise<null> {
  return getData(request.post<null>("/order/cancel", { order_id: orderId }));
}

/** 确认收货 */
export function apiOrderTake(orderId: string): Promise<null> {
  return getData(request.post<null>("/order/take", { order_id: orderId }));
}

/** 地址列表 (GET /api/address/list) */
export function apiAddressList(): Promise<UserAddress[]> {
  return getData(request.get<UserAddress[]>("/address/list"));
}

/** 保存地址 (POST /api/address/edit) */
export function apiAddressSave(params: Partial<UserAddress>): Promise<{ id: number }> {
  return getData(request.post<{ id: number }>("/address/edit", params));
}

/** 删除地址 (POST /api/address/del) */
export function apiAddressDel(id: number): Promise<null> {
  return getData(request.post<null>("/address/del", { id }));
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
  return getData(request.get(`/order/express/${encodeURIComponent(orderId)}${suffix}`));
}
