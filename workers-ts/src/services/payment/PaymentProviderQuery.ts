import type {
  PaymentCallbackOrderDomain,
  PaymentCallbackProfile,
  PaymentCallbackProvider,
} from "@/models/schema";
import type { PaymentQueryIdentityEvidence } from './PaymentQueryIdentity';

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

/** Strict allowlist; identity provenance must not be confused with a callback. */
export interface PaymentProviderQueryResult {
  status: PaymentProviderQueryStatus;
  providerTradeState: string;
  orderNo: string;
  transactionId: string;
  amountCents: number;
  currency: "CNY";
  providerEventTime: number;
  errorCode: string;
  identityEvidence?: PaymentQueryIdentityEvidence;
}

export type PaymentProviderQuery = (
  request: PaymentProviderQueryRequest,
) => Promise<PaymentProviderQueryResult>;
