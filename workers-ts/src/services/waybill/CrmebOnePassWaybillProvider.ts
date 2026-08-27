const API_ROOT = "https://sms.crmeb.net/api/";
const LOGIN_PATH = "v2/user/login";
const ISSUE_PATH = "v2/expr/dump";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 32 * 1_024;

export interface CrmebOnePassCredentials {
  accessKey?: string;
  secretKey?: string;
}

export interface WaybillCarrierSnapshot {
  partnerId: boolean;
  partnerKey: boolean;
  net: boolean;
  checkMan: boolean;
  partnerName: boolean;
  isCode: boolean;
  account: string;
  key: string;
  netName: string;
  courierName: string;
  customerName: string;
  codeName: string;
}

export interface WaybillIssueInput {
  carrierCode: string;
  recipientName: string;
  recipientPhone: string;
  recipientAddress: string;
  senderName: string;
  senderPhone: string;
  senderAddress: string;
  templateId: string;
  cloudPrinterId: string;
  count: number;
  cargo: string;
  weight: string;
  orderNo: string;
  carrier: WaybillCarrierSnapshot;
}

export interface WaybillIssueResult {
  trackingNumber: string;
  labelUrl: string;
  providerReference: string;
  responseCode: string;
}

export class WaybillConfigurationError extends Error {}

/** Authentication failed before the irreversible issue endpoint was invoked. */
export class WaybillPreflightError extends Error {}

/** Provider returned a valid application response that explicitly rejected the issue request. */
export class WaybillRejectedError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

interface TokenCacheEntry {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, TokenCacheEntry>();

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function safeText(value: unknown, maximum: number): string {
  return [...String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()].slice(0, maximum).join("");
}

function requiredCredential(value: string | undefined, label: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new WaybillConfigurationError(`${label}未通过 Worker Secret 配置`);
  if (normalized.length > 512) throw new WaybillConfigurationError(`${label}长度无效`);
  return normalized;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function boundedResponseText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel("provider_response_too_large").catch(() => undefined);
        throw new Error("provider_response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function postForm(
  path: string,
  form: FormData,
  headers: HeadersInit,
  fetcher: typeof fetch,
): Promise<{ response: Response; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetcher(`${API_ROOT}${path}`, {
      method: "POST",
      headers,
      body: form,
      signal: controller.signal,
      redirect: "error",
    });
    return { response, text: await boundedResponseText(response) };
  } finally {
    clearTimeout(timer);
  }
}

function parseEnvelope(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("provider_response_not_json");
  }
  const envelope = record(parsed);
  if (!envelope || !Number.isFinite(Number(envelope.status))) {
    throw new Error("provider_response_invalid_envelope");
  }
  return envelope;
}

async function accessToken(
  credentials: CrmebOnePassCredentials,
  fetcher: typeof fetch,
): Promise<string> {
  const accessKey = requiredCredential(credentials.accessKey, "一号通 Access Key");
  const secretKey = requiredCredential(credentials.secretKey, "一号通 Secret Key");
  const cacheKey = await sha256(`${accessKey}\u0000${secretKey}`);
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const form = new FormData();
  form.set("access_key", accessKey);
  form.set("secret_key", secretKey);
  try {
    const { response, text } = await postForm(LOGIN_PATH, form, {}, fetcher);
    if (!response.ok) throw new Error(`login_http_${response.status}`);
    const envelope = parseEnvelope(text);
    if (Number(envelope.status) !== 200) {
      throw new Error(`login_rejected:${safeText(envelope.msg, 300) || "unknown"}`);
    }
    const data = record(envelope.data);
    const token = safeText(data?.access_token, 2_000);
    if (!token) throw new Error("login_token_missing");
    tokenCache.set(cacheKey, { token, expiresAt: Date.now() + 240_000 });
    return token;
  } catch (error) {
    if (error instanceof WaybillConfigurationError) throw error;
    throw new WaybillPreflightError(
      `一号通认证失败: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1_000),
    );
  }
}

function field(form: FormData, key: string, value: string | number): void {
  form.set(key, String(value));
}

function issueForm(input: WaybillIssueInput): FormData {
  const form = new FormData();
  field(form, "com", input.carrierCode);
  // These names intentionally preserve the observed CRMEB protocol. Despite
  // the old PHP docblock, `to_*` carries the recipient and `from_*` the sender.
  field(form, "to_name", input.recipientName);
  field(form, "to_tel", input.recipientPhone);
  field(form, "to_addr", input.recipientAddress);
  field(form, "from_name", input.senderName);
  field(form, "from_tel", input.senderPhone);
  field(form, "from_addr", input.senderAddress);
  field(form, "temp_id", input.templateId);
  field(form, "count", input.count);
  if (input.cloudPrinterId) field(form, "siid", input.cloudPrinterId);
  else field(form, "print_type", "IMAGE");
  if (input.cargo) field(form, "cargo", input.cargo);
  if (input.weight) field(form, "weight", input.weight);
  if (input.orderNo) field(form, "order_id", input.orderNo);
  if (input.carrier.partnerId) field(form, "partner_id", input.carrier.account);
  if (input.carrier.partnerKey) field(form, "partner_key", input.carrier.key);
  if (input.carrier.net) field(form, "net", input.carrier.netName);
  if (input.carrier.checkMan) field(form, "checkMan", input.carrier.courierName);
  if (input.carrier.partnerName) field(form, "partnerName", input.carrier.customerName);
  if (input.carrier.isCode) field(form, "code", input.carrier.codeName);
  return form;
}

/**
 * Call the irreversible allocation endpoint exactly once. Any transport,
 * timeout, non-JSON, or malformed-success outcome after this call is ambiguous
 * and intentionally remains an ordinary Error for the job service to mark UNKNOWN.
 */
export async function issueCrmebOnePassWaybill(
  credentials: CrmebOnePassCredentials,
  input: WaybillIssueInput,
  fetcher: typeof fetch = fetch,
): Promise<WaybillIssueResult> {
  const token = await accessToken(credentials, fetcher);
  const headers: Record<string, string> = { Authorization: `Bearer-${token}` };
  if (!input.cloudPrinterId) headers.version = "v1.1";
  const { response, text } = await postForm(ISSUE_PATH, issueForm(input), headers, fetcher);
  if (!response.ok) throw new Error(`issue_http_${response.status}`);
  const envelope = parseEnvelope(text);
  const status = Number(envelope.status);
  if (status !== 200) {
    throw new WaybillRejectedError(
      safeText(envelope.msg, 500) || "一号通明确拒绝电子面单签发",
      String(status),
    );
  }
  const data = record(envelope.data);
  const trackingNumber = safeText(data?.kuaidinum, 64);
  if (!trackingNumber) throw new Error("issue_tracking_number_missing");
  const labelUrl = safeText(data?.label, 255);
  return {
    trackingNumber,
    labelUrl,
    providerReference: safeText(data?.task_id ?? data?.order_id ?? trackingNumber, 255),
    responseCode: String(status),
  };
}
