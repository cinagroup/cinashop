/**
 * Admin 订单 + 用户管理 API
 * 对应后端 /adminapi/order/* 和 /adminapi/user/*
 */
import request, { getData } from "@/utils/request";
import type { AdminOrder, AdminUser } from "@/types/admin";

// ─── 订单管理 ───────────────────────────────────────────────
export function apiAdminOrderList(params: {
  page?: number;
  limit?: number;
  status?: number;
  paid?: number;
  order_id?: string;
}): Promise<{ list: AdminOrder[]; page: number; limit: number }> {
  return getData(request.get("/order/list", { params }));
}

export function apiAdminOrderDetail(orderId: string): Promise<AdminOrder> {
  return getData(request.get(`/order/detail/${orderId}`));
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
): Promise<null> {
  return getData(request.post(`/order/delivery/${orderId}`, data));
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

export function apiAdminCreateWaybill(orderId: string, carrierId: number) {
  return getData<{ duplicate: boolean; job: { id: number; status: string } }>(
    request.post(`/order/waybill/${orderId}`, {
      request_key: crypto.randomUUID(),
      fulfillment_mode: "whole",
      carrier_id: carrierId,
    }),
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

export function apiAdminDeliveryOptions(): Promise<{ list: AdminDeliveryOption[]; count: number }> {
  return getData(request.get("/order/delivery/list", { params: { page: 1, limit: 100 } }));
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

export function apiAdminWriteoffInfo(code: string): Promise<AdminWriteoffPreview> {
  return getData(request.post("/order/writeoff_info", { code }));
}

export function apiAdminWriteoff(
  code: string,
  items?: Array<{ order_cart_id: number; quantity: number }>,
): Promise<{ order_id: string; completed: boolean; status: number }> {
  return getData(request.post("/order/writeoff", { code, items }));
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

export function apiAdminUserUpdate(
  id: number,
  data: Record<string, unknown>,
): Promise<null> {
  return getData(request.post(`/user/update/${id}`, data));
}

export function apiAdminUserMoney(
  id: number,
  money: string,
  type: "add" | "sub",
): Promise<{ balance: string }> {
  return getData(request.post(`/user/money/${id}`, { money, type }));
}
