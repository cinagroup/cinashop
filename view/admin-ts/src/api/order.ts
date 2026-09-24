/**
 * Admin 订单 + 用户管理 API
 * 对应后端 /adminapi/order/* 和 /adminapi/user/*
 */
import request, { getData } from "@/utils/request";
import type { AdminUser } from "@/types/admin";
import { orderNumber, parseAdminOrderList, parseAdminOrderDetail, parseAdminOrderChart, type AdminOrderQuery } from '@/utils/orderRead';
import { sendOrderRequest } from '@/utils/orderRequest';

// ─── 订单管理 ───────────────────────────────────────────────
export async function apiAdminOrderChart(signal?: AbortSignal) {
  return parseAdminOrderChart(await sendOrderRequest('/order/chart', 'get', undefined, undefined, signal));
}

export async function apiAdminOrderList(params: AdminOrderQuery, signal?: AbortSignal) {
  const query = { ...params };
  if (query.order_id) orderNumber(query.order_id);
  return parseAdminOrderList(await sendOrderRequest('/order/list', 'get', undefined, query, signal), query);
}

export async function apiAdminOrderDetail(orderId: string, signal?: AbortSignal) {
  orderNumber(orderId);
  return parseAdminOrderDetail(await sendOrderRequest(`/order/detail/${orderId}`, 'get', undefined, undefined, signal), orderId);
}

export function apiAdminOrderRemark(orderId: string, remark: string): Promise<null> {
  return getData(request.post(`/order/remark/${orderId}`, { remark }));
}

export function apiAdminOrderDelivery(
  orderId: string,
  data: {
    delivery_type: "express" | "send" | "fictitious";
    delivery_name?: string;
    delivery_id?: string;
    delivery_uid?: number;
    fictitious_content?: string;
  },
  signal?: AbortSignal,
): Promise<null> {
  return sendOrderRequest(`/order/delivery/${orderNumber(orderId)}`, 'post', data, undefined, signal);
}

export type AdminWaybillJobStatus =
  | "PENDING" | "ENQUEUING" | "ENQUEUED" | "PROCESSING" | "RETRYABLE"
  | "SENT" | "UNKNOWN" | "DEAD" | "CLOSED";

export interface AdminWaybillJob {
  id: number;
  event_key: string;
  order_id: number;
  order_no: string;
  root_order_id: number;
  supplier_id: number;
  actor_type: "admin" | "supplier";
  actor_id: number;
  fulfillment_mode: "whole" | "split";
  carrier_id: number;
  carrier_code: string;
  carrier_name: string;
  template_id: string;
  has_cloud_printer: boolean;
  status: AdminWaybillJobStatus;
  attempt_count: number;
  replay_count: number;
  provider_reference: string;
  response_code: string;
  tracking_number: string;
  label_url: string;
  fulfilled_order_id: number;
  remaining_order_id: number | null;
  last_error: string;
  sent_time: number;
  add_time: number;
  update_time: number;
}

export interface AdminWaybillListResult {
  list: AdminWaybillJob[];
  next_cursor: number | null;
  summary: { pending: number; sent: number; unknown: number; dead: number; closed: number };
}

export function apiAdminCreateWaybill(orderId: string, carrierId: number, signal?: AbortSignal) {
  return sendOrderRequest<{ duplicate: boolean; job: { id: number; status: string } }>(
    `/order/waybill/${orderNumber(orderId)}`, 'post', {
      request_key: crypto.randomUUID(),
      fulfillment_mode: "whole",
      carrier_id: carrierId,
    }, undefined, signal,
  );
}

export function apiAdminWaybillJobs(params: Record<string, string | number> = {}) {
  return getData<AdminWaybillListResult>(request.get("/waybill/jobs", { params }));
}

export function apiAdminOperateWaybill(
  id: number,
  action: "apply-existing" | "confirm-issued" | "confirm-retry" | "close",
  data: Record<string, unknown>,
) {
  return getData(request.post(`/waybill/jobs/${id}/${action}`, {
    request_key: crypto.randomUUID(),
    ...data,
  }));
}

export interface AdminDeliveryOption {
  id: number;
  uid: number;
  nickname: string;
  phone: string;
}

export function apiAdminDeliveryOptions(signal?: AbortSignal): Promise<{ list: AdminDeliveryOption[]; count: number }> {
  return sendOrderRequest('/order/delivery/list', 'get', undefined, { page: 1, limit: 100 }, signal);
}

export interface AdminWriteoffCart {
  id: number;
  cart_id: string;
  product_id: number;
  product_type: number;
  write_times: number;
  write_surplus_times: number;
  is_writeoff: number;
  cart_info: Record<string, unknown> | null;
}

export interface AdminWriteoffPreview {
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
  cart_info: AdminWriteoffCart[];
}

export function apiAdminWriteoffInfo(code: string, signal?: AbortSignal): Promise<AdminWriteoffPreview> {
  return sendOrderRequest('/order/writeoff_info', 'post', { code }, undefined, signal);
}

export function apiAdminWriteoff(
  code: string,
  items?: Array<{ order_cart_id: number; quantity: number }>,
  signal?: AbortSignal,
): Promise<{ order_id: string; completed: boolean; status: number }> {
  return sendOrderRequest('/order/writeoff', 'post', { code, items }, undefined, signal);
}

// ─── 用户管理 ───────────────────────────────────────────────
export function apiAdminUserList(params: {
  page?: number;
  limit?: number;
  phone?: string;
  uid?: number;
}): Promise<{ list: AdminUser[]; page: number; limit: number }> {
  return getData(request.get("/user/list", { params }));
}

export function apiAdminUserInfo(id: number): Promise<AdminUser> {
  return getData(request.get(`/user/info/${id}`));
}

export function apiAdminUserMoney(
  id: number,
  money: string,
  type: "add" | "sub",
): Promise<{ balance: string }> {
  return getData(request.post(`/user/update_other/${id}`, {
    status: type === "add" ? 1 : 2,
    number: money,
    type: 1,
  }, {
    headers: { "Idempotency-Key": crypto.randomUUID() },
  }));
}
