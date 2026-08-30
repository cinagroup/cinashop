import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isAllowedAuthOrigin,
  isAllowedCorsOrigin,
  isAllowedCorsOriginForPath,
  allowlistedAuthRequest,
} from "../src/services/auth/TrustedAuthClient";
import { createToken } from "../src/utils/jwt";

const productionOrigins = {
  NODE_ENV: "production" as const,
  ALLOWED_ORIGINS: "https://cinashop-pc.pages.dev,https://cinashop-h5.pages.dev",
  PC_AUTH_ALLOWED_ORIGINS: "https://cinashop-pc.pages.dev",
};

describe("scan/OAuth browser boundary hardening", () => {
  it("accepts exact configured origins and never reflects arbitrary origins", () => {
    expect(isAllowedCorsOrigin("https://cinashop-h5.pages.dev", productionOrigins)).toBe(true);
    expect(isAllowedCorsOrigin("https://evil.example", productionOrigins)).toBe(false);
    expect(isAllowedCorsOrigin("https://cinashop-h5.pages.dev.evil.example", productionOrigins)).toBe(false);
    expect(isAllowedCorsOrigin("null", productionOrigins)).toBe(false);
    expect(isAllowedAuthOrigin("https://cinashop-pc.pages.dev", productionOrigins, "pc_user")).toBe(true);
    expect(isAllowedAuthOrigin("https://cinashop-h5.pages.dev", productionOrigins, "pc_user")).toBe(false);
    expect(isAllowedAuthOrigin("https://cinashop-pc.pages.dev", productionOrigins, "kefu_agent")).toBe(false);
  });

  it("limits Work-only browser origins to the Enterprise WeChat API surface", () => {
    const env = {
      ...productionOrigins,
      WORK_WECHAT_ALLOWED_ORIGINS: "https://work.example.com",
    };
    expect(isAllowedCorsOrigin("https://work.example.com", env)).toBe(false);
    expect(isAllowedCorsOriginForPath(
      "https://work.example.com",
      "/api/work/client/info",
      env,
    )).toBe(true);
    expect(isAllowedCorsOriginForPath(
      "https://work.example.com",
      "/adminapi/work/client",
      env,
    )).toBe(false);
    expect(isAllowedCorsOriginForPath(
      "https://work.example.com",
      "/api/order/list",
      env,
    )).toBe(false);
    expect(isAllowedCorsOriginForPath(
      "https://cinashop-h5.pages.dev",
      "/api/order/list",
      env,
    )).toBe(true);
  });

  it("requires an allowlisted browser source and projects only coarse request metadata", () => {
    const request = new Request("https://api.example.test/api/pc/key", {
      method: "POST",
      headers: {
        Origin: "https://cinashop-pc.pages.dev",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0) AppleWebKit Chrome/130.0 Safari/537.36",
      },
    });
    expect(allowlistedAuthRequest(request, productionOrigins, "pc_user")).toEqual({
      origin: "https://cinashop-pc.pages.dev",
      device: "Windows · Chrome",
      target: "CinaShop PC 商城",
    });
    expect(() => allowlistedAuthRequest(
      new Request("https://api.example.test/api/pc/key", { method: "POST" }),
      productionOrigins,
      "pc_user",
    )).toThrow("请求来源未进入登录白名单");

    expect(allowlistedAuthRequest(new Request(
      "https://api.example.test/api/pc/key",
      { method: "GET", headers: { Referer: "https://cinashop-pc.pages.dev/login" } },
    ), productionOrigins, "pc_user").origin).toBe("https://cinashop-pc.pages.dev");
    expect(() => allowlistedAuthRequest(new Request(
      "https://api.example.test/api/pc/key",
      { method: "GET", headers: { Referer: "https://evil.example/login" } },
    ), productionOrigins, "pc_user")).toThrow("请求来源未进入登录白名单");
    expect(() => allowlistedAuthRequest(request, productionOrigins, "kefu_agent"))
      .toThrow("客服登录来源白名单尚未配置");
    expect(() => allowlistedAuthRequest(request, {
      NODE_ENV: "production",
      ALLOWED_ORIGINS: "https://cinashop-pc.pages.dev",
    }, "pc_user")).toThrow("PC 登录来源白名单尚未配置");
  });

  it("uses a fixed issuance timestamp so a retry signs the identical bearer", async () => {
    const first = await createToken(17, "api", "password-hash", "test-app-key", "cinashop", 1_780_000_000);
    const retry = await createToken(17, "api", "password-hash", "test-app-key", "cinashop", 1_780_000_000);
    expect(retry).toEqual(first);
  });

  it("keeps browser verifier, delivery lease, and secrets in server-only boundaries", () => {
    const oauth = readFileSync("src/services/wechat/WechatOpenWebAuthService.ts", "utf8");
    const cookie = readFileSync("src/services/auth/OauthBrowserCookie.ts", "utf8");
    const durable = readFileSync("src/do/TokenBucketDO.ts", "utf8");
    const cache = readFileSync("src/utils/cache.ts", "utf8");
    const cors = readFileSync("src/middleware/cors.ts", "utf8");
    const auth = readFileSync("src/middleware/auth.ts", "utf8");
    const login = readFileSync("src/services/user/LoginService.ts", "utf8");
    const wechat = readFileSync("src/services/wechat/WechatAuthService.ts", "utf8");
    const realtime = readFileSync("src/services/kefu/KefuRealtimeService.ts", "utf8");
    const loginController = readFileSync("src/controllers/api/v1/LoginController.ts", "utf8");
    const pcStorage = readFileSync("../view/pc-ts/src/utils/auth.ts", "utf8");
    const kefuStorage = readFileSync("../view/kefu-ts/src/stores/auth.ts", "utf8");

    expect(cookie).toContain("__Host-cinashop-pc-oauth");
    expect(cookie).toContain("httpOnly: true");
    expect(cookie).toContain("secure: true");
    expect(cookie).toContain('sameSite: "Lax"');
    expect(oauth).toContain("`${STATE_PREFIX}${state}:${verifierHash}`");
    expect(oauth).toContain("WECHAT_OPEN_APP_SECRET");
    expect(oauth).not.toContain('"wechat_open_app_secret"');
    expect(durable).toContain('state.stage = "issuing"');
    expect(durable).toContain('state.stage = "delivered"');
    expect(durable).toContain("completeScanLoginChallenge");
    expect(durable).toContain("releaseScanLoginIssuance");
    expect(cache).toContain('if (!r) throw new ServiceUnavailableException("令牌状态存储不可用")');
    expect(cache).toContain('env.NODE_ENV === "production"');
    expect(cache).toContain('throw new ServiceUnavailableException("令牌状态存储不可用")');
    expect(auth).toContain('bucket.type !== "api"');
    expect(auth).toContain("bucket.token !== token");
    expect(auth).toContain('payload.type !== "api"');
    expect(auth).toContain("const authoritativeAuth = md5(user.pwd)");
    expect(auth).toContain("payload.auth !== authoritativeAuth");
    expect(auth).toContain("activeLegacyWorkerToken");
    expect(auth).not.toContain('user.pwd !== md5("123456")');
    expect(login).toContain('"api",\n      md5(user.pwd),');
    expect(wechat.match(/createToken\(uid, "api", md5\(user\.pwd\)/g)).toHaveLength(2);
    expect(realtime).toContain("session.authVersion !== md5(user.pwd)");
    expect(realtime).toContain("allowLegacyUserAuth && session.authVersion === user.pwd");
    expect(loginController).toContain("disconnectToken(key)");
    expect(pcStorage).toContain("sessionStorage.setItem(TOKEN_KEY, token)");
    expect(pcStorage).toContain("localStorage.removeItem(TOKEN_KEY)");
    expect(kefuStorage).toContain("sessionStorage.setItem(KEFU_TOKEN_KEY, result.token)");
    expect(cors).not.toContain("return origin ??");
  });
});
