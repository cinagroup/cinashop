import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { KEFU_INFO_KEY, KEFU_TOKEN_KEY } from "@/api/client";
import { kefuApi } from "@/api/kefu";
import type { KefuIdentity } from "@/types/kefu";
import type { LoginResult } from "@/types/kefu";

function storedIdentity(): KefuIdentity | null {
  const raw = sessionStorage.getItem(KEFU_INFO_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as KefuIdentity; } catch { return null; }
}

export const useAuthStore = defineStore("kefu-auth", () => {
  const identity = ref<KefuIdentity | null>(storedIdentity());
  // Per-tab storage prevents the visible Pinia identity from diverging from
  // the bearer used by API/WebSocket calls during parallel OAuth logins.
  localStorage.removeItem(KEFU_TOKEN_KEY);
  localStorage.removeItem(KEFU_INFO_KEY);
  const token = ref(sessionStorage.getItem(KEFU_TOKEN_KEY) ?? "");
  const authenticated = computed(() => Boolean(token.value));

  function applyLogin(result: LoginResult): void {
    token.value = result.token;
    identity.value = result.kefuInfo;
    sessionStorage.setItem(KEFU_TOKEN_KEY, result.token);
    sessionStorage.setItem(KEFU_INFO_KEY, JSON.stringify(result.kefuInfo));
  }

  async function login(account: string, password: string): Promise<void> {
    applyLogin(await kefuApi.login(account, password));
  }

  async function refreshIdentity(): Promise<void> {
    identity.value = await kefuApi.info();
    sessionStorage.setItem(KEFU_INFO_KEY, JSON.stringify(identity.value));
  }

  async function logout(): Promise<boolean> {
    let serverRevoked = true;
    try {
      if (token.value) await kefuApi.logout();
    } catch {
      serverRevoked = false;
    }
    token.value = "";
    identity.value = null;
    sessionStorage.removeItem(KEFU_TOKEN_KEY);
    sessionStorage.removeItem(KEFU_INFO_KEY);
    return serverRevoked;
  }

  function usePreviewIdentity(value: KefuIdentity): void {
    identity.value = value;
  }

  return { identity, token, authenticated, applyLogin, login, logout, refreshIdentity, usePreviewIdentity };
});
