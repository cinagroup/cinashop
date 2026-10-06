export const KEFU_TOKEN_KEY = "cinashop_kefu_token";
export const KEFU_INFO_KEY = "cinashop_kefu_info";

let revision = 0;
export interface KefuSessionSnapshot { token: string; revision: number }
export function captureKefuSession(): KefuSessionSnapshot {
  return { token: sessionStorage.getItem(KEFU_TOKEN_KEY) ?? "", revision };
}
export function isCurrentKefuSession(value: KefuSessionSnapshot): boolean {
  const current = captureKefuSession();
  return value.revision === current.revision && value.token === current.token;
}
export function announceKefuSessionChange(): void {
  revision++;
  window.dispatchEvent(new Event("kefu-session-changed"));
}
export function expireKefuSession(value: KefuSessionSnapshot): void {
  if (!value.token || !isCurrentKefuSession(value)) return;
  sessionStorage.removeItem(KEFU_TOKEN_KEY);
  sessionStorage.removeItem(KEFU_INFO_KEY);
  localStorage.removeItem(KEFU_TOKEN_KEY);
  localStorage.removeItem(KEFU_INFO_KEY);
  announceKefuSessionChange();
  window.dispatchEvent(new Event("kefu-auth-expired"));
}
