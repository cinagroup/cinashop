import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { KEFU_INFO_KEY, KEFU_TOKEN_KEY } from "@/api/client";
import { kefuApi } from "@/api/kefu";
import type { KefuIdentity } from "@/types/kefu";
import type { LoginResult } from "@/types/kefu";
import { announceKefuSessionChange, captureKefuSession, isCurrentKefuSession } from "@/services/session";

function storedIdentity(): KefuIdentity | null {
  const raw = sessionStorage.getItem(KEFU_INFO_KEY);
  if (!raw || !sessionStorage.getItem(KEFU_TOKEN_KEY)) return null;
  try { return JSON.parse(raw) as KefuIdentity; } catch { return null; }
}

export const useAuthStore = defineStore("kefu-auth", () => {
  const identity = ref<KefuIdentity | null>(storedIdentity());
  // Per-tab storage prevents the visible Pinia identity from diverging from
  // the bearer used by API/WebSocket calls during parallel OAuth logins.
  localStorage.removeItem(KEFU_TOKEN_KEY);
  localStorage.removeItem(KEFU_INFO_KEY);
  const token = ref(sessionStorage.getItem(KEFU_TOKEN_KEY) ?? "");
  const generation = ref(captureKefuSession().revision);
  window.addEventListener("kefu-session-changed", () => {
    token.value = sessionStorage.getItem(KEFU_TOKEN_KEY) ?? "";
    identity.value = storedIdentity();
    generation.value = captureKefuSession().revision;
  });
  const authenticated = computed(() => Boolean(token.value));

  function applyLogin(result: LoginResult): void {
    sessionStorage.setItem(KEFU_TOKEN_KEY, result.token);
    sessionStorage.setItem(KEFU_INFO_KEY, JSON.stringify(result.kefuInfo));
    announceKefuSessionChange();
  }

  async function login(account: string, password: string): Promise<void> {
    applyLogin(await kefuApi.login(account, password));
  }

  async function refreshIdentity(): Promise<void> {
    const current = captureKefuSession();
    const result = await kefuApi.info();
    if (!current.token || !isCurrentKefuSession(current)) return;
    identity.value = result;
    sessionStorage.setItem(KEFU_INFO_KEY, JSON.stringify(identity.value));
  }

  async function logout(): Promise<boolean> {
    const revocation = token.value ? kefuApi.logout() : Promise.resolve();
    clearSession();
    let serverRevoked = true;
    try {
      await revocation;
    } catch {
      serverRevoked = false;
    }
    return serverRevoked;
  }

  function clearSession(): void {
    sessionStorage.removeItem(KEFU_TOKEN_KEY);
    sessionStorage.removeItem(KEFU_INFO_KEY);
    announceKefuSessionChange();
  }

  function usePreviewIdentity(value: KefuIdentity): void {
    identity.value = value;
  }

  return { identity, token, generation, authenticated, applyLogin, login, logout, clearSession, refreshIdentity, usePreviewIdentity };
});
