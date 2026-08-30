import type { Env } from "@/env";
import type { Container } from "@/lib/di";
import { SystemConfigService } from "@/services/system/SystemConfigService";
import { ForbiddenException, ServiceUnavailableException, ValidateException } from "@/utils/errors";
import { generateNonceStr, jsSdkSignature } from "@/utils/wechat-crypto";

const ACCESS_TOKEN_URL = "https://qyapi.weixin.qq.com/cgi-bin/gettoken";
const COMPANY_TICKET_URL = "https://qyapi.weixin.qq.com/cgi-bin/get_jsapi_ticket";
const AGENT_TICKET_URL = "https://qyapi.weixin.qq.com/cgi-bin/ticket/get";
const FETCH_TIMEOUT_MS = 5_000;
const MAX_PROVIDER_JSON_BYTES = 16 * 1024;
const MAX_SIGNED_URL_BYTES = 2_048;
const MAX_PROVIDER_CREDENTIAL_BYTES = 512;
const MAX_ALLOWED_ORIGINS = 32;
const INVALID_ACCESS_TOKEN_CODES = new Set([40_001, 40_014, 42_001]);

export const ENTERPRISE_WECHAT_JS_API_LIST = [
  "getCurExternalContact",
  "getCurExternalChat",
  "getContext",
  "chooseImage",
  "sendChatMessage",
  "shareAppMessage",
] as const;

type JsonRecord = Record<string, unknown>;
type CredentialScope = "company" | "agent";
type TicketKind = "company" | "agent";

interface CachedCredential {
  value: string;
  expiresAt: number;
}

interface ProviderCredential {
  value: string;
  expiresIn: number;
}

class EnterpriseWechatProviderError extends Error {
  constructor(
    readonly operation: string,
    readonly providerCode: number,
    readonly httpStatus: number,
  ) {
    super("Enterprise WeChat provider request failed");
    this.name = "EnterpriseWechatProviderError";
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validProviderValue(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && !/\s/.test(value)
    && utf8Bytes(value) <= MAX_PROVIDER_CREDENTIAL_BYTES;
}

function normalizedAllowedOrigins(raw: string | undefined): Set<string> {
  const entries = String(raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0 || entries.length > MAX_ALLOWED_ORIGINS) {
    throw new ServiceUnavailableException("企业微信签名来源尚未配置");
  }
  const origins = new Set<string>();
  for (const entry of entries) {
    let parsed: URL;
    try {
      parsed = new URL(entry);
    } catch {
      throw new ServiceUnavailableException("企业微信签名来源配置无效");
    }
    if (
      parsed.protocol !== "https:"
      || parsed.username
      || parsed.password
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash
      || entry.replace(/\/$/, "") !== parsed.origin
    ) {
      throw new ServiceUnavailableException("企业微信签名来源配置无效");
    }
    origins.add(parsed.origin);
  }
  return origins;
}

/** Normalize the browser URL exactly once before both allowlist comparison and signing. */
export function normalizeEnterpriseWechatSignedUrl(
  rawUrl: string,
  allowedOrigins: string | undefined,
): string {
  const value = rawUrl.trim();
  if (!value || utf8Bytes(value) > MAX_SIGNED_URL_BYTES) {
    throw new ValidateException("企业微信签名 URL 无效");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ValidateException("企业微信签名 URL 无效");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new ForbiddenException("企业微信签名 URL 来源不受信任");
  }
  parsed.hash = "";
  if (!normalizedAllowedOrigins(allowedOrigins).has(parsed.origin)) {
    throw new ForbiddenException("企业微信签名 URL 来源不受信任");
  }
  const normalized = parsed.href;
  if (utf8Bytes(normalized) > MAX_SIGNED_URL_BYTES) {
    throw new ValidateException("企业微信签名 URL 无效");
  }
  return normalized;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function readBoundedJson(response: Response, operation: string): Promise<JsonRecord> {
  const header = response.headers.get("Content-Length");
  if (header !== null) {
    const declared = Number(header);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_PROVIDER_JSON_BYTES) {
      throw new EnterpriseWechatProviderError(operation, -1, response.status);
    }
  }
  const reader = response.body?.getReader();
  if (!reader) throw new EnterpriseWechatProviderError(operation, -1, response.status);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_PROVIDER_JSON_BYTES) {
        await reader.cancel();
        throw new EnterpriseWechatProviderError(operation, -1, response.status);
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new EnterpriseWechatProviderError(operation, -1, response.status);
  }
  if (!isRecord(parsed)) {
    throw new EnterpriseWechatProviderError(operation, -1, response.status);
  }
  return parsed;
}

function providerCredential(
  data: JsonRecord,
  field: "access_token" | "ticket",
  operation: string,
  httpStatus: number,
): ProviderCredential {
  const providerCode = Number(data.errcode ?? 0);
  const expiresIn = Number(data.expires_in);
  if (
    providerCode !== 0
    || !validProviderValue(data[field])
    || !Number.isSafeInteger(expiresIn)
    || expiresIn < 120
    || expiresIn > 86_400
  ) {
    throw new EnterpriseWechatProviderError(
      operation,
      Number.isSafeInteger(providerCode) ? providerCode : -1,
      httpStatus,
    );
  }
  return { value: data[field], expiresIn };
}

export class EnterpriseWechatJsSdkService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async companyConfig(rawUrl: string) {
    const url = normalizeEnterpriseWechatSignedUrl(rawUrl, this.env.WORK_WECHAT_ALLOWED_ORIGINS);
    return this.withProviderBoundary("company_config", async () => {
      const { corpId } = await this.nonSecretConfig(false);
      const secret = this.requiredSecret(this.env.WECHAT_WORK_CORP_SECRET, "company");
      const ticket = await this.ticket("company", corpId, secret);
      const timestamp = Math.floor(Date.now() / 1_000);
      const nonceStr = generateNonceStr();
      return {
        jsApiList: [...ENTERPRISE_WECHAT_JS_API_LIST],
        openTagList: [] as string[],
        debug: false,
        beta: true,
        appId: corpId,
        nonceStr,
        timestamp,
        url,
        signature: await jsSdkSignature(ticket, nonceStr, timestamp, url),
      };
    });
  }

  async agentConfig(rawUrl: string) {
    const url = normalizeEnterpriseWechatSignedUrl(rawUrl, this.env.WORK_WECHAT_ALLOWED_ORIGINS);
    return this.withProviderBoundary("agent_config", async () => {
      const { corpId, agentId } = await this.nonSecretConfig(true);
      const secret = this.requiredSecret(this.env.WECHAT_WORK_AGENT_SECRET, "agent");
      const ticket = await this.ticket("agent", corpId, secret, agentId);
      const timestamp = Math.floor(Date.now() / 1_000);
      const nonceStr = generateNonceStr();
      return {
        jsApiList: [...ENTERPRISE_WECHAT_JS_API_LIST],
        openTagList: [] as string[],
        debug: false,
        corpid: corpId,
        agentid: agentId,
        nonceStr,
        timestamp,
        url,
        signature: await jsSdkSignature(ticket, nonceStr, timestamp, url),
      };
    });
  }

  private async nonSecretConfig(requireAgentId: boolean): Promise<{
    corpId: string;
    agentId: number;
  }> {
    const values = await new SystemConfigService(this.container, this.env).getMany([
      "wechat_work_corpid",
      "wechat_work_build_agent_id",
    ]);
    const corpId = values.wechat_work_corpid?.trim() ?? "";
    const rawAgentId = values.wechat_work_build_agent_id?.trim() ?? "";
    const agentId = Number(rawAgentId);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(corpId)) {
      throw new ServiceUnavailableException("企业微信 CorpID 尚未配置");
    }
    if (
      requireAgentId
      && (!/^\d{1,10}$/.test(rawAgentId)
        || !Number.isSafeInteger(agentId)
        || agentId <= 0
        || agentId > 2_147_483_647)
    ) {
      throw new ServiceUnavailableException("企业微信 AgentID 尚未配置");
    }
    return { corpId, agentId: requireAgentId ? agentId : 0 };
  }

  private requiredSecret(value: string | undefined, scope: CredentialScope): string {
    const secret = value?.trim() ?? "";
    if (!validProviderValue(secret)) {
      throw new ServiceUnavailableException(
        scope === "company" ? "企业微信企业凭据尚未配置" : "企业微信应用凭据尚未配置",
      );
    }
    return secret;
  }

  private async ticket(
    kind: TicketKind,
    corpId: string,
    secret: string,
    agentId = 0,
  ): Promise<string> {
    const fingerprint = await sha256Hex(`${kind}\0${corpId}\0${agentId}\0${secret}`);
    const tokenKey = `work_jssdk:access:${kind}:${fingerprint}`;
    const ticketKey = `work_jssdk:ticket:${kind}:${fingerprint}`;
    const cached = await this.cacheGet(ticketKey);
    if (cached) return cached;

    for (let attempt = 0; attempt < 2; attempt++) {
      const accessToken = await this.accessToken(kind, corpId, secret, tokenKey, attempt > 0);
      try {
        const credential = await this.fetchTicket(kind, accessToken);
        await this.cachePut(ticketKey, credential);
        return credential.value;
      } catch (error) {
        if (
          attempt === 0
          && error instanceof EnterpriseWechatProviderError
          && INVALID_ACCESS_TOKEN_CODES.has(error.providerCode)
        ) {
          await Promise.all([
            this.env.CONFIG_KV.delete(tokenKey),
            this.env.CONFIG_KV.delete(ticketKey),
          ]);
          continue;
        }
        throw error;
      }
    }
    throw new EnterpriseWechatProviderError(`${kind}_ticket`, -1, 502);
  }

  private async accessToken(
    scope: CredentialScope,
    corpId: string,
    secret: string,
    cacheKey: string,
    forceRefresh: boolean,
  ): Promise<string> {
    if (!forceRefresh) {
      const cached = await this.cacheGet(cacheKey);
      if (cached) return cached;
    }
    const url = new URL(ACCESS_TOKEN_URL);
    url.searchParams.set("corpid", corpId);
    url.searchParams.set("corpsecret", secret);
    const { response, data } = await this.providerJson(url, `${scope}_access_token`);
    if (!response.ok) {
      throw new EnterpriseWechatProviderError(
        `${scope}_access_token`,
        Number.isSafeInteger(Number(data.errcode)) ? Number(data.errcode) : -1,
        response.status,
      );
    }
    const credential = providerCredential(
      data,
      "access_token",
      `${scope}_access_token`,
      response.status,
    );
    await this.cachePut(cacheKey, credential);
    return credential.value;
  }

  private async fetchTicket(kind: TicketKind, accessToken: string): Promise<ProviderCredential> {
    const url = new URL(kind === "company" ? COMPANY_TICKET_URL : AGENT_TICKET_URL);
    url.searchParams.set("access_token", accessToken);
    if (kind === "agent") url.searchParams.set("type", "agent_config");
    const operation = `${kind}_ticket`;
    const { response, data } = await this.providerJson(url, operation);
    if (!response.ok) {
      throw new EnterpriseWechatProviderError(
        operation,
        Number.isSafeInteger(Number(data.errcode)) ? Number(data.errcode) : -1,
        response.status,
      );
    }
    return providerCredential(data, "ticket", operation, response.status);
  }

  private async providerJson(
    url: URL,
    operation: string,
  ): Promise<{ response: Response; data: JsonRecord }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await this.fetcher(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      return { response, data: await readBoundedJson(response, operation) };
    } catch (error) {
      if (error instanceof EnterpriseWechatProviderError) throw error;
      throw new EnterpriseWechatProviderError(operation, -1, 0);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async cacheGet(key: string): Promise<string | null> {
    let cached: CachedCredential | null;
    try {
      cached = await this.env.CONFIG_KV.get<CachedCredential>(key, "json");
    } catch {
      throw new ServiceUnavailableException("企业微信凭据缓存暂时不可用");
    }
    if (!cached || !validProviderValue(cached.value)) return null;
    const now = Math.floor(Date.now() / 1_000);
    return Number.isSafeInteger(cached.expiresAt) && cached.expiresAt > now + 10
      ? cached.value
      : null;
  }

  private async cachePut(key: string, credential: ProviderCredential): Promise<void> {
    const now = Math.floor(Date.now() / 1_000);
    const ttl = Math.max(60, Math.min(7_200, credential.expiresIn) - 300);
    const cached: CachedCredential = { value: credential.value, expiresAt: now + ttl };
    try {
      await this.env.CONFIG_KV.put(key, JSON.stringify(cached), { expirationTtl: ttl });
    } catch {
      throw new ServiceUnavailableException("企业微信凭据缓存暂时不可用");
    }
  }

  private async withProviderBoundary<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      if (error instanceof EnterpriseWechatProviderError) {
        console.error(JSON.stringify({
          event: "enterprise_wechat_provider_failed",
          operation,
          providerOperation: error.operation,
          providerCode: error.providerCode,
          httpStatus: error.httpStatus,
        }));
        throw new ServiceUnavailableException("企业微信签名服务暂时不可用，请稍后重试");
      }
      console.error(JSON.stringify({
        event: "enterprise_wechat_jssdk_failed",
        operation,
        error: error instanceof Error ? error.name : "unknown",
      }));
      throw new ServiceUnavailableException("企业微信签名服务暂时不可用，请稍后重试");
    }
  }
}
