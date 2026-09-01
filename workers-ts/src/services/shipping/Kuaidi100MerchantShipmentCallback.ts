import { createHash, timingSafeEqual } from "node:crypto";

export type MerchantShipmentState =
  | "ORDER_CREATED"
  | "ACCEPTED"
  | "COLLECTING"
  | "PICKED_UP"
  | "IN_TRANSIT"
  | "DELIVERING"
  | "SIGNED"
  | "ABNORMAL_SIGNED"
  | "SETTLED"
  | "REASSIGNED"
  | "CANCEL_REQUESTED"
  | "CANCELLED"
  | "PICKUP_FAILED"
  | "ORDER_FAILED"
  | "RESURRECTED"
  | "LABEL_CREATED"
  | "LABEL_FAILED"
  | "WEIGHT_CHANGED"
  | "UNKNOWN";

export interface MerchantShipmentStateSpec {
  state: MerchantShipmentState;
  rank: number;
  projectionType: "order_state" | "metadata" | "ignored";
  terminal: boolean;
  fulfilsOrder: boolean;
}

export interface VerifiedKuaidi100MerchantShipmentCallback {
  provider: "kuaidi100";
  eventKey: string;
  payloadHash: string;
  subjectKeyHash: string;
  taskId: string;
  providerOrderId: string;
  carrierCode: string;
  trackingNumber: string;
  callbackStatus: string;
  orderStatus: string;
  payload: Record<string, unknown>;
  state: MerchantShipmentStateSpec;
}

const STATE_BY_STATUS: Readonly<Record<string, MerchantShipmentStateSpec>> = {
  "0": { state: "ORDER_CREATED", rank: 10, projectionType: "order_state", terminal: false, fulfilsOrder: false },
  "1": { state: "ACCEPTED", rank: 20, projectionType: "order_state", terminal: false, fulfilsOrder: false },
  "2": { state: "COLLECTING", rank: 30, projectionType: "order_state", terminal: false, fulfilsOrder: false },
  "9": { state: "CANCEL_REQUESTED", rank: 80, projectionType: "order_state", terminal: true, fulfilsOrder: false },
  "10": { state: "PICKED_UP", rank: 40, projectionType: "order_state", terminal: false, fulfilsOrder: true },
  "11": { state: "PICKUP_FAILED", rank: 80, projectionType: "order_state", terminal: true, fulfilsOrder: false },
  "13": { state: "SIGNED", rank: 70, projectionType: "order_state", terminal: false, fulfilsOrder: true },
  "14": { state: "ABNORMAL_SIGNED", rank: 70, projectionType: "order_state", terminal: false, fulfilsOrder: true },
  "15": { state: "SETTLED", rank: 75, projectionType: "order_state", terminal: true, fulfilsOrder: true },
  "99": { state: "CANCELLED", rank: 90, projectionType: "order_state", terminal: true, fulfilsOrder: false },
  "101": { state: "IN_TRANSIT", rank: 50, projectionType: "order_state", terminal: false, fulfilsOrder: true },
  "155": { state: "WEIGHT_CHANGED", rank: 0, projectionType: "metadata", terminal: false, fulfilsOrder: false },
  "166": { state: "RESURRECTED", rank: 15, projectionType: "order_state", terminal: false, fulfilsOrder: false },
  "200": { state: "LABEL_CREATED", rank: 0, projectionType: "metadata", terminal: false, fulfilsOrder: false },
  "201": { state: "LABEL_FAILED", rank: 0, projectionType: "metadata", terminal: false, fulfilsOrder: false },
  "302": { state: "REASSIGNED", rank: 35, projectionType: "order_state", terminal: false, fulfilsOrder: false },
  "400": { state: "DELIVERING", rank: 60, projectionType: "order_state", terminal: false, fulfilsOrder: true },
  "610": { state: "ORDER_FAILED", rank: 80, projectionType: "order_state", terminal: true, fulfilsOrder: false },
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function visible(value: unknown, label: string, maximum: number, required = false): string {
  if (typeof value !== "string" && typeof value !== "number") {
    if (!required && (value === undefined || value === null)) return "";
    throw new Error(`kuaidi100_${label}_invalid`);
  }
  const normalized = String(value).trim();
  if ((required && !normalized) || [...normalized].length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`kuaidi100_${label}_invalid`);
  }
  return normalized;
}

function status(value: unknown, label: string): string {
  const normalized = visible(value, label, 3, true);
  if (!/^[0-9]{1,3}$/.test(normalized)) throw new Error(`kuaidi100_${label}_invalid`);
  return normalized;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function kuaidi100TaskSubjectHash(taskId: string): string {
  return sha256(taskId);
}

export function kuaidi100CallbackSignature(param: string, salt: string): string {
  return createHash("md5").update(param + salt, "utf8").digest("hex").toUpperCase();
}

export function validateKuaidi100CallbackSalt(salt: string | undefined): string {
  const normalized = String(salt ?? "");
  const bytes = Buffer.byteLength(normalized, "utf8");
  if (bytes < 16 || bytes > 100 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error("kuaidi100_callback_salt_invalid");
  }
  return normalized;
}

export function merchantShipmentState(orderStatus: string): MerchantShipmentStateSpec {
  return STATE_BY_STATUS[orderStatus] ?? {
    state: "UNKNOWN",
    rank: 0,
    projectionType: "ignored",
    terminal: false,
    fulfilsOrder: false,
  };
}

/**
 * Parse the exact current Kuaidi100 application/x-www-form-urlencoded
 * callback contract. Signature verification uses the decoded `param` string,
 * matching MD5(param + salt); the raw form and signature are then discarded.
 */
export function verifyKuaidi100MerchantShipmentCallback(
  rawBody: string,
  saltValue: string | undefined,
): VerifiedKuaidi100MerchantShipmentCallback {
  const salt = validateKuaidi100CallbackSalt(saltValue);
  const form = new URLSearchParams(rawBody);
  const allowed = new Set(["taskId", "sign", "param"]);
  const counts = new Map<string, number>();
  for (const [key] of form.entries()) {
    if (!allowed.has(key)) throw new Error("kuaidi100_callback_form_field_invalid");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (["taskId", "sign", "param"].some((key) => counts.get(key) !== 1) || counts.size !== 3) {
    throw new Error("kuaidi100_callback_form_invalid");
  }

  const taskId = visible(form.get("taskId"), "task_id", 128, true);
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(taskId)) throw new Error("kuaidi100_task_id_invalid");
  const signature = visible(form.get("sign"), "signature", 32, true);
  if (!/^[0-9a-f]{32}$/i.test(signature)) throw new Error("kuaidi100_signature_invalid");
  const param = form.get("param") ?? "";
  if (!param || Buffer.byteLength(param, "utf8") > 24 * 1024) {
    throw new Error("kuaidi100_param_invalid");
  }
  const expected = Buffer.from(kuaidi100CallbackSignature(param, salt), "hex");
  const actual = Buffer.from(signature, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error("kuaidi100_signature_mismatch");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(param);
  } catch {
    throw new Error("kuaidi100_param_not_json");
  }
  const root = record(decoded);
  const data = record(root?.data);
  if (!root || !data) throw new Error("kuaidi100_param_shape_invalid");
  const callbackStatus = status(root.status, "callback_status");
  if (callbackStatus !== "200") throw new Error("kuaidi100_callback_status_failed");
  const orderStatus = status(data.status, "order_status");
  const carrierCode = visible(root.kuaidicom, "carrier_code", 50, true).toLowerCase();
  if (!/^[a-z0-9_-]{1,50}$/.test(carrierCode)) throw new Error("kuaidi100_carrier_code_invalid");
  const trackingNumber = visible(root.kuaidinum, "tracking_number", 64);
  const providerOrderId = visible(data.orderId, "provider_order_id", 128);
  const state = merchantShipmentState(orderStatus);
  if (state.fulfilsOrder && !trackingNumber) throw new Error("kuaidi100_tracking_number_required");
  let payload: Record<string, unknown> = { protocol: "kuaidi100-order-callback-v1" };
  if (state.state === "REASSIGNED") {
    const reassignedTaskId = visible(data.taskId, "reassigned_task_id", 128, true);
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(reassignedTaskId)) {
      throw new Error("kuaidi100_reassigned_task_id_invalid");
    }
    const reassignedCarrierCode = visible(data.kuaidiCom, "reassigned_carrier_code", 50, true).toLowerCase();
    if (!/^[a-z0-9_-]{1,50}$/.test(reassignedCarrierCode)) {
      throw new Error("kuaidi100_reassigned_carrier_code_invalid");
    }
    const reassignedTrackingNumber = visible(data.kuaidiNum, "reassigned_tracking_number", 64);
    payload = {
      protocol: "kuaidi100-order-callback-v1",
      reassignment: {
        taskId: reassignedTaskId,
        carrierCode: reassignedCarrierCode,
        trackingNumber: reassignedTrackingNumber,
      },
    };
  }
  const payloadHash = sha256(param);
  return {
    provider: "kuaidi100",
    eventKey: sha256(`kuaidi100\u0000${taskId}\u0000${param}`),
    payloadHash,
    subjectKeyHash: kuaidi100TaskSubjectHash(taskId),
    taskId,
    providerOrderId,
    carrierCode,
    trackingNumber,
    callbackStatus,
    orderStatus,
    payload,
    state,
  };
}
