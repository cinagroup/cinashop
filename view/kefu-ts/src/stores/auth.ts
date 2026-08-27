import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { KEFU_INFO_KEY, KEFU_TOKEN_KEY } from "@/api/client";
import { kefuApi } from "@/api/kefu";
import type { KefuIdentity } from "@/types/kefu";

function storedIdentity(): KefuIdentity | null {
  const raw = localStorage.getItem(KEFU_INFO_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as KefuIdentity; } catch { return null; }
}

export const useAuthStore = defineStore("kefu-auth", () => {
  const identity = ref<KefuIdentity | null>(storedIdentity());
  const token = ref(localStorage.getItem(KEFU_TOKEN_KEY) ?? "");
  const authenticated = computed(() => Boolean(token.value));

  async function login(account: string, password: string): Promise<void> {
    const result = await kefuApi.login(account, password);
    token.value = result.token;
    identity.value = result.kefuInfo;
    localStorage.setItem(KEFU_TOKEN_KEY, result.token);
    localStorage.setItem(KEFU_INFO_KEY, JSON.stringify(result.kefuInfo));
  }

  async function refreshIdentity(): Promise<void> {
    identity.value = await kefuApi.info();
    localStorage.setItem(KEFU_INFO_KEY, JSON.stringify(identity.value));
  }

  async function logout(): Promise<void> {
    try { if (token.value) await kefuApi.logout(); } finally {
      token.value = "";
      identity.value = null;
      localStorage.removeItem(KEFU_TOKEN_KEY);
      localStorage.removeItem(KEFU_INFO_KEY);
    }
  }

  function usePreviewIdentity(value: KefuIdentity): void {
    identity.value = value;
  }

  return { identity, token, authenticated, login, logout, refreshIdentity, usePreviewIdentity };
});
