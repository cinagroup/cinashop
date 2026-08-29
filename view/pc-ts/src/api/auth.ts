/**
 * 认证 API
 */
import request, { getData } from "@/utils/request";
import type { LoginResult } from "@/types/api";

export type UserSmsType =
  | "register"
  | "mobile"
  | "reset"
  | "binding"
  | "social_binding"
  | "update_phone";

export interface SmsChallenge {
  key: string;
  expire_time: number;
  site_key: string;
  action: "sms_send";
  challenge_url: string;
}

export interface PcAppConfig {
  appid: string;
  version: string;
}

export interface ScanLoginChallenge {
  key: string;
  poll_token: string;
  time: number;
  expires_in: number;
  audience: "pc_user";
}

export type ScanLoginPollResult =
  | { status: 0 }
  | { status: 1 | 2; audience: "pc_user"; expiresAt: number }
  | { status: 3; token: string; exp_time: number };

export interface OauthStateResult {
  state: string;
  expires_in: number;
}

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

/** 创建绑定手机号和用途的人机验证挑战。 */
export function apiVerifyCode(phone: string, type: UserSmsType): Promise<SmsChallenge> {
  return getData(request.post<SmsChallenge>("/verify_code", { phone, type }));
}

/** Public WeChat Open Platform AppID. The secret never reaches the browser. */
export function apiPcAppConfig(): Promise<PcAppConfig> {
  return getData(request.get<PcAppConfig>("/pc/get_appid"));
}

/** New clients use POST so browsers always attach an Origin header. */
export function apiCreatePcScanChallenge(): Promise<ScanLoginChallenge> {
  return getData(request.post<ScanLoginChallenge>("/pc/key"));
}

export function apiPollPcScanChallenge(
  key: string,
  pollToken: string,
): Promise<ScanLoginPollResult> {
  return getData(request.get<ScanLoginPollResult>(`/pc/scan/${encodeURIComponent(key)}`, {
    headers: { "X-Scan-Poll-Token": pollToken },
  }));
}

/** Sets an HttpOnly browser verifier cookie and returns only the public state. */
export function apiCreatePcOauthState(): Promise<OauthStateResult> {
  return getData(request.post<OauthStateResult>("/pc/oauth_state"));
}

export function apiPcWechatAuth(code: string, state: string): Promise<{ token: string; exp_time: number }> {
  return getData(request.get<{ token: string; exp_time: number }>("/pc/wechat_auth", {
    params: { code, state },
  }));
}

/** 服务端状态确认，防止客户端仅凭 postMessage 绕过验证。 */
export function apiVerifyCodeStatus(key: string): Promise<{ verified: boolean; expires_in: number }> {
  return getData(request.get<{ verified: boolean; expires_in: number }>("/verify_code/status", {
    params: { key },
  }));
}

/** 消费一次性挑战并请求短信验证码。 */
export function apiRequestCode(
  phone: string,
  type: UserSmsType,
  key: string,
): Promise<{ queued: true; expires_in: number }> {
  return getData(request.post("/register/verify", { phone, type, key }));
}

/** 注册 (POST /api/register) */
export function apiRegister(
  account: string,
  captcha: string,
  password: string,
  confirm: string,
): Promise<LoginResult> {
  return getData(request.post<LoginResult>("/register", {
    account,
    captcha,
    password,
    confirm_password: confirm,
  }));
}

/** 使用短信验证码重置密码。 */
export function apiResetPassword(
  account: string,
  captcha: string,
  password: string,
): Promise<null> {
  return getData(request.post<null>("/register/reset", { account, captcha, password }));
}

/** 为尚未绑定手机号的登录账号绑定手机号。 */
export function apiBindPhone(phone: string, captcha: string): Promise<null> {
  return getData(request.post<null>("/user/binding", { phone, captcha }));
}

/** 更换当前登录账号的手机号。 */
export function apiUpdatePhone(phone: string, captcha: string): Promise<null> {
  return getData(request.post<null>("/user/updatePhone", { phone, captcha }));
}
