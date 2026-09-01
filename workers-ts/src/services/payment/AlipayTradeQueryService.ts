import type { Env } from "@/env";
import {
  formatAlipayTimestamp,
  parseAndVerifyAlipayApiResponse,
  signAlipayParams,
  type AlipayParams,
} from "@/utils/alipay";
import { amountToCents } from "@/services/payment/RefundGateway";
import type {
  PaymentProviderQueryRequest,
  PaymentProviderQueryResult,
} from "@/services/payment/PaymentProviderQuery";
import { ValidateException } from "@/utils/errors";

const ALIPAY_GATEWAY = "https://openapi.alipay.com/gateway.do";

interface AlipayTradeQueryResponse {
  code?: string;
  msg?: string;
  sub_code?: string;
  sub_msg?: string;
  out_trade_no?: string;
  trade_no?: string;
  trade_status?: string;
  total_amount?: string;
  send_pay_date?: string;
}

export class AlipayTradeQueryService {
  constructor(private readonly env: Env) {}

  async query(request: PaymentProviderQueryRequest): Promise<PaymentProviderQueryResult> {
    if (request.provider !== "alipay" || request.profile !== "alipay") {
      throw new ValidateException("支付宝查单渠道无效");
    }
    const response = await this.call({ out_trade_no: request.orderNo });
    if (response.code !== "10000") {
      const code = response.sub_code ?? response.code ?? "UNKNOWN";
      if (/TRADE_NOT_EXIST/.test(code)) {
        return emptyResult(request, "NOT_FOUND", "TRADE_NOT_EXIST", "provider_trade_not_found");
      }
      return emptyResult(request, "UNKNOWN", code, classifyAlipayQueryError(code));
    }
    if (response.out_trade_no !== request.orderNo) {
      return emptyResult(request, "UNKNOWN", "ORDER_MISMATCH", "provider_order_mismatch");
    }
    const providerTradeState = response.trade_status ?? "UNKNOWN";
    if (providerTradeState === "WAIT_BUYER_PAY") {
      return emptyResult(request, "PENDING", providerTradeState, "");
    }
    if (providerTradeState === "TRADE_CLOSED") {
      return emptyResult(request, "CLOSED", providerTradeState, "");
    }
    if (!["TRADE_SUCCESS", "TRADE_FINISHED"].includes(providerTradeState)) {
      return emptyResult(request, "UNKNOWN", providerTradeState, "provider_status_unknown");
    }
    const amountCents = response.total_amount ? amountToCents(response.total_amount) : null;
    const transactionId = response.trade_no ?? "";
    if (
      !/^[A-Za-z0-9_-]{1,100}$/.test(transactionId)
      || amountCents !== request.expectedAmountCents
    ) {
      return {
        ...emptyResult(request, "UNKNOWN", providerTradeState, "provider_evidence_mismatch"),
        transactionId,
        amountCents: amountCents ?? -1,
      };
    }
    return {
      status: "SUCCESS",
      providerTradeState,
      orderNo: request.orderNo,
      transactionId,
      amountCents: amountCents ?? -1,
      currency: "CNY",
      providerEventTime: parseAlipayTime(response.send_pay_date),
      errorCode: "",
    };
  }

  private async call(bizContent: Record<string, unknown>): Promise<AlipayTradeQueryResponse> {
    const { appId, privateKey, publicKey } = this.config();
    const params: AlipayParams = {
      app_id: appId,
      method: "alipay.trade.query",
      format: "JSON",
      charset: "utf-8",
      sign_type: "RSA2",
      timestamp: formatAlipayTimestamp(new Date()),
      version: "1.0",
      biz_content: JSON.stringify(bizContent),
    };
    params.sign = await signAlipayParams(params, privateKey);
    let response: Response;
    try {
      response = await fetch(ALIPAY_GATEWAY, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
        },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(8_000),
      });
    } catch (error) {
      throw new Error(`支付宝支付查单网络状态未知: ${errorMessage(error)}`);
    }
    const rawBody = await response.text();
    if (!response.ok) throw new Error(`支付宝支付查单网关 HTTP ${response.status}`);
    try {
      return await parseAndVerifyAlipayApiResponse<AlipayTradeQueryResponse>(
        rawBody,
        "alipay_trade_query_response",
        publicKey,
      );
    } catch (error) {
      throw new Error(`支付宝支付查单响应不可验证: ${errorMessage(error)}`);
    }
  }

  private config(): { appId: string; privateKey: string; publicKey: string } {
    const appId = this.env.ALIPAY_APP_ID;
    const privateKey = this.env.ALIPAY_PRIVATE_KEY;
    const publicKey = this.env.ALIPAY_PUBLIC_KEY;
    if (!appId || !privateKey || !publicKey) {
      throw new ValidateException("支付宝查单尚未完成商户密钥配置");
    }
    return { appId, privateKey, publicKey };
  }
}

function emptyResult(
  request: PaymentProviderQueryRequest,
  status: PaymentProviderQueryResult["status"],
  providerTradeState: string,
  errorCode: string,
): PaymentProviderQueryResult {
  return {
    status,
    providerTradeState: boundedProviderState(providerTradeState),
    orderNo: request.orderNo,
    transactionId: "",
    amountCents: 0,
    currency: "CNY",
    providerEventTime: 0,
    errorCode,
  };
}

function classifyAlipayQueryError(code: string): string {
  if (/SYSTEM_ERROR|UNKNOWN|TIMEOUT/.test(code)) return "provider_query_transient";
  return "provider_query_rejected";
}

function boundedProviderState(value: string): string {
  return /^[A-Z0-9_.:-]{1,32}$/.test(value) ? value : "UNKNOWN";
}

function parseAlipayTime(value: string | undefined): number {
  if (!value || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return 0;
  const milliseconds = Date.parse(`${value.replace(" ", "T")}+08:00`);
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1_000) : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
