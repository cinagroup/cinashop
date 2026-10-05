import type { ApiEnvelope } from "@/types/kefu";
import { captureKefuSession, isCurrentKefuSession, expireKefuSession } from "@/services/session";
export { KEFU_TOKEN_KEY, KEFU_INFO_KEY } from "@/services/session";

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

export async function apiRequest<T>(path: string, init: RequestInit = {}, allowSessionChange = path === "/kefuapi/user/logout"): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const session = captureKefuSession(), token = session.token;
  if (token) headers.set("Authori-zation", `Bearer ${token}`);
  const response = await fetch(apiUrl(path), { ...init, headers, credentials: "include" });
  let envelope: ApiEnvelope<T>;
  try {
    envelope = await response.json() as ApiEnvelope<T>;
  } catch {
    throw new ApiError("服务返回了无法识别的响应", response.status);
  }
  if (!allowSessionChange && !isCurrentKefuSession(session)) throw new ApiError("客服身份已变更，请重新加载", 409);
  if (!response.ok || envelope.status !== 200) {
    if ((response.status === 401 || [401, 410000, 410001, 410002].includes(envelope.status))
      && token) expireKefuSession(session);
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
