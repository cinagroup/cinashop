import type { Context } from "hono";
import { jsonFail, jsonOk } from "@/utils/json";
import { ValidateException } from "@/utils/errors";
import { readBoundedJsonObject } from "@/utils/request-body";
import {
  WechatAuthService,
  type SocialAuthResult,
} from "@/services/wechat/WechatAuthService";
import { SmsVerificationService } from "@/services/message/SmsVerificationService";
import type { AppVariables, Env } from "@/env";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
const MAX_AUTH_BODY_BYTES = 8 * 1024;

function service(c: C): WechatAuthService {
  return new WechatAuthService(c.get("container"), c.env);
}

function clientIp(c: C): string {
  return c.req.header("CF-Connecting-IP")
    ?? c.req.header("X-Forwarded-For")?.split(",")[0].trim()
    ?? c.req.header("X-Real-IP")
    ?? "0.0.0.0";
}

function positiveInt(...values: unknown[]): number {
  for (const value of values) {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function querySpreadUid(c: C): number {
  return positiveInt(
    c.req.query("spread_spid"),
    c.req.query("spread_uid"),
    c.req.query("spid"),
  );
}

function bodySpreadUid(body: Record<string, unknown>): number {
  return positiveInt(body.spread_spid, body.spread_uid, body.spid);
}

function noStore(c: C): void {
  c.header("Cache-Control", "private, no-store, max-age=0");
  c.header("Pragma", "no-cache");
}

function compatibilityResult(result: SocialAuthResult, pendingMode: "bind" | "silent" = "bind") {
  if ("bindPhone" in result) {
    return pendingMode === "silent"
      ? { auth_login: 1, key: result.key, expires_in: result.expiresIn }
      : { bindPhone: true, key: result.key, expires_in: result.expiresIn };
  }
  return {
    token: result.token,
    expires_time: result.expiresTime,
    uid: result.uid,
    userInfo: result.userInfo,
    store_user_avatar: result.storeUserAvatar,
  };
}

async function body(c: C): Promise<Record<string, unknown>> {
  return readBoundedJsonObject(c.req.raw, MAX_AUTH_BODY_BYTES);
}

async function respond<T>(c: C, action: () => Promise<T>, message = "登录成功") {
  try {
    const result = await action();
    noStore(c);
    return jsonOk(c, result, message);
  } catch (error) {
    noStore(c);
    if (error instanceof ValidateException) return jsonFail(c, error.message);
    throw error;
  }
}

/** POST /api/v2/wechat/oauth_state — one-time login-CSRF state. */
export async function oauthState(c: C) {
  return respond(c, async () => {
    const result = await service(c).createOauthState(clientIp(c));
    return { state: result.state, expires_in: result.expiresIn };
  }, "授权状态创建成功");
}

/** GET /api/v2/routine/auth_type */
export async function routineAuthType(c: C) {
  return respond(c, () => service(c).beginMiniProgramLogin({
    code: c.req.query("code") ?? "",
    spreadUid: querySpreadUid(c),
    ip: clientIp(c),
  }).then((result) => ({
    bindPhone: result.bindPhone,
    key: result.key,
    expires_in: result.expiresIn,
  })), "ok");
}

/** GET /api/v2/routine/auth_login */
export async function routineAuthLogin(c: C) {
  return respond(c, () => service(c)
    .completeMiniProgramLogin(c.req.query("key"), clientIp(c))
    .then((result) => compatibilityResult(result)));
}

/** POST /api/v2/routine/auth_binding_phone and legacy typo alias. */
export async function routineAuthBindingPhone(c: C) {
  const input = await body(c);
  return respond(c, () => service(c).miniProgramPhoneCredentialLogin({
    key: input.key,
    code: String(input.code ?? ""),
    phoneCode: String(input.phone_code ?? input.phoneCode ?? ""),
    iv: String(input.iv ?? ""),
    encryptedData: String(input.encryptedData ?? input.encrypted_data ?? ""),
    spreadUid: bodySpreadUid(input),
    ip: clientIp(c),
  }).then((result) => {
    if (!("token" in result)) throw new ValidateException("登录状态创建失败");
    return compatibilityResult(result);
  }));
}

/** POST /api/v2/routine/binding_phone — exact legacy no-token response. */
export async function routineBindingPhone(c: C) {
  const input = await body(c);
  return respond(c, async () => {
    await service(c).miniProgramPhoneCredentialLogin({
      key: input.key,
      code: String(input.code ?? ""),
      phoneCode: String(input.phone_code ?? input.phoneCode ?? ""),
      iv: String(input.iv ?? ""),
      encryptedData: String(input.encryptedData ?? input.encrypted_data ?? ""),
      spreadUid: bodySpreadUid(input),
      ip: clientIp(c),
      issueToken: false,
    });
    return 410016;
  }, "ok");
}

/** POST /api/v2/routine/phone_login and /phone_silence_auth. */
export async function routinePhoneLogin(c: C) {
  const input = await body(c);
  const social = service(c);
  return respond(c, async () => {
    await social.assertMiniProgramPhoneLoginCredential({
      key: input.key,
      code: input.code,
      ip: clientIp(c),
    });
    const phone = await new SmsVerificationService(c.get("container"), c.env)
      .consumeUserCode("user_social_binding", input.phone, input.captcha);
    const result = await social.miniProgramPhoneLogin({
      key: input.key,
      code: String(input.code ?? ""),
      phone,
      spreadUid: bodySpreadUid(input),
      ip: clientIp(c),
    });
    return compatibilityResult(result);
  });
}

/** GET /api/v2/wechat/routine_auth */
export async function routineLegacyAuth(c: C) {
  return respond(c, () => service(c).miniProgramSilentLogin({
    code: c.req.query("code") ?? "",
    spreadUid: querySpreadUid(c),
    ip: clientIp(c),
  }).then((result) => compatibilityResult(result, "silent")));
}

/** GET /api/v2/wechat/silence_auth */
export async function routineSilentNoLogin(c: C) {
  return respond(c, () => service(c).miniProgramSilentLogin({
    code: c.req.query("code") ?? "",
    spreadUid: querySpreadUid(c),
    ip: clientIp(c),
    forcePendingForNew: true,
  }).then((result) => compatibilityResult(result, "silent")), "授权成功");
}

/** GET /api/v2/wechat/silence_auth_login */
export async function routineSilentLogin(c: C) {
  return respond(c, () => service(c).miniProgramSilentLogin({
    code: c.req.query("code") ?? "",
    spreadUid: querySpreadUid(c),
    ip: clientIp(c),
  }).then((result) => compatibilityResult(result, "silent")));
}

async function officialLogin(c: C, forcePendingForNew: boolean, pendingMode: "bind" | "silent") {
  return respond(c, () => service(c).oauthLogin(
    c.req.query("code") ?? "",
    clientIp(c),
    {
      state: c.req.query("state"),
      spreadUid: querySpreadUid(c),
      forcePendingForNew,
    },
  ).then((result) => compatibilityResult(result, pendingMode)));
}

/** GET /api/v2/wechat/auth_login and /wechat/auth. */
export async function wechatAuthLogin(c: C) {
  return officialLogin(c, false, "bind");
}

export async function wechatLegacyAuth(c: C) {
  return officialLogin(c, false, "silent");
}

/** GET /api/v2/wechat/wx_silence_auth */
export async function wechatSilentNoLogin(c: C) {
  return officialLogin(c, true, "silent");
}

/** GET /api/v2/wechat/wx_silence_auth_login */
export async function wechatSilentLogin(c: C) {
  return officialLogin(c, false, "silent");
}

/** POST official-account pending identity + purpose-bound SMS completion. */
export async function wechatAuthBindingPhone(c: C) {
  const input = await body(c);
  const social = service(c);
  return respond(c, async () => {
    await social.assertPendingIdentity(input.key, clientIp(c));
    const phone = await new SmsVerificationService(c.get("container"), c.env)
      .consumeUserCode("user_social_binding", input.phone, input.captcha);
    const result = await social.completePendingPhoneBinding(input.key, phone, clientIp(c));
    return compatibilityResult(result);
  });
}
