/**
 * 认证状态 (Pinia)
 * token 存 uni storage
 */
import { defineStore } from "pinia";

const TOKEN_KEY = "uni_token";
const UID_KEY = "uni_uid";

interface AuthState {
  token: string;
  uid: number;
}

export const useAuthStore = defineStore("auth", {
  state: (): AuthState => ({
    token: uni.getStorageSync(TOKEN_KEY) || "",
    uid: Number(uni.getStorageSync(UID_KEY)) || 0,
  }),

  getters: {
    isLoggedIn: (state): boolean => !!state.token,
  },

  actions: {
    setLogin(token: string, uid: number): void {
      this.token = token;
      this.uid = uid;
      uni.setStorageSync(TOKEN_KEY, token);
      uni.setStorageSync(UID_KEY, uid);
    },

    clear(): void {
      this.token = "";
      this.uid = 0;
      uni.removeStorageSync(TOKEN_KEY);
      uni.removeStorageSync(UID_KEY);
    },
  },
});
