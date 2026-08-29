/**
 * 登录态管理
 * token 存 sessionStorage，让并行标签页保持各自一致的 token/Pinia 身份。
 */
const TOKEN_KEY = "pc_token";
const UID_KEY = "pc_uid";

// This release intentionally stops using persistent bearer storage. Remove
// leftovers immediately, including for users who have not logged in again yet.
if (typeof window !== "undefined") {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(UID_KEY);
}

export function setToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
  localStorage.removeItem(TOKEN_KEY);
}

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setUid(uid: number): void {
  sessionStorage.setItem(UID_KEY, String(uid));
  localStorage.removeItem(UID_KEY);
}

export function getUid(): number {
  return Number(sessionStorage.getItem(UID_KEY) ?? 0);
}

export function isLoggedIn(): boolean {
  return !!getToken();
}

export function clearAuth(): void {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(UID_KEY);
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(UID_KEY);
}
