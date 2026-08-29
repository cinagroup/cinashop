import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("API-004-AUTH / CORE-004 migration", () => {
  it("mounts all sixteen PHP v2 WeChat and Mini Program paths", () => {
    const routes = readFileSync("src/routes/v2/index.ts", "utf8");
    for (const route of [
      'v2Routes.get("/routine/auth_type", V2WechatAuthController.routineAuthType)',
      'v2Routes.get("/routine/auth_login", V2WechatAuthController.routineAuthLogin)',
      'v2Routes.post("/routine/auth_binding_phone", V2WechatAuthController.routineAuthBindingPhone)',
      'v2Routes.post("/routine/phone_login", V2WechatAuthController.routinePhoneLogin)',
      'v2Routes.post("/routine/binding_phone", V2WechatAuthController.routineBindingPhone)',
      'v2Routes.get("/wechat/auth_login", V2WechatAuthController.wechatAuthLogin)',
      'v2Routes.post("/wechat/auth_binding_phone", V2WechatAuthController.wechatAuthBindingPhone)',
      'v2Routes.get("/wechat/routine_auth", V2WechatAuthController.routineLegacyAuth)',
      'v2Routes.get("/wechat/silence_auth", V2WechatAuthController.routineSilentNoLogin)',
      'v2Routes.get("/wechat/silence_auth_login", V2WechatAuthController.routineSilentLogin)',
      'v2Routes.post("/auth_bindind_phone", V2WechatAuthController.routineAuthBindingPhone)',
      'v2Routes.post("/phone_silence_auth", V2WechatAuthController.routinePhoneLogin)',
      'v2Routes.get("/wechat/auth", V2WechatAuthController.wechatLegacyAuth)',
      'v2Routes.get("/wechat/wx_silence_auth", V2WechatAuthController.wechatSilentNoLogin)',
      'v2Routes.get("/wechat/wx_silence_auth_login", V2WechatAuthController.wechatSilentLogin)',
      'v2Routes.post("/phone_wx_silence_auth", V2WechatAuthController.wechatAuthBindingPhone)',
    ]) expect(routes).toContain(route);
  });

  it("requires one-time provider codes, bounded provider reads and real configuration", () => {
    const service = readFileSync("src/services/wechat/WechatAuthService.ts", "utf8");
    expect(service).toContain("claimProviderCode(");
    expect(service).toContain("cacheSetIfAbsent(");
    expect(service).toContain("WECHAT_CODE_TTL_SECONDS = 10 * 60");
    expect(service).toContain("WECHAT_AUTH_LIMIT_PER_MINUTE = 30");
    expect(service).toContain("WECHAT_RESPONSE_MAX_BYTES = 32 * 1024");
    expect(service).toContain("WECHAT_FETCH_TIMEOUT_MS = 8_000");
    expect(service).toContain('getAppId("routine")');
    expect(service).toContain('getAppSecret("routine")');
    expect(service).toContain('getAppId("wechat")');
    expect(service).toContain('getAppSecret("wechat")');
    expect(service).not.toContain("Math.random(");
  });

  it("binds OAuth state and pending identities to a one-time network capability", () => {
    const service = readFileSync("src/services/wechat/WechatAuthService.ts", "utf8");
    const controller = readFileSync("src/controllers/api/v1/V2WechatAuthController.ts", "utf8");
    expect(service).toContain("createOauthState(");
    expect(service).toContain("consumeOauthState(");
    expect(service).toContain("cacheTake<WechatOauthState>");
    expect(service).toContain("cacheTake<RoutineLoginTicket>");
    expect(service).toContain("cacheTake<PendingSocialIdentity>");
    expect(service.indexOf("const preview = await this.peekRoutineLoginTicket"))
      .toBeLessThan(service.indexOf("const ticket = await this.takeRoutineLoginTicket"));
    expect(service).toContain("normalizedAuditIp(ip)");
    expect(controller).toContain('c.req.query("state")');
    expect(controller).toContain('"Cache-Control", "private, no-store, max-age=0"');
  });

  it("accepts current and legacy phone credentials without trusting a client phone", () => {
    const service = readFileSync("src/services/wechat/WechatAuthService.ts", "utf8");
    const controller = readFileSync("src/controllers/api/v1/V2WechatAuthController.ts", "utf8");
    expect(service).toContain("phoneNumberFromCode(");
    expect(service).toContain("decryptMiniProgramData(");
    expect(service).toContain("手机号凭据所属小程序不匹配");
    expect(service).toContain('claimProviderCode("routine_phone"');
    expect(controller).toContain("input.phone_code ?? input.phoneCode");
    expect(controller).toContain("input.encryptedData ?? input.encrypted_data");
    expect(controller).not.toContain("phone: input.phone,");
  });

  it("uses a social-binding SMS purpose and returns PHP field aliases", () => {
    const controller = readFileSync("src/controllers/api/v1/V2WechatAuthController.ts", "utf8");
    expect(controller.match(/consumeUserCode\("user_social_binding"/g)?.length).toBe(2);
    expect(controller).toContain("expires_time: result.expiresTime");
    expect(controller).toContain("store_user_avatar: result.storeUserAvatar");
    expect(controller).toContain("userInfo: result.userInfo");
    expect(controller).toContain("spread_spid");
    expect(controller).toContain("spread_uid");
    expect(controller).toContain("spid");
  });

  it("registers safe legacy captcha aliases without fixed-success compatibility", () => {
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    const controller = readFileSync("src/controllers/api/v1/LoginController.ts", "utf8");
    expect(routes).toContain('v1Routes.get("/verify_code", LoginController.legacyVerifyCode)');
    expect(routes).toContain('v1Routes.get("/ajcaptcha", LoginController.ajcaptchaUnavailable)');
    expect(routes).toContain('v1Routes.post("/ajcheck", LoginController.ajcaptchaUnavailable)');
    expect(routes).toContain('v1Routes.get("/sms_captcha", LoginController.smsCaptchaUnavailable)');
    expect(controller).toContain("旧 GET verify_code 必须提供 phone 和 type");
    expect(controller).toContain('jsonRaw(c, 410, "AJCaptcha 已迁移为 Turnstile');
    expect(controller).not.toContain("aj_captcha");
  });
});
