/**
 * 认证 API
 */
import request, { getData } from "@/utils/request";
import type { LoginResult } from "@/types/api";

/** 账号密码登录 (POST /api/login) */
export function apiLogin(account: string, password: string): Promise<LoginResult> {
  return getData(
    request.post<LoginResult>("/login", { account, password }),
  );
}

/** 手机号验证码登录 (POST /api/login/mobile) */
export function apiMobileLogin(phone: string, captcha: string): Promise<LoginResult> {
  return getData(
    request.post<LoginResult>("/login/mobile", { phone, captcha }),
  );
}

/** 退出登录 */
export function apiLogout(): Promise<null> {
  return getData(request.get<null>("/logout"));
}

/** 获取验证码 key */
export function apiVerifyCode(): Promise<{ key: string }> {
  return getData(request.get<{ key: string }>("/verify_code"));
}

/** 注册 (POST /api/register) */
export function apiRegister(account: string, password: string, confirm: string): Promise<LoginResult> {
  return getData(request.post<LoginResult>("/register", { account, password, confirm_password: confirm }));
}
