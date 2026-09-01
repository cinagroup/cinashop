import { createHash, timingSafeEqual } from "node:crypto";

export type CityDeliveryState =
  | "WAITING_ACCEPT"
  | "RIDER_CANCELLED"
  | "APPENDED_WAITING"
  | "WAITING_PICKUP"
  | "RIDER_AT_STORE"
  | "DELIVERING"
  | "ARRIVED_DESTINATION"
  | "DELIVERED"
  | "CANCELLED"
  | "RETURNING"
  | "RETURNED"
  | "AFTERSALE_RETURNED"
  | "ORDER_FAILED"
  | "UNKNOWN";

export interface CityDeliveryStateSpec {
  state: CityDeliveryState;
  rank: number;
  legacyStatus: number | null;
  terminal: boolean;
  completesOrder: boolean;
  cancelsDelivery: boolean;
  clearsRider?: boolean;
}

export type CityDeliveryProvider = "dada" | "uu";

export interface VerifiedCityDeliveryEvent<P extends CityDeliveryProvider = CityDeliveryProvider> {
  provider: P;
  source: "callback" | "query";
  eventKey: string;
  payloadHash: string;
  subjectKeyHash: string;
  clientId: string;
  providerOrderId: string;
  providerStatus: string;
  providerUpdateTime: number;
  repeatReasonType: number;
  cancelFrom: number;
  finishCode: string;
  riderName: string;
  riderMobile: string;
  reasonText: string;
  payload: Record<string, unknown>;
  state: CityDeliveryStateSpec;
}

export type VerifiedDadaCityDeliveryEvent = VerifiedCityDeliveryEvent<"dada">;

export interface CityDeliveryWatermarkSnapshot {
  lastEventKey: string;
  lastState: string;
  lastRank: number;
  providerUpdateTime: number;
  terminal: number;
}

export type CityDeliveryTransitionDecision =
  | "apply"
  | "noop"
  | "superseded"
  | "conflict"
  | "ignored";

const STATE_BY_STATUS: Readonly<Record<string, CityDeliveryStateSpec>> = {
  "1": { state: "WAITING_ACCEPT", rank: 10, legacyStatus: 0, terminal: false, completesOrder: false, cancelsDelivery: false },
  "8": { state: "APPENDED_WAITING", rank: 15, legacyStatus: 8, terminal: false, completesOrder: false, cancelsDelivery: false },
  "2": { state: "WAITING_PICKUP", rank: 20, legacyStatus: 2, terminal: false, completesOrder: false, cancelsDelivery: false },
  "100": { state: "RIDER_AT_STORE", rank: 30, legacyStatus: 100, terminal: false, completesOrder: false, cancelsDelivery: false },
  "3": { state: "DELIVERING", rank: 40, legacyStatus: 3, terminal: false, completesOrder: false, cancelsDelivery: false },
  "9": { state: "RETURNING", rank: 50, legacyStatus: 9, terminal: false, completesOrder: false, cancelsDelivery: false },
  "4": { state: "DELIVERED", rank: 60, legacyStatus: 4, terminal: true, completesOrder: true, cancelsDelivery: false },
  "10": { state: "RETURNED", rank: 70, legacyStatus: 10, terminal: true, completesOrder: false, cancelsDelivery: true },
  "6": { state: "AFTERSALE_RETURNED", rank: 80, legacyStatus: 6, terminal: true, completesOrder: false, cancelsDelivery: false },
  "5": { state: "CANCELLED", rank: 90, legacyStatus: -1, terminal: true, completesOrder: false, cancelsDelivery: true },
  "1000": { state: "ORDER_FAILED", rank: 90, legacyStatus: 1000, terminal: true, completesOrder: false, cancelsDelivery: true },
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown, label: string, maximum: number, required = false): string {
  if (typeof value !== "string" && typeof value !== "number") {
    if (!required && (value === undefined || value === null)) return "";
    throw new Error(`dada_${label}_invalid`);
  }
  const normalized = String(value).trim();
  if ((required && !normalized) || [...normalized].length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`dada_${label}_invalid`);
  }
  return normalized;
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  const normalized = typeof value === "string" && /^-?\d+$/.test(value.trim())
    ? Number(value.trim())
    : value;
  if (!Number.isSafeInteger(normalized) || Number(normalized) < minimum || Number(normalized) > maximum) {
    throw new Error(`dada_${label}_invalid`);
  }
  return Number(normalized);
}

function optionalInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  fallback = 0,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  return boundedInteger(value, label, minimum, maximum);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function normalizedProviderTime(raw: number, status: string): number {
  const seconds = status === "1000" && raw >= 1_000_000_000_000
    ? Math.floor(raw / 1_000)
    : raw;
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 4_102_444_800) {
    throw new Error("dada_update_time_invalid");
  }
  return seconds;
}

function eventFromFields(input: {
  source: "callback" | "query";
  clientId: string;
  providerOrderId: string;
  providerStatus: string;
  providerUpdateTime: number;
  repeatReasonType: number;
  cancelFrom: number;
  finishCode: string;
  riderName: string;
  riderMobile: string;
  reasonText: string;
}): VerifiedDadaCityDeliveryEvent {
  const state = dadaCityDeliveryState(input.providerStatus);
  const privateHashes = [input.finishCode, input.riderName, input.riderMobile, input.reasonText]
    .map((value) => sha256(value));
  const canonical = JSON.stringify({
    provider: "dada",
    source: input.source,
    clientId: input.clientId,
    providerOrderId: input.providerOrderId,
    providerStatus: input.providerStatus,
    providerUpdateTime: input.providerUpdateTime,
    repeatReasonType: input.repeatReasonType,
    cancelFrom: input.cancelFrom,
    privateHashes,
  });
  const payloadHash = sha256(canonical);
  return {
    provider: "dada",
    ...input,
    eventKey: payloadHash,
    payloadHash,
    subjectKeyHash: dadaCityDeliverySubjectHash(input.providerOrderId),
    payload: {
      protocol: input.source === "callback" ? "dada-order-callback-v1" : "dada-order-query-v1",
      repeatReasonType: input.repeatReasonType,
      cancelFrom: input.cancelFrom,
    },
    state,
  };
}

export function dadaCityDeliverySubjectHash(providerOrderId: string): string {
  return cityDeliverySubjectHash("dada", providerOrderId);
}

export function cityDeliverySubjectHash(provider: CityDeliveryProvider, providerOrderId: string): string {
  return sha256(`${provider}\u0000${providerOrderId}`);
}

/** Current Dada callback checksum: lowercase MD5 of the three sorted values. */
export function dadaCallbackChecksum(clientId: string, orderId: string, updateTime: string | number): string {
  return createHash("md5")
    .update([clientId, orderId, String(updateTime)].sort().join(""), "utf8")
    .digest("hex");
}

export function validateDadaCallbackToken(token: string | undefined): string {
  const normalized = String(token ?? "");
  if (Buffer.byteLength(normalized, "utf8") < 24
    || Buffer.byteLength(normalized, "utf8") > 128
    || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error("dada_callback_token_invalid");
  }
  return normalized;
}

export function dadaCityDeliveryState(status: string): CityDeliveryStateSpec {
  return STATE_BY_STATUS[status] ?? {
    state: "UNKNOWN",
    rank: 0,
    legacyStatus: null,
    terminal: false,
    completesOrder: false,
    cancelsDelivery: false,
  };
}

/**
 * Dada's documented checksum is unkeyed. A dedicated unguessable callback URL
 * token and an exact configured client ID are therefore mandatory in addition
 * to the checksum; neither the token nor the raw callback is persisted.
 */
export function verifyDadaCityDeliveryCallback(
  rawBody: string,
  input: {
    requestToken: string | undefined;
    callbackToken: string | undefined;
    expectedClientId: string | undefined;
  },
): VerifiedDadaCityDeliveryEvent {
  const configuredToken = validateDadaCallbackToken(input.callbackToken);
  const requestToken = String(input.requestToken ?? "");
  if (!safeEqual(configuredToken, requestToken)) throw new Error("dada_callback_token_mismatch");
  const expectedClientId = text(input.expectedClientId, "configured_client_id", 64, true);

  let decoded: unknown;
  try {
    decoded = JSON.parse(rawBody);
  } catch {
    throw new Error("dada_callback_not_json");
  }
  const body = record(decoded);
  if (!body) throw new Error("dada_callback_shape_invalid");

  const clientId = text(body.client_id, "client_id", 64, true);
  if (!safeEqual(clientId, expectedClientId)) throw new Error("dada_client_id_mismatch");
  const providerOrderId = text(body.order_id, "order_id", 32, true);
  if (!/^[A-Za-z0-9._:-]{1,32}$/.test(providerOrderId)) throw new Error("dada_order_id_invalid");
  const providerStatus = text(body.order_status, "order_status", 4, true);
  if (!/^(?:[1-9]\d{0,2}|1000)$/.test(providerStatus)) throw new Error("dada_order_status_invalid");
  const rawUpdateTime = boundedInteger(body.update_time, "update_time", 1, Number.MAX_SAFE_INTEGER);
  const signature = text(body.signature, "signature", 32, true).toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(signature)) throw new Error("dada_signature_invalid");
  const expected = dadaCallbackChecksum(clientId, providerOrderId, rawUpdateTime);
  if (!safeEqual(signature, expected)) throw new Error("dada_signature_mismatch");

  const repeatReasonType = optionalInteger(body.repeat_reason_type, "repeat_reason_type", 0, 2);
  const cancelFrom = optionalInteger(body.cancel_from, "cancel_from", 0, 3);
  const finishCode = text(body.finish_code, "finish_code", 32);
  const riderName = text(body.dm_name, "rider_name", 64);
  const riderMobile = text(body.dm_mobile, "rider_mobile", 32);
  if (riderMobile && !/^[+0-9 -]{5,32}$/.test(riderMobile)) throw new Error("dada_rider_mobile_invalid");
  const reasonText = text(body.cancel_reason, "cancel_reason", 255);

  return eventFromFields({
    source: "callback",
    clientId,
    providerOrderId,
    providerStatus,
    providerUpdateTime: normalizedProviderTime(rawUpdateTime, providerStatus),
    repeatReasonType,
    cancelFrom,
    finishCode,
    riderName,
    riderMobile,
    reasonText,
  });
}

/** Normalize a response obtained by an authenticated active order query. */
export function normalizeDadaCityDeliveryQuery(
  value: unknown,
  input: { expectedClientId: string; providerOrderId: string; observedAt: number },
): VerifiedDadaCityDeliveryEvent {
  const body = record(value);
  if (!body) throw new Error("dada_query_shape_invalid");
  const clientId = text(input.expectedClientId, "configured_client_id", 64, true);
  const providerOrderId = text(input.providerOrderId, "order_id", 32, true);
  const providerStatus = text(body.order_status ?? body.status, "order_status", 4, true);
  if (!/^(?:[1-9]\d{0,2}|1000)$/.test(providerStatus)) throw new Error("dada_order_status_invalid");
  const rawProviderTime = body.update_time === undefined || body.update_time === null
    ? input.observedAt
    : boundedInteger(body.update_time, "update_time", 1, Number.MAX_SAFE_INTEGER);
  const providerUpdateTime = normalizedProviderTime(rawProviderTime, providerStatus);
  const repeatReasonType = optionalInteger(body.repeat_reason_type, "repeat_reason_type", 0, 2);
  const cancelFrom = optionalInteger(body.cancel_from, "cancel_from", 0, 3);
  const finishCode = text(body.finish_code, "finish_code", 32);
  const riderName = text(body.dm_name, "rider_name", 64);
  const riderMobile = text(body.dm_mobile, "rider_mobile", 32);
  if (riderMobile && !/^[+0-9 -]{5,32}$/.test(riderMobile)) throw new Error("dada_rider_mobile_invalid");
  const reasonText = text(body.cancel_reason, "cancel_reason", 255);
  return eventFromFields({
    source: "query",
    clientId,
    providerOrderId,
    providerStatus,
    providerUpdateTime,
    repeatReasonType,
    cancelFrom,
    finishCode,
    riderName,
    riderMobile,
    reasonText,
  });
}

export function cityDeliveryTransition(
  current: CityDeliveryWatermarkSnapshot | undefined,
  next: Pick<VerifiedCityDeliveryEvent,
    "eventKey" | "source" | "providerUpdateTime" | "repeatReasonType" | "state">,
): CityDeliveryTransitionDecision {
  if (next.state.state === "UNKNOWN") return "ignored";
  if (!current) return "apply";
  if (current.lastEventKey === next.eventKey) return "noop";
  if (next.source === "callback" && next.providerUpdateTime < current.providerUpdateTime) {
    return "superseded";
  }
  if (next.providerUpdateTime === current.providerUpdateTime && next.state.state !== current.lastState) {
    return "conflict";
  }
  if (current.terminal === 1) {
    return next.state.state === current.lastState ? "apply" : "conflict";
  }
  // UU documents state 2 as a rider cancellation that returns the order to
  // the waiting pool. It is the only allowed active-state regression and is
  // rejected once pickup has happened.
  if (next.state.state === "RIDER_CANCELLED") {
    return current.lastRank < 40 ? "apply" : "conflict";
  }
  // A returned parcel is a legitimate post-pickup outcome (3/9 -> 10), not a
  // late cancellation. Ordinary cancellation/failure still cannot roll back
  // a delivery after the rider has picked it up.
  if (next.state.cancelsDelivery && next.state.state !== "RETURNED" && current.lastRank >= 40) {
    return "conflict";
  }
  if (next.state.rank < current.lastRank) {
    return next.source === "query" ? "conflict" : "superseded";
  }
  if (next.state.rank === current.lastRank && next.state.state !== current.lastState) return "conflict";
  return "apply";
}
