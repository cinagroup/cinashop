/**
 * 认证状态 (Pinia)
 */
import { defineStore } from "pinia";
import { apiLogin, apiLogout, apiMobileLogin } from "@/api/auth";
import type { LoginResult } from "@/types/api";
import { getToken, getUid, setAuth, captureAuthSession, clearAuthIfCurrent } from "@/utils/auth";

interface AuthState {
  token: string;
  uid: number;
}

export const useAuthStore = defineStore("auth", {
  state: (): AuthState => ({
    token: getToken() ?? "",
    uid: getUid(),
  }),

  getters: {
    isLoggedIn: (state): boolean => !!state.token,
  },

  actions: {
    applyLogin(result: LoginResult): void {
      let uid = 0;
      try {
        const payload = JSON.parse(atob(result.token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
        uid = Number(payload.jti?.id ?? 0);
      } catch { /* UID is display-only; the server authenticates the token. */ }
      setAuth(result.token, uid);
      this.token = getToken() ?? "";
      this.uid = getUid();
    },

    /** 账号密码登录 */
    async login(account: string, password: string): Promise<void> {
      const result = await apiLogin(account, password);
      this.applyLogin(result);
    },

    /** 手机号验证码登录。 */
    async mobileLogin(phone: string, captcha: string): Promise<void> {
      this.applyLogin(await apiMobileLogin(phone, captcha));
    },

    /** 退出登录 */
    async logout(): Promise<{ serverRevoked: boolean; clearedCurrentSession: boolean }> {
      const session = captureAuthSession();
      let serverRevoked = true;
      try {
        await apiLogout();
      } catch {
        serverRevoked = false;
      }
      const clearedCurrentSession = clearAuthIfCurrent(session);
      if (clearedCurrentSession) { this.token = ""; this.uid = 0; }
      return { serverRevoked, clearedCurrentSession };
    },
  },
});
