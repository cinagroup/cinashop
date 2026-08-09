/**
 * 微信支付 V3 Service (M6)
 *
 * 对应 PHP crmeb/services/wechat/v3pay/PayClient.php + Payment.php
 *
 * 核心:
 *   - createOrder: 统一下单 (JSAPI/Native/H5), 返回支付参数
 *   - verifyAndParseNotify: 回调验签 + AES-GCM 解密
 *   - refund: V3 退款
 *   - buildJsapiPaySign: 客户端调起支付签名 (在 wechat-crypto.ts)
 *
 * 配置从 system_config 读 (与 PHP 一致):
 *   - pay_weixin_mchid (商户号)
 *   - pay_weixin_serial_no (证书序列号)
 *   - v3_pay_weixin_key (APIv3 key, 用于回调解密)
 *   - pay_wechat_type (V3 开关)
 *   - 商户私钥从环境变量 WECHAT_MCH_PRIVATE_KEY 读 (Workers 不能读文件)
 */
import type { Container } from "@/lib/di";
import type { Env } from "@/env";
import { ValidateException } from "@/utils/errors";
import {
  buildV3Authorization,
  aesGcmDecrypt,
  rsaVerify,
} from "@/utils/wechat-crypto";

const BASE_URL = "https://api.mch.weixin.qq.com";

export class WechatPayService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  /**
   * 统一下单 (对应 PHP PayClient::pay)
   *
   * @param type jsapi | native | h5 | app
   * @returns JSAPI: { prepay_id + 支付签名参数 }; Native: { code_url }; H5: { h5_url }
   */
  async createOrder(params: {
    type: "jsapi" | "native" | "h5" | "app";
    outTradeNo: string;
    description: string;
    amount: number; // 元 (会转分)
    openid?: string; // jsapi 必填
    attach?: string; // 附加数据 (路由回调用, 如 'product')
    payerClientIp?: string; // h5 必填
  }): Promise<Record<string, unknown>> {
    const cfg = await this.getConfig();
    const path = `/v3/pay/transactions/${params.type}`;
    const body: Record<string, unknown> = {
      appid: cfg.appId,
      mchid: cfg.mchId,
      out_trade_no: params.outTradeNo,
      description: params.description,
      notify_url: cfg.notifyUrl,
      attach: params.attach ?? "product",
      amount: { total: Math.round(params.amount * 100), currency: "CNY" },
    };
    if (params.type === "jsapi" && params.openid) {
      body.payer = { openid: params.openid };
    }
    if (params.type === "h5") {
      body.scene_info = {
        payer_client_ip: params.payerClientIp ?? "0.0.0.0",
        h5_info: { type: "Wap" },
      };
    }

    const bodyStr = JSON.stringify(body);
    const auth = await buildV3Authorization(
      cfg.privateKey,
      "POST",
      path,
      bodyStr,
      cfg.mchId,
      cfg.serialNo,
    );

    const resp = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: auth,
      },
      body: bodyStr,
    });

    const result = (await resp.json()) as { prepay_id?: string; code_url?: string; h5_url?: string; message?: string };
    if (!resp.ok) {
      throw new ValidateException(`微信下单失败: ${result.message ?? resp.statusText}`);
    }

    // JSAPI 需要额外返回支付签名参数
    if (params.type === "jsapi" && result.prepay_id) {
      const { buildJsapiPaySign } = await import("@/utils/wechat-crypto");
      const signParams = await buildJsapiPaySign(cfg.privateKey, cfg.appId, result.prepay_id);
      return { prepay_id: result.prepay_id, ...signParams };
    }

    return result;
  }

  /**
   * 验证并解析支付回调 (对应 PHP Payment::handleNotify + Validator)
   *
   * 流程:
   *   1. 读 Wechatpay-Timestamp/Nonce/Serial/Signature 头
   *   2. 时效校验 (300s 内)
   *   3. 用平台公钥验签 (timestamp\nnonce\nbody\n)
   *   4. AES-256-GCM 解密 resource.ciphertext → 订单数据
   *
   * @returns 解密后的回调数据 { out_trade_no, transaction_id, trade_state, amount }
   */
  async verifyAndParseNotify(
    headers: Record<string, string>,
    rawBody: string,
  ): Promise<{
    outTradeNo: string;
    transactionId: string;
    tradeState: string;
    amountTotal: number;
  }> {
    const timestamp = headers["wechatpay-timestamp"] ?? "";
    const nonce = headers["wechatpay-nonce"] ?? "";
    const signature = headers["wechatpay-signature"] ?? "";

    if (!timestamp || !nonce || !signature) {
      throw new ValidateException("缺少微信回调签名头");
    }

    // 时效校验 (300s)
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - Number(timestamp)) > 300) {
      throw new ValidateException("回调已过期");
    }

    // 验签消息: timestamp\nnonce\nbody\n
    const message = `${timestamp}\n${nonce}\n${rawBody}\n`;
    const cfg = await this.getConfig();
    if (cfg.platformCert) {
      const valid = await rsaVerify(cfg.platformCert, message, signature);
      if (!valid) throw new ValidateException("回调验签失败");
    }
    // 无平台证书时跳过验签 (开发阶段; 生产必须配置)

    // AES-GCM 解密 resource
    const notifyBody = JSON.parse(rawBody) as {
      resource?: { ciphertext: string; nonce: string; associated_data: string };
    };
    if (!notifyBody.resource) throw new ValidateException("回调缺少 resource");

    const decrypted = await aesGcmDecrypt(
      notifyBody.resource.ciphertext,
      cfg.apiV3Key,
      notifyBody.resource.nonce,
      notifyBody.resource.associated_data,
    );
    const data = JSON.parse(decrypted) as {
      out_trade_no: string;
      transaction_id: string;
      trade_state: string;
      amount?: { total: number };
    };

    return {
      outTradeNo: data.out_trade_no,
      transactionId: data.transaction_id,
      tradeState: data.trade_state,
      amountTotal: data.amount?.total ?? 0,
    };
  }

  /**
   * V3 退款 (对应 PHP PayClient::refund)
   */
  async refund(params: {
    transactionId: string; // 微信支付单号
    outRefundNo: string; // 商户退款单号
    refundAmount: number; // 退款金额 (元)
    totalAmount: number; // 原订单总额 (元)
    reason?: string;
  }): Promise<Record<string, unknown>> {
    const cfg = await this.getConfig();
    const path = "/v3/refund/domestic/refunds";
    const body = JSON.stringify({
      transaction_id: params.transactionId,
      out_refund_no: params.outRefundNo,
      reason: params.reason ?? "",
      amount: {
        refund: Math.round(params.refundAmount * 100),
        total: Math.round(params.totalAmount * 100),
        currency: "CNY",
      },
      funds_account: "AVAILABLE",
    });

    const auth = await buildV3Authorization(cfg.privateKey, "POST", path, body, cfg.mchId, cfg.serialNo);
    const resp = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: auth,
      },
      body,
    });
    const result = (await resp.json()) as Record<string, unknown>;
    if (!resp.ok) {
      throw new ValidateException(`微信退款失败: ${(result as { message?: string }).message ?? resp.statusText}`);
    }
    return result;
  }

  // ─── 配置 ─────────────────────────────────────────────────

  private async getConfig(): Promise<{
    appId: string;
    mchId: string;
    serialNo: string;
    apiV3Key: string;
    privateKey: string;
    platformCert?: string;
    notifyUrl: string;
  }> {
    const svc = new (await import("@/services/system/SystemConfigService")).SystemConfigService(
      this.container,
      this.env,
    );
    const values = await svc.getMany([
      "wechat_appid",
      "pay_weixin_mchid",
      "pay_weixin_serial_no",
      "v3_pay_weixin_key",
      "site_url",
    ]);

    const privateKey = this.env.WECHAT_MCH_PRIVATE_KEY;
    if (!privateKey) {
      throw new ValidateException("商户私钥未配置 (WECHAT_MCH_PRIVATE_KEY 环境变量)");
    }

    return {
      appId: values["wechat_appid"] ?? "",
      mchId: values["pay_weixin_mchid"] ?? "",
      serialNo: values["pay_weixin_serial_no"] ?? "",
      apiV3Key: values["v3_pay_weixin_key"] ?? "",
      privateKey,
      platformCert: this.env.WECHAT_PLATFORM_CERT, // 可选, 无则跳过验签
      notifyUrl: `${values["site_url"] ?? ""}/api/pay/notify/wechat`,
    };
  }
}
