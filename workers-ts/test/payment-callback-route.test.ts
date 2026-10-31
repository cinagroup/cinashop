import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import ts from 'typescript';
import { resolvePaymentCallbackDispatch } from "@/controllers/api/v1/PaymentCallbackController";
import { wechatPayAppIdKey } from "@/services/wechat/WechatPayService";
import { parseAlipayNotificationForm } from "@/utils/alipay";

describe("CORE-001 payment callback compatibility", () => {
  it("dispatches only the four PHP callback types over POST", () => {
    expect(resolvePaymentCallbackDispatch("POST", "alipay"))
      .toEqual({ outcome: "dispatch", target: "alipay" });
    expect(resolvePaymentCallbackDispatch("POST", "wechat"))
      .toEqual({ outcome: "dispatch", target: "wechat" });
    expect(resolvePaymentCallbackDispatch("POST", "routine"))
      .toEqual({ outcome: "dispatch", target: "routine" });
    expect(resolvePaymentCallbackDispatch("POST", "app"))
      .toEqual({ outcome: "dispatch", target: "app" });
    expect(resolvePaymentCallbackDispatch("POST", "WECHAT"))
      .toEqual({ outcome: "unsupported-type" });
    expect(resolvePaymentCallbackDispatch("POST", "wechat%2Frefund"))
      .toEqual({ outcome: "unsupported-type" });
  });

  it("keeps the legacy ANY address while rejecting non-provider methods", () => {
    expect(resolvePaymentCallbackDispatch("GET", "wechat"))
      .toEqual({ outcome: "method-not-allowed" });
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    expect(routes).toContain('"/pay/notify/:type"');
    expect(routes).toContain("PaymentCallbackController.paymentNotify(c, {");
  });

  it("maps callback types to independent authority AppIDs", () => {
    expect(wechatPayAppIdKey("wechat")).toBe("wechat_appid");
    expect(wechatPayAppIdKey("routine")).toBe("routine_appId");
    expect(wechatPayAppIdKey("app")).toBe("wechat_app_appid");
  });

  it("rejects ambiguous Alipay form fields before signature verification", () => {
    expect(parseAlipayNotificationForm("notify_id=n1&trade_no=t1&sign=s1"))
      .toEqual({ notify_id: "n1", trade_no: "t1", sign: "s1" });
    expect(() => parseAlipayNotificationForm("trade_no=t1&trade_no=t2&sign=s1"))
      .toThrow("支付宝回调字段重复");
    expect(() => parseAlipayNotificationForm(`sign=${"x".repeat(16 * 1024 + 1)}`))
      .toThrow("支付宝回调字段值无效");
  });

  it("propagates the authenticated channel profile into all payment initiators", () => {
    for (const file of [
      "src/services/order/StoreOrderPayService.ts",
      "src/services/payment/RechargePaymentService.ts",
      "src/services/user/PaidMembershipService.ts",
    ]) {
      expect(readFileSync(file, "utf8")).toContain("profile: identity.profile");
    }
    const service = readFileSync("src/services/wechat/WechatPayService.ts", "utf8");
    expect(service).toContain('const notifyUrl = `${siteUrl}/api/pay/notify/${profile}`');
    // Check channel propagation in the real call AST. Its optional internal
    // approved-account configuration must not erase the existing profile.
    const source=ts.createSourceFile('WechatPayService.ts',service,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
    const transactions:ts.CallExpression[]=[];
    const visit=(node:ts.Node):void=>{
      if(ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text==='verifyAndDecryptNotify' && node.arguments[2]
        && ts.isStringLiteral(node.arguments[2]) && node.arguments[2].text==='transaction') transactions.push(node);
      ts.forEachChild(node,visit);
    };
    visit(source);
    expect(transactions).toHaveLength(1);
    expect(transactions[0].arguments.slice(0,2).map(argument=>argument.getText(source))).toEqual(['headers','rawBody']);
    expect(transactions[0].arguments[3].getText(source)).toBe('profile');
    const payController = readFileSync("src/controllers/api/v1/PayController.ts", "utf8");
    const wechatController = readFileSync("src/controllers/api/v1/WechatController.ts", "utf8");
    expect(payController).toContain("readBoundedUtf8Text");
    expect(payController).toContain("!publicKey || !appId || !sellerId");
    expect(payController).toContain("params.seller_id !== sellerId");
    expect(wechatController.match(/readBoundedUtf8Text/g)?.length).toBeGreaterThanOrEqual(3);
    expect(service).toContain('data.amount?.currency !== "CNY"');
    expect(service).toContain("微信回调通知 ID 无效");
  });
});
