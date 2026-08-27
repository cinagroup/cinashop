import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import type { RateLimitDecision } from "@/services/out/OutRateLimitPolicy";
import { RateLimitException, ValidateException } from "@/utils/errors";

type KefuContext = Context<{ Bindings: Env; Variables: AppVariables }>;

const KEFU_LOGIN_LIMIT = 10;
const KEFU_LOGIN_WINDOW_SECONDS = 60;
const KEFU_UPLOAD_LIMIT = 100;
const KEFU_UPLOAD_WINDOW_SECONDS = 24 * 60 * 60;

function clientIp(c: KefuContext): string {
  return (
    c.req.header("CF-Connecting-IP") ??
    c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
    c.req.header("X-Real-IP") ??
    "0.0.0.0"
  ).slice(0, 128);
}

async function loginSourceHash(env: Env, ip: string): Promise<string> {
  if (!env.APP_KEY) throw new Error("Customer-service login HMAC key unavailable");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.APP_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`kefu-login-ip\u0000${ip}`),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function setRateLimitHeaders(c: KefuContext, decision: RateLimitDecision): void {
  c.header("X-RateLimit-Limit", String(decision.limit));
  c.header("X-RateLimit-Remaining", String(decision.remaining));
  c.header("X-RateLimit-Reset", String(Math.ceil(decision.resetAt / 1000)));
}

/** Reject abusive sources before parsing credentials or querying PostgreSQL. */
export async function enforceKefuLoginRateLimit(c: KefuContext): Promise<void> {
  const sourceHash = await loginSourceHash(c.env, clientIp(c));
  const decision = await c.env.TOKEN_BUCKET
    .getByName(`kefu-login:${sourceHash.slice(0, 32)}`)
    .consumeRateLimit([{ key: "login", limit: KEFU_LOGIN_LIMIT }], KEFU_LOGIN_WINDOW_SECONDS);

  setRateLimitHeaders(c, decision);
  if (!decision.allowed) {
    const retryAfter = Math.max(1, Math.ceil((decision.resetAt - Date.now()) / 1000));
    throw new RateLimitException("登录尝试过于频繁，请稍后重试", retryAfter, false);
  }
}

/** Preserve the PHP 100-per-24-hour boundary with one strongly consistent bucket per agent. */
export async function enforceKefuUploadRateLimit(c: KefuContext): Promise<void> {
  const kefuId = Number(c.get("kefuId") ?? 0);
  if (!Number.isSafeInteger(kefuId) || kefuId <= 0) {
    throw new ValidateException("客服身份无效");
  }
  const decision = await c.env.TOKEN_BUCKET
    .getByName(`kefu-upload:${kefuId}`)
    .consumeRateLimit([{ key: "upload", limit: KEFU_UPLOAD_LIMIT }], KEFU_UPLOAD_WINDOW_SECONDS);

  setRateLimitHeaders(c, decision);
  if (!decision.allowed) {
    const retryAfter = Math.max(1, Math.ceil((decision.resetAt - Date.now()) / 1000));
    throw new RateLimitException("今日图片上传次数已达上限，请稍后重试", retryAfter, false);
  }
}
