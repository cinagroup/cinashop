import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { UserProfileService } from "@/services/user/UserProfileService";
import { ScanLoginService } from "@/services/auth/ScanLoginService";
import { NotFoundException, ValidateException } from "@/utils/errors";
import { jsonFail, jsonOk } from "@/utils/json";
import { readBoundedJsonObject } from "@/utils/request-body";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function service(c: C): UserProfileService {
  return new UserProfileService(c.get("container"), c.env);
}

function uid(c: C): number {
  const value = c.get("uid");
  if (!value) throw new ValidateException("请先登录");
  return value;
}

async function response<T>(c: C, operation: () => Promise<T>) {
  try {
    return jsonOk(c, await operation());
  } catch (error) {
    if (error instanceof ValidateException || error instanceof NotFoundException) {
      return jsonFail(c, error.message);
    }
    throw error;
  }
}

/** GET /api/user/activity — public activity-presence flags. */
export async function activity(c: C) {
  return response(c, () => service(c).activity());
}

/** GET /api/user — PHP-compatible personal-home aggregation. */
export async function personalHome(c: C) {
  return response(c, () => service(c).personalHome(uid(c)));
}

/** GET /api/userinfo — legacy safe self-profile alias. */
export async function userInfo(c: C) {
  return response(c, () => service(c).userInfo(uid(c)));
}

/** GET /api/user/rand_code — cryptographically secure, ten-minute payment code. */
export async function randCode(c: C) {
  return response(c, async () => ({ code: await service(c).paymentCode(uid(c)) }));
}

/** POST /api/user/share — durable five-minute share cooldown. */
export async function userShare(c: C) {
  return response(c, () => service(c).recordShare(uid(c)));
}

/** GET /api/user/share/words?product_id= — product copy command. */
export async function shareWords(c: C) {
  const productId = Number(c.req.query("product_id") ?? 0);
  return response(c, async () => ({ key_words: await service(c).shareWords(productId) }));
}

/** GET /api/user/routine_code — cached WeChat mini-program spread code. */
export async function routineCode(c: C) {
  return response(c, async () => ({ url: await service(c).routineCode(uid(c)) }));
}

/** GET /api/user/spread_info — poster and safe user identity data. */
export async function spreadInfo(c: C) {
  return response(c, () => service(c).spreadInfo(uid(c)));
}

function scanCode(c: C): string {
  return c.req.query("code") ?? c.req.query("key") ?? "";
}

function clientIp(c: C): string {
  return (
    c.req.header("CF-Connecting-IP")
    ?? c.req.header("X-Forwarded-For")?.split(",")[0]?.trim()
    ?? c.req.header("X-Real-IP")
    ?? "0.0.0.0"
  ).slice(0, 128);
}

/** GET /api/user/code — inspect and bind an authenticated mobile scan. */
export async function inspectLoginCode(c: C) {
  c.header("Cache-Control", "no-store, max-age=0");
  c.header("Referrer-Policy", "no-referrer");
  return response(c, () => new ScanLoginService(c.get("container"), c.env)
    .inspect(scanCode(c), uid(c), clientIp(c)));
}

/** POST /api/user/code — approve or reject only as the mobile uid that inspected. */
export async function approveLoginCode(c: C) {
  c.header("Cache-Control", "no-store, max-age=0");
  c.header("Referrer-Policy", "no-referrer");
  return response(c, async () => {
    const payload = await readBoundedJsonObject(c.req.raw, 4 * 1024);
    const action = String(payload.action ?? "approve").trim();
    const login = new ScanLoginService(c.get("container"), c.env);
    const key = payload.code ?? payload.key ?? scanCode(c);
    if (action === "reject") return login.reject(key, uid(c), clientIp(c));
    if (action !== "approve") throw new ValidateException("扫码登录操作无效");
    return login.approve(key, uid(c), clientIp(c));
  });
}
