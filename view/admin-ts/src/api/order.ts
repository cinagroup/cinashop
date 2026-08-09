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
  data: { delivery_name?: string; delivery_id?: string },
): Promise<null> {
  return getData(request.post(`/order/delivery/${orderId}`, data));
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
