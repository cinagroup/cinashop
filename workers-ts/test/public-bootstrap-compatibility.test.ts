import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Env } from "@/env";
import type { Container } from "@/lib/di";
import { PublicBrandingService } from "@/services/system/PublicBrandingService";
import {
  LEGACY_SUBSCRIBE_TEMPLATE_KEYS,
  PublicBootstrapCompatibilityService,
} from "@/services/system/PublicBootstrapCompatibilityService";
import { ValidateException } from "@/utils/errors";

function chainRows(rows: unknown[]) {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => rows,
    then: (resolve: (value: unknown[]) => unknown) => resolve(rows),
  };
  return chain;
}

function harness(values: Record<string, string>, rows: unknown[] = []) {
  const cache = new Map<string, string>();
  const container = {
    db: { select: () => chainRows(rows) },
    systemConfigDao: {
      getValue: async (key: string) => values[key] ?? "",
      getValues: async (keys: string[]) => Object.fromEntries(keys.map((key) => [key, values[key] ?? ""])),
    },
  } as unknown as Container;
  const env = {
    APP_KEY: "public-bootstrap-test-signing-key",
    CONFIG_KV: {
      get: async (key: string) => cache.get(key) ?? null,
      put: async (key: string, value: string) => { cache.set(key, value); },
      delete: async (key: string) => { cache.delete(key); },
    },
  } as unknown as Env;
  return {
    branding: new PublicBrandingService(container, env),
    service: new PublicBootstrapCompatibilityService(container, env),
  };
}

describe("legacy public bootstrap compatibility", () => {
  it("returns bounded copy/customer configuration and rejects unsafe customer URLs", async () => {
    const { service } = harness({
      copy_words: " 邀请好友加入 ",
      routine_contact_type: "2",
      customer_type: "1",
      customer_phone: " 400-123-4567 ",
      customer_url: "javascript:alert(1)",
      wechat_work_corpid: " wxwork-corp ",
    });
    await expect(service.copyWords()).resolves.toEqual({ words: "邀请好友加入" });
    await expect(service.customerType()).resolves.toEqual({
      routine_contact_type: 2,
      customer_type: 1,
      customer_phone: "400-123-4567",
      customer_url: "",
      wechat_work_corpid: "wxwork-corp",
      userInfo: [],
    });
  });

  it("signs canonical login-logo assets and resolves legacy paths against the site origin", async () => {
    const signed = await harness({
      site_url: "https://shop.example.com/path",
      wap_login_logo: "/api/assets/7",
    }).branding.loginLogo("https://api.example.com");
    expect(signed.logo_url).toMatch(/^https:\/\/api\.example\.com\/api\/assets\/7\?/u);
    expect(signed.logo_url).toContain("signature=");

    const legacy = await harness({
      site_url: "https://shop.example.com/path",
      wap_login_logo: "/uploads/logo.png",
    }).branding.loginLogo("https://api.example.com");
    expect(legacy.logo_url).toBe("https://shop.example.com/uploads/logo.png");
  });

  it("maps every PHP subscription short ID and keeps absent provider IDs explicit", async () => {
    const rows = [
      { id: 9, mark: "1927", tempid: "provider-pay-new" },
      { id: 8, mark: "1927", tempid: "provider-pay-old" },
      { id: 7, mark: "25599", tempid: "provider-sign" },
    ];
    const result = await harness({}, rows).service.subscriptionTemplateIds();
    expect(Object.keys(result)).toEqual(Object.keys(LEGACY_SUBSCRIBE_TEMPLATE_KEYS));
    expect(result.order_pay_success).toBe("provider-pay-new");
    expect(result.sign_remind_time).toBe("provider-sign");
    expect(result.order_refund).toBeNull();
  });

  it("returns only carrier picker fields and validates the legacy status selector", async () => {
    const rows = [{
      id: 3,
      name: "安全快递",
      code: "SAFE",
      account: "must-not-leak",
      key: "must-not-leak",
    }];
    const service = harness({}, rows).service;
    await expect(service.expressList("1")).resolves.toEqual([
      { id: 3, name: "安全快递", code: "SAFE" },
    ]);
    await expect(service.expressList("invalid")).rejects.toBeInstanceOf(ValidateException);
  });

  it("registers all five PHP paths with station and optional-auth middleware", () => {
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    for (const path of [
      "/wechat/get_logo",
      "/wechat/teml_ids",
      "/logistics",
      "/copy_words",
      "/get_customer_type",
    ]) {
      const start = routes.indexOf(`\"${path}\"`);
      expect(start).toBeGreaterThan(-1);
      const registration = routes.slice(start, start + 260);
      expect(registration).toContain("stationOpenMiddleware()");
      expect(registration).toContain("authMiddleware({ force: false })");
    }
  });
});
