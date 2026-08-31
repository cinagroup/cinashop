import type { Env } from "@/env";

const PROVIDER_ORIGIN = "https://qyapi.weixin.qq.com";
const ACCESS_TOKEN_PATH = "/cgi-bin/gettoken";
const FETCH_TIMEOUT_MS = 5_000;
const DEFAULT_RESPONSE_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_CREDENTIAL_BYTES = 512;
const MAX_RETRY_AFTER_SECONDS = 900;
const INVALID_ACCESS_TOKEN_CODES = new Set([40_001, 40_014, 42_001]);
const RETRYABLE_PROVIDER_CODES = new Set([-1, 45_009, 45_011]);
const CONFIGURATION_PROVIDER_CODES = new Set([40_013, 48_002, 60_020]);
const UNAVAILABLE_PROVIDER_CODE = -2;
const NOT_FOUND_PROVIDER_CODES: Readonly<Record<string, ReadonlySet<number>>> = {
  directory_member_get: new Set([60_111]),
  directory_department_get: new Set([60_003, 60_123]),
  directory_department_list: new Set([60_003, 60_123]),
  external_contact_get: new Set([40_096, 84_061]),
  external_group_chat_get: new Set([40_050, 86_003]),
};

type JsonRecord = Record<string, unknown>;

export type EnterpriseWechatCredentialScope =
  | "company-jssdk"
  | "agent"
  | "directory"
  | "external-contact";

export type EnterpriseWechatProviderFailureKind =
  | "not_found"
  | "retryable"
  | "terminal"
  | "configuration";

export interface EnterpriseWechatProviderClientConfig {
  corpId: string;
  agentId?: number;
}

interface CachedCredential {
  value: string;
  expiresAt: number;
}

interface ProviderCredential {
  value: string;
  expiresIn: number;
}

interface ProviderOperation {
  name: string;
  path: string;
  method: "GET" | "POST";
  scope: EnterpriseWechatCredentialScope;
  maxResponseBytes?: number;
  notFoundCodes?: ReadonlySet<number>;
}

interface ProviderRequest {
  query?: Record<string, string | number>;
  body?: JsonRecord;
}

interface TokenFlightFailureMetadata {
  kind: EnterpriseWechatProviderFailureKind;
  operation: string;
  providerCode: number;
  httpStatus: number;
  retryAfterSeconds?: number;
}

type TokenFlightOutcome =
  | { ok: true; token: string }
  | { ok: false; failure: TokenFlightFailureMetadata };

// Best-effort isolate-local singleflight: correctness still comes from the
// persisted stale-token check. The Map stores a deferred result rather than the
// leader's I/O chain, and the leader removes its entry when it settles.
const TOKEN_IN_FLIGHT = new Map<string, Promise<TokenFlightOutcome>>();

/** A metadata-only failure: URLs, bodies, provider text, tokens and PII are never retained. */
export class EnterpriseWechatProviderError extends Error {
  constructor(
    readonly kind: EnterpriseWechatProviderFailureKind,
    readonly operation: string,
    readonly providerCode: number,
    readonly httpStatus: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(`enterprise_wechat_provider_${kind}`);
    this.name = "EnterpriseWechatProviderError";
  }
}

export function isEnterpriseWechatCorpId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,18}$/.test(value);
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validCredential(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && !/\s/.test(value)
    && utf8Bytes(value) <= MAX_CREDENTIAL_BYTES;
}

function requiredIdentifier(value: string, operation: string, maxLength = 128): string {
  const normalized = value.trim();
  if (
    value !== normalized
    || normalized.length === 0
    || normalized.length > maxLength
    || !/^[A-Za-z0-9_@.-]+$/.test(normalized)
  ) {
    throw new EnterpriseWechatProviderError("terminal", operation, -1, 0);
  }
  return normalized;
}

function optionalCursor(value: string | undefined, operation: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (value !== value.trim() || utf8Bytes(value) > 512 || /[\u0000-\u001f\u007f\s]/.test(value)) {
    throw new EnterpriseWechatProviderError("terminal", operation, -1, 0);
  }
  return value;
}

function providerCode(data: JsonRecord): number {
  return typeof data.errcode === "number" && Number.isSafeInteger(data.errcode)
    ? data.errcode
    : UNAVAILABLE_PROVIDER_CODE;
}

function retryAfterSeconds(response: Response): number | undefined {
  const raw = response.headers.get("Retry-After")?.trim();
  if (!raw) return undefined;
  const seconds = /^\d+$/.test(raw)
    ? Number(raw)
    : Math.ceil((Date.parse(raw) - Date.now()) / 1_000);
  if (!Number.isFinite(seconds)) return undefined;
  return Math.max(1, Math.min(MAX_RETRY_AFTER_SECONDS, Math.floor(seconds)));
}

function failureKind(
  operation: string,
  httpStatus: number,
  code: number,
  extraNotFoundCodes?: ReadonlySet<number>,
): EnterpriseWechatProviderFailureKind {
  if (
    httpStatus >= 200
    && httpStatus < 300
    && (NOT_FOUND_PROVIDER_CODES[operation]?.has(code) || extraNotFoundCodes?.has(code))
  ) {
    return "not_found";
  }
  if (
    httpStatus === 408
    || httpStatus === 425
    || httpStatus === 429
    || httpStatus >= 500
    || RETRYABLE_PROVIDER_CODES.has(code)
  ) return "retryable";
  if (code === UNAVAILABLE_PROVIDER_CODE && httpStatus >= 200 && httpStatus < 300) {
    return "retryable";
  }
  if (INVALID_ACCESS_TOKEN_CODES.has(code) || CONFIGURATION_PROVIDER_CODES.has(code)) {
    return "configuration";
  }
  return "terminal";
}

function responseFailure(
  operation: string,
  response: Response,
  code: number,
  notFoundCodes?: ReadonlySet<number>,
): EnterpriseWechatProviderError {
  return new EnterpriseWechatProviderError(
    failureKind(operation, response.status, code, notFoundCodes),
    operation,
    code,
    response.status,
    retryAfterSeconds(response),
  );
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function readBoundedJson(
  response: Response,
  operation: string,
  maxBytes: number,
): Promise<JsonRecord> {
  const declaredHeader = response.headers.get("Content-Length");
  if (declaredHeader !== null) {
    const declared = Number(declaredHeader);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes) {
      throw responseFailure(operation, response, UNAVAILABLE_PROVIDER_CODE);
    }
  }
  const reader = response.body?.getReader();
  if (!reader) throw responseFailure(operation, response, UNAVAILABLE_PROVIDER_CODE);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw responseFailure(operation, response, UNAVAILABLE_PROVIDER_CODE);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw responseFailure(operation, response, UNAVAILABLE_PROVIDER_CODE);
  }
  if (!isRecord(value)) throw responseFailure(operation, response, UNAVAILABLE_PROVIDER_CODE);
  return value;
}

function providerCredential(
  data: JsonRecord,
  field: "access_token" | "ticket",
  operation: string,
  response: Response,
): ProviderCredential {
  const code = providerCode(data);
  const expiresIn = Number(data.expires_in);
  if (!response.ok || code !== 0) throw responseFailure(operation, response, code);
  if (
    !validCredential(data[field])
    || !Number.isSafeInteger(expiresIn)
    || expiresIn < 120
    || expiresIn > 86_400
  ) throw responseFailure(operation, response, UNAVAILABLE_PROVIDER_CODE);
  return { value: data[field], expiresIn };
}

const COMPANY_TICKET: ProviderOperation = {
  name: "company_ticket",
  path: "/cgi-bin/get_jsapi_ticket",
  method: "GET",
  scope: "company-jssdk",
  maxResponseBytes: 16 * 1024,
};
const AGENT_TICKET: ProviderOperation = {
  name: "agent_ticket",
  path: "/cgi-bin/ticket/get",
  method: "GET",
  scope: "agent",
  maxResponseBytes: 16 * 1024,
};
const EMPLOYEE_IDENTITY: ProviderOperation = {
  name: "employee_identity",
  path: "/cgi-bin/auth/getuserinfo",
  method: "GET",
  scope: "agent",
  maxResponseBytes: 16 * 1024,
};

/** Reusable, read-only Enterprise WeChat provider boundary for C2-C7 projections. */
export class EnterpriseWechatProviderClient {
  private readonly corpId: string;
  private readonly agentId: number;

  constructor(
    private readonly env: Pick<Env,
      | "CONFIG_KV"
      | "WECHAT_WORK_CORP_SECRET"
      | "WECHAT_WORK_AGENT_SECRET"
      | "WECHAT_WORK_DIRECTORY_SECRET"
      | "WECHAT_WORK_EXTERNAL_CONTACT_SECRET">,
    config: EnterpriseWechatProviderClientConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.corpId = config.corpId.trim();
    this.agentId = config.agentId ?? 0;
    if (!isEnterpriseWechatCorpId(this.corpId)) {
      throw new EnterpriseWechatProviderError("configuration", "provider_config", -1, 0);
    }
    if (
      !Number.isSafeInteger(this.agentId)
      || this.agentId < 0
      || this.agentId > 2_147_483_647
    ) throw new EnterpriseWechatProviderError("configuration", "provider_config", -1, 0);
  }

  async companyJsApiTicket(): Promise<string> {
    return this.cachedTicket(COMPANY_TICKET);
  }

  async agentJsApiTicket(): Promise<string> {
    if (this.agentId <= 0) {
      throw new EnterpriseWechatProviderError("configuration", "agent_ticket", -1, 0);
    }
    return this.cachedTicket(AGENT_TICKET, { query: { type: "agent_config" } });
  }

  async employeeIdentity(code: string): Promise<JsonRecord> {
    if (this.agentId <= 0) {
      throw new EnterpriseWechatProviderError("configuration", "employee_identity", -1, 0);
    }
    return this.authorized(EMPLOYEE_IDENTITY, {
      query: { code: requiredIdentifier(code, "employee_identity", 512) },
    });
  }

  async directoryMember(userid: string): Promise<JsonRecord> {
    return this.authorized({
      name: "directory_member_get",
      path: "/cgi-bin/user/get",
      method: "GET",
      scope: "directory",
      maxResponseBytes: 256 * 1024,
    }, { query: { userid: requiredIdentifier(userid, "directory_member_get") } });
  }

  async directoryDepartment(id: number): Promise<JsonRecord> {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new EnterpriseWechatProviderError("terminal", "directory_department_get", -1, 0);
    }
    return this.authorized({
      name: "directory_department_get",
      path: "/cgi-bin/department/get",
      method: "GET",
      scope: "directory",
      maxResponseBytes: 256 * 1024,
    }, { query: { id } });
  }

  async directoryDepartments(id?: number): Promise<JsonRecord> {
    if (id !== undefined && (!Number.isSafeInteger(id) || id <= 0)) {
      throw new EnterpriseWechatProviderError("terminal", "directory_department_list", -1, 0);
    }
    return this.authorized({
      name: "directory_department_list",
      path: "/cgi-bin/department/list",
      method: "GET",
      scope: "directory",
      maxResponseBytes: 512 * 1024,
    }, { query: id === undefined ? undefined : { id } });
  }

  async externalContact(externalUserid: string, cursor?: string): Promise<JsonRecord> {
    const query: Record<string, string> = {
      external_userid: requiredIdentifier(externalUserid, "external_contact_get"),
    };
    const normalizedCursor = optionalCursor(cursor, "external_contact_get");
    if (normalizedCursor) query.cursor = normalizedCursor;
    return this.authorized({
      name: "external_contact_get",
      path: "/cgi-bin/externalcontact/get",
      method: "GET",
      scope: "external-contact",
      maxResponseBytes: 512 * 1024,
    }, { query });
  }

  async externalGroupChat(chatId: string): Promise<JsonRecord> {
    return this.authorized({
      name: "external_group_chat_get",
      path: "/cgi-bin/externalcontact/groupchat/get",
      method: "POST",
      scope: "external-contact",
      maxResponseBytes: MAX_RESPONSE_BYTES,
    }, { body: { chat_id: requiredIdentifier(chatId, "external_group_chat_get"), need_name: 0 } });
  }

  async corpTagList(tagIds: string[] = [], groupIds: string[] = []): Promise<JsonRecord> {
    if (tagIds.length > 100 || groupIds.length > 100) {
      throw new EnterpriseWechatProviderError("terminal", "external_corp_tag_list", -1, 0);
    }
    return this.authorized({
      name: "external_corp_tag_list",
      path: "/cgi-bin/externalcontact/get_corp_tag_list",
      method: "POST",
      scope: "external-contact",
      maxResponseBytes: 512 * 1024,
      notFoundCodes: tagIds.length > 0 || groupIds.length > 0 ? new Set([40_068]) : undefined,
    }, {
      body: {
        tag_id: tagIds.map((id) => requiredIdentifier(id, "external_corp_tag_list")),
        group_id: groupIds.map((id) => requiredIdentifier(id, "external_corp_tag_list")),
      },
    });
  }

  async strategyTagList(
    strategyId: number,
    tagIds: string[] = [],
    groupIds: string[] = [],
  ): Promise<JsonRecord> {
    if (
      !Number.isSafeInteger(strategyId)
      || strategyId <= 0
      || strategyId > 2_147_483_647
      || tagIds.length > 100
      || groupIds.length > 100
    ) {
      throw new EnterpriseWechatProviderError(
        "terminal",
        "external_strategy_tag_list",
        -1,
        0,
      );
    }
    return this.authorized({
      name: "external_strategy_tag_list",
      path: "/cgi-bin/externalcontact/get_strategy_tag_list",
      method: "POST",
      scope: "external-contact",
      maxResponseBytes: 512 * 1024,
      notFoundCodes: tagIds.length > 0 || groupIds.length > 0 ? new Set([40_068]) : undefined,
    }, {
      body: {
        strategy_id: strategyId,
        tag_id: tagIds.map((id) => requiredIdentifier(id, "external_strategy_tag_list")),
        group_id: groupIds.map((id) => requiredIdentifier(id, "external_strategy_tag_list")),
      },
    });
  }

  private secret(scope: EnterpriseWechatCredentialScope, operation: string): string {
    const value = scope === "company-jssdk"
      ? this.env.WECHAT_WORK_CORP_SECRET
      : scope === "agent"
        ? this.env.WECHAT_WORK_AGENT_SECRET
        : scope === "directory"
          ? this.env.WECHAT_WORK_DIRECTORY_SECRET
          : this.env.WECHAT_WORK_EXTERNAL_CONTACT_SECRET;
    const secret = value?.trim() ?? "";
    if (!validCredential(secret)) {
      throw new EnterpriseWechatProviderError("configuration", operation, -1, 0);
    }
    return secret;
  }

  private async fingerprint(
    scope: EnterpriseWechatCredentialScope,
    secret: string,
  ): Promise<string> {
    return sha256Hex(`${scope}\0${this.corpId}\0${this.agentId}\0${secret}`);
  }

  private async accessToken(
    scope: EnterpriseWechatCredentialScope,
    operation: string,
    forceRefresh = false,
    staleToken?: string,
  ): Promise<{ token: string; cacheKey: string }> {
    const secret = this.secret(scope, operation);
    const fingerprint = await this.fingerprint(scope, secret);
    const cacheKey = `work_provider:access:${scope}:${fingerprint}`;
    if (!forceRefresh) {
      const cached = await this.cacheGet(cacheKey, operation);
      if (cached) return { token: cached, cacheKey };
    }
    const existing = TOKEN_IN_FLIGHT.get(cacheKey);
    if (existing) {
      const outcome = await existing;
      if (!outcome.ok) {
        throw new EnterpriseWechatProviderError(
          outcome.failure.kind,
          outcome.failure.operation,
          outcome.failure.providerCode,
          outcome.failure.httpStatus,
          outcome.failure.retryAfterSeconds,
        );
      }
      return { token: outcome.token, cacheKey };
    }
    let resolvePending!: (outcome: TokenFlightOutcome) => void;
    const pending = new Promise<TokenFlightOutcome>((resolve) => {
      resolvePending = resolve;
    });
    TOKEN_IN_FLIGHT.set(cacheKey, pending);
    try {
      let token: string;
      if (forceRefresh) {
        const refreshed = await this.cacheGet(cacheKey, operation);
        if (refreshed && refreshed !== staleToken) {
          token = refreshed;
        } else {
          await this.cacheDelete(cacheKey, operation);
          token = await this.fetchAccessToken(scope, secret, cacheKey, operation);
        }
      } else {
        token = await this.fetchAccessToken(scope, secret, cacheKey, operation);
      }
      resolvePending({ ok: true, token });
      return { token, cacheKey };
    } catch (error) {
      const failure = error instanceof EnterpriseWechatProviderError
        ? error
        : new EnterpriseWechatProviderError("retryable", operation, -1, 0);
      resolvePending({
        ok: false,
        failure: {
          kind: failure.kind,
          operation: failure.operation,
          providerCode: failure.providerCode,
          httpStatus: failure.httpStatus,
          retryAfterSeconds: failure.retryAfterSeconds,
        },
      });
      throw failure;
    } finally {
      if (TOKEN_IN_FLIGHT.get(cacheKey) === pending) TOKEN_IN_FLIGHT.delete(cacheKey);
    }
  }

  private async fetchAccessToken(
    scope: EnterpriseWechatCredentialScope,
    secret: string,
    cacheKey: string,
    callerOperation: string,
  ): Promise<string> {
    const operation = `${scope}_access_token`;
    const url = new URL(ACCESS_TOKEN_PATH, PROVIDER_ORIGIN);
    url.searchParams.set("corpid", this.corpId);
    url.searchParams.set("corpsecret", secret);
    const { response, data } = await this.fetchJson(url, operation, {
      method: "GET",
      maxResponseBytes: 16 * 1024,
    });
    const credential = providerCredential(data, "access_token", operation, response);
    await this.cachePut(cacheKey, credential, callerOperation);
    return credential.value;
  }

  private async cachedTicket(
    operation: ProviderOperation,
    request: ProviderRequest = {},
  ): Promise<string> {
    const secret = this.secret(operation.scope, operation.name);
    const fingerprint = await this.fingerprint(operation.scope, secret);
    const key = `work_provider:ticket:${operation.scope}:${fingerprint}`;
    const cached = await this.cacheGet(key, operation.name);
    if (cached) return cached;
    const data = await this.authorized(operation, request);
    const code = providerCode(data);
    if (code !== 0) {
      throw new EnterpriseWechatProviderError("terminal", operation.name, code, 200);
    }
    const value = data.ticket;
    const expiresIn = Number(data.expires_in);
    if (!validCredential(value) || !Number.isSafeInteger(expiresIn) || expiresIn < 120 || expiresIn > 86_400) {
      throw new EnterpriseWechatProviderError(
        "retryable",
        operation.name,
        UNAVAILABLE_PROVIDER_CODE,
        200,
      );
    }
    await this.cachePut(key, { value, expiresIn }, operation.name);
    return value;
  }

  private async authorized(operation: ProviderOperation, request: ProviderRequest): Promise<JsonRecord> {
    const maxResponseBytes = operation.maxResponseBytes ?? DEFAULT_RESPONSE_BYTES;
    if (maxResponseBytes <= 0 || maxResponseBytes > MAX_RESPONSE_BYTES) {
      throw new EnterpriseWechatProviderError("configuration", operation.name, -1, 0);
    }
    let staleToken: string | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const credential = await this.accessToken(
        operation.scope,
        operation.name,
        attempt > 0,
        staleToken,
      );
      const url = new URL(operation.path, PROVIDER_ORIGIN);
      url.searchParams.set("access_token", credential.token);
      for (const [key, value] of Object.entries(request.query ?? {})) {
        url.searchParams.set(key, String(value));
      }
      const { response, data } = await this.fetchJson(url, operation.name, {
        method: operation.method,
        body: request.body,
        maxResponseBytes,
      });
      const code = providerCode(data);
      if (attempt === 0 && response.ok && INVALID_ACCESS_TOKEN_CODES.has(code)) {
        staleToken = credential.token;
        continue;
      }
      if (!response.ok || code !== 0) {
        throw responseFailure(operation.name, response, code, operation.notFoundCodes);
      }
      return data;
    }
    throw new EnterpriseWechatProviderError("configuration", operation.name, -1, 0);
  }

  private async fetchJson(
    url: URL,
    operation: string,
    input: { method: "GET" | "POST"; body?: JsonRecord; maxResponseBytes: number },
  ): Promise<{ response: Response; data: JsonRecord }> {
    let body: string | undefined;
    if (input.method === "POST") {
      try {
        body = JSON.stringify(input.body ?? {});
      } catch {
        throw new EnterpriseWechatProviderError("terminal", operation, -1, 0);
      }
      if (utf8Bytes(body) > MAX_REQUEST_BYTES) {
        throw new EnterpriseWechatProviderError("terminal", operation, -1, 0);
      }
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await this.fetcher(url, {
        method: input.method,
        redirect: "error",
        headers: input.method === "POST"
          ? { Accept: "application/json", "Content-Type": "application/json" }
          : { Accept: "application/json" },
        body,
        signal: controller.signal,
      });
      const data = await readBoundedJson(response, operation, input.maxResponseBytes);
      return { response, data };
    } catch (error) {
      if (error instanceof EnterpriseWechatProviderError) throw error;
      throw new EnterpriseWechatProviderError("retryable", operation, -1, 0);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async cacheGet(key: string, operation: string): Promise<string | null> {
    let cached: CachedCredential | null;
    try {
      cached = await this.env.CONFIG_KV.get<CachedCredential>(key, "json");
    } catch {
      throw new EnterpriseWechatProviderError("retryable", operation, -1, 0);
    }
    if (!cached || !validCredential(cached.value)) return null;
    const now = Math.floor(Date.now() / 1_000);
    return Number.isSafeInteger(cached.expiresAt) && cached.expiresAt > now + 10
      ? cached.value
      : null;
  }

  private async cachePut(
    key: string,
    credential: ProviderCredential,
    operation: string,
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1_000);
    const ttl = Math.max(60, Math.min(7_200, credential.expiresIn) - 300);
    const cached: CachedCredential = { value: credential.value, expiresAt: now + ttl };
    try {
      await this.env.CONFIG_KV.put(key, JSON.stringify(cached), { expirationTtl: ttl });
    } catch {
      throw new EnterpriseWechatProviderError("retryable", operation, -1, 0);
    }
  }

  private async cacheDelete(key: string, operation: string): Promise<void> {
    try {
      await this.env.CONFIG_KV.delete(key);
    } catch {
      throw new EnterpriseWechatProviderError("retryable", operation, -1, 0);
    }
  }
}
