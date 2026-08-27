/** 登录态管理 (admin) */
const TOKEN_KEY = "admin_token";
const SESSION_KEY = "admin_session";

export interface StoredAdminSession {
  userInfo: {
    id: number;
    account: string;
    head_pic: string;
    real_name: string;
    level: number;
    roles: string;
    division_id?: number;
  };
  menus: Array<{
    id: number;
    pid: number;
    path: string;
    name: string;
    icon: string;
    sort: number;
    type: number;
    children: unknown[];
  }>;
  uniqueAuth: string[];
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function isLoggedIn(): boolean {
  return !!getToken();
}

export function setAdminSession(session: StoredAdminSession): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function getAdminSession(): StoredAdminSession | null {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredAdminSession;
    return parsed?.userInfo && Array.isArray(parsed.menus) && Array.isArray(parsed.uniqueAuth)
      ? parsed
      : null;
  } catch {
    localStorage.removeItem(SESSION_KEY);
    return null;
  }
}

export function clearAuth(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(SESSION_KEY);
}
