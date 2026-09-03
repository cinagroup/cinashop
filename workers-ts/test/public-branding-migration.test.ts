import { describe, expect, it } from "vitest";
import type { Env } from "@/env";
import type { Container } from "@/lib/di";
import { PublicBrandingService } from "@/services/system/PublicBrandingService";

function harness(values: Record<string, string>) {
  const cache = new Map<string, string>();
  const container = {
    systemConfigDao: {
      getValues: async (keys: string[]) => Object.fromEntries(keys.map((key) => [key, values[key] ?? ""])),
    },
  } as unknown as Container;
  const env = {
    APP_KEY: "public-branding-test-signing-key",
    CONFIG_KV: {
      get: async (key: string) => cache.get(key) ?? null,
      put: async (key: string, value: string) => { cache.set(key, value); },
      delete: async (key: string) => { cache.delete(key); },
    },
  } as unknown as Env;
  return new PublicBrandingService(container, env);
}

describe("public branding and share migration", () => {
  it("signs stable private R2 references and keeps legacy storefront paths absolute", async () => {
    const service = harness({
      record_No: "ICP备案示例",
      site_name: "CinaShop",
      site_url: "https://shop.example.com/path",
      site_logo: "/uploads/logo.png",
      site_logo_square: "/api/assets/21",
      login_logo: "/api/assets/22",
      ico_path: "/api/assets/23",
      admin_login_slide: '["/api/assets/24","https://cdn.example.com/slide.webp"]',
    });
    const result = await service.siteConfig("https://api.example.com");
    expect(result.record_No).toBe("ICP备案示例");
    expect(result.site_logo).toBe("https://shop.example.com/uploads/logo.png");
    expect(result.site_logo_square).toMatch(/^https:\/\/api\.example\.com\/api\/assets\/21\?/);
    expect(result.login_logo).toContain("signature=");
    expect(result.ico_path).toContain("expires=");
    expect(result.admin_login_slide).toHaveLength(2);
    expect(result.admin_login_slide[0]).toMatch(/^https:\/\/api\.example\.com\/api\/assets\/24\?/);
    expect(result.admin_login_slide[1]).toBe("https://cdn.example.com/slide.webp");
  });

  it("projects only bounded share fields and rejects unsafe stored media", async () => {
    const safe = await harness({
      site_url: "https://shop.example.com",
      wechat_share_img: "/api/assets/31",
      wechat_share_title: " 分享标题 ",
      wechat_share_synopsis: "分享简介",
    }).share("https://api.example.com");
    expect(safe.img).toMatch(/^https:\/\/api\.example\.com\/api\/assets\/31\?/);
    expect(safe.title).toBe("分享标题");
    expect(safe.synopsis).toBe("分享简介");

    const unsafe = await harness({
      site_url: "javascript:alert(1)",
      wechat_share_img: "javascript:alert(2)",
    }).share("https://api.example.com");
    expect(unsafe.img).toBe("");
  });
});
