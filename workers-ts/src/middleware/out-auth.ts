import type { Context, MiddlewareHandler } from "hono";
import type { AppVariables, Env } from "@/env";
import { extractToken } from "@/middleware/auth";
import {
  type AuthenticatedOutAccount,
  OutApiService,
} from "@/services/out/OutApiService";
import type { RateLimitDecision, RateLimitPolicy } from "@/services/out/OutRateLimitPolicy";
import {
  ApiException,
  AuthException,
  RateLimitException,
} from "@/utils/errors";
import { emitOperationalEvent, operationalErrorCode } from "@/utils/observability";

type OutContext = Context<{ Bindings: Env; Variables: AppVariables }>;
type RateOperation = "login" | "refresh" | "read" | "write";

const RATE_WINDOW_SECONDS = 60;
const DEFAULT_LIMITS: Record<RateOperation, number> = {
  login: 10,
  refresh: 30,
  read: 120,
  write: 30,
};

function boundedLimit(input: string | undefined, fallback: number): number {
  const value = Number(input);
  return Number.isSafeInteger(value) && value >= 1 && value <= 100_000
    ? value
    : fallback;
}

function configuredLimit(env: Env, operation: RateOperation): number {
  if (operation === "login") {
    return boundedLimit(env.OUT_API_LOGIN_LIMIT_PER_MINUTE, DEFAULT_LIMITS.login);
  }
  if (operation === "refresh") {
    return boundedLimit(env.OUT_API_REFRESH_LIMIT_PER_MINUTE, DEFAULT_LIMITS.refresh);
  }
  if (operation === "read") {
    return boundedLimit(env.OUT_API_READ_LIMIT_PER_MINUTE, DEFAULT_LIMITS.read);
  }
  return boundedLimit(env.OUT_API_WRITE_LIMIT_PER_MINUTE, DEFAULT_LIMITS.write);
}

export function outClientIp(c: OutContext): string {
  return (
    c.req.header("CF-Connecting-IP") ??
    c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
    c.req.header("X-Real-IP") ??
    "0.0.0.0"
  ).slice(0, 128);
}

async function hmacHex(env: Env, purpose: string, value: string): Promise<string> {
  if (!env.APP_KEY) throw new Error("Out API HMAC key unavailable");
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
    new TextEncoder().encode(`${purpose}\u0000${value}`),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function consume(
  env: Env,
  subject: string,
  policies: RateLimitPolicy[],
): Promise<RateLimitDecision> {
  return env.TOKEN_BUCKET.getByName(`out-rate:${subject}`).consumeRateLimit(
    policies,
    RATE_WINDOW_SECONDS,
  );
}

function combineDecisions(decisions: RateLimitDecision[]): RateLimitDecision {
  return decisions.reduce((result, decision) => ({
    allowed: result.allowed && decision.allowed,
    auditEvent: result.auditEvent || decision.auditEvent,
    limit: Math.min(result.limit, decision.limit),
    remaining: Math.min(result.remaining, decision.remaining),
    resetAt: Math.max(result.resetAt, decision.resetAt),
  }));
}

function setRateHeaders(c: OutContext, decision: RateLimitDecision): void {
  c.header("X-RateLimit-Limit", String(decision.limit));
  c.header("X-RateLimit-Remaining", String(decision.remaining));
  c.header("X-RateLimit-Reset", String(Math.ceil(decision.resetAt / 1000)));
}

async function consumeIpRateLimit(
  c: OutContext,
  operation: RateOperation,
  ipHash?: string,
): Promise<RateLimitDecision> {
  const digest = ipHash ?? await hmacHex(c.env, "out-api-ip", outClientIp(c));
  const ipLimit = configuredLimit(c.env, operation);
  return consume(c.env, `ip:${digest.slice(0, 32)}`, [
    { key: `operation:${operation}`, limit: ipLimit },
  ]);
}

async function consumeAccountRateLimit(
  c: OutContext,
  operation: "read" | "write",
  account: AuthenticatedOutAccount,
): Promise<RateLimitDecision> {
  const ipLimit = configuredLimit(c.env, operation);
  return consume(c.env, `account:${account.id}`, [{
    key: `operation:${operation}`,
    limit: Math.min(100_000, ipLimit * 4),
  }]);
}

function enforceDecision(c: OutContext, decision: RateLimitDecision): void {
  setRateHeaders(c, decision);
  if (!decision.allowed) {
    const retryAfter = Math.max(1, Math.ceil((decision.resetAt - Date.now()) / 1000));
    throw new RateLimitException("请求过于频繁，请稍后重试", retryAfter, decision.auditEvent);
  }
}

/** Protect token endpoints before credentials or request bodies are processed. */
export async function enforceOutAnonymousRateLimit(
  c: OutContext,
  operation: "login" | "refresh",
): Promise<void> {
  enforceDecision(c, await consumeIpRateLimit(c, operation));
}

function queryFieldNames(c: OutContext): string {
  const names = [...new Set([...new URL(c.req.url).searchParams.keys()])]
    .filter((name) => /^[A-Za-z0-9_.-]{1,40}$/.test(name))
    .sort();
  const accepted: string[] = [];
  let length = 0;
  for (const name of names) {
    const nextLength = length + (accepted.length ? 1 : 0) + name.length;
    if (nextLength > 255) break;
    accepted.push(name);
    length = nextLength;
  }
  return accepted.join(",");
}

function isSensitiveRoute(method: string, routeTemplate: string): boolean {
  return method !== "GET" || ["/order/", "/refund/", "/user/"].some(
    (prefix) => routeTemplate.startsWith(prefix),
  );
}

function auditOutcome(error: unknown): "denied" | "rate_limited" | "error" {
  if (error instanceof RateLimitException) return "rate_limited";
  if (error instanceof AuthException) return "denied";
  return "error";
}

export function outAuthMiddleware(
  methodInput: string,
  routeTemplate: string,
): MiddlewareHandler<{ Bindings: Env; Variables: AppVariables }> {
  const method = methodInput.trim().toUpperCase();
  const operation: "read" | "write" = method === "GET" ? "read" : "write";
  const sensitive = isSensitiveRoute(method, routeTemplate);

  return async (c, next) => {
    const startedAt = Date.now();
    const service = new OutApiService(c.get("container"), c.env);
    const ipHash = await hmacHex(c.env, "out-api-ip", outClientIp(c));
    const ipDecision = await consumeIpRateLimit(c, operation, ipHash);
    // Reject abusive invalid-token traffic before JWT verification or PostgreSQL.
    enforceDecision(c, ipDecision);
    const account = await service.authenticateToken(extractToken(c) ?? "");
    const auditBase = sensitive
      ? {
          account,
          method,
          routeTemplate,
          operation,
          resourceHash: await hmacHex(c.env, "out-api-resource", c.req.path),
          queryFields: queryFieldNames(c),
          ipHash,
          userAgentHash: c.req.header("User-Agent")
            ? await hmacHex(c.env, "out-api-user-agent", c.req.header("User-Agent") ?? "")
            : "",
        }
      : null;
    let auditAttempted = false;

    try {
      const accountDecision = await consumeAccountRateLimit(c, operation, account);
      enforceDecision(c, combineDecisions([ipDecision, accountDecision]));
      await service.assertInterfacePermission(account, method, routeTemplate);
      c.set("outId", account.id);
      c.set("outInfo", account);
      await next();

      if (auditBase) {
        auditAttempted = true;
        await service.recordAccessAudit({
          ...auditBase,
          outcome: "success",
          resultCode: c.res.status,
          durationMs: Date.now() - startedAt,
        });
      }
    } catch (error) {
      const shouldAuditRateLimit = !(error instanceof RateLimitException) || error.recordAudit;
      if (auditBase && !auditAttempted && shouldAuditRateLimit) {
        auditAttempted = true;
        try {
          await service.recordAccessAudit({
            ...auditBase,
            outcome: auditOutcome(error),
            resultCode: error instanceof ApiException ? error.code : 500,
            durationMs: Date.now() - startedAt,
          });
        } catch (auditError) {
          emitOperationalEvent("error", {
            event: "login_audit_write_failed",
            component: "login",
            operation: "out_api_audit",
            outcome: "failure",
            errorCode: operationalErrorCode(auditError),
          });
        }
      }
      throw error;
    }
  };
}
