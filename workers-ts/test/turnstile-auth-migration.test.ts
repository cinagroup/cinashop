import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "@/env";
import { TurnstileService } from "@/services/auth/TurnstileService";

const NOW = Date.parse("2026-08-15T10:00:00.000Z");
const KEY = "0ad785b4-b75f-4cf8-8d5f-5ba0a78db8f3";

function configuredEnv(overrides: Partial<Env> = {}): Env {
  return {
    TURNSTILE_SECRET_KEY: "server-secret",
    TURNSTILE_SITE_KEY: "site-key",
    TURNSTILE_EXPECTED_HOSTNAMES: "auth.example.com, AUTH-ALT.EXAMPLE.COM.",
    ...overrides,
  } as Env;
}

function siteverifyResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    success: true,
    challenge_ts: "2026-08-15T09:58:00.000Z",
    hostname: "auth.example.com",
    action: "sms_send",
    cdata: KEY,
    "error-codes": [],
    ...overrides,
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Turnstile SMS migration", () => {
  it("fails closed unless secret, site key, and hostname policy are all configured", async () => {
    for (const env of [
      configuredEnv({ TURNSTILE_SECRET_KEY: undefined }),
      configuredEnv({ TURNSTILE_SITE_KEY: undefined }),
      configuredEnv({ TURNSTILE_EXPECTED_HOSTNAMES: undefined }),
    ]) {
      const fetcher = vi.fn() as unknown as typeof fetch;
      const service = new TurnstileService(env, fetcher);
      expect(() => service.publicConfig()).toThrow("人机验证尚未配置");
      await expect(service.verify("token", "192.0.2.1", "sms_send", KEY, NOW))
        .rejects.toThrow("人机验证尚未配置");
      expect(fetcher).not.toHaveBeenCalled();
    }
  });

  it("validates remotely and binds hostname, action, cdata, and challenge age", async () => {
    const fetcher = vi.fn(async function (this: unknown, _input: RequestInfo | URL, init?: RequestInit) {
      expect(this).toBeUndefined();
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.secret).toBe("server-secret");
      expect(body.response).toBe("browser-token");
      expect(body.remoteip).toBe("192.0.2.1");
      expect(body.idempotency_key).toMatch(/^[0-9a-f-]{36}$/i);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return siteverifyResponse();
    }) as typeof fetch;
    const service = new TurnstileService(configuredEnv(), fetcher);

    await expect(service.verify("browser-token", "192.0.2.1", "sms_send", KEY, NOW))
      .resolves.toEqual({
        hostname: "auth.example.com",
        action: "sms_send",
        challengeTime: "2026-08-15T09:58:00.000Z",
      });
    expect(fetcher).toHaveBeenCalledWith(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it.each([
    [{ hostname: "evil.example.com" }, "来源不匹配"],
    [{ action: "login" }, "用途不匹配"],
    [{ cdata: "different-key" }, "挑战不匹配"],
    [{ challenge_ts: "2026-08-15T09:40:00.000Z" }, "已过期"],
    [{ success: false, "error-codes": ["timeout-or-duplicate"] }, "验证失败"],
  ])("rejects a mismatched Siteverify response %#", async (overrides, message) => {
    const fetcher = vi.fn(async () => siteverifyResponse(overrides)) as unknown as typeof fetch;
    await expect(
      new TurnstileService(configuredEnv(), fetcher)
        .verify("browser-token", "192.0.2.1", "sms_send", KEY, NOW),
    ).rejects.toThrow(message);
  });

  it("bounds both the browser token and Siteverify response", async () => {
    const fetcher = vi.fn(async () => new Response("x".repeat(16 * 1_024 + 1))) as unknown as typeof fetch;
    const service = new TurnstileService(configuredEnv(), fetcher);
    await expect(service.verify("x".repeat(2_049), "192.0.2.1", "sms_send", KEY, NOW))
      .rejects.toThrow("请完成人机验证");
    expect(fetcher).not.toHaveBeenCalled();
    await expect(service.verify("token", "192.0.2.1", "sms_send", KEY, NOW))
      .rejects.toThrow("人机验证服务暂时不可用");
  });

  it("keeps the one-time state machine ahead of all database and queue work", () => {
    const sms = readFileSync("src/services/message/SmsVerificationService.ts", "utf8");
    const controller = readFileSync("src/controllers/api/v1/LoginController.ts", "utf8");
    const pc = readFileSync("../view/pc-ts/src/components/auth/SmsChallengeDialog.vue", "utf8");
    const uni = readFileSync("../view/uniapp-ts/src/pages/auth/smsChallenge.vue", "utf8");
    const uniHelper = readFileSync("../view/uniapp-ts/src/utils/smsChallenge.ts", "utf8");
    expect(sms).toContain('state: "pending"');
    expect(sms).toContain('state: "verified"');
    expect(sms).toContain("redis.getdel<PublicSmsChallenge>");
    expect(sms).toContain("challenge.phone !== phone");
    expect(sms).toContain("challenge.purpose !== purpose");
    expect(sms.indexOf('challenge.state !== "verified"')).toBeLessThan(sms.indexOf("this.queueCode"));
    expect(controller).toContain("Referrer-Policy");
    expect(controller).toContain("Content-Security-Policy");
    expect(controller).toContain('cData: key');
    expect(pc).toContain('event.origin !== expectedOrigin');
    expect(uni).toContain("confirmPendingSmsChallenge");
    expect(uniHelper).toContain("apiVerifyCodeStatus");
  });

  it("retains a read-only production Hyperdrive runtime audit", () => {
    const worker = readFileSync("test/integration/TurnstileProductionAuditWorker.ts", "utf8");
    const config = readFileSync("test/integration/turnstile-production-audit.wrangler.toml", "utf8");
    expect(worker).toContain("cinashop_turnstile_read_only_audit");
    expect(worker).toContain("production_state_unchanged");
    expect(worker).toContain("missing_config_failed_closed");
    expect(worker).toContain("siteverify_transport_reached");
    expect(worker).not.toContain("INSERT INTO");
    expect(worker).not.toContain("UPDATE public");
    expect(worker).not.toContain("DELETE FROM");
    expect(worker).not.toContain("DROP SCHEMA");
    expect(config).toContain('id = "9748c294e21c49a99579c9cef70102e0"');
  });
});
