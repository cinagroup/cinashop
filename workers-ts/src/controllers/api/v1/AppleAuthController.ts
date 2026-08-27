import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { AppleAuthService } from "@/services/auth/AppleAuthService";
import { clientIp } from "@/controllers/api/v1/UserBehaviorController";
import { ValidateException } from "@/utils/errors";
import { jsonFail, jsonOk } from "@/utils/json";
import { readBoundedJsonObject } from "@/utils/request-body";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
const MAX_APPLE_AUTH_BODY_BYTES = 8 * 1024;

/** POST /api/apple_login/challenge — one-time nonce for a native Apple request. */
export async function challenge(c: C) {
  try {
    const result = await new AppleAuthService(c.get("container"), c.env)
      .createChallenge(clientIp(c));
    return jsonOk(c, result);
  } catch (error) {
    if (error instanceof ValidateException) return jsonFail(c, error.message);
    throw error;
  }
}

/** POST /api/apple_login — accepts only an Apple-signed identityToken. */
export async function login(c: C) {
  const body = await readBoundedJsonObject(c.req.raw, MAX_APPLE_AUTH_BODY_BYTES);
  try {
    const result = await new AppleAuthService(c.get("container"), c.env).login({
      identityToken: body.identityToken,
      nonceKey: body.nonce_key ?? body.nonceKey,
      spreadUid: body.spread_spid,
      ip: clientIp(c),
    });
    return jsonOk(c, result, "登录成功");
  } catch (error) {
    if (error instanceof ValidateException) return jsonFail(c, error.message);
    throw error;
  }
}
