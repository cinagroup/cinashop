import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Env } from "@/env";
import type { Container } from "@/lib/di";
import {
  appleAudienceList,
  AppleAuthService,
  sha256Hex,
} from "@/services/auth/AppleAuthService";

describe("Apple social authentication migration", () => {
  it("parses an explicit audience allowlist and rejects absent configuration", () => {
    expect(appleAudienceList("com.example.app, app.example.web,com.example.app"))
      .toEqual(["com.example.app", "app.example.web"]);
    expect(() => appleAudienceList("")).toThrow("Apple 登录尚未配置");
    expect(() => appleAudienceList("x".repeat(256))).toThrow("Apple 登录配置无效");
  });

  it("uses Web Crypto for the nonce digest", async () => {
    await expect(sha256Hex("abc")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("fails closed on deployment configuration before Redis, JWKS, or database access", async () => {
    const service = new AppleAuthService({} as Container, {} as Env);
    await expect(service.createChallenge()).rejects.toThrow("Apple 登录尚未配置");
    await expect(service.login({ identityToken: "x".repeat(256), nonceKey: crypto.randomUUID() }))
      .rejects.toThrow("Apple 登录尚未配置");
  });

  it("verifies only Apple-signed identityToken claims and one-time nonce state", () => {
    const service = readFileSync("src/services/auth/AppleAuthService.ts", "utf8");
    const controller = readFileSync("src/controllers/api/v1/AppleAuthController.ts", "utf8");
    expect(service).toContain('new URL("https://appleid.apple.com/auth/keys")');
    expect(service).toContain('issuer: APPLE_ISSUER');
    expect(service).toContain('algorithms: ["ES256"]');
    expect(service).toContain("audience: audiences");
    expect(service).toContain("payload.nonce !== expectedNonce");
    expect(service).toContain("cacheTake<string>(APPLE_NONCE_PREFIX");
    expect(service).toContain("APPLE_TOKEN_PREFIX + tokenDigest");
    expect(service).toContain("checkIpRateLimit");
    expect(service).toContain("openid: payload.sub");
    expect(controller).toContain("MAX_APPLE_AUTH_BODY_BYTES = 8 * 1024");
    expect(controller).not.toContain("body.openId");
    expect(controller).not.toContain("body.email");
  });
});
