/**
 * 认证状态 (Pinia)
 */
import { defineStore } from "pinia";
import { apiLogin, apiLogout } from "@/api/auth";
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
    /** 账号密码登录 */
    async login(account: string, password: string): Promise<void> {
      const result = await apiLogin(account, password);
      this.token = result.token;
      setToken(result.token);
      // uid 从 token payload 解析 (jti.id)
      try {
        const payload = JSON.parse(atob(result.token.split(".")[1]));
        this.uid = payload.jti?.id ?? 0;
        setUid(this.uid);
      } catch {
        // ignore
      }
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
