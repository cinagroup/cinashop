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

function storedPermissions(): string[] {
  try {
    const value = localStorage.getItem("supplier-permissions");
    return value ? (JSON.parse(value) as string[]) : [];
  } catch {
    return [];
  }
}

export const useAuthStore = defineStore("supplier-auth", () => {
  const token = ref(localStorage.getItem("supplier-token") ?? "");
  const user = ref<SupplierUser | null>(storedUser());
  const permissions = ref<string[]>(storedPermissions());
  const permissionsLoaded = ref(localStorage.getItem("supplier-permissions") !== null);

  async function signIn(account: string, password: string) {
    const result = await supplierApi.login(account, password);
    token.value = result.token;
    user.value = result.user_info;
    permissions.value = result.unique_auth;
    permissionsLoaded.value = true;
    localStorage.setItem("supplier-token", result.token);
    localStorage.setItem("supplier-user", JSON.stringify(result.user_info));
    localStorage.setItem("supplier-permissions", JSON.stringify(result.unique_auth));
  }

  async function signOut(): Promise<boolean> {
    let serverRevoked = true;
    try {
      await supplierApi.logout();
    } catch {
      serverRevoked = false;
    }
    token.value = "";
    user.value = null;
    permissions.value = [];
    permissionsLoaded.value = false;
    localStorage.removeItem("supplier-token");
    localStorage.removeItem("supplier-user");
    localStorage.removeItem("supplier-permissions");
    return serverRevoked;
  }

  function can(permission: string): boolean {
    // Existing primary sessions issued before RBAC have no permission snapshot;
    // the server remains authoritative and the next login stores exact keys.
    return !permissionsLoaded.value || permissions.value.includes(permission);
  }

  return { token, user, permissions, permissionsLoaded, can, signIn, signOut };
});
