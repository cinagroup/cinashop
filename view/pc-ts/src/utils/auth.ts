/**
 * 登录态管理
 * token 存 sessionStorage，让并行标签页保持各自一致的 token/Pinia 身份。
 */
const TOKEN_KEY = "pc_token";
const UID_KEY = "pc_uid";
let generation = 0;
export interface AuthSessionSnapshot { generation: number; token: string | null }
const listeners = new Set<() => void>();

function changed(): void {
  generation++;
  for (const listener of listeners) listener();
}
export function onAuthChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function captureAuthSession(): AuthSessionSnapshot {
  return { generation, token: getToken() };
}
export function isCurrentAuthSession(snapshot: AuthSessionSnapshot): boolean {
  return snapshot.generation === generation && snapshot.token === getToken();
}

// This release intentionally stops using persistent bearer storage. Remove
// leftovers immediately, including for users who have not logged in again yet.
if (typeof window !== "undefined") {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(UID_KEY);
}

/** Publish token and display UID atomically; even an identical new token is a new session generation. */
export function setAuth(token: string, uid: number): void {
  sessionStorage.setItem(TOKEN_KEY, token);
  sessionStorage.setItem(UID_KEY, String(Number.isSafeInteger(uid) && uid > 0 ? uid : 0));
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(UID_KEY);
  changed();
}

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function getUid(): number {
  const uid = Number(sessionStorage.getItem(UID_KEY) ?? 0);
  return Number.isSafeInteger(uid) && uid > 0 ? uid : 0;
}

export function isLoggedIn(): boolean {
  return !!getToken();
}

export function clearAuth(): void {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(UID_KEY);
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(UID_KEY);
  changed();
}

export function clearAuthIfCurrent(snapshot: AuthSessionSnapshot): boolean {
  if (!isCurrentAuthSession(snapshot)) return false;
  clearAuth();
  return true;
}
