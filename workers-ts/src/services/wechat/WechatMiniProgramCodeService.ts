import { and, eq } from "drizzle-orm";
import type { Env } from "@/env";
import type { Container } from "@/lib/di";
import { user } from "@/models/schema";
import { SystemConfigService } from "@/services/system/SystemConfigService";
import { cacheDelete, cacheGet, cacheSet } from "@/utils/cache";
import { ValidateException } from "@/utils/errors";

const INVITE_SIGNATURE_TTL_SECONDS = 10 * 60;
const CODE_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_CODE_BYTES = 1024 * 1024;
const INVALID_TOKEN_CODES = new Set([40001, 40014, 42001]);

interface CachedMiniProgramCode {
  contentType: string;
  base64: string;
}

interface WechatTokenResponse {
  access_token?: string;
  expires_in?: number;
  errcode?: number;
  errmsg?: string;
}

interface WechatErrorResponse {
  errcode?: number;
  errmsg?: string;
}

export class WechatMiniProgramApiError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "WechatMiniProgramApiError";
  }
}

function signatureMessage(uid: number, expires: number): string {
  return `division-agent:${uid}:${expires}`;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

async function importSignatureKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new ValidateException("APP_KEY 未配置");
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function createAgentInviteSignature(
  uid: number,
  expires: number,
  secret: string,
): Promise<string> {
  const key = await importSignatureKey(secret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signatureMessage(uid, expires)),
  );
  return encodeBase64Url(new Uint8Array(signature));
}

export async function verifyAgentInviteSignature(
  uid: number,
  expires: number,
  signature: string,
  secret: string,
  now = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(expires)) return false;
  if (expires < now || expires > now + INVITE_SIGNATURE_TTL_SECONDS) return false;
  const bytes = decodeBase64Url(signature);
  if (!bytes || bytes.byteLength !== 32) return false;
  const key = await importSignatureKey(secret);
  return crypto.subtle.verify(
    "HMAC",
    key,
    bytes,
    new TextEncoder().encode(signatureMessage(uid, expires)),
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

export class WechatMiniProgramCodeService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async createAgentInviteUrl(
    uid: number,
    requestUrl: string,
  ): Promise<{ url: string; expires: number }> {
    await this.assertActiveAgent(uid);
    const expires = Math.floor(Date.now() / 1000) + INVITE_SIGNATURE_TTL_SECONDS;
    const signature = await createAgentInviteSignature(uid, expires, this.env.APP_KEY);
    const url = new URL(requestUrl);
    const marker = "/division/agent/spread/code";
    const markerIndex = url.pathname.lastIndexOf(marker);
    const prefix = markerIndex >= 0 ? url.pathname.slice(0, markerIndex) : "/api";
    url.pathname = `${prefix}${marker}/image/${uid}`;
    url.search = new URLSearchParams({ expires: String(expires), signature }).toString();
    url.hash = "";
    return { url: url.toString(), expires };
  }

  /** Build the fixed membership-activation mini-program code for Admin. */
  async createMembershipActivationDataUrl(): Promise<string | null> {
    const config = new SystemConfigService(this.container, this.env);
    const values = await config.getMany(["routine_appId", "routine_appsecret"]);
    const appId = values.routine_appId?.trim() ?? "";
    const appSecret = values.routine_appsecret?.trim() ?? "";
    if (!appId || !appSecret) return null;

    const cacheKey = `routine_code:membership_activation:${appId}`;
    const cached = await cacheGet<CachedMiniProgramCode>(cacheKey, this.env);
    if (cached?.base64 && cached.contentType) {
      return `data:${cached.contentType};base64,${cached.base64}`;
    }

    let accessToken = await this.getAccessToken(appId, appSecret);
    let code: { bytes: Uint8Array; contentType: string };
    try {
      code = await this.fetchMembershipActivationCode(accessToken);
    } catch (error) {
      if (!(error instanceof WechatMiniProgramApiError) || !INVALID_TOKEN_CODES.has(error.code)) throw error;
      await cacheDelete(`routine_access_token:${appId}`, this.env);
      accessToken = await this.getAccessToken(appId, appSecret, true);
      code = await this.fetchMembershipActivationCode(accessToken);
    }
    const base64 = bytesToBase64(code.bytes);
    await cacheSet(
      cacheKey,
      { contentType: code.contentType, base64 } satisfies CachedMiniProgramCode,
      this.env,
      CODE_CACHE_TTL_SECONDS,
    );
    return `data:${code.contentType};base64,${base64}`;
  }

  /** Build the authenticated user's distributor mini-program code. */
  async createUserSpreadDataUrl(uid: number): Promise<string | null> {
    if (!Number.isSafeInteger(uid) || uid <= 0) throw new ValidateException("用户ID错误");
    const config = new SystemConfigService(this.container, this.env);
    const values = await config.getMany(["routine_appId", "routine_appsecret"]);
    const appId = values.routine_appId?.trim() ?? "";
    const appSecret = values.routine_appsecret?.trim() ?? "";
    if (!appId || !appSecret) return null;

    const cacheKey = `routine_code:user_spread:${appId}:${uid}`;
    const cached = await cacheGet<CachedMiniProgramCode>(cacheKey, this.env);
    if (cached?.base64 && cached.contentType) {
      return `data:${cached.contentType};base64,${cached.base64}`;
    }

    let accessToken = await this.getAccessToken(appId, appSecret);
    let code: { bytes: Uint8Array; contentType: string };
    try {
      code = await this.fetchInviteCode(accessToken, uid);
    } catch (error) {
      if (!(error instanceof WechatMiniProgramApiError) || !INVALID_TOKEN_CODES.has(error.code)) throw error;
      await cacheDelete(`routine_access_token:${appId}`, this.env);
      accessToken = await this.getAccessToken(appId, appSecret, true);
      code = await this.fetchInviteCode(accessToken, uid);
    }
    const encoded = { contentType: code.contentType, base64: bytesToBase64(code.bytes) };
    await cacheSet(cacheKey, encoded, this.env, CODE_CACHE_TTL_SECONDS);
    return `data:${encoded.contentType};base64,${encoded.base64}`;
  }

  async renderAgentInviteCode(
    uid: number,
    expires: number,
    signature: string,
  ): Promise<Response> {
    const valid = await verifyAgentInviteSignature(uid, expires, signature, this.env.APP_KEY);
    if (!valid) throw new ValidateException("员工邀请码已失效，请重新生成");
    await this.assertActiveAgent(uid);

    const config = new SystemConfigService(this.container, this.env);
    const values = await config.getMany(["routine_appId", "routine_appsecret"]);
    const appId = values.routine_appId?.trim() ?? "";
    const appSecret = values.routine_appsecret?.trim() ?? "";
    if (!appId || !appSecret) throw new ValidateException("小程序 AppID 或 AppSecret 未配置");

    const cacheKey = `routine_code:division_agent:${appId}:${uid}`;
    const cached = await cacheGet<CachedMiniProgramCode>(cacheKey, this.env);
    if (cached?.base64 && cached.contentType) {
      return this.imageResponse(base64ToBytes(cached.base64), cached.contentType);
    }

    let accessToken = await this.getAccessToken(appId, appSecret);
    let code: { bytes: Uint8Array; contentType: string };
    try {
      code = await this.fetchInviteCode(accessToken, uid);
    } catch (error) {
      if (!(error instanceof WechatMiniProgramApiError) || !INVALID_TOKEN_CODES.has(error.code)) throw error;
      await cacheDelete(`routine_access_token:${appId}`, this.env);
      accessToken = await this.getAccessToken(appId, appSecret, true);
      code = await this.fetchInviteCode(accessToken, uid);
    }

    await cacheSet(
      cacheKey,
      { contentType: code.contentType, base64: bytesToBase64(code.bytes) } satisfies CachedMiniProgramCode,
      this.env,
      CODE_CACHE_TTL_SECONDS,
    );
    return this.imageResponse(code.bytes, code.contentType);
  }

  private async assertActiveAgent(uid: number): Promise<void> {
    if (!Number.isSafeInteger(uid) || uid <= 0) throw new ValidateException("代理商不存在");
    const rows = await this.container.db
      .select({
        uid: user.uid,
        divisionType: user.divisionType,
        divisionStatus: user.divisionStatus,
        divisionEndTime: user.divisionEndTime,
      })
      .from(user)
      .where(and(eq(user.uid, uid), eq(user.status, 1), eq(user.isDel, 0)))
      .limit(1);
    const agent = rows[0];
    const now = Math.floor(Date.now() / 1000);
    if (!agent || agent.divisionType !== 2 || !agent.divisionStatus) {
      throw new ValidateException("代理商不存在或已停用");
    }
    if (agent.divisionEndTime > 0 && agent.divisionEndTime < now) {
      throw new ValidateException("代理商已到期");
    }
  }

  private async getAccessToken(appId: string, appSecret: string, forceRefresh = false): Promise<string> {
    const cacheKey = `routine_access_token:${appId}`;
    if (!forceRefresh) {
      const cached = await cacheGet<string>(cacheKey, this.env);
      if (cached) return cached;
    }
    const url = new URL("https://api.weixin.qq.com/cgi-bin/token");
    url.search = new URLSearchParams({
      grant_type: "client_credential",
      appid: appId,
      secret: appSecret,
    }).toString();
    const response = await this.fetcher(url, { method: "GET" });
    const data = (await response.json()) as WechatTokenResponse;
    if (!response.ok || !data.access_token) {
      throw new WechatMiniProgramApiError(
        Number(data.errcode ?? response.status),
        `获取小程序 access_token 失败: ${data.errmsg ?? response.statusText}`,
      );
    }
    const ttl = Math.max(60, Number(data.expires_in ?? 7200) - 200);
    await cacheSet(cacheKey, data.access_token, this.env, ttl);
    return data.access_token;
  }

  private async fetchInviteCode(
    accessToken: string,
    uid: number,
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    const url = new URL("https://api.weixin.qq.com/wxa/getwxacodeunlimit");
    url.searchParams.set("access_token", accessToken);
    const response = await this.fetcher(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scene: String(uid),
        page: "pages/users/user_spread_user/index",
        check_path: true,
        env_version: "release",
        width: 430,
      }),
    });
    const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (contentType === "application/json" || contentType === "text/plain") {
      const data = (await response.json()) as WechatErrorResponse;
      throw new WechatMiniProgramApiError(
        Number(data.errcode ?? response.status),
        `生成小程序员工邀请码失败: ${data.errmsg ?? response.statusText}`,
      );
    }
    const contentLength = Number(response.headers.get("Content-Length") ?? 0);
    if (!response.ok || (contentLength > 0 && contentLength > MAX_CODE_BYTES)) {
      throw new ValidateException("微信返回的小程序码无效或过大");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.byteLength || bytes.byteLength > MAX_CODE_BYTES) {
      throw new ValidateException("微信返回的小程序码无效或过大");
    }
    return {
      bytes,
      contentType: contentType.startsWith("image/") ? contentType : "image/png",
    };
  }

  private async fetchMembershipActivationCode(
    accessToken: string,
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    const url = new URL("https://api.weixin.qq.com/wxa/getwxacode");
    url.searchParams.set("access_token", accessToken);
    const response = await this.fetcher(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "pages/annex/vip_active/index",
        check_path: true,
        env_version: "release",
        width: 430,
      }),
    });
    const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (contentType === "application/json" || contentType === "text/plain") {
      const data = (await response.json()) as WechatErrorResponse;
      throw new WechatMiniProgramApiError(
        Number(data.errcode ?? response.status),
        `生成小程序会员激活码失败: ${data.errmsg ?? response.statusText}`,
      );
    }
    const contentLength = Number(response.headers.get("Content-Length") ?? 0);
    if (!response.ok || (contentLength > 0 && contentLength > MAX_CODE_BYTES)) {
      throw new ValidateException("微信返回的小程序会员激活码无效或过大");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.byteLength || bytes.byteLength > MAX_CODE_BYTES) {
      throw new ValidateException("微信返回的小程序会员激活码无效或过大");
    }
    return {
      bytes,
      contentType: contentType.startsWith("image/") ? contentType : "image/png",
    };
  }

  private imageResponse(bytes: Uint8Array, contentType: string): Response {
    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
}
