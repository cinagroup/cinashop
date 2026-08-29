import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertMarketingOfflinePaymentAllowed,
  orderCancelHours,
} from "../src/services/payment/OrderPaymentPolicy";
import { normalizeWechatPaymentChannel } from "../src/services/payment/WechatPaymentIdentity";
import { parseRechargeQuota } from "../src/services/user/UserFinanceService";

describe("checkout payment migration", () => {
  it("maps every supported client channel to a server-known WeChat rail", () => {
    expect(normalizeWechatPaymentChannel("wechat")).toBe("weixin");
    expect(normalizeWechatPaymentChannel("routine")).toBe("routine");
    expect(normalizeWechatPaymentChannel("weixinh5")).toBe("h5");
    expect(normalizeWechatPaymentChannel("pc")).toBe("pc");
    expect(normalizeWechatPaymentChannel("app")).toBe("app");
    expect(() => normalizeWechatPaymentChannel("unknown")).toThrow("不支持当前微信支付渠道");
  });

  it("uses activity-specific cancellation windows with PHP-compatible fallbacks", () => {
    const config = {
      order_cancel_time: "2",
      order_activity_time: "3",
      order_seckill_time: "4",
      order_bargain_time: "",
      order_pink_time: "5",
      rebate_points_orders_time: "6",
    };
    expect(orderCancelHours(0, config)).toBe(2);
    expect(orderCancelHours(1, config)).toBe(4);
    expect(orderCancelHours(2, config)).toBe(3);
    expect(orderCancelHours(3, config)).toBe(5);
    expect(orderCancelHours(4, config)).toBe(6);
    expect(orderCancelHours(7, config)).toBe(3);
  });

  it("allows marketing offline payment only on the PC channel", () => {
    expect(() => assertMarketingOfflinePaymentAllowed(0, "h5")).not.toThrow();
    expect(() => assertMarketingOfflinePaymentAllowed(1, "pc")).not.toThrow();
    expect(() => assertMarketingOfflinePaymentAllowed(3, "PC")).not.toThrow();
    expect(() => assertMarketingOfflinePaymentAllowed(1, "h5"))
      .toThrow("营销商品不能使用线下支付");
    expect(() => assertMarketingOfflinePaymentAllowed(2, undefined))
      .toThrow("营销商品不能使用线下支付");

    const create = readFileSync("src/services/order/StoreOrderCreateService.ts", "utf8");
    const pay = readFileSync("src/services/order/StoreOrderPayService.ts", "utf8");
    expect(create).toContain("assertMarketingOfflinePaymentAllowed(type, params.from)");
    expect(pay).toContain("assertMarketingOfflinePaymentAllowed(order.type, from)");
  });

  it("keeps recharge crediting behind provider-verified callbacks", () => {
    const controller = readFileSync("src/controllers/api/v1/PayController.ts", "utf8");
    const orderService = readFileSync("src/services/order/StoreOrderPayService.ts", "utf8");
    const rechargeService = readFileSync(
      "src/services/payment/RechargePaymentService.ts",
      "utf8",
    );
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");

    expect(controller).toContain("充值订单请使用充值支付接口");
    expect(orderService).not.toContain("async rechargePay(");
    expect(orderService).toContain("sameProviderEvidence");
    expect(orderService).toContain('order.tradeNo === (params.tradeNo ?? "")');
    expect(routes).toContain('v1Routes.post("/recharge/pay"');
    expect(rechargeService).toContain("expectedAmountCents");
    expect(rechargeService).toContain('.for("update")');
    expect(rechargeService).toContain("支付回调与已入账交易不匹配");
  });

  it("uses the PHP recharge quota shape without trusting the client price", () => {
    expect(parseRechargeQuota(177, JSON.stringify({
      price: { type: "input", value: "500" },
      give_money: { type: "input", value: "25.50" },
    }))).toEqual({ id: 177, price: "500.00", give_money: "25.50" });
    expect(parseRechargeQuota(178, JSON.stringify({ price: "100", give_money: "0" })))
      .toEqual({ id: 178, price: "100.00", give_money: "0.00" });
    expect(parseRechargeQuota(179, "not-json")).toBeNull();

    const finance = readFileSync("src/services/user/UserFinanceService.ts", "utf8");
    const controller = readFileSync("src/controllers/api/v1/UserMessageController.ts", "utf8");
    expect(finance).toContain('eq(systemGroup.configName, "user_recharge_quota")');
    expect(finance).toContain("priceCents = decimalToCents(quota.price)");
    expect(finance).toContain("givePrice: centsToDecimal(givePriceCents)");
    expect(finance).toContain("let minRechargeCents = 1");
    expect(finance).toContain("recharge_quota: quotas");
    expect(finance).toContain("recharge_attention:");
    expect(finance).toContain("user_extract_balance_status:");
    expect(controller).toContain("svc.brokerageToBalance");
  });

  it("keeps PHP commission-to-balance ledgers in one transaction", () => {
    const finance = readFileSync("src/services/user/UserFinanceService.ts", "utf8");
    expect(finance).toContain("export async function applyBrokerageToBalance");
    expect(finance).toContain('.for("update")');
    expect(finance).toContain("user_extract_balance_status");
    expect(finance).toContain("await tx.insert(userMoney)");
    expect(finance).toContain("await tx.insert(userExtract)");
    expect(finance).toContain("await tx.insert(userBrokerage)");
    expect(finance).toContain('type: "extract_money"');
    expect(finance).toContain('.set({ nowMoney, brokeragePrice })');
  });

  it("keeps the SQL and embedded recharge indexes aligned", () => {
    const migration = readFileSync("migrations/0082_payment_checkout_integrity.sql", "utf8").trim();
    const embedded = readFileSync("src/services/MigrationService.ts", "utf8")
      .match(/private migration_0089\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    expect(embedded).toBe(migration);
  });
});
