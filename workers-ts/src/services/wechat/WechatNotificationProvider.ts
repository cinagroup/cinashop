import type { Env } from "@/env";
import type { Container } from "@/lib/di";
import type {
  WechatShippingNotificationPayload,
  WechatTemplateNotificationPayload,
} from "@/models/schema";
import { readOfficialAccountCredentials, officialCredentialCacheKey, type OfficialAccountCredentials } from "./OfficialAccountRuntimeConfig";
import { cacheDelete, cacheGet, cacheSet } from "@/utils/cache";
import { ValidateException } from "@/utils/errors";
import { readRoutineCredentials, withRoutineCredentials, RoutineConfigurationError, type RoutineCredentials } from './RoutineRuntimeConfig';
import { getRoutineAccessToken, invalidateRoutineAccessToken } from './RoutineAccessTokenService';

const MAX_RESPONSE_BYTES = 64 * 1024;
const INVALID_TOKEN_CODES = new Set([40001, 40014, 42001]);
const RETRYABLE_CODES = new Set([-1, 45009, 45011]);

interface WechatResponse {
  errcode?: number;
  errmsg?: string;
  access_token?: string;
  expires_in?: number;
  msgid?: number | string;
  delivery_list?: Array<{ delivery_name?: string; delivery_id?: string }>;
}

export class WechatProviderConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WechatProviderConfigurationError";
  }
}

export class WechatProviderRejectedError extends Error {
  constructor(readonly code: number, readonly retryable: boolean) {
    super(`WeChat rejected request: ${code}`);
    this.name = "WechatProviderRejectedError";
  }
}

async function readBoundedJson(response: Response): Promise<WechatResponse> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error("WeChat response exceeded 64 KiB");
  }
  if (!response.body) throw new Error("WeChat returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("WeChat response exceeded 64 KiB");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as WechatResponse;
  } catch {
    throw new Error(`WeChat returned invalid JSON (${response.status})`);
  }
}

function assertWechatSuccess(response: Response, data: WechatResponse): void {
  const code = Number(data.errcode ?? 0);
  if (!response.ok || code !== 0) {
    throw new WechatProviderRejectedError(
      Number.isFinite(code) && code !== 0 ? code : response.status,
      RETRYABLE_CODES.has(code) || response.status === 429 || response.status >= 500,
    );
  }
}

export class WechatNotificationProvider {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async sendOfficial(
    openid: string,
    templateCode: string,
    payload: WechatTemplateNotificationPayload,
  ): Promise<{ providerReference: string; requestId: string; responseCode: string }> {
    const data = await this.postWithToken("cgi-bin/message/template/send", {
      touser: openid,
      template_id: templateCode,
      url: payload.url,
      data: Object.fromEntries(
        Object.entries(payload.data).map(([key, value]) => [key, { value }]),
      ),
    });
    return {
      providerReference: String(data.msgid ?? ""),
      requestId: "",
      responseCode: "0",
    };
  }

  async sendRoutine(
    openid: string,
    templateCode: string,
    payload: WechatTemplateNotificationPayload,
  ): Promise<{ providerReference: string; requestId: string; responseCode: string }> {
    if (payload.kind !== 'wechat_routine' || typeof payload.routineAppId !== 'string'
      || !payload.routineAppId || payload.routineAppId.length > 64 || /[\u0000-\u001f\u007f]/u.test(payload.routineAppId))
      throw new WechatProviderConfigurationError('小程序通知缺少原目标账号记录，请完成归属维护');
    const credentials = await this.routineCredentials();
    if (credentials.appId !== payload.routineAppId)
      throw new WechatProviderConfigurationError('小程序通知目标账号与当前配置不符，请完成归属维护');
    await this.postRoutineWithToken(credentials, "cgi-bin/message/subscribe/send", {
      touser: openid,
      template_id: templateCode,
      page: payload.url,
      data: Object.fromEntries(
        Object.entries(payload.data).map(([key, value]) => [key, { value }]),
      ),
    });
    return { providerReference: "", requestId: "", responseCode: "0" };
  }

  async uploadShipping(
    _openid: string,
    _payload: WechatShippingNotificationPayload,
  ): Promise<{ providerReference: string; requestId: string; responseCode: string }> {
    // The legacy payload has transactionId but no durable original Mini AppID,
    // merchant and payer witness. Current configuration cannot supply history.
    // Preserve the delivery as DEAD for audited maintenance; never submit it
    // under today's account or merchant. Original-payment recovery is pending.
    throw new WechatProviderConfigurationError('wechat_shipping_original_account_evidence_required');
  }

  private async routineCredentials(): Promise<RoutineCredentials> {
    try { return await readRoutineCredentials(this.container, this.env); }
    catch (error) {
      if (error instanceof RoutineConfigurationError)
        throw new WechatProviderConfigurationError(error.message);
      throw error;
    }
  }

  private async assertRoutineCurrent(credentials: RoutineCredentials): Promise<void> {
    try {
      await withRoutineCredentials(this.container, this.env, credentials.stamp, async (_bound, current) => {
        if (current.appId !== credentials.appId || current.secret !== credentials.secret)
          throw new ValidateException('小程序通知账户配置已变化');
      });
    } catch (error) {
      if (error instanceof RoutineConfigurationError || error instanceof ValidateException)
        throw new WechatProviderConfigurationError(error.message);
      throw error;
    }
  }

  private async postRoutineWithToken(credentials: RoutineCredentials, path: string,
    body: Record<string, unknown>): Promise<WechatResponse> {
    const accessToken = async (forceRefresh = false) => {
      try { return await getRoutineAccessToken(this.container, this.env, credentials, { fetcher: this.fetcher, forceRefresh }); }
      catch (error) {
        // Token GET is not a notification send. Map only deterministic source
        // and configuration failures; SQL/Redis/provider faults stay UNKNOWN.
        if (error instanceof RoutineConfigurationError || error instanceof ValidateException)
          throw new WechatProviderConfigurationError(error.message);
        throw error;
      }
    };
    let token = await accessToken();
    await this.assertRoutineCurrent(credentials);
    try { return await this.postRoutine(path, token, body); }
    catch (error) {
      // Only an explicit invalid-token rejection permits one retry. An unknown
      // outcome never takes this branch, even if configuration changed meanwhile.
      if (!(error instanceof WechatProviderRejectedError) || !INVALID_TOKEN_CODES.has(error.code)) throw error;
      await this.assertRoutineCurrent(credentials);
      await invalidateRoutineAccessToken(this.env, credentials);
      token = await accessToken(true);
      await this.assertRoutineCurrent(credentials);
      return this.postRoutine(path, token, body);
    }
  }

  /** Hard deadline covers fetch and streamed body, including ignore-abort
   * transports. A parsed errcode=0 is the send result: no post-send source check
   * may turn that known success into a retry after a credential rotation. */
  private async postRoutine(path: string, token: string, body: Record<string, unknown>): Promise<WechatResponse> {
    const url = new URL(`https://api.weixin.qq.com/${path}`); url.searchParams.set('access_token', token);
    const controller = new AbortController();
    let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
    const unknown = () => new Error('WeChat notification outcome unknown');
    const cancel = () => {
      try { void (reader ? reader.cancel() : response?.body?.cancel())?.catch(() => undefined); }
      catch { /* Cleanup cannot replace the outcome or expose a token URL. */ }
    };
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { stopped = true; controller.abort(); cancel(); reject(unknown()); }, 8_000);
    });
    const receive = async () => {
      response = await this.fetcher(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: controller.signal, redirect: 'error' });
      if (stopped) { cancel(); throw unknown(); }
      const declared = response.headers.get('content-length');
      if (response.redirected || !response.body || declared !== null &&
        (!/^\d+$/u.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > MAX_RESPONSE_BYTES)) throw unknown();
      reader = response.body.getReader();
      let complete = false, size = 0; const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const next = await reader.read(); if (stopped) throw unknown();
          if (next.done) { complete = true; break; }
          size += next.value.byteLength; if (size > MAX_RESPONSE_BYTES) throw unknown();
          chunks.push(next.value);
        }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw unknown();
        const code = (data as Record<string, unknown>).errcode;
        if (typeof code !== 'number' || !Number.isSafeInteger(code)) throw unknown();
        if (code !== 0) throw new WechatProviderRejectedError(code,
          RETRYABLE_CODES.has(code) || response.status === 429 || response.status >= 500);
        if (!response.ok) throw unknown();
        return data as WechatResponse;
      } finally {
        if (!complete) cancel();
        try { reader.releaseLock(); } catch { /* A pending read still owns it. */ }
      }
    };
    try { return await Promise.race([receive(), deadline]); }
    catch (error) {
      stopped = true; controller.abort(); cancel();
      if (error instanceof WechatProviderRejectedError) throw error;
      throw unknown();
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }

  private async postWithToken(
    path: string,
    body: Record<string, unknown>,
  ): Promise<WechatResponse> {
    const official = await this.officialCredentials();
    let token = await this.accessToken(false, official);
    try {
      return await this.post(path, token, body);
    } catch (error) {
      if (!(error instanceof WechatProviderRejectedError) || !INVALID_TOKEN_CODES.has(error.code)) {
        throw error;
      }
      if ((await this.officialCredentials()).stamp !== official.stamp) {
        throw new WechatProviderConfigurationError('公众号账户配置已变化，请稍后重试');
      }
      await cacheDelete(officialCredentialCacheKey(official, 'access-token'), this.env);
      token = await this.accessToken(true, official);
      return this.post(path, token, body);
    }
  }

  private async post(
    path: string,
    token: string,
    body: Record<string, unknown>,
  ): Promise<WechatResponse> {
    const url = new URL(`https://api.weixin.qq.com/${path}`);
    url.searchParams.set("access_token", token);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await this.fetcher(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await readBoundedJson(response);
      assertWechatSuccess(response, data);
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async accessToken(force = false, snapshot?: OfficialAccountCredentials): Promise<string> {
    const credentials = snapshot ?? await this.officialCredentials();
    const cacheKey = officialCredentialCacheKey(credentials, 'access-token');
    if (!force) {
      const cached = await cacheGet<string>(cacheKey, this.env);
      if (cached) return cached;
    }
    const url = new URL("https://api.weixin.qq.com/cgi-bin/token");
    url.search = new URLSearchParams({
      grant_type: "client_credential",
      appid: credentials.appId,
      secret: credentials.secret,
    }).toString();
    const response = await this.fetcher(url, { method: "GET" });
    const data = await readBoundedJson(response);
    if (!response.ok || !data.access_token) {
      const code = Number(data.errcode ?? response.status);
      throw new WechatProviderRejectedError(code, RETRYABLE_CODES.has(code) || response.status >= 500);
    }
    await cacheSet(
      cacheKey,
      data.access_token,
      this.env,
      Math.max(60, Number(data.expires_in ?? 7_200) - 200),
    );
    return data.access_token;
  }

  private async officialCredentials(): Promise<OfficialAccountCredentials> {
    try {
      return await readOfficialAccountCredentials(this.container, this.env);
    } catch (error) {
      // This validation occurs before HTTP (or after an explicit invalid-token
      // rejection). Missing/oversized configuration is a known failure; SQL
      // and transport faults retain the delivery ledger's conservative handling.
      if (error instanceof ValidateException) {
        throw new WechatProviderConfigurationError(error.message);
      }
      throw error;
    }
  }

}
