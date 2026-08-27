import { defineStore } from "pinia";
import { ref } from "vue";
import * as supplierApi from "@/api/supplier";
import type { SupplierUser } from "@/types";

function storedUser(): SupplierUser | null {
  try {
    const value = localStorage.getItem("supplier-user");
    return value ? (JSON.parse(value) as SupplierUser) : null;
  } catch {
    return null;
  }
}

export const useAuthStore = defineStore("supplier-auth", () => {
  const token = ref(localStorage.getItem("supplier-token") ?? "");
  const user = ref<SupplierUser | null>(storedUser());

  async function signIn(account: string, password: string) {
    const result = await supplierApi.login(account, password);
    token.value = result.token;
    user.value = result.user_info;
    localStorage.setItem("supplier-token", result.token);
    localStorage.setItem("supplier-user", JSON.stringify(result.user_info));
  }

  async function signOut() {
    try {
      await supplierApi.logout();
    } finally {
      token.value = "";
      user.value = null;
      localStorage.removeItem("supplier-token");
      localStorage.removeItem("supplier-user");
    }
  }

  return { token, user, signIn, signOut };
});
