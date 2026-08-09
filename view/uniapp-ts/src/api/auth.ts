/**
 * 认证 API
 */
import { http } from "@/utils/request";
import type { LoginResult } from "@/types/api";

export function apiLogin(account: string, password: string): Promise<LoginResult> {
  return http.post<LoginResult>("/login", { account, password });
}

export function apiLogout(): Promise<null> {
  return http.get<null>("/logout");
}
