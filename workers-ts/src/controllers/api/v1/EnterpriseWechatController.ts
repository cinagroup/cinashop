import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { AppVariables, Env } from "@/env";
import { EnterpriseWechatContextService } from "@/services/work/EnterpriseWechatContextService";
import { EnterpriseWechatJsSdkService } from "@/services/work/EnterpriseWechatJsSdkService";
import {
  RateLimitException,
  ServiceUnavailableException,
  ValidateException,
} from "@/utils/errors";
import { jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
export const WORK_CONTEXT_COOKIE = "__Host-cinashop-work-context-state";
const MAX_CONTEXT_BODY_BYTES = 4 * 1024;

function signedUrl(c: C): string {
  const url = c.req.query("url");
  if (!url) throw new ValidateException("url 不能为空");
  return url;
}

function noStore(c: C): void {
  c.header("Cache-Control", "private, no-store, max-age=0");
  c.header("Pragma", "no-cache");
}

async function jsonBody(c: C): Promise<Record<string, unknown>> {
  if (!(c.req.header("Content-Type") ?? "").toLowerCase().startsWith("application/json")) {
    throw new ValidateException("Content-Type 必须为 application/json");
  }
  const declared = Number(c.req.header("Content-Length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_CONTEXT_BODY_BYTES) {
    throw new ValidateException("请求体过大");
  }
  const reader = c.req.raw.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_CONTEXT_BODY_BYTES) {
          await reader.cancel();
          throw new ValidateException("请求体过大");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new ValidateException("JSON 请求体无效");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ValidateException("JSON 请求体无效");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ValidateException("JSON 请求体无效");
  }
  return parsed as Record<string, unknown>;
}

function requestOrigin(c: C): string {
  return c.req.header("Origin") ?? "";
}

function bearer(c: C): string {
  const header = c.req.header("Authorization") ?? "";
  const match = header.match(/^Bearer ([^\s]+)$/i);
  if (!match) throw new ValidateException("请提供企业微信上下文令牌");
  return match[1];
}

function clientIp(c: C): string {
  return (
    c.req.header("CF-Connecting-IP")
    ?? c.req.header("X-Forwarded-For")?.split(",")[0]?.trim()
    ?? c.req.header("X-Real-IP")
    ?? "0.0.0.0"
  ).slice(0, 128);
}

async function rateLimit(c: C, operation: "challenge" | "exchange", limit: number) {
  const secret = new TextEncoder().encode(c.env.APP_KEY ?? "");
  if (secret.byteLength < 32) {
    throw new ServiceUnavailableException("企业微信上下文签名密钥尚未安全配置");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`work-context-ip\0${clientIp(c)}`),
  );
  const source = Array.from(new Uint8Array(digest), (part) => part.toString(16).padStart(2, "0"))
    .join("").slice(0, 32);
  const decision = await c.env.TOKEN_BUCKET
    .getByName(`work-context:${source}`)
    .consumeRateLimit([{ key: operation, limit }], 60);
  c.header("X-RateLimit-Limit", String(decision.limit));
  c.header("X-RateLimit-Remaining", String(decision.remaining));
  c.header("X-RateLimit-Reset", String(Math.ceil(decision.resetAt / 1_000)));
  if (!decision.allowed) {
    throw new RateLimitException(
      "企业微信上下文授权请求过于频繁，请稍后重试",
      Math.max(1, Math.ceil((decision.resetAt - Date.now()) / 1_000)),
      false,
    );
  }
}

function contextService(c: C) {
  return new EnterpriseWechatContextService(c.get("container"), c.env);
}

/** GET /api/work/config — enterprise-level JS-SDK signature. */
export async function config(c: C) {
  noStore(c);
  const data = await new EnterpriseWechatJsSdkService(c.get("container"), c.env)
    .companyConfig(signedUrl(c));
  return jsonOk(c, data);
}

/** GET /api/work/agentConfig — application-level JS-SDK signature. */
export async function agentConfig(c: C) {
  noStore(c);
  const data = await new EnterpriseWechatJsSdkService(c.get("container"), c.env)
    .agentConfig(signedUrl(c));
  return jsonOk(c, data);
}

/** POST /api/work/context/challenge — one-time OAuth state + PKCE-style cookie verifier. */
export async function contextChallenge(c: C) {
  noStore(c);
  await rateLimit(c, "challenge", 20);
  const body = await jsonBody(c);
  const data = await contextService(c).challenge(requestOrigin(c), String(body.redirect_uri ?? ""));
  setCookie(c, WORK_CONTEXT_COOKIE, data.cookie_value, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: data.expires_in,
  });
  const { cookie_value: _cookieValue, ...publicData } = data;
  return jsonOk(c, publicData);
}

/** POST /api/work/context/exchange — verified employee + local target visibility. */
export async function contextExchange(c: C) {
  noStore(c);
  await rateLimit(c, "exchange", 10);
  const body = await jsonBody(c);
  const targetType = body.target_type;
  const target = targetType === "client"
    ? { type: "client" as const, externalUserid: String(body.external_userid ?? "") }
    : targetType === "group"
      ? { type: "group" as const, chatId: String(body.chat_id ?? "") }
      : null;
  if (!target) throw new ValidateException("target_type 仅支持 client 或 group");
  if (
    (target.type === "client" && body.chat_id !== undefined)
    || (target.type === "group" && body.external_userid !== undefined)
  ) throw new ValidateException("上下文目标参数冲突");
  const cookieValue = getCookie(c, WORK_CONTEXT_COOKIE) ?? "";
  setCookie(c, WORK_CONTEXT_COOKIE, "", {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 0,
  });
  return jsonOk(c, await contextService(c).exchange({
    origin: requestOrigin(c),
    state: body.state,
    code: body.code,
    cookieValue,
    target,
  }));
}

/** GET /api/work/groupInfo */
export async function groupInfo(c: C) {
  noStore(c);
  return jsonOk(c, await contextService(c).groupInfo(bearer(c)));
}

/** GET /api/work/groupMember/:id */
export async function groupMember(c: C) {
  noStore(c);
  return jsonOk(c, await contextService(c).groupMembers(
    bearer(c),
    c.req.param("id"),
    c.req.query(),
  ));
}

/** GET /api/work/client/info */
export async function clientInfo(c: C) {
  noStore(c);
  return jsonOk(c, await contextService(c).clientInfo(bearer(c)));
}

/** GET /api/work/order/list */
export async function orderList(c: C) {
  noStore(c);
  return jsonOk(c, await contextService(c).orderList(bearer(c), c.req.query()));
}

/** GET /api/work/order/info/:id */
export async function orderInfo(c: C) {
  noStore(c);
  return jsonOk(c, await contextService(c).orderInfo(bearer(c), c.req.param("id")));
}

/** GET /api/work/product/cart_list */
export async function productCartList(c: C) {
  noStore(c);
  return jsonOk(c, await contextService(c).purchasedProducts(bearer(c), c.req.query()));
}

/** GET /api/work/product/visit_list */
export async function productVisitList(c: C) {
  noStore(c);
  return jsonOk(c, await contextService(c).visitedProducts(bearer(c), c.req.query()));
}
