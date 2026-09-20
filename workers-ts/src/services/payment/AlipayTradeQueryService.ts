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
import { readPaymentProviderResponse } from '@/utils/payment-response';
import { assertPaymentQueryCredentialIdentity, validatePaymentQueryIdentity, type PaymentQueryOriginalIdentity } from './PaymentQueryIdentity';

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
  trans_currency?: string;
  settle_currency?: string;
}

export class AlipayTradeQueryService {
  constructor(private readonly env: Env) {}

  async query(request: PaymentProviderQueryRequest, original?: PaymentQueryOriginalIdentity): Promise<PaymentProviderQueryResult> {
    if (request.provider !== "alipay" || request.profile !== "alipay") {
      throw new ValidateException("支付宝查单渠道无效");
    }
    // Snapshot before the first await; caller/config mutation cannot switch the scope in flight.
    request = { ...request };
    original = original ? { ...original } : undefined;
    validatePaymentQueryIdentity(request, original);
    const cfg = this.config();
    assertPaymentQueryCredentialIdentity(original, cfg.appId, cfg.sellerId);
    const response = await this.call({ out_trade_no: request.orderNo }, cfg);
    if (response.code !== "10000") {
      const code = response.sub_code ?? response.code ?? "UNKNOWN";
      if (code === 'ACQ.TRADE_NOT_EXIST') {
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
      // This state also includes fully refunded paid trades, not proof of non-payment.
      return emptyResult(request, "UNKNOWN", providerTradeState, 'provider_closed_or_refunded');
    }
    if (!["TRADE_SUCCESS", "TRADE_FINISHED"].includes(providerTradeState)) {
      return emptyResult(request, "UNKNOWN", providerTradeState, "provider_status_unknown");
    }
    const amountCents = typeof response.total_amount === 'string' && /^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(response.total_amount)
      ? amountToCents(response.total_amount) : null;
    const transactionId = typeof response.trade_no === 'string' ? response.trade_no : '';
    const providerEventTime = parseAlipayTime(response.send_pay_date);
    if (
      !/^[A-Za-z0-9_-]{1,100}$/.test(transactionId)
      || amountCents !== request.expectedAmountCents
      || (response.trans_currency !== undefined && response.trans_currency !== 'CNY')
      || (response.settle_currency !== undefined && response.settle_currency !== 'CNY')
      || (original && (transactionId.length > 50 || providerEventTime <= 0))
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
      providerEventTime,
      errorCode: "",
      ...(original ? { identityEvidence: { source: 'alipay-direct-request-scope' as const,
        appId: cfg.appId, merchantId: original.merchantId } } : {}),
    };
  }

  private async call(bizContent: Record<string, unknown>, cfg: ReturnType<AlipayTradeQueryService['config']>): Promise<AlipayTradeQueryResponse> {
    const { appId, privateKey, publicKey } = cfg;
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
    const rawBody = await readPaymentProviderResponse(response);
    if (!response.ok) throw new Error(`支付宝支付查单网关 HTTP ${response.status}`);
    try {
      const decoded = await parseAndVerifyAlipayApiResponse<Record<string, unknown>>(
        rawBody,
        "alipay_trade_query_response",
        publicKey,
      );
      return { code: responseString(decoded, 'code'), msg: responseString(decoded, 'msg'),
        sub_code: responseString(decoded, 'sub_code'), sub_msg: responseString(decoded, 'sub_msg'),
        out_trade_no: responseString(decoded, 'out_trade_no'), trade_no: responseString(decoded, 'trade_no'),
        trade_status: responseString(decoded, 'trade_status'), total_amount: responseString(decoded, 'total_amount'),
        send_pay_date: responseString(decoded, 'send_pay_date'), trans_currency: responseString(decoded, 'trans_currency'),
        settle_currency: responseString(decoded, 'settle_currency') };
    } catch (error) {
      throw new Error(`支付宝支付查单响应不可验证: ${errorMessage(error)}`);
    }
  }

  private config(): { appId: string; sellerId: string | undefined; privateKey: string; publicKey: string } {
    const appId = this.env.ALIPAY_APP_ID;
    const privateKey = this.env.ALIPAY_PRIVATE_KEY;
    const publicKey = this.env.ALIPAY_PUBLIC_KEY;
    if (!appId || !privateKey || !publicKey) {
      throw new ValidateException("支付宝查单尚未完成商户密钥配置");
    }
    return { appId, sellerId: this.env.ALIPAY_SELLER_ID, privateKey, publicKey };
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
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return 0;
  const milliseconds = Date.parse(`${value.replace(" ", "T")}+08:00`);
  return Number.isFinite(milliseconds) && formatAlipayTimestamp(new Date(milliseconds)) === value
    ? Math.floor(milliseconds / 1_000) : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function responseString(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== 'string') throw Error('支付宝查单字段类型无效');
  return field;
}
