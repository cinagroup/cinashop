import type {
  PaymentCallbackOrderDomain,
  PaymentCallbackProfile,
  PaymentCallbackProvider,
} from "@/models/schema";

export type PaymentProviderQueryStatus =
  | "SUCCESS"
  | "PENDING"
  | "CLOSED"
  | "NOT_FOUND"
  | "UNKNOWN";

export interface PaymentProviderQueryRequest {
  provider: PaymentCallbackProvider;
  profile: PaymentCallbackProfile;
  orderDomain: PaymentCallbackOrderDomain;
  orderNo: string;
  expectedAmountCents: number;
  currency: "CNY";
}

/** Strict allowlist projected from a signed provider response. */
export interface PaymentProviderQueryResult {
  status: PaymentProviderQueryStatus;
  providerTradeState: string;
  orderNo: string;
  transactionId: string;
  amountCents: number;
  currency: "CNY";
  providerEventTime: number;
  errorCode: string;
}

export type PaymentProviderQuery = (
  request: PaymentProviderQueryRequest,
) => Promise<PaymentProviderQueryResult>;
