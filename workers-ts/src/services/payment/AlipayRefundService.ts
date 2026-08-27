import type { Env } from "@/env";
import {
  formatAlipayTimestamp,
  parseAndVerifyAlipayApiResponse,
  signAlipayParams,
  type AlipayParams,
} from "@/utils/alipay";
import { ValidateException } from "@/utils/errors";
import {
  amountToCents,
  centsToAmount,
  type RefundProviderRequest,
  type RefundProviderResult,
} from "@/services/payment/RefundGateway";

const ALIPAY_GATEWAY = "https://openapi.alipay.com/gateway.do";

interface AlipayResponse {
  code?: string;
  msg?: string;
  sub_code?: string;
  sub_msg?: string;
  out_trade_no?: string;
  trade_no?: string;
  out_request_no?: string;
  refund_fee?: string;
  refund_amount?: string;
  refund_status?: string;
  fund_change?: string;
}

export class AlipayRefundService {
  constructor(private readonly env: Env) {}

  async requestRefund(request: RefundProviderRequest): Promise<RefundProviderResult> {
    const response = await this.call(
      "alipay.trade.refund",
      "alipay_trade_refund_response",
      {
        out_trade_no: request.outTradeNo,
        refund_amount: centsToAmount(request.refundAmount),
        refund_reason: (request.reason ?? "").slice(0, 256),
        out_request_no: request.outRefundNo,
      },
    );

    if (response.code !== "10000") return classifyAlipayFailure(response);
    if (response.out_trade_no && response.out_trade_no !== request.outTradeNo) {
      return { status: "UNKNOWN", message: "支付宝退款响应订单号不匹配" };
    }
    if (response.refund_fee && amountToCents(response.refund_fee) !== request.refundAmount) {
      return { status: "UNKNOWN", message: "支付宝退款响应金额不匹配" };
    }
    if (response.fund_change === "Y") {
      return {
        status: "SUCCESS",
        providerRefundId: response.trade_no,
        successTime: Math.floor(Date.now() / 1000),
      };
    }

    // 官方要求 fund_change=N 或缺失时必须查询，不得以 code=10000 判成功。
    return this.queryRefund(request);
  }

  async queryRefund(request: RefundProviderRequest): Promise<RefundProviderResult> {
    const response = await this.call(
      "alipay.trade.fastpay.refund.query",
      "alipay_trade_fastpay_refund_query_response",
      {
        out_trade_no: request.outTradeNo,
        out_request_no: request.outRefundNo,
      },
    );

    if (response.code !== "10000") return classifyAlipayFailure(response, true);
    if (
      response.out_trade_no !== request.outTradeNo ||
      response.out_request_no !== request.outRefundNo
    ) {
      return { status: "NOT_FOUND", message: "支付宝未找到对应退款请求" };
    }
    if (response.refund_amount && amountToCents(response.refund_amount) !== request.refundAmount) {
      return { status: "UNKNOWN", message: "支付宝退款查询金额不匹配" };
    }
    if (response.refund_status === "REFUND_SUCCESS") {
      return {
        status: "SUCCESS",
        providerRefundId: response.trade_no,
        successTime: Math.floor(Date.now() / 1000),
      };
    }
    return {
      status: "FAILED",
      providerRefundId: response.trade_no,
      message: "支付宝退款尚未成功",
    };
  }

  private async call(
    method: string,
    responseKey: string,
    bizContent: Record<string, unknown>,
  ): Promise<AlipayResponse> {
    const { appId, privateKey, publicKey } = this.config();
    const params: AlipayParams = {
      app_id: appId,
      method,
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
      });
    } catch (error) {
      throw new Error(`支付宝退款请求网络状态未知: ${errorMessage(error)}`);
    }
    const rawBody = await response.text();
    if (!response.ok) {
      throw new Error(`支付宝退款网关 HTTP ${response.status}，结果未知`);
    }
    try {
      return await parseAndVerifyAlipayApiResponse<AlipayResponse>(
        rawBody,
        responseKey,
        publicKey,
      );
    } catch (error) {
      throw new Error(`支付宝退款响应不可验证: ${errorMessage(error)}`);
    }
  }

  private config(): { appId: string; privateKey: string; publicKey: string } {
    const appId = this.env.ALIPAY_APP_ID;
    const privateKey = this.env.ALIPAY_PRIVATE_KEY;
    const publicKey = this.env.ALIPAY_PUBLIC_KEY;
    if (!appId || !privateKey || !publicKey) {
      throw new ValidateException("支付宝退款尚未完成商户密钥配置");
    }
    return { appId, privateKey, publicKey };
  }
}

export function classifyAlipayFailure(
  response: AlipayResponse,
  querying = false,
): RefundProviderResult {
  const code = response.sub_code ?? response.code ?? "UNKNOWN";
  const message = [response.msg, response.sub_msg].filter(Boolean).join(": ") || code;
  if (querying && /(?:TRADE|REFUND)_NOT_EXIST/.test(code)) {
    return { status: "NOT_FOUND", message };
  }
  if (/SYSTEM_ERROR|UNKNOWN|TIMEOUT/.test(code)) return { status: "UNKNOWN", message };
  return { status: "FAILED", message };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
