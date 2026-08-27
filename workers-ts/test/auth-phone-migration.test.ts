import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Env, SmsVerificationMessage } from "@/env";
import type { Container } from "@/lib/di";
import {
  isSmsVerificationMessage,
  normalizeUserSmsType,
  secureSixDigitCode,
  SmsVerificationService,
} from "@/services/message/SmsVerificationService";

describe("phone authentication migration", () => {
  it("isolates every phone authorization capability by purpose", () => {
    expect(normalizeUserSmsType("register")).toEqual({ type: "register", purpose: "user_register" });
    expect(normalizeUserSmsType("mobile")).toEqual({ type: "mobile", purpose: "user_login" });
    expect(normalizeUserSmsType("login")).toEqual({ type: "mobile", purpose: "user_login" });
    expect(normalizeUserSmsType("reset")).toEqual({ type: "reset", purpose: "user_password_reset" });
    expect(normalizeUserSmsType("binding")).toEqual({ type: "binding", purpose: "user_phone_binding" });
    expect(normalizeUserSmsType("social_binding")).toEqual({
      type: "social_binding",
      purpose: "user_social_binding",
    });
    expect(normalizeUserSmsType("update_phone")).toEqual({ type: "update_phone", purpose: "user_phone_update" });
    expect(() => normalizeUserSmsType("supplier_application")).toThrow(
      "短信验证码用途错误",
    );
  });

  it("generates fixed-width cryptographically sourced verification codes", () => {
    const values = Array.from({ length: 128 }, () => secureSixDigitCode());
    expect(values.every((value) => /^\d{6}$/.test(value))).toBe(true);
    expect(new Set(values).size).toBeGreaterThan(120);
  });

  it("accepts unauthenticated user messages without weakening supplier ownership", () => {
    const base = {
      action: "sendSmsVerification",
      recordId: 19,
      uid: 0,
      phone: "13800138000",
      code: "042731",
      expiresIn: 300,
      purpose: "user_register",
      templateCode: "SMS_123456789",
    } satisfies SmsVerificationMessage;
    expect(isSmsVerificationMessage(base)).toBe(true);
    for (const purpose of [
      "user_login",
      "user_password_reset",
      "user_phone_binding",
      "user_social_binding",
      "user_phone_update",
    ] satisfies SmsVerificationMessage["purpose"][]) {
      expect(isSmsVerificationMessage({ ...base, purpose })).toBe(true);
    }
    expect(isSmsVerificationMessage({ ...base, purpose: "supplier_application" })).toBe(false);
    expect(isSmsVerificationMessage({ ...base, purpose: "password_reset" })).toBe(false);
  });

  it("fails closed before database or queue access when SMS secrets are absent", async () => {
    const env = {
      UPSTASH_REDIS_URL: "https://redis.example.test",
      UPSTASH_REDIS_TOKEN: "test-token",
    } as Env;
    const service = new SmsVerificationService({} as Container, env);
    await expect(service.requestUserCode(
      "13800138000",
      "register",
      "00000000-0000-4000-8000-000000000000",
      "127.0.0.1",
    )).rejects.toThrow("短信服务尚未配置");
  });

  it("registers the PHP-compatible lifecycle and bounds every auth body", () => {
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    const controller = readFileSync("src/controllers/api/v1/LoginController.ts", "utf8");
    for (const route of [
      '"/verify_code"',
      '"/verify_code/complete"',
      '"/verify_code/status"',
      '"/turnstile/challenge"',
      '"/register/verify"',
      '"/login/mobile"',
      '"/register/reset"',
      '"/user/updatePhone"',
      '"/user/binding"',
      '"/binding"',
      '"/apple_login/challenge"',
      '"/apple_login"',
    ]) expect(routes).toContain(route);
    expect(controller).toContain("MAX_AUTH_BODY_BYTES = 4 * 1024");
    expect(controller).not.toContain("c.req.json(");
    expect(controller).toContain("clearToken(md5(token), c.env)");
    expect(controller).toContain('consumeUserCode("user_register"');
    expect(controller).toContain('consumeUserCode("user_login"');
    expect(controller).toContain('consumeUserCode("user_password_reset"');
    expect(controller).toContain('consumeUserCode("user_phone_binding"');
    expect(controller).toContain('consumeUserCode("user_social_binding"');
    expect(controller).toContain('consumeUserCode("user_phone_update"');
    expect(controller).not.toContain('consumeUserCode("user_mobile"');
  });

  it("serializes phone writes and refuses ambiguous legacy identities", () => {
    const service = readFileSync("src/services/user/LoginService.ts", "utf8");
    expect(service).toContain("pg_advisory_xact_lock");
    expect(service).toContain("手机号关联多个账号，请联系客服处理");
    expect(service).toContain("pwd: md5(crypto.randomUUID())");
    expect(service).toContain("lockValues");
    expect(service).toContain(".sort()");
  });

  it("removes client placeholders and sends challenge-bound requests", () => {
    const files = [
      "../view/pc-ts/src/pages/auth/Login.vue",
      "../view/pc-ts/src/pages/auth/Register.vue",
      "../view/pc-ts/src/pages/auth/ForgotPassword.vue",
      "../view/pc-ts/src/pages/user/PhoneSettings.vue",
      "../view/uniapp-ts/src/pages/auth/login.vue",
      "../view/uniapp-ts/src/pages/auth/register.vue",
      "../view/uniapp-ts/src/pages/auth/reset.vue",
      "../view/uniapp-ts/src/pages/user/phone.vue",
    ];
    const source = files.map((file) => readFileSync(file, "utf8")).join("\n");
    expect(source).not.toContain("验证码发送接入中");
    expect(source).not.toContain("手机号验证码登录接入中");
    expect(source.match(/requestSmsChallenge\(/g)?.length).toBe(8);
    expect(source.match(/apiRequestCode\(/g)?.length).toBe(8);
    for (const purpose of ["register", "mobile", "reset", "binding", "update_phone"]) {
      expect(source).toContain(`"${purpose}"`);
    }
  });

  it("exposes recovery and phone-management navigation on both clients", () => {
    const pcRouter = readFileSync("../view/pc-ts/src/router/index.ts", "utf8");
    const uniPages = readFileSync("../view/uniapp-ts/src/pages.json", "utf8");
    const uniUser = readFileSync("../view/uniapp-ts/src/pages/user/index.vue", "utf8");
    expect(pcRouter).toContain('path: "forgot-password"');
    expect(pcRouter).toContain('path: "user/phone"');
    expect(uniPages).toContain('"path": "pages/auth/reset"');
    expect(uniPages).toContain('"path": "pages/user/phone"');
    expect(uniUser).toContain("await apiLogout()");
  });

  it("binds Mini Program phones to the authenticated server-side identity", () => {
    const service = readFileSync("src/services/wechat/WechatAuthService.ts", "utf8");
    const controller = readFileSync("src/controllers/api/v1/WechatController.ts", "utf8");
    expect(service).toContain("session_key_uid:${uid}");
    expect(service).toContain("session_key_uid:${params.uid}");
    expect(service).toContain("eq(wechatUser.uid, params.uid)");
    expect(service).toContain("login.bindPhone(params.uid, phone)");
    expect(service).toContain("login.updatePhone(params.uid, phone)");
    expect(service).toContain("md5(crypto.randomUUID())");
    expect(service).not.toContain('md5("123456")');
    expect(controller).toContain("uid,");
    expect(controller).not.toContain("openid: body.openid");
    expect(controller).toContain("MAX_SOCIAL_AUTH_BODY_BYTES = 8 * 1024");
    expect(controller.match(/readBoundedJsonObject\(/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps provider-verified pending identities one-time and conflict-safe", () => {
    const service = readFileSync("src/services/wechat/WechatAuthService.ts", "utf8");
    const cache = readFileSync("src/utils/cache.ts", "utf8");
    expect(service).toContain("SOCIAL_PENDING_TTL_SECONDS = 15 * 60");
    expect(service).toContain("cacheTake<PendingSocialIdentity>");
    expect(service).toContain("identityLocks");
    expect(service).toContain(".sort()");
    expect(service).toContain("社交身份与手机号属于不同账号");
    expect(service).toContain("user-phone:${phone}");
    expect(cache).toContain("r.getdel<T>");
  });
});
