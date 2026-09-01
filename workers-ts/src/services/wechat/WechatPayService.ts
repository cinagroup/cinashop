/** 微信支付 API v3：下单、回调验签、原路退款和退款查询。 */
import type { Container } from "@/lib/di";
import type { Env } from "@/env";
import { ValidateException } from "@/utils/errors";
import {
  aesGcmDecrypt,
  buildV3Authorization,
  rsaVerify,
} from "@/utils/wechat-crypto";
import type {
  RefundProviderRequest,
  RefundProviderResult,
  RefundProviderStatus,
} from "@/services/payment/RefundGateway";
import type {
  PaymentProviderQueryRequest,
  PaymentProviderQueryResult,
} from "@/services/payment/PaymentProviderQuery";

const BASE_URL = "https://api.mch.weixin.qq.com";

export type WechatPayProfile = "wechat" | "routine" | "app";

const PROFILE_APP_ID_KEYS = {
  wechat: "wechat_appid",
  routine: "routine_appId",
  app: "wechat_app_appid",
} as const satisfies Record<WechatPayProfile, string>;

export function wechatPayAppIdKey(profile: WechatPayProfile): string {
  return PROFILE_APP_ID_KEYS[profile];
}

interface WechatPayConfig {
  appId: string;
  mchId: string;
  serialNo: string;
  apiV3Key: string;
  privateKey: string;
  platformPublicKey: string;
  platformPublicKeyId?: string;
  notifyUrl: string;
  refundNotifyUrl: string;
}

interface WechatRefundResponse {
  refund_id?: string;
  out_refund_no?: string;
  transaction_id?: string;
  out_trade_no?: string;
  status?: string;
  success_time?: string;
  amount?: { refund?: number; total?: number };
  code?: string;
  message?: string;
}

interface WechatTradeQueryResponse {
  appid?: string;
  mchid?: string;
  out_trade_no?: string;
  transaction_id?: string;
  trade_state?: string;
  success_time?: string;
  amount?: { total?: number; currency?: string };
}

export class WechatPayService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  async createOrder(params: {
    profile: WechatPayProfile;
    type: "jsapi" | "native" | "h5" | "app";
    outTradeNo: string;
    description: string;
    amount: number;
    openid?: string;
    attach?: string;
    payerClientIp?: string;
  }): Promise<Record<string, unknown>> {
    const cfg = await this.getConfig(params.profile);
    const path = `/v3/pay/transactions/${params.type}`;
    const total = Math.round(params.amount * 100);
    if (!Number.isSafeInteger(total) || total <= 0) throw new ValidateException("微信支付金额无效");
    const body: Record<string, unknown> = {
      appid: cfg.appId,
      mchid: cfg.mchId,
      out_trade_no: params.outTradeNo,
      description: params.description,
      notify_url: cfg.notifyUrl,
      attach: params.attach ?? "product",
      amount: { total, currency: "CNY" },
    };
    if (params.type === "jsapi" && params.openid) body.payer = { openid: params.openid };
    if (params.type === "h5") {
      body.scene_info = {
        payer_client_ip: params.payerClientIp ?? "0.0.0.0",
        h5_info: { type: "Wap" },
      };
    }

    const result = await this.callApi<Record<string, unknown>>("POST", path, body, cfg);
    if (params.type === "jsapi" && typeof result.prepay_id === "string") {
      const { buildJsapiPaySign } = await import("@/utils/wechat-crypto");
      const signParams = await buildJsapiPaySign(cfg.privateKey, cfg.appId, result.prepay_id);
      return { prepay_id: result.prepay_id, ...signParams };
    }
    return result;
  }

  async verifyAndParseNotify(
    headers: Record<string, string>,
    rawBody: string,
    profile: WechatPayProfile,
  ): Promise<{
    eventId: string;
    outTradeNo: string;
    transactionId: string;
    tradeState: string;
    amountTotal: number;
    providerEventTime: number;
  }> {
    const { data, cfg, eventId } = await this.verifyAndDecryptNotify<{
      appid?: string;
      mchid?: string;
      out_trade_no?: string;
      transaction_id?: string;
      trade_state?: string;
      success_time?: string;
      amount?: { total?: number; currency?: string };
    }>(headers, rawBody, "transaction", profile);
    if (data.mchid !== cfg.mchId || data.appid !== cfg.appId) {
      throw new ValidateException("微信支付回调商户信息不匹配");
    }
    if (
      !data.out_trade_no
      || !data.transaction_id
      || !data.trade_state
      || !/^[A-Za-z0-9_-]{2,64}$/.test(data.out_trade_no)
      || !/^[A-Za-z0-9_-]{1,100}$/.test(data.transaction_id)
      || !Number.isSafeInteger(data.amount?.total)
      || Number(data.amount?.total) <= 0
      || data.amount?.currency !== "CNY"
    ) {
      throw new ValidateException("微信支付回调业务字段不完整");
    }
    const providerEventTime = parseProviderTime(data.success_time);
    if (data.trade_state === "SUCCESS" && providerEventTime === undefined) {
      throw new ValidateException("微信支付回调成功时间无效");
    }
    return {
      eventId,
      outTradeNo: data.out_trade_no,
      transactionId: data.transaction_id,
      tradeState: data.trade_state,
      amountTotal: data.amount?.total ?? 0,
      providerEventTime: providerEventTime ?? 0,
    };
  }

  async requestRefund(request: RefundProviderRequest): Promise<RefundProviderResult> {
    validateRefundRequest(request);
    const cfg = await this.getConfig("wechat");
    const path = "/v3/refund/domestic/refunds";
    const body: Record<string, unknown> = {
      out_refund_no: request.outRefundNo,
      reason: (request.reason ?? "").slice(0, 80),
      notify_url: cfg.refundNotifyUrl,
      amount: {
        refund: request.refundAmount,
        total: request.totalAmount,
        currency: "CNY",
      },
    };
    if (request.transactionId) body.transaction_id = request.transactionId;
    else body.out_trade_no = request.outTradeNo;

    const response = await this.callApi<WechatRefundResponse>("POST", path, body, cfg);
    return normalizeWechatRefundResponse(response, request);
  }

  async queryRefund(request: RefundProviderRequest): Promise<RefundProviderResult> {
    validateRefundRequest(request);
    const cfg = await this.getConfig("wechat");
    const path = `/v3/refund/domestic/refunds/${encodeURIComponent(request.outRefundNo)}`;
    try {
      const response = await this.callApi<WechatRefundResponse>("GET", path, undefined, cfg);
      return normalizeWechatRefundResponse(response, request);
    } catch (error) {
      if (error instanceof WechatApiError && error.code === "RESOURCE_NOT_EXISTS") {
        return { status: "NOT_FOUND", message: error.message };
      }
      throw error;
    }
  }

  async queryOrder(request: PaymentProviderQueryRequest): Promise<PaymentProviderQueryResult> {
    if (request.provider !== "wechat" || !["wechat", "routine", "app"].includes(request.profile)) {
      throw new ValidateException("微信支付查单渠道无效");
    }
    const cfg = await this.getConfig(request.profile as WechatPayProfile);
    const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(request.orderNo)}`
      + `?mchid=${encodeURIComponent(cfg.mchId)}`;
    let response: WechatTradeQueryResponse;
    try {
      response = await this.callApi<WechatTradeQueryResponse>("GET", path, undefined, cfg);
    } catch (error) {
      if (
        error instanceof WechatApiError
        && ["ORDER_NOT_EXIST", "RESOURCE_NOT_EXISTS"].includes(error.code)
      ) {
        return emptyTradeQueryResult(request, "NOT_FOUND", "NOTPAY", "provider_trade_not_found");
      }
      throw error;
    }
    if (
      response.appid !== cfg.appId
      || response.mchid !== cfg.mchId
      || response.out_trade_no !== request.orderNo
    ) {
      return emptyTradeQueryResult(request, "UNKNOWN", "UNKNOWN", "provider_identity_mismatch");
    }
    const providerTradeState = response.trade_state ?? "UNKNOWN";
    if (["NOTPAY", "USERPAYING"].includes(providerTradeState)) {
      return emptyTradeQueryResult(request, "PENDING", providerTradeState, "");
    }
    if (["CLOSED", "REVOKED", "PAYERROR", "REFUND"].includes(providerTradeState)) {
      return emptyTradeQueryResult(request, "CLOSED", providerTradeState, "");
    }
    if (providerTradeState !== "SUCCESS") {
      return emptyTradeQueryResult(request, "UNKNOWN", providerTradeState, "provider_status_unknown");
    }
    const transactionId = response.transaction_id ?? "";
    const amountCents = Number(response.amount?.total ?? -1);
    const providerEventTime = parseProviderTime(response.success_time) ?? 0;
    if (
      !/^[A-Za-z0-9_-]{1,100}$/.test(transactionId)
      || !Number.isSafeInteger(amountCents)
      || amountCents !== request.expectedAmountCents
      || response.amount?.currency !== "CNY"
      || providerEventTime <= 0
    ) {
      return {
        ...emptyTradeQueryResult(
          request,
          "UNKNOWN",
          providerTradeState,
          "provider_evidence_mismatch",
        ),
        transactionId,
        amountCents,
        providerEventTime,
      };
    }
    return {
      status: "SUCCESS",
      providerTradeState,
      orderNo: request.orderNo,
      transactionId,
      amountCents,
      currency: "CNY",
      providerEventTime,
      errorCode: "",
    };
  }

  async verifyAndParseRefundNotify(
    headers: Record<string, string>,
    rawBody: string,
  ): Promise<{
    eventId: string;
    outTradeNo: string;
    transactionId: string;
    outRefundNo: string;
    providerRefundId: string;
    status: RefundProviderStatus;
    refundAmount: number;
    totalAmount: number;
    successTime?: number;
  }> {
    const { data, cfg, eventId } = await this.verifyAndDecryptNotify<{
      mchid?: string;
      out_trade_no?: string;
      transaction_id?: string;
      out_refund_no?: string;
      refund_id?: string;
      refund_status?: string;
      success_time?: string;
      amount?: { refund?: number; total?: number };
    }>(headers, rawBody, "refund", "wechat");
    if (data.mchid !== cfg.mchId) throw new ValidateException("微信退款回调商户号不匹配");
    if (
      !data.out_trade_no ||
      !data.transaction_id ||
      !data.out_refund_no ||
      !data.refund_id ||
      !data.refund_status
    ) {
      throw new ValidateException("微信退款回调业务字段不完整");
    }
    return {
      eventId,
      outTradeNo: data.out_trade_no,
      transactionId: data.transaction_id,
      outRefundNo: data.out_refund_no,
      providerRefundId: data.refund_id,
      status: normalizeWechatStatus(data.refund_status),
      refundAmount: data.amount?.refund ?? -1,
      totalAmount: data.amount?.total ?? -1,
      successTime: parseProviderTime(data.success_time),
    };
  }

  private async verifyAndDecryptNotify<T>(
    headers: Record<string, string>,
    rawBody: string,
    expectedOriginalType: "transaction" | "refund",
    profile: WechatPayProfile,
  ): Promise<{ data: T; cfg: WechatPayConfig; eventId: string }> {
    const timestamp = headers["wechatpay-timestamp"] ?? "";
    const nonce = headers["wechatpay-nonce"] ?? "";
    const signature = headers["wechatpay-signature"] ?? "";
    const serial = headers["wechatpay-serial"] ?? "";
    if (!timestamp || !nonce || !signature || !serial) {
      throw new ValidateException("缺少微信回调签名头");
    }
    const timestampNumber = Number(timestamp);
    if (!Number.isSafeInteger(timestampNumber)) throw new ValidateException("微信回调时间戳无效");
    if (Math.abs(Math.floor(Date.now() / 1000) - timestampNumber) > 300) {
      throw new ValidateException("微信回调已过期");
    }

    const cfg = await this.getConfig(profile);
    this.assertPlatformSerial(serial, cfg);
    if (signature.startsWith("WECHATPAY/SIGNTEST/")) {
      throw new ValidateException("微信签名探测请求已拒绝");
    }
    const valid = await rsaVerify(
      cfg.platformPublicKey,
      `${timestamp}\n${nonce}\n${rawBody}\n`,
      signature,
    );
    if (!valid) throw new ValidateException("微信回调验签失败");

    const notifyBody = JSON.parse(rawBody) as {
      id?: string;
      resource_type?: string;
      resource?: {
        algorithm?: string;
        original_type?: string;
        ciphertext?: string;
        nonce?: string;
        associated_data?: string;
      };
    };
    const eventId = notifyBody.id ?? "";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(eventId)) {
      throw new ValidateException("微信回调通知 ID 无效");
    }
    const resource = notifyBody.resource;
    if (
      notifyBody.resource_type !== "encrypt-resource" ||
      resource?.algorithm !== "AEAD_AES_256_GCM" ||
      resource.original_type !== expectedOriginalType ||
      !resource.ciphertext ||
      !resource.nonce
    ) {
      throw new ValidateException("微信回调 resource 格式不正确");
    }
    const decrypted = await aesGcmDecrypt(
      resource.ciphertext,
      cfg.apiV3Key,
      resource.nonce,
      resource.associated_data ?? "",
    );
    return { data: JSON.parse(decrypted) as T, cfg, eventId };
  }

  private async callApi<T extends object>(
    method: "GET" | "POST",
    path: string,
    bodyValue: Record<string, unknown> | undefined,
    cfg: WechatPayConfig,
  ): Promise<T> {
    const body = bodyValue ? JSON.stringify(bodyValue) : "";
    const authorization = await buildV3Authorization(
      cfg.privateKey,
      method,
      path,
      body,
      cfg.mchId,
      cfg.serialNo,
    );
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: authorization,
    };
    if (bodyValue) headers["Content-Type"] = "application/json";
    if (cfg.platformPublicKeyId) headers["Wechatpay-Serial"] = cfg.platformPublicKeyId;

    let response: Response;
    try {
      response = await fetch(`${BASE_URL}${path}`, {
        method,
        headers,
        body: bodyValue ? body : undefined,
        signal: AbortSignal.timeout(8_000),
      });
    } catch (error) {
      throw new Error(`微信支付请求网络状态未知: ${errorMessage(error)}`);
    }
    const rawBody = await response.text();
    if (response.ok) await this.verifyApiResponse(response.headers, rawBody, cfg);

    let result: Record<string, unknown>;
    try {
      result = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
    } catch {
      throw new Error(`微信支付响应不是 JSON (HTTP ${response.status})`);
    }
    if (!response.ok) {
      throw new WechatApiError(
        typeof result.code === "string" ? result.code : `HTTP_${response.status}`,
        typeof result.message === "string" ? result.message : response.statusText,
      );
    }
    return result as unknown as T;
  }

  private async verifyApiResponse(
    headers: Headers,
    rawBody: string,
    cfg: WechatPayConfig,
  ): Promise<void> {
    const timestamp = headers.get("Wechatpay-Timestamp") ?? "";
    const nonce = headers.get("Wechatpay-Nonce") ?? "";
    const signature = headers.get("Wechatpay-Signature") ?? "";
    const serial = headers.get("Wechatpay-Serial") ?? "";
    if (!timestamp || !nonce || !signature || !serial) {
      throw new Error("微信支付成功响应缺少验签头");
    }
    this.assertPlatformSerial(serial, cfg);
    const valid = await rsaVerify(
      cfg.platformPublicKey,
      `${timestamp}\n${nonce}\n${rawBody}\n`,
      signature,
    );
    if (!valid) throw new Error("微信支付成功响应验签失败");
  }

  private assertPlatformSerial(serial: string, cfg: WechatPayConfig): void {
    if (cfg.platformPublicKeyId && serial !== cfg.platformPublicKeyId) {
      throw new ValidateException("微信支付平台公钥 ID 不匹配");
    }
  }

  private async getConfig(profile: WechatPayProfile): Promise<WechatPayConfig> {
    const svc = new (await import("@/services/system/SystemConfigService")).SystemConfigService(
      this.container,
      this.env,
    );
    const values = await svc.getMany([
      "wechat_appid",
      "routine_appId",
      "wechat_app_appid",
      "pay_weixin_mchid",
      "pay_weixin_serial_no",
      "site_url",
    ]);
    const privateKey = this.env.WECHAT_MCH_PRIVATE_KEY;
    const platformPublicKey =
      this.env.WECHAT_PLATFORM_PUBLIC_KEY ?? this.env.WECHAT_PLATFORM_CERT;
    if (!privateKey) throw new ValidateException("微信商户私钥未配置");
    if (!platformPublicKey?.includes("BEGIN PUBLIC KEY")) {
      throw new ValidateException("微信支付平台公钥未配置为 SPKI PEM");
    }
    const appId = values[wechatPayAppIdKey(profile)] ?? "";
    const mchId = values.pay_weixin_mchid ?? "";
    const serialNo = values.pay_weixin_serial_no ?? "";
    const apiV3Key = this.env.WECHAT_API_V3_KEY ?? "";
    if (!appId || !mchId || !serialNo) throw new ValidateException("微信支付商户配置不完整");
    if (new TextEncoder().encode(apiV3Key).byteLength !== 32) {
      throw new ValidateException("微信支付 APIv3 密钥必须为 32 字节");
    }
    const siteUrl = (values.site_url ?? "").replace(/\/$/, "");
    const notifyUrl = `${siteUrl}/api/pay/notify/${profile}`;
    const refundNotifyUrl =
      this.env.WECHAT_REFUND_NOTIFY_URL ?? `${siteUrl}/api/pay/notify/wechat/refund`;
    assertCallbackUrl(notifyUrl, "微信支付回调");
    assertCallbackUrl(refundNotifyUrl, "微信退款回调");
    return {
      appId,
      mchId,
      serialNo,
      apiV3Key,
      privateKey,
      platformPublicKey,
      platformPublicKeyId: this.env.WECHAT_PLATFORM_PUBLIC_KEY_ID,
      notifyUrl,
      refundNotifyUrl,
    };
  }
}

export class WechatApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`微信支付 ${code}: ${message}`);
    this.name = "WechatApiError";
  }
}

export function normalizeWechatRefundResponse(
  response: WechatRefundResponse,
  request: RefundProviderRequest,
): RefundProviderResult {
  if (
    response.out_refund_no !== request.outRefundNo ||
    response.out_trade_no !== request.outTradeNo
  ) {
    return { status: "UNKNOWN", message: "微信退款响应单号不匹配" };
  }
  if (
    response.amount?.refund !== request.refundAmount ||
    response.amount?.total !== request.totalAmount
  ) {
    return { status: "UNKNOWN", message: "微信退款响应金额不匹配" };
  }
  return {
    status: normalizeWechatStatus(response.status ?? "UNKNOWN"),
    providerRefundId: response.refund_id,
    successTime: parseProviderTime(response.success_time),
    message: response.message,
  };
}

function normalizeWechatStatus(status: string): RefundProviderStatus {
  if (["SUCCESS", "PROCESSING", "CLOSED", "ABNORMAL"].includes(status)) {
    return status as RefundProviderStatus;
  }
  return "UNKNOWN";
}

function validateRefundRequest(request: RefundProviderRequest): void {
  if (!request.outTradeNo || !request.outRefundNo) throw new ValidateException("微信退款单号无效");
  if (
    !Number.isSafeInteger(request.refundAmount) ||
    !Number.isSafeInteger(request.totalAmount) ||
    request.refundAmount <= 0 ||
    request.totalAmount <= 0 ||
    request.refundAmount > request.totalAmount
  ) {
    throw new ValidateException("微信退款金额无效");
  }
}

function parseProviderTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : undefined;
}

function emptyTradeQueryResult(
  request: PaymentProviderQueryRequest,
  status: PaymentProviderQueryResult["status"],
  providerTradeState: string,
  errorCode: string,
): PaymentProviderQueryResult {
  return {
    status,
    providerTradeState: /^[A-Z0-9_.:-]{1,32}$/.test(providerTradeState)
      ? providerTradeState
      : "UNKNOWN",
    orderNo: request.orderNo,
    transactionId: "",
    amountCents: 0,
    currency: "CNY",
    providerEventTime: 0,
    errorCode,
  };
}

function assertCallbackUrl(value: string, label: string): void {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.hostname !== "localhost") throw new Error();
    if (url.search || url.hash) throw new Error();
  } catch {
    throw new ValidateException(`${label}地址无效`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
