import type { ApiEnvelope } from "@/types/kefu";

export const KEFU_TOKEN_KEY = "cinashop_kefu_token";
export const KEFU_INFO_KEY = "cinashop_kefu_info";

const configuredBase = (import.meta.env.VITE_API_BASE ?? "").trim().replace(/\/$/, "");

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export function apiUrl(path: string): string {
  return `${configuredBase}${path}`;
}

export function resolveKefuAssetUrl(value: string): string {
  if (!value.startsWith("/")) return value;
  if (configuredBase) return `${configuredBase}${value}`;
  return value.replace(/^\/api\/assets\/(?=[1-9]\d*(?:\?|$))/, "/kefuapi/assets/");
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const token = sessionStorage.getItem(KEFU_TOKEN_KEY);
  if (token) headers.set("Authori-zation", `Bearer ${token}`);
  const response = await fetch(apiUrl(path), { ...init, headers, credentials: "include" });
  let envelope: ApiEnvelope<T>;
  try {
    envelope = await response.json() as ApiEnvelope<T>;
  } catch {
    throw new ApiError("服务返回了无法识别的响应", response.status);
  }
  if (!response.ok || envelope.status !== 200) {
    if (response.status === 401 || envelope.status === 401) {
      sessionStorage.removeItem(KEFU_TOKEN_KEY);
      sessionStorage.removeItem(KEFU_INFO_KEY);
      localStorage.removeItem(KEFU_TOKEN_KEY);
      localStorage.removeItem(KEFU_INFO_KEY);
      window.dispatchEvent(new Event("kefu-auth-expired"));
    }
    throw new ApiError(envelope.msg || "请求失败", envelope.status || response.status);
  }
  return envelope.data;
}

export function queryString(input: Record<string, string | number | undefined>): string {
  const values = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== "") values.set(key, String(value));
  }
  const result = values.toString();
  return result ? `?${result}` : "";
}

export function websocketUrl(path: string): string {
  const origin = configuredBase || window.location.origin;
  const url = new URL(path, origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
