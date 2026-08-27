import { describe, expect, it } from "vitest";
import { classifyAlipayFailure } from "@/services/payment/AlipayRefundService";
import {
  amountToCents,
  centsToAmount,
  type RefundProviderRequest,
} from "@/services/payment/RefundGateway";
import { normalizeWechatRefundResponse } from "@/services/wechat/WechatPayService";

const request: RefundProviderRequest = {
  outTradeNo: "wx20260809001",
  transactionId: "42000000000001",
  outRefundNo: "CNSR2001",
  refundAmount: 1234,
  totalAmount: 5000,
};

describe("第三方退款协议守卫", () => {
  it("金额仅在合法两位小数字符串与整数分之间转换", () => {
    expect(amountToCents("12.34")).toBe(1234);
    expect(amountToCents("12.345")).toBeNull();
    expect(amountToCents(12.34)).toBeNull();
    expect(centsToAmount(1234)).toBe("12.34");
    expect(() => centsToAmount(-1)).toThrow("金额分值无效");
  });

  it("微信只在单号和金额均一致时接受 SUCCESS", () => {
    expect(
      normalizeWechatRefundResponse(
        {
          refund_id: "5030001",
          out_refund_no: request.outRefundNo,
          out_trade_no: request.outTradeNo,
          status: "SUCCESS",
          amount: { refund: 1234, total: 5000 },
        },
        request,
      ),
    ).toMatchObject({ status: "SUCCESS", providerRefundId: "5030001" });

    expect(
      normalizeWechatRefundResponse(
        {
          refund_id: "5030001",
          out_refund_no: request.outRefundNo,
          out_trade_no: request.outTradeNo,
          status: "SUCCESS",
          amount: { refund: 1, total: 5000 },
        },
        request,
      ),
    ).toMatchObject({ status: "UNKNOWN", message: "微信退款响应金额不匹配" });
  });

  it("支付宝查询未找到与系统错误不会被误判为退款失败或成功", () => {
    expect(
      classifyAlipayFailure({ code: "40004", sub_code: "ACQ.REFUND_NOT_EXIST" }, true),
    ).toMatchObject({ status: "NOT_FOUND" });
    expect(
      classifyAlipayFailure({ code: "20000", sub_code: "SYSTEM_ERROR" }),
    ).toMatchObject({ status: "UNKNOWN" });
    expect(
      classifyAlipayFailure({ code: "40004", sub_code: "ACQ.INVALID_PARAMETER" }),
    ).toMatchObject({ status: "FAILED" });
  });
});
