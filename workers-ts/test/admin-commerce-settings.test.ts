import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COMMERCE_CONFIG_KEYS,
  normalizeCommerceSettings,
} from "@/services/system/AdminCommerceSettingsService";
import { requiredAdminPermission } from "@/services/admin/AdminPermissionService";

function validInput(): Record<string, unknown> {
  return {
    basic: {
      station_open: 1,
      site_name: "CinaShop",
      site_url: "https://shop.example.com/",
      site_phone: "400-800-8888",
      site_logo: "/uploads/logo.png",
      site_logo_square: "https://cdn.example.com/logo-square.png",
      login_logo: "",
      wap_login_logo: "",
      navigation_open: 1,
      video_func_status: 0,
      product_video_status: 1,
      product_poster_title: "品牌官方 · 售后无忧",
      record_No: "ICP备案示例",
      pay_weixin_key: "must-not-be-accepted",
    },
    product: { store_stock: 20 },
    trade: {
      order_cancel_time: 1,
      order_activity_time: 2,
      order_bargain_time: 0,
      order_seckill_time: 0,
      order_pink_time: 3,
      rebate_points_orders_time: 4,
      reminder_deadline_second_card_time: 24,
      system_delivery_time: 7,
      system_comment_time: 7,
      refund_name: "售后中心",
      refund_phone: "+86 400-800-8888",
      refund_address: "示例市示例区售后仓",
      stor_reason: " 商品损坏\r\n与描述不符 ",
      refund_time_available: 7,
    },
    payment: {
      balance_func_status: 1,
      yue_pay_status: 1,
      offline_pay_status: 2,
      pay_weixin_open: 1,
      ali_pay_status: 0,
      alipay_merchant_private_key: "must-not-be-accepted",
    },
    division: { division_open: 1, division_apply_open: 1 },
  };
}

describe("admin commerce settings", () => {
  it("normalizes only the explicit non-secret legacy whitelist", () => {
    const normalized = normalizeCommerceSettings(validInput());
    expect(Object.keys(normalized)).toEqual([...COMMERCE_CONFIG_KEYS]);
    expect(normalized.site_url).toBe("https://shop.example.com");
    expect(normalized.stor_reason).toBe("商品损坏\n与描述不符");
    expect(normalized.offline_pay_status).toBe(2);
    expect(normalized).not.toHaveProperty("pay_weixin_key");
    expect(normalized).not.toHaveProperty("alipay_merchant_private_key");
  });

  it("rejects unsafe URLs, invalid hierarchy, and unbounded values", () => {
    const unsafe = validInput();
    (unsafe.basic as Record<string, unknown>).site_url = "http://shop.example.com";
    expect(() => normalizeCommerceSettings(unsafe)).toThrow("HTTPS");

    const protocolRelative = validInput();
    (protocolRelative.basic as Record<string, unknown>).site_logo = "//evil.example/logo.png";
    expect(() => normalizeCommerceSettings(protocolRelative)).toThrow("站内地址");

    const invalidDivision = validInput();
    invalidDivision.division = { division_open: 0, division_apply_open: 1 };
    expect(() => normalizeCommerceSettings(invalidDivision)).toThrow("必须先开启事业部");

    const invalidHours = validInput();
    (invalidHours.trade as Record<string, unknown>).order_cancel_time = 8_761;
    expect(() => normalizeCommerceSettings(invalidHours)).toThrow("0到8760");
  });

  it("uses bounded writes, short PostgreSQL timeouts, readback, audit, and cache invalidation", () => {
    const controller = readFileSync("src/controllers/api/v1/AdminCommerceSettingsController.ts", "utf8");
    const service = readFileSync("src/services/system/AdminCommerceSettingsService.ts", "utf8");
    const routes = readFileSync("src/routes/adminapi.ts", "utf8");
    expect(controller).toContain("readBoundedJsonObject(c.req.raw, MAX_COMMERCE_SETTINGS_BODY_BYTES)");
    expect(controller).toContain('Cache-Control", "private, no-store');
    expect(service).toContain("SET LOCAL lock_timeout = '2s'");
    expect(service).toContain("SET LOCAL statement_timeout = '5s'");
    expect(service).toContain("pg_advisory_xact_lock");
    expect(service).toContain("商城设置回读不一致");
    expect(service).toContain("tx.insert(systemLog)");
    expect(service).toContain("this.env.CONFIG_KV.delete");
    expect(service).toContain("UPDATE store_product AS product");
    expect(routes).toContain('get("/config/commerce"');
    expect(routes).toContain('post("/config/commerce"');
    expect(requiredAdminPermission("GET", "/adminapi/config/commerce")).toBe("config.view");
    expect(requiredAdminPermission("POST", "/adminapi/config/commerce")).toBe("config.manage");
  });

  it("keeps payment credentials out of the Admin form and displays effective readiness", () => {
    const page = readFileSync("../view/admin-ts/src/pages/config/CommerceSettings.vue", "utf8");
    const api = readFileSync("../view/admin-ts/src/api/commerceSettings.ts", "utf8");
    expect(page).toContain("Cloudflare Secret");
    expect(page).toContain("payment_readiness");
    expect(page).not.toContain("pay_weixin_key");
    expect(page).not.toContain("merchant_private_key");
    expect(api).not.toContain("pay_weixin_key");
    expect(api).not.toContain("merchant_private_key");
  });
});
