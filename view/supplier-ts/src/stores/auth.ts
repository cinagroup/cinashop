import { defineStore } from "pinia";
import { onScopeDispose, ref } from "vue";
import * as supplierApi from "@/api/supplier";
import type { SupplierUser } from "@/types";
import { clearSupplierSession, createSupplierSessionScope, isSupplierStorageEvent, setSupplierSession } from '@/utils/supplierSession';

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
    const parsed: unknown = value ? JSON.parse(value) : [];
    return Array.isArray(parsed) && parsed.every(item => typeof item === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

export const useAuthStore = defineStore("supplier-auth", () => {
  const token = ref(localStorage.getItem("supplier-token") ?? "");
  const user = ref<SupplierUser | null>(storedUser());
  const permissions = ref<string[]>(storedPermissions());
  const permissionsLoaded = ref(localStorage.getItem("supplier-permissions") !== null);
  let loginGeneration = 0;
  function sync() {
    token.value = localStorage.getItem('supplier-token') ?? '';
    user.value = storedUser(); permissions.value = storedPermissions();
    permissionsLoaded.value = localStorage.getItem('supplier-permissions') !== null;
  }
  function storage(event: StorageEvent) { if (isSupplierStorageEvent(event)) sync(); }
  window.addEventListener('supplier-session-changed', sync);
  window.addEventListener('storage', storage);
  onScopeDispose(() => { window.removeEventListener('supplier-session-changed', sync); window.removeEventListener('storage', storage); });

  async function signIn(account: string, password: string) {
    const generation = ++loginGeneration, scope = createSupplierSessionScope(() => {}, true);
    try {
      const result = await supplierApi.login(account, password);
      if (generation !== loginGeneration || !scope.isCurrent()) throw new Error('登录会话已改变，请重新确认');
      setSupplierSession(result);
    } finally { scope.dispose(); }
  }

  async function signOut(): Promise<boolean> {
    loginGeneration += 1;
    // Capture the old token for server revocation, then invalidate local work immediately.
    const request = supplierApi.logout();
    clearSupplierSession();
    let serverRevoked = true;
    try {
      await request;
    } catch {
      serverRevoked = false;
    }
    return serverRevoked;
  }

  function can(permission: string): boolean {
    // Existing primary sessions issued before RBAC have no permission snapshot;
    // the server remains authoritative and the next login stores exact keys.
    return !permissionsLoaded.value || permissions.value.includes(permission);
  }

  return { token, user, permissions, permissionsLoaded, can, signIn, signOut };
});
