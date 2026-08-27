/**
 * 认证状态 (Pinia)
 */
import { defineStore } from "pinia";
import { apiLogin, apiLogout, apiMobileLogin } from "@/api/auth";
import type { LoginResult } from "@/types/api";
import { getToken, setToken, clearAuth, getUid, setUid } from "@/utils/auth";

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
      this.token = result.token;
      setToken(result.token);
      try {
        const payload = JSON.parse(atob(result.token.split(".")[1]));
        this.uid = payload.jti?.id ?? 0;
        setUid(this.uid);
      } catch {
        this.uid = 0;
        setUid(0);
      }
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
    async logout(): Promise<void> {
      try {
        await apiLogout();
      } catch {
        // 忽略退出失败
      }
      this.token = "";
      this.uid = 0;
      clearAuth();
    },
  },
});
