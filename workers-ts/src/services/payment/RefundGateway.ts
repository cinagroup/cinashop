export type RefundProvider = "wechat" | "alipay";

export type RefundProviderStatus =
  | "SUCCESS"
  | "PROCESSING"
  | "CLOSED"
  | "ABNORMAL"
  | "FAILED"
  | "UNKNOWN"
  | "NOT_FOUND";

export interface RefundProviderResult {
  status: RefundProviderStatus;
  providerRefundId?: string;
  successTime?: number;
  message?: string;
}

export interface RefundProviderRequest {
  outTradeNo: string;
  transactionId?: string;
  outRefundNo: string;
  refundAmount: number;
  totalAmount: number;
  reason?: string;
}

export function centsToAmount(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error("金额分值无效");
  return (cents / 100).toFixed(2);
}

export function amountToCents(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const amount = Number(value);
  const cents = Math.round(amount * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}
