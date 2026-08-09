/**
 * 登录态管理
 * token 存 localStorage (PC 端, 简单可靠)
 */
const TOKEN_KEY = "pc_token";
const UID_KEY = "pc_uid";

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setUid(uid: number): void {
  localStorage.setItem(UID_KEY, String(uid));
}

export function getUid(): number {
  return Number(localStorage.getItem(UID_KEY) ?? 0);
}

export function isLoggedIn(): boolean {
  return !!getToken();
}

export function clearAuth(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(UID_KEY);
}
