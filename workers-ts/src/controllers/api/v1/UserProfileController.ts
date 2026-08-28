import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { UserProfileService } from "@/services/user/UserProfileService";
import { NotFoundException, ValidateException } from "@/utils/errors";
import { jsonFail, jsonOk, jsonRaw } from "@/utils/json";

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

/**
 * The PHP QR-login contract accepts a caller-controlled cache key and is not a
 * safe authentication challenge. Keep the exact route explicit but closed.
 */
export function userCodeUnavailable(c: C) {
  return jsonRaw(c, 501, "客服扫码登录尚未启用安全的一次性挑战流程");
}
