import { http } from '@/utils/request';
export interface NativeWechatAuthChallenge { state: string; verifier: string; appId: string; expiresIn: number }
export interface NativeWechatAuthenticated { token: string; exp_time: number; uid: number }
export type NativeWechatAuthResult = NativeWechatAuthenticated | { need_phone: true; key: string; expiresIn: number };
export function apiNativeWechatAuthChallenge(): Promise<NativeWechatAuthChallenge> {
  return http.post<NativeWechatAuthChallenge>('/wechat/app_auth/state', {}, { noAuth: true });
}
export function apiNativeWechatAuthComplete(code: string, state: string, verifier: string): Promise<NativeWechatAuthResult> {
  return http.post<NativeWechatAuthResult>('/wechat/app_auth', { code, state, verifier }, { noAuth: true });
}
export function apiNativeWechatAuthPhone(key: string, verifier: string, phone: string, captcha: string): Promise<NativeWechatAuthenticated> {
  return http.post<NativeWechatAuthenticated>('/wechat/app_auth/phone', { key, verifier, phone, captcha }, { noAuth: true });
}
