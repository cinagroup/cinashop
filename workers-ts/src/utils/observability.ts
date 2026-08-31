export type OperationalComponent =
  | "http"
  | "hyperdrive"
  | "queue"
  | "dlq"
  | "durable_object"
  | "r2"
  | "login"
  | "payment"
  | "refund"
  | "print"
  | "waybill";

export type OperationalOutcome =
  | "success"
  | "rejected"
  | "retry"
  | "unknown"
  | "failure";

export type OperationalSeverity = "info" | "warn" | "error";

type OperationalScalar = string | number | boolean | null | undefined;

export interface OperationalEvent {
  event: string;
  component: OperationalComponent;
  outcome: OperationalOutcome;
  operation?: string;
  durationMs?: number;
  thresholdMs?: number;
  statusCode?: number;
  queueAttempt?: number;
  resourceCount?: number;
  result?: string;
  errorCode?: string;
  [key: string]: OperationalScalar;
}

const NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const FIELD_PATTERN = /^[a-z][A-Za-z0-9]{0,63}$/;
const FORBIDDEN_FIELD = /^(authorization|body|content|cookie|credential|credentials|email|error|message|password|payload|phone|query|secret|token|url)$/i;

function isForbiddenField(key: string): boolean {
  return key === "schema" || key === "id" || key.endsWith("Id") || key.endsWith("Uid") ||
    key.endsWith("_id") || key.endsWith("_uid") ||
    FORBIDDEN_FIELD.test(key);
}

/**
 * Return a low-cardinality error code. Exception messages are intentionally
 * excluded because providers and database drivers can include credentials,
 * SQL parameters, PII, or complete remote response bodies in them.
 */
export function operationalErrorCode(error: unknown, fallback = "unknown_error"): string {
  const candidate = error instanceof Error ? error.name : "";
  const normalize = (value: string) => value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  const normalized = normalize(candidate);
  if (NAME_PATTERN.test(normalized)) return normalized;
  const fallbackCode = normalize(fallback);
  return NAME_PATTERN.test(fallbackCode) ? fallbackCode : "unknown_error";
}

/** Emit one Cloudflare Workers Logs object whose fields can be indexed. */
export function emitOperationalEvent(
  severity: OperationalSeverity,
  input: OperationalEvent,
): void {
  if (!NAME_PATTERN.test(input.event)) throw new Error("Operational event name is invalid");
  if (!NAME_PATTERN.test(input.operation ?? "operation")) {
    throw new Error("Operational operation name is invalid");
  }

  const event: Record<string, Exclude<OperationalScalar, undefined>> = {
    schema: "cinashop_operational_v1",
  };
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (!FIELD_PATTERN.test(key) || isForbiddenField(key)) {
      throw new Error(`Operational field is forbidden: ${key}`);
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`Operational number is invalid: ${key}`);
    }
    if (value !== null && !["string", "number", "boolean"].includes(typeof value)) {
      throw new Error(`Operational field must be scalar: ${key}`);
    }
    if (key === "errorCode" && (typeof value !== "string" || !NAME_PATTERN.test(value))) {
      throw new Error("Operational error code is invalid");
    }
    event[key] = value;
  }

  if (severity === "error") console.error(event);
  else if (severity === "warn") console.warn(event);
  else console.log(event);
}

export type CriticalHttpOperation =
  | "login"
  | "payment"
  | "refund"
  | "print"
  | "waybill"
  | "r2";

/** Classify only stable operational domains; never put the raw path in logs. */
export function classifyCriticalHttpOperation(
  method: string,
  path: string,
): CriticalHttpOperation | null {
  const normalizedMethod = method.toUpperCase();
  const normalizedPath = path.toLowerCase();

  if (
    /\/(?:login|login_key|scan_login|apple_login|wechat_login)(?:\/|$)/.test(normalizedPath) ||
    normalizedPath === "/api/login"
  ) return "login";
  if (normalizedPath.includes("refund")) return "refund";
  if (
    normalizedPath.includes("/pay/") || normalizedPath.endsWith("/pay") ||
    normalizedPath.includes("payment") || normalizedPath.includes("ali_pay")
  ) return "payment";
  if (normalizedPath.includes("waybill") || normalizedPath.includes("electronic_sheet")) {
    return "waybill";
  }
  if (normalizedPath.includes("print")) return "print";
  if (
    normalizedPath.includes("/upload") || normalizedPath.includes("/assets/") ||
    (normalizedMethod === "DELETE" && normalizedPath.includes("attachment"))
  ) return "r2";
  return null;
}
