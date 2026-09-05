/**
 * 认证状态 (admin)
 */
import { defineStore } from "pinia";
import { apiAdminLogin } from "@/api/auth";
import { getToken, setToken, clearAuth, getAdminSession, setAdminSession } from "@/utils/auth";
import type { AdminLoginResult } from "@/types/admin";

interface AdminState {
  token: string;
  userInfo: AdminLoginResult["user_info"] | null;
  menus: AdminLoginResult["menus"];
  uniqueAuth: string[];
}

const storedSession = getAdminSession();

export const useAuthStore = defineStore("admin-auth", {
  state: (): AdminState => ({
    token: getToken() ?? "",
    userInfo: storedSession?.userInfo ?? null,
    menus: (storedSession?.menus as AdminLoginResult["menus"] | undefined) ?? [],
    uniqueAuth: storedSession?.uniqueAuth ?? [],
  }),

  getters: {
    isLoggedIn: (state): boolean => !!state.token,
  },

  actions: {
    async login(account: string, pwd: string): Promise<void> {
      const result = await apiAdminLogin(account, pwd);
      setToken(result.token);
      setAdminSession({ userInfo: result.user_info, menus: result.menus, uniqueAuth: result.unique_auth });
      this.$patch({ token: result.token, userInfo: result.user_info, menus: result.menus, uniqueAuth: result.unique_auth });
    },

    logout(): void {
      clearAuth();
      this.$patch({ token: '', userInfo: null, menus: [], uniqueAuth: [] });
    },
  },
});
