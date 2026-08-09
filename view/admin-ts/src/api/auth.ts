/**
 * Admin 认证 + Dashboard API
 */
import request, { getData } from "@/utils/request";
import type { AdminLoginResult, DashboardData } from "@/types/admin";

/** 管理员登录 (POST /adminapi/login) */
export function apiAdminLogin(account: string, pwd: string): Promise<AdminLoginResult> {
  return getData(request.post<AdminLoginResult>("/login", { account, pwd }));
}

/** Dashboard 统计 (GET /adminapi/home/header) */
export function apiDashboard(): Promise<DashboardData> {
  return getData(request.get<DashboardData>("/home/header"));
}

/** 管理员消息通知 (GET /adminapi/new_push) */
export function apiNewPush(): Promise<{
  ordernum: number;
  inventory: number;
  commentnum: number;
  reflectnum: number;
  msgcount: number;
}> {
  return getData(request.get("/new_push"));
}
