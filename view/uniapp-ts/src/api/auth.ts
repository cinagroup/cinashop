/**
 * 认证 API
 */
import { http } from "@/utils/request";
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

export interface AppleSignInChallenge {
  key: string;
  /** Raw nonce retained only to support native APIs that hash it client-side. */
  nonce: string;
  /** Supply this value as the nonce in the Apple authorization request. */
  nonceSha256: string;
  expiresIn: number;
}

export type SocialLoginResult =
  | { token: string; expiresTime: number; uid: number }
  | { bindPhone: true; key: string; expiresIn: number };

export function apiLogin(account: string, password: string): Promise<LoginResult> {
  return http.post<LoginResult>("/login", { account, password });
}

export function apiMobileLogin(phone: string, captcha: string): Promise<LoginResult> {
  return http.post<LoginResult>("/login/mobile", { phone, captcha });
}

export function apiVerifyCode(phone: string, type: UserSmsType): Promise<SmsChallenge> {
  return http.post<SmsChallenge>("/verify_code", { phone, type }, { noAuth: true });
}

export function apiVerifyCodeStatus(key: string): Promise<{ verified: boolean; expires_in: number }> {
  return http.get<{ verified: boolean; expires_in: number }>(
    "/verify_code/status",
    { key },
    { noAuth: true },
  );
}

export function apiRequestCode(
  phone: string,
  type: UserSmsType,
  key: string,
): Promise<{ queued: true; expires_in: number }> {
  return http.post<{ queued: true; expires_in: number }>(
    "/register/verify",
    { phone, type, key },
    { noAuth: true },
  );
}

export function apiRegister(
  account: string,
  captcha: string,
  password: string,
  confirmPassword: string,
): Promise<LoginResult> {
  return http.post<LoginResult>("/register", {
    account,
    captcha,
    password,
    confirm_password: confirmPassword,
  }, { noAuth: true });
}

export function apiLogout(): Promise<null> {
  return http.get<null>("/logout");
}

export function apiResetPassword(
  account: string,
  captcha: string,
  password: string,
): Promise<null> {
  return http.post<null>(
    "/register/reset",
    { account, captcha, password },
    { noAuth: true },
  );
}

export function apiBindPhone(phone: string, captcha: string): Promise<null> {
  return http.post<null>("/user/binding", { phone, captcha });
}

export function apiUpdatePhone(phone: string, captcha: string): Promise<null> {
  return http.post<null>("/user/updatePhone", { phone, captcha });
}

export function apiAppleSignInChallenge(): Promise<AppleSignInChallenge> {
  return http.post<AppleSignInChallenge>("/apple_login/challenge", {}, { noAuth: true });
}

/** identityToken must come from Apple; openId/email are deliberately not accepted. */
export function apiAppleLogin(
  identityToken: string,
  nonceKey: string,
): Promise<SocialLoginResult> {
  return http.post<SocialLoginResult>(
    "/apple_login",
    { identityToken, nonce_key: nonceKey },
    { noAuth: true },
  );
}

export function apiBindPendingSocialIdentity(
  phone: string,
  captcha: string,
  key: string,
): Promise<{ token: string; expiresTime: number; uid: number }> {
  return http.post<{ token: string; expiresTime: number; uid: number }>(
    "/binding",
    { phone, captcha, key },
    { noAuth: true },
  );
}
