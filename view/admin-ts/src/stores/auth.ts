/**
 * 认证状态 (admin)
 */
import { defineStore } from "pinia";
import { apiAdminLogin } from "@/api/auth";
import { getToken, setToken, clearAuth } from "@/utils/auth";
import type { AdminLoginResult } from "@/types/admin";

interface AdminState {
  token: string;
  userInfo: AdminLoginResult["user_info"] | null;
  menus: AdminLoginResult["menus"];
}

export const useAuthStore = defineStore("admin-auth", {
  state: (): AdminState => ({
    token: getToken() ?? "",
    userInfo: null,
    menus: [],
  }),

  getters: {
    isLoggedIn: (state): boolean => !!state.token,
  },

  actions: {
    async login(account: string, pwd: string): Promise<void> {
      const result = await apiAdminLogin(account, pwd);
      this.token = result.token;
      this.userInfo = result.user_info;
      this.menus = result.menus;
      setToken(result.token);
    },

    logout(): void {
      this.token = "";
      this.userInfo = null;
      this.menus = [];
      clearAuth();
    },
  },
});
