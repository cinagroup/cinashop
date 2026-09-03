import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  evaluatePaymentReadiness,
  isWechatMerchantCertificateSerial,
  isWechatMerchantId,
} from "@/services/payment/PaymentReadinessService";

type RuntimeEnv = Parameters<typeof evaluatePaymentReadiness>[1];
type PaymentConfig = Parameters<typeof evaluatePaymentReadiness>[0];

const readyEnv: RuntimeEnv = {
  WECHAT_MCH_PRIVATE_KEY: [
    "-----BEGIN PRIVATE",
    "KEY-----",
    "fixture-only",
    "-----END PRIVATE",
    "KEY-----",
  ].join("\n"),
  WECHAT_API_V3_KEY: "x".repeat(32),
  WECHAT_PLATFORM_PUBLIC_KEY: "-----BEGIN PUBLIC KEY-----\npublic\n-----END PUBLIC KEY-----",
};

function baseConfig(): PaymentConfig {
  return {
    balance_func_status: "1",
    yue_pay_status: "1",
    offline_pay_status: "1",
    ali_pay_status: "0",
    pay_weixin_open: "1",
    pay_weixin_mchid: "1900000109",
    pay_weixin_serial_no: "5157F09EFDC096DE15EBE81A47057A7232F1B8E1",
    site_url: "https://shop.example.com",
  };
}

describe("payment readiness profiles", () => {
  it("accepts a routine-only deployment without requiring the official-account AppID", () => {
    const readiness = evaluatePaymentReadiness(
      { ...baseConfig(), routine_appId: "wx1234567890abcdef" },
      readyEnv,
    );
    expect(readiness.methods.weixin).toEqual({ enabled: true, reason: "" });
    expect(readiness.wechatProfiles.routine).toEqual({ enabled: true, reason: "" });
    expect(readiness.wechatProfiles.wechat).toEqual({
      enabled: false,
      reason: "公众号/H5/PC AppID 未配置",
    });
    expect(readiness.wechatProfiles.app.enabled).toBe(false);
  });

  it("requires the selected profile AppID and the shared deployment credential set", () => {
    const allProfiles = {
      ...baseConfig(),
      wechat_appid: "wx1111111111111111",
      routine_appId: "wx2222222222222222",
      wechat_app_appid: "wx3333333333333333",
    };
    const missingRuntime = evaluatePaymentReadiness(allProfiles, {
      ...readyEnv,
      WECHAT_API_V3_KEY: "too-short",
    });
    expect(missingRuntime.methods.weixin).toEqual({
      enabled: false,
      reason: "微信支付部署凭据未完成",
    });
    expect(Object.values(missingRuntime.wechatProfiles).every((state) => !state.enabled)).toBe(true);

    const ready = evaluatePaymentReadiness(allProfiles, readyEnv);
    expect(Object.values(ready.wechatProfiles).every((state) => state.enabled)).toBe(true);
  });

  it("validates only the non-secret merchant identifiers", () => {
    expect(isWechatMerchantId("1900000109")).toBe(true);
    expect(isWechatMerchantId("mch-1900000109")).toBe(false);
    expect(isWechatMerchantCertificateSerial("ab12CD34")).toBe(true);
    expect(isWechatMerchantCertificateSerial("serial-z")).toBe(false);

    const invalidPublicConfig = evaluatePaymentReadiness(
      { ...baseConfig(), pay_weixin_serial_no: "serial-z", routine_appId: "wx1234567890abcdef" },
      readyEnv,
    );
    expect(invalidPublicConfig.methods.weixin.reason).toBe("微信支付公开商户配置未完成");
  });

  it("gates every initiation on the resolved profile and retires the legacy mini-pay rail", () => {
    for (const path of [
      "src/services/order/StoreOrderPayService.ts",
      "src/services/payment/RechargePaymentService.ts",
      "src/services/user/PaidMembershipService.ts",
    ]) {
      const source = readFileSync(path, "utf8");
      const resolveAt = source.indexOf("resolveWechatPaymentIdentity(");
      const assertAt = source.indexOf("assertWechatPaymentProfileAvailable(", resolveAt);
      const registerAt = source.indexOf("registerPaymentReconciliationIntent(", assertAt);
      expect(resolveAt, path).toBeGreaterThan(-1);
      expect(assertAt, path).toBeGreaterThan(resolveAt);
      expect(registerAt, path).toBeGreaterThan(assertAt);
    }

    const wechatPay = readFileSync("src/services/wechat/WechatPayService.ts", "utf8");
    expect(wechatPay).toContain("/v3/pay/transactions/${params.type}");
    expect(wechatPay).toContain("WECHAT_PAYMENT_PROFILE_APP_ID_KEYS[profile]");
    expect(wechatPay).not.toContain("shop/pay/createorder");
    expect(wechatPay).not.toContain("pay_routine_mchid");
  });

  it("keeps the production audit read-only, summary-only, and self-cleaning", () => {
    const worker = readFileSync("test/integration/PaymentPublicConfigAuditWorker.ts", "utf8");
    const runner = readFileSync("scripts/run-payment-public-config-production-audit.ps1", "utf8");
    const config = readFileSync("test/integration/payment-public-config-audit.wrangler.jsonc", "utf8");
    expect(worker).toContain('client.begin("read only"');
    expect(worker).toContain('"Cache-Control": "private, no-store"');
    expect(worker).toContain("distinct_value_count");
    expect(worker).not.toContain("INSERT INTO");
    expect(worker).not.toContain("UPDATE system_config");
    expect(worker).not.toContain("DELETE FROM");
    expect(runner).toContain("wrangler delete");
    expect(runner).not.toContain("Read-Host");
    expect(config).toContain("9748c294e21c49a99579c9cef70102e0");
  });
});
