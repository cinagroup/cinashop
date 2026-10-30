const API_ROOT = "https://sms.crmeb.net/api/";
const LOGIN_PATH = "v2/user/login";
const TEMPLATE_PATH = "v2/expr_dump/temp";
const ISSUE_PATH = "v2/expr/dump";
const EXPRESS_CATALOG_PATH = "v2/expr/express";
const MAX_CATALOG_RESPONSE_BYTES = 1_024 * 1_024;
const MAX_CATALOG_ROWS = 5_000;
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

export interface WaybillTemplateQuery {
  carrierCode: string;
  cloudPrinterConfigured: boolean;
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

async function boundedResponseText(response: Response, maximum = MAX_RESPONSE_BYTES): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
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

async function getProviderJson(
  path: string,
  query: URLSearchParams,
  headers: HeadersInit,
  fetcher: typeof fetch,
  maximum = MAX_RESPONSE_BYTES,
): Promise<{ response: Response; text: string }> {
  const url = new URL(path, API_ROOT);
  url.search = query.toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetcher(url, {
      method: "GET",
      headers,
      signal: controller.signal,
      redirect: "error",
    });
    return { response, text: await boundedResponseText(response, maximum) };
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

/** Read the provider's carrier-specific template catalog without allocating a waybill. */
export async function listCrmebOnePassWaybillTemplates(
  credentials: CrmebOnePassCredentials,
  input: WaybillTemplateQuery,
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  const carrierCode = safeText(input.carrierCode, 50);
  if (!carrierCode || !/^[a-zA-Z0-9_-]+$/.test(carrierCode)) {
    throw new WaybillConfigurationError("快递公司编码无效");
  }
  const token = await accessToken(credentials, fetcher);
  const headers: Record<string, string> = { Authorization: `Bearer-${token}` };
  if (!input.cloudPrinterConfigured) headers.version = "v1.1";
  const query = new URLSearchParams({ com: carrierCode });
  let response: Response;
  let text: string;
  try {
    ({ response, text } = await getProviderJson(TEMPLATE_PATH, query, headers, fetcher));
  } catch (error) {
    throw new WaybillPreflightError(
      `一号通模板查询失败: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1_000),
    );
  }
  if (!response.ok) throw new WaybillPreflightError(`一号通模板查询 HTTP ${response.status}`);
  const envelope = parseEnvelope(text);
  if (Number(envelope.status) !== 200) {
    throw new WaybillRejectedError(
      safeText(envelope.msg, 500) || "一号通拒绝电子面单模板查询",
      String(envelope.status),
    );
  }
  return envelope.data ?? [];
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


/** Provider-owned requirements, never carrier account values or arbitrary metadata. */
export interface CrmebExpressCatalogRow {
  code: string;
  name: string;
  partner_id: 0 | 1;
  partner_key: 0 | 1;
  net: 0 | 1;
  check_man: 0 | 1;
  partner_name: 0 | 1;
  is_code: 0 | 1;
}

const EXPRESS_FLAGS = ['partner_id', 'partner_key', 'net', 'check_man', 'partner_name', 'is_code'] as const;
const catalogInvalid = () => new WaybillPreflightError('一号通快递目录响应不完整或包含无效数据');
function catalogRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw catalogInvalid();
  return value as Record<string, unknown>;
}
function catalogOwn(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !('value' in descriptor)) throw catalogInvalid();
  return descriptor.value;
}
function catalogInteger(value: unknown, maximum = MAX_CATALOG_ROWS): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}
/** The fixed PHP source proves data.data, but does not prove a total-count
 * field. No metadata means only this response's snapshot, never an assertion
 * that the complete remote provider directory was returned. Explicit totals
 * must match; ambiguous/pending pagination is never silently truncated. */
function checkedCatalogMetadata(value: Record<string, unknown>, length: number): void {
  const keys = Object.getOwnPropertyNames(value);
  let complete = false;
  for (const key of ['count', 'total']) {
    if (!keys.includes(key)) continue;
    const count = catalogOwn(value, key);
    if (!catalogInteger(count) || count !== length) throw catalogInvalid();
    complete = true;
  }
  for (const key of ['last_page', 'total_pages', 'pages']) {
    if (!keys.includes(key)) continue;
    const pages = catalogOwn(value, key);
    if (pages !== 1 && !(length === 0 && pages === 0)) throw catalogInvalid();
    complete = true;
  }
  const known = new Set(['count', 'total', 'last_page', 'total_pages', 'pages',
    'has_more', 'hasMore', 'more', 'next', 'next_page', 'next_page_url', 'next_cursor',
    'page', 'current_page', 'limit', 'per_page', 'page_size', 'offset']);
  for (const key of keys) {
    const field = catalogOwn(value, key);
    if (['has_more', 'hasMore', 'more'].includes(key) && field !== false && field !== 0) throw catalogInvalid();
    if (['next', 'next_page', 'next_page_url', 'next_cursor'].includes(key)
      && field !== null && field !== '' && field !== 0 && field !== false) throw catalogInvalid();
    if (['page', 'current_page'].includes(key) && (field !== 1 || !complete)) throw catalogInvalid();
    if (['limit', 'per_page', 'page_size'].includes(key)
      && (!catalogInteger(field) || field < length || field === 0 && length !== 0 || !complete)) throw catalogInvalid();
    if (key === 'offset' && (field !== 0 || !complete)) throw catalogInvalid();
    if (!known.has(key) && /(?:page|paginat|cursor|offset|limit|^next|^has[_A-Z]|^meta$|^links$)/i.test(key)) throw catalogInvalid();
  }
}

/** Validate every row before projecting; never return a valid prefix. */
export function checkedCrmebExpressCatalog(raw: unknown): CrmebExpressCatalogRow[] {
  try {
    const envelope = catalogRecord(raw), status = catalogOwn(envelope, 'status');
    if (status !== 200 && status !== '200') throw catalogInvalid();
    const data = catalogRecord(catalogOwn(envelope, 'data'));
    const rows = catalogOwn(data, 'data');
    if (!Array.isArray(rows) || rows.length > MAX_CATALOG_ROWS) throw catalogInvalid();
    checkedCatalogMetadata(envelope, rows.length);
    checkedCatalogMetadata(data, rows.length);
    const codes = new Set<string>();
    return Array.from(rows, value => {
      const row = catalogRecord(value), code = catalogOwn(row, 'code'), name = catalogOwn(row, 'name');
      if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{1,50}$/.test(code) || codes.has(code)
        || typeof name !== 'string' || !name || name.trim() !== name || [...name].length > 64
        || /[\u0000-\u001f\u007f-\u009f]/u.test(name)) throw catalogInvalid();
      codes.add(code);
      const result = { code, name } as CrmebExpressCatalogRow;
      for (const key of EXPRESS_FLAGS) {
        const flag = catalogOwn(row, key);
        if (flag !== 0 && flag !== 1 && flag !== '0' && flag !== '1') throw catalogInvalid();
        result[key] = flag === 1 || flag === '1' ? 1 : 0;
      }
      return result;
    });
  } catch {
    // Do not echo provider-controlled text, account data or thrown getters.
    throw catalogInvalid();
  }
}

/** Read-only provider request; local synchronization is a separate authorized
 * database operation. No issue/open/shipment endpoint or retry is invoked. */
export async function listCrmebOnePassExpressCatalog(
  credentials: CrmebOnePassCredentials,
  fetcher: typeof fetch = fetch,
): Promise<CrmebExpressCatalogRow[]> {
  let token: string;
  try { token = await accessToken(credentials, fetcher); } catch (error) {
    if (error instanceof WaybillConfigurationError) throw error;
    throw new WaybillPreflightError('一号通快递目录认证失败');
  }
  let result: { response: Response; text: string };
  try {
    result = await getProviderJson(EXPRESS_CATALOG_PATH, new URLSearchParams(),
      { Authorization: `Bearer-${token}`, Accept: 'application/json' }, fetcher, MAX_CATALOG_RESPONSE_BYTES);
  } catch {
    throw new WaybillPreflightError('一号通快递目录读取失败');
  }
  if (!result.response.ok) throw new WaybillPreflightError('一号通快递目录读取失败');
  let raw: unknown;
  try { raw = JSON.parse(result.text); } catch { throw catalogInvalid(); }
  return checkedCrmebExpressCatalog(raw);
}
