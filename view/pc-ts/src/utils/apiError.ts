/** Preserve machine-readable business failures without treating transport errors as rejections. */
export class ApiResponseError extends Error {
  constructor(message: string, public readonly status: number | undefined, public readonly data: unknown) {
    super(message);
    this.name = "ApiResponseError";
  }
}

export function isOrderFormRejection(error: unknown, key: string): boolean {
  if (!(error instanceof ApiResponseError) || error.status !== 400 || !key) return false;
  const value = error.data;
  return !!value && typeof value === "object" && !Array.isArray(value)
    && "errorCode" in value && (value.errorCode === "ORDER_FORM_REJECTED" || value.errorCode === "ORDER_QUOTE_RECONFIRM_REQUIRED")
    && "orderKey" in value && value.orderKey === key;
}

/** A rejection on a later retry cannot settle an earlier request whose outcome is still unknown. */
export function canEditRejectedOrder(error: unknown, key: string, hadUncertainAttempt: boolean): boolean {
  return !hadUncertainAttempt && isOrderFormRejection(error, key);
}
