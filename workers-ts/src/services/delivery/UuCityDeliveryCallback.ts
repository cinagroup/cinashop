import { createHash, timingSafeEqual } from "node:crypto";
import {
  cityDeliverySubjectHash,
  type CityDeliveryStateSpec,
  type VerifiedCityDeliveryEvent,
} from "./DadaCityDeliveryCallback";

export type VerifiedUuCityDeliveryEvent = VerifiedCityDeliveryEvent<"uu">;

const STATE_BY_STATUS: Readonly<Record<string, CityDeliveryStateSpec>> = {
  "1": { state: "WAITING_ACCEPT", rank: 10, legacyStatus: 0, terminal: false, completesOrder: false, cancelsDelivery: false },
  "2": { state: "RIDER_CANCELLED", rank: 10, legacyStatus: 0, terminal: false, completesOrder: false, cancelsDelivery: false, clearsRider: true },
  "3": { state: "WAITING_PICKUP", rank: 20, legacyStatus: 2, terminal: false, completesOrder: false, cancelsDelivery: false },
  "4": { state: "RIDER_AT_STORE", rank: 30, legacyStatus: 100, terminal: false, completesOrder: false, cancelsDelivery: false },
  "5": { state: "DELIVERING", rank: 40, legacyStatus: 3, terminal: false, completesOrder: false, cancelsDelivery: false },
  "6": { state: "ARRIVED_DESTINATION", rank: 50, legacyStatus: 3, terminal: false, completesOrder: false, cancelsDelivery: false },
  "10": { state: "DELIVERED", rank: 60, legacyStatus: 4, terminal: true, completesOrder: true, cancelsDelivery: false },
  "-1": { state: "CANCELLED", rank: 90, legacyStatus: -1, terminal: true, completesOrder: false, cancelsDelivery: true },
  "-2": { state: "CANCELLED", rank: 90, legacyStatus: -1, terminal: true, completesOrder: false, cancelsDelivery: true },
  "-3": { state: "CANCELLED", rank: 90, legacyStatus: -1, terminal: true, completesOrder: false, cancelsDelivery: true },
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown, label: string, maximum: number, required = false): string {
  if (typeof value !== "string" && typeof value !== "number") {
    if (!required && (value === undefined || value === null)) return "";
    throw new Error(`uu_${label}_invalid`);
  }
  const normalized = String(value).trim();
  if ((required && !normalized) || Buffer.byteLength(normalized, "utf8") > maximum
    || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`uu_${label}_invalid`);
  }
  return normalized;
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  const normalized = typeof value === "string" && /^-?\d+$/.test(value.trim())
    ? Number(value.trim())
    : value;
  if (!Number.isSafeInteger(normalized) || Number(normalized) < minimum || Number(normalized) > maximum) {
    throw new Error(`uu_${label}_invalid`);
  }
  return Number(normalized);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function validateCallbackToken(value: string | undefined): string {
  const normalized = String(value ?? "");
  if (Buffer.byteLength(normalized, "utf8") < 24
    || Buffer.byteLength(normalized, "utf8") > 128
    || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error("uu_callback_token_invalid");
  }
  return normalized;
}

function normalizedProviderTime(raw: number): number {
  const seconds = raw >= 1_000_000_000_000 ? Math.floor(raw / 1_000) : raw;
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 4_102_444_800) {
    throw new Error("uu_change_time_invalid");
  }
  return seconds;
}

function providerOrderId(value: unknown, label: "origin_id" | "order_code"): string {
  const normalized = text(value, label, 32, true);
  if (!/^[A-Za-z0-9._:-]{1,32}$/.test(normalized)) throw new Error(`uu_${label}_invalid`);
  return normalized;
}

function providerStatus(value: unknown): string {
  const normalized = text(value, "state", 5, true);
  if (!/^-?\d{1,3}$/.test(normalized)) throw new Error("uu_state_invalid");
  return normalized;
}

function eventFromFields(input: {
  source: "callback" | "query";
  openId: string;
  originId: string;
  orderCode: string;
  status: string;
  providerUpdateTime: number;
  stateText: string;
  riderName: string;
  riderMobile: string;
}): VerifiedUuCityDeliveryEvent {
  const state = uuCityDeliveryState(input.status);
  const privateHashes = [input.stateText, input.riderName, input.riderMobile]
    .map((value) => sha256(value));
  const canonical = JSON.stringify({
    provider: "uu",
    source: input.source,
    openId: input.openId,
    originId: input.originId,
    orderCode: input.orderCode,
    providerStatus: input.status,
    providerUpdateTime: input.providerUpdateTime,
    privateHashes,
  });
  const payloadHash = sha256(canonical);
  return {
    provider: "uu",
    source: input.source,
    eventKey: payloadHash,
    payloadHash,
    subjectKeyHash: uuCityDeliverySubjectHash(input.originId),
    clientId: input.openId,
    providerOrderId: input.originId,
    providerStatus: input.status,
    providerUpdateTime: input.providerUpdateTime,
    repeatReasonType: 0,
    cancelFrom: 0,
    finishCode: "",
    riderName: input.riderName,
    riderMobile: input.riderMobile,
    reasonText: state.cancelsDelivery ? input.stateText : "",
    payload: {
      protocol: input.source === "callback" ? "uu-order-callback-v3" : "uu-order-query-v3",
      providerOrderCode: input.orderCode,
      callbackAuthentication: input.source === "callback" ? "url-token-and-open-id" : "authenticated-active-query",
      providerSignaturePresented: input.source === "callback",
    },
    state,
  };
}

export function uuCityDeliverySubjectHash(originId: string): string {
  return cityDeliverySubjectHash("uu", originId);
}

export function uuCityDeliveryState(status: string): CityDeliveryStateSpec {
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
 * UU's current public callback page exposes openId/timestamp/biz/sign but
 * explicitly says that callback verification and retry rules are not public.
 * The signature is therefore syntax-checked only. Provider authentication is
 * instead an independent unguessable callback URL token plus exact openId;
 * neither secret nor the raw callback is persisted.
 */
export function verifyUuCityDeliveryCallback(
  rawBody: string,
  input: {
    requestToken: string | undefined;
    callbackToken: string | undefined;
    expectedOpenId: string | undefined;
  },
): VerifiedUuCityDeliveryEvent {
  const configuredToken = validateCallbackToken(input.callbackToken);
  if (!safeEqual(configuredToken, String(input.requestToken ?? ""))) {
    throw new Error("uu_callback_token_mismatch");
  }
  const expectedOpenId = text(input.expectedOpenId, "configured_open_id", 64, true);

  let decoded: unknown;
  try {
    decoded = JSON.parse(rawBody);
  } catch {
    throw new Error("uu_callback_not_json");
  }
  const body = record(decoded);
  if (!body) throw new Error("uu_callback_shape_invalid");

  const openId = text(body.openId, "open_id", 64, true);
  if (!safeEqual(openId, expectedOpenId)) throw new Error("uu_open_id_mismatch");
  boundedInteger(body.timestamp, "timestamp", 1, 4_102_444_800_000);
  const signature = text(body.sign, "signature", 32, true);
  if (!/^[0-9a-f]{32}$/i.test(signature)) throw new Error("uu_signature_invalid");
  const rawBiz = text(body.biz, "biz", 24 * 1024, true);

  let decodedBiz: unknown;
  try {
    decodedBiz = JSON.parse(rawBiz);
  } catch {
    throw new Error("uu_biz_not_json");
  }
  const biz = record(decodedBiz);
  if (!biz) throw new Error("uu_biz_shape_invalid");
  const originId = providerOrderId(biz.originId, "origin_id");
  const orderCode = providerOrderId(biz.orderCode, "order_code");
  const status = providerStatus(biz.state);
  const changeTime = normalizedProviderTime(
    boundedInteger(biz.changeTime, "change_time", 1, 4_102_444_800_000),
  );
  const stateText = text(biz.stateText, "state_text", 255, true);
  const riderName = text(biz.driverName, "rider_name", 64);
  const riderMobile = text(biz.driverMobile, "rider_mobile", 32);
  if (riderMobile && !/^[+0-9 -]{5,32}$/.test(riderMobile)) throw new Error("uu_rider_mobile_invalid");

  return eventFromFields({
    source: "callback",
    openId,
    originId,
    orderCode,
    status,
    providerUpdateTime: changeTime,
    stateText,
    riderName,
    riderMobile,
  });
}

/** Normalize evidence returned by an authenticated V3 order-detail query. */
export function normalizeUuCityDeliveryQuery(
  value: unknown,
  input: { expectedOpenId: string; originId: string; observedAt: number },
): VerifiedUuCityDeliveryEvent {
  const body = record(value);
  if (!body) throw new Error("uu_query_shape_invalid");
  const openId = text(input.expectedOpenId, "configured_open_id", 64, true);
  const expectedOriginId = providerOrderId(input.originId, "origin_id");
  const returnedOriginId = providerOrderId(body.originId, "origin_id");
  if (!safeEqual(expectedOriginId, returnedOriginId)) throw new Error("uu_query_order_mismatch");
  const orderCode = providerOrderId(body.orderCode, "order_code");
  const status = providerStatus(body.state);
  const riderName = text(body.driverName, "rider_name", 64);
  const riderMobile = text(body.driverMobile, "rider_mobile", 32);
  if (riderMobile && !/^[+0-9 -]{5,32}$/.test(riderMobile)) throw new Error("uu_rider_mobile_invalid");
  return eventFromFields({
    source: "query",
    openId,
    originId: expectedOriginId,
    orderCode,
    status,
    providerUpdateTime: normalizedProviderTime(input.observedAt),
    stateText: "",
    riderName,
    riderMobile,
  });
}
