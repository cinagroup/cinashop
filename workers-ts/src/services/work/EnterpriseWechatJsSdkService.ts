import type { Env } from "@/env";
import type { Container } from "@/lib/di";
import { SystemConfigService } from "@/services/system/SystemConfigService";
import {
  EnterpriseWechatProviderClient,
  EnterpriseWechatProviderError,
  isEnterpriseWechatCorpId,
} from "@/services/work/EnterpriseWechatProviderClient";
import { ForbiddenException, ServiceUnavailableException, ValidateException } from "@/utils/errors";
import { generateNonceStr, jsSdkSignature } from "@/utils/wechat-crypto";
import { emitOperationalEvent, operationalErrorCode } from "@/utils/observability";

const MAX_SIGNED_URL_BYTES = 2_048;
const MAX_PROVIDER_CREDENTIAL_BYTES = 512;
const MAX_ALLOWED_ORIGINS = 32;

export const ENTERPRISE_WECHAT_JS_API_LIST = [
  "getCurExternalContact",
  "getCurExternalChat",
  "getContext",
  "chooseImage",
  "sendChatMessage",
  "shareAppMessage",
] as const;

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
      this.requiredSecret(this.env.WECHAT_WORK_CORP_SECRET, "company");
      const ticket = await this.provider(corpId).companyJsApiTicket();
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
      this.requiredSecret(this.env.WECHAT_WORK_AGENT_SECRET, "agent");
      const ticket = await this.provider(corpId, agentId).agentJsApiTicket();
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

  /** Exchange a one-time code only for an employee in the configured enterprise. */
  async employeeIdentity(rawCode: string): Promise<{
    corpId: string;
    agentId: number;
    userid: string;
  }> {
    const code = rawCode.trim();
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(code)) {
      throw new ValidateException("企业微信 OAuth code 无效");
    }
    return this.withProviderBoundary("employee_identity", async () => {
      const { corpId, agentId } = await this.nonSecretConfig(true);
      this.requiredSecret(this.env.WECHAT_WORK_AGENT_SECRET, "agent");
      const data = await this.provider(corpId, agentId).employeeIdentity(code);
      const userid = String(data.userid ?? data.UserId ?? "").trim();
      const returnedCorpId = String(data.CorpId ?? data.corpid ?? "").trim();
      if (!/^[A-Za-z0-9_@.-]{1,128}$/.test(userid)) {
        throw new ForbiddenException("仅企业内部员工可以访问客户工作台");
      }
      if (returnedCorpId && returnedCorpId !== corpId) {
        throw new ForbiddenException("企业微信身份不属于当前企业");
      }
      return { corpId, agentId, userid };
    });
  }

  private provider(corpId: string, agentId = 0): EnterpriseWechatProviderClient {
    return new EnterpriseWechatProviderClient(this.env, { corpId, agentId }, this.fetcher);
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
    if (!isEnterpriseWechatCorpId(corpId)) {
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

  private requiredSecret(value: string | undefined, scope: "company" | "agent"): void {
    const secret = value?.trim() ?? "";
    if (!validProviderValue(secret)) {
      throw new ServiceUnavailableException(
        scope === "company" ? "企业微信企业凭据尚未配置" : "企业微信应用凭据尚未配置",
      );
    }
  }

  private async withProviderBoundary<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    const unavailableMessage = operation.endsWith("_config")
      ? "企业微信签名服务暂时不可用，请稍后重试"
      : "企业微信服务暂时不可用，请稍后重试";
    try {
      return await fn();
    } catch (error) {
      if (
        error instanceof ServiceUnavailableException
        || error instanceof ForbiddenException
        || error instanceof ValidateException
      ) throw error;
      if (error instanceof EnterpriseWechatProviderError) {
        emitOperationalEvent("error", {
          event: "enterprise_wechat_provider_failed",
          component: "http",
          operation,
          outcome: "failure",
          statusCode: error.httpStatus,
          retryDelaySeconds: error.retryAfterSeconds ?? 0,
          errorCode: operationalErrorCode(error),
        });
        throw new ServiceUnavailableException(unavailableMessage);
      }
      emitOperationalEvent("error", {
        event: "enterprise_wechat_jssdk_failed",
        component: "http",
        operation,
        outcome: "failure",
        errorCode: operationalErrorCode(error),
      });
      throw new ServiceUnavailableException(unavailableMessage);
    }
  }
}
