import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import type { RateLimitDecision } from "@/services/out/OutRateLimitPolicy";
import { RateLimitException } from "@/utils/errors";

type AdminContext = Context<{ Bindings: Env; Variables: AppVariables }>;

export const ADMIN_LOGIN_POLICY = {
  bodyLimitBytes: 4 * 1024,
  sourceAttempts: 10,
  sourceWindowSeconds: 60,
  accountAttempts: 30,
  accountWindowSeconds: 15 * 60,
  newPasswordMinLength: 12,
  bcryptCost: 12,
} as const;

function clientIp(c: AdminContext): string {
  return (
    c.req.header("CF-Connecting-IP") ??
    c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
    c.req.header("X-Real-IP") ??
    "0.0.0.0"
  ).slice(0, 128);
}

async function subjectHash(env: Env, purpose: string, subject: string): Promise<string> {
  if (!env.APP_KEY) throw new Error("Admin login HMAC key unavailable");
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
    new TextEncoder().encode(`${purpose}\u0000${subject}`),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function rateHeaders(c: AdminContext, decision: RateLimitDecision): void {
  c.header("X-RateLimit-Limit", String(decision.limit));
  c.header("X-RateLimit-Remaining", String(decision.remaining));
  c.header("X-RateLimit-Reset", String(Math.ceil(decision.resetAt / 1_000)));
}

function enforce(c: AdminContext, decision: RateLimitDecision): void {
  rateHeaders(c, decision);
  if (!decision.allowed) {
    throw new RateLimitException(
      "登录尝试过于频繁，请稍后重试",
      Math.max(1, Math.ceil((decision.resetAt - Date.now()) / 1_000)),
      false,
    );
  }
}

/** Strongly consistent per-source limit, checked before credentials are buffered. */
export async function enforceAdminLoginSourceLimit(c: AdminContext): Promise<void> {
  const hash = await subjectHash(c.env, "admin-login-source", clientIp(c));
  const decision = await c.env.TOKEN_BUCKET
    .getByName(`admin-login-source:${hash.slice(0, 32)}`)
    .consumeRateLimit(
      [{ key: "login", limit: ADMIN_LOGIN_POLICY.sourceAttempts }],
      ADMIN_LOGIN_POLICY.sourceWindowSeconds,
    );
  enforce(c, decision);
}

/** Separate account bucket prevents distributed guessing without storing account names. */
export async function enforceAdminLoginAccountLimit(
  c: AdminContext,
  normalizedAccount: string,
): Promise<void> {
  const hash = await subjectHash(c.env, "admin-login-account", normalizedAccount.toLowerCase());
  const decision = await c.env.TOKEN_BUCKET
    .getByName(`admin-login-account:${hash.slice(0, 32)}`)
    .consumeRateLimit(
      [{ key: "login", limit: ADMIN_LOGIN_POLICY.accountAttempts }],
      ADMIN_LOGIN_POLICY.accountWindowSeconds,
    );
  enforce(c, decision);
}
