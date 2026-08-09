/**
 * 订单 API
 */
import request, { getData } from "@/utils/request";
import type { OrderInfo, CreateOrderResult, UserAddress } from "@/types/order";

/** 创建订单 (POST /api/order/create/:key) */
export function apiOrderCreate(key: string, params: {
  cartIds: number[];
  realName?: string;
  userPhone?: string;
  province?: string;
  userAddress?: string;
  mark?: string;
  shippingType?: number;
  type?: number;
}): Promise<CreateOrderResult> {
  return getData(request.post<CreateOrderResult>(`/order/create/${key}`, params));
}

/** 订单列表 (GET /api/order/list) */
export function apiOrderList(params: {
  type?: number;
  page?: number;
  limit?: number;
}): Promise<OrderInfo[]> {
  return getData(request.get<OrderInfo[]>("/order/list", { params }));
}

/** 订单详情 (GET /api/order/detail/:uni) */
export function apiOrderDetail(orderId: string): Promise<OrderInfo> {
  return getData(request.get<OrderInfo>(`/order/detail/${orderId}`));
}

/** 余额支付 (POST /api/order/pay) */
export function apiOrderPay(orderId: string, paytype = "yue"): Promise<{ paid: boolean }> {
  return getData(request.post<{ paid: boolean }>("/order/pay", { uni: orderId, paytype }));
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

/** 物流查询 (GET /api/order/express/:orderId) */
export function apiOrderExpress(orderId: string): Promise<{
  orderId: string;
  deliveryStatus: string;
  expressName: string;
  expressNo: string;
  traces: { time: string; content: string; status: string }[];
}> {
  return getData(request.get(`/order/express/${orderId}`));
}
