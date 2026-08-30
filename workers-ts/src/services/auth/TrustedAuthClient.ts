import type { ScanLoginAudience } from "@/do/TokenBucketDO";
import type { Env } from "@/env";
import { ForbiddenException, ServiceUnavailableException } from "@/utils/errors";

/**
 * Request metadata admitted by the browser-origin allowlist.
 *
 * Origin and User-Agent are useful for browser CSRF reduction and for an
 * explicit human comparison, but a non-browser client can forge both. Never
 * treat these fields as cryptographic proof of a device or application.
 */
export interface AuthRequestMetadata {
  origin: string;
  device: string;
  target: string;
}

function normalizedOrigin(value: string): string | null {
  const input = value.trim();
  if (!input || input === "null") return null;
  try {
    const url = new URL(input);
    if (
      url.username
      || url.password
      || (url.pathname !== "/" && url.pathname !== "")
      || url.search
      || url.hash
    ) return null;
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function configuredOrigins(value: string | undefined): Set<string> {
  return new Set(
    String(value ?? "")
      .split(",")
      .map((entry) => normalizedOrigin(entry))
      .filter((entry): entry is string => Boolean(entry)),
  );
}

function isLocalDevelopmentOrigin(origin: string, env: Pick<Env, "NODE_ENV">): boolean {
  if (env.NODE_ENV === "production") return false;
  const url = new URL(origin);
  return url.protocol === "http:"
    && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

export function isAllowedCorsOrigin(
  value: string,
  env: Pick<Env, "ALLOWED_ORIGINS" | "WORK_WECHAT_ALLOWED_ORIGINS" | "NODE_ENV">,
): boolean {
  const origin = normalizedOrigin(value);
  if (!origin) return false;
  return configuredOrigins(env.ALLOWED_ORIGINS).has(origin)
    || isLocalDevelopmentOrigin(origin, env);
}

/**
 * Enterprise WeChat browser origins are deliberately narrower than the
 * storefront CORS allowlist: unless an origin is also a general storefront
 * origin, it may call only the public Work compatibility surface.
 */
export function isAllowedCorsOriginForPath(
  value: string,
  path: string,
  env: Pick<Env, "ALLOWED_ORIGINS" | "WORK_WECHAT_ALLOWED_ORIGINS" | "NODE_ENV">,
): boolean {
  const origin = normalizedOrigin(value);
  if (!origin) return false;
  if (isAllowedCorsOrigin(origin, env)) return true;
  return configuredOrigins(env.WORK_WECHAT_ALLOWED_ORIGINS).has(origin)
    && (path === "/api/work" || path.startsWith("/api/work/"));
}

export function isAllowedAuthOrigin(
  value: string,
  env: Pick<
    Env,
    | "ALLOWED_ORIGINS"
    | "AUTH_ALLOWED_ORIGINS"
    | "PC_AUTH_ALLOWED_ORIGINS"
    | "KEFU_AUTH_ALLOWED_ORIGINS"
    | "NODE_ENV"
  >,
  audience: ScanLoginAudience,
): boolean {
  const origin = normalizedOrigin(value);
  if (!origin) return false;
  const configuredValue = audience === "pc_user"
    ? env.PC_AUTH_ALLOWED_ORIGINS || env.AUTH_ALLOWED_ORIGINS
    : env.KEFU_AUTH_ALLOWED_ORIGINS;
  const configured = configuredOrigins(configuredValue);
  return configured.has(origin) || isLocalDevelopmentOrigin(origin, env);
}

function deviceLabel(userAgent: string): string {
  const ua = userAgent.slice(0, 512);
  const platform = /Android/i.test(ua)
    ? "Android"
    : /iPhone|iPad|iPod/i.test(ua)
      ? "iOS"
      : /Windows/i.test(ua)
        ? "Windows"
        : /Macintosh|Mac OS X/i.test(ua)
          ? "macOS"
          : /Linux/i.test(ua)
            ? "Linux"
            : "未知设备";
  const browser = /Edg\//i.test(ua)
    ? "Edge"
    : /Firefox\//i.test(ua)
      ? "Firefox"
      : /Chrome\//i.test(ua)
        ? "Chrome"
        : /Safari\//i.test(ua)
          ? "Safari"
          : "浏览器";
  return `${platform} · ${browser}`;
}

function authRequestOrigin(request: Request): string {
  const suppliedOrigin = request.headers.get("Origin") ?? "";
  if (suppliedOrigin) return suppliedOrigin;
  // Browsers commonly omit Origin on legacy same-origin GET requests. A
  // strictly allowlisted Referer origin keeps those read-method aliases usable
  // without weakening POST bootstrap requirements.
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return "";
  }
  const referrer = request.headers.get("Referer") ?? "";
  try {
    return referrer ? new URL(referrer).origin : "";
  } catch {
    return "";
  }
}

export function allowlistedAuthRequest(
  request: Request,
  env: Pick<
    Env,
    | "ALLOWED_ORIGINS"
    | "AUTH_ALLOWED_ORIGINS"
    | "PC_AUTH_ALLOWED_ORIGINS"
    | "KEFU_AUTH_ALLOWED_ORIGINS"
    | "NODE_ENV"
  >,
  audience: ScanLoginAudience,
): AuthRequestMetadata {
  const configuredValue = audience === "pc_user"
    ? env.PC_AUTH_ALLOWED_ORIGINS || env.AUTH_ALLOWED_ORIGINS
    : env.KEFU_AUTH_ALLOWED_ORIGINS;
  const configured = String(configuredValue ?? "").trim();
  if (!configured && env.NODE_ENV === "production") {
    throw new ServiceUnavailableException(
      audience === "pc_user" ? "PC 登录来源白名单尚未配置" : "客服登录来源白名单尚未配置",
    );
  }
  const suppliedOrigin = authRequestOrigin(request);
  if (!isAllowedAuthOrigin(suppliedOrigin, env, audience)) {
    throw new ForbiddenException("请求来源未进入登录白名单");
  }
  return {
    origin: normalizedOrigin(suppliedOrigin)!,
    device: deviceLabel(request.headers.get("User-Agent") ?? ""),
    target: audience === "pc_user" ? "CinaShop PC 商城" : "CinaShop 客服工作台",
  };
}
