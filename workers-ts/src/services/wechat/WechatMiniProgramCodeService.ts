import { and, eq } from "drizzle-orm";
import type { Env } from "@/env";
import type { Container } from "@/lib/di";
import { user } from "@/models/schema";
import { cacheGet, cacheSet } from "@/utils/cache";
import { ServiceUnavailableException, ValidateException } from "@/utils/errors";
import { OFFLINE_MINI_PAGE, offlineMiniScanImage } from '@/services/order/OfflineScanCode';
import { DIVISION_STAFF_INVITE_PAGE, readDivisionStaffWechatCredentials } from '@/services/division/DivisionStaffInvitePolicy';
import { legacyShareDataImage } from '@/services/other/LegacyShareCodeProtocol';
import { readLegacyShareProvider } from '@/services/other/LegacyShareProviderRead';
import { readRoutineCredentials, readRoutineCredentialsIfConfigured, withRoutineCredentials, type RoutineCredentials } from './RoutineRuntimeConfig';
import { getRoutineAccessToken, invalidateRoutineAccessToken } from './RoutineAccessTokenService';

const INVITE_SIGNATURE_TTL_SECONDS = 10 * 60;
const CODE_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_CODE_BYTES = 1024 * 1024;
const INVALID_TOKEN_CODES = new Set([40001, 40014, 42001]);

interface CachedMiniProgramCode {
  version: 2;
  stamp: string;
  contentType: string;
  base64: string;
}

interface WechatErrorResponse {
  errcode?: number;
  errmsg?: string;
}

export type LegacyActivityCodeType = 1 | 2 | 3 | 31;

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

  async createDivisionStaffInviteDataUrl(qrcodeId: number, expectedAppId: string): Promise<string> {
    if (!Number.isSafeInteger(qrcodeId) || qrcodeId <= 0 || qrcodeId > 2147483647) throw new ValidateException('员工二维码ID错误');
    const credentials = await readRoutineCredentials(this.container, this.env);
    // Preserve the employee-specific admission rules as well as the common
    // complete source stamp. Both reads must describe this exact operation.
    const employee = await readDivisionStaffWechatCredentials(this.container.db, this.env);
    if (credentials.stamp !== employee.stamp || credentials.appId !== expectedAppId)
      throw new ServiceUnavailableException('员工邀请小程序账户已变化，请重新读取');
    try {
      return await this.codeDataUrl(credentials, null,
        token => this.fetchUnlimitedCode(token, `a=${qrcodeId}`, DIVISION_STAFF_INVITE_PAGE, '员工邀请'));
    } catch {
      throw new ServiceUnavailableException('员工邀请码暂时无法生成，请稍后重试');
    }
  }

  async createAgentInviteUrl(uid: number, requestUrl: string): Promise<{ url: string; expires: number }> {
    await this.assertActiveAgent(uid);
    const expires = Math.floor(Date.now() / 1000) + INVITE_SIGNATURE_TTL_SECONDS;
    const signature = await createAgentInviteSignature(uid, expires, this.env.APP_KEY);
    const url = new URL(requestUrl), marker = '/division/agent/spread/code';
    const markerIndex = url.pathname.lastIndexOf(marker), prefix = markerIndex >= 0 ? url.pathname.slice(0, markerIndex) : '/api';
    url.pathname = `${prefix}${marker}/image/${uid}`;
    url.search = new URLSearchParams({ expires: String(expires), signature }).toString(); url.hash = '';
    return { url: url.toString(), expires };
  }

  async createMembershipActivationDataUrl(): Promise<string | null> {
    return this.createFixedPathDataUrl('membership_activation', 'pages/annex/vip_active/index', '会员激活');
  }

  /** Navigation only: no customer, amount, order or payment capability. */
  async createOfflineCashierDataUrl(): Promise<string | null> {
    return this.createFixedPathDataUrl('offline_cashier_v1', OFFLINE_MINI_PAGE, '线下收银', image => { offlineMiniScanImage(image, 0); });
  }

  async createPaidMembershipDataUrl(): Promise<string | null> {
    return this.createFixedPathDataUrl('paid_membership', 'pages/annex/vip_paid/index', '付费会员');
  }

  async createProductDetailDataUrl(productId: number): Promise<string | null> {
    if (!Number.isSafeInteger(productId) || productId <= 0) throw new ValidateException('商品ID错误');
    const credentials = await readRoutineCredentialsIfConfigured(this.container, this.env);
    if (!credentials) return null;
    return this.codeDataUrl(credentials, `product_detail:${productId}`,
      token => this.fetchUnlimitedCode(token, `id=${productId}&spid=0`, 'pages/goods_details/index', '商品详情'));
  }

  /** Historical share documents already own an exact public AppID. A new
   * provider request may not silently create their image for a different app. */
  async createLegacyShareLandingDataUrl(token: string, expectedAppId: string): Promise<string | null> {
    if (!/^[a-f0-9]{24}$/.test(token)) throw new ValidateException('分享小程序场景错误');
    const credentials = await readRoutineCredentialsIfConfigured(this.container, this.env);
    if (!expectedAppId) return null;
    if (!credentials) throw new ServiceUnavailableException('分享小程序凭据暂不可用，请稍后重试');
    if (credentials.appId !== expectedAppId) throw new ValidateException('分享小程序账户配置已变化，请稍后重试');
    return this.codeDataUrl(credentials, null,
      accessToken => this.fetchUnlimitedCode(accessToken, `q=${token}`, 'pages/share/landing', '分享落地'));
  }

  async createOrdinaryProductDataUrl(productId: number, uid: number): Promise<string | null> {
    if (!Number.isSafeInteger(productId) || productId <= 0 || productId > 2147483647 || !Number.isSafeInteger(uid) || uid <= 0 || uid > 2147483647)
      throw new ValidateException('商品分享参数错误');
    const scene = `id=${productId}&spid=${uid}`;
    if (new TextEncoder().encode(scene).byteLength > 32) throw new ValidateException('商品分享场景过长');
    const credentials = await readRoutineCredentialsIfConfigured(this.container, this.env);
    if (!credentials) return null;
    return this.codeDataUrl(credentials, null, token => this.fetchUnlimitedCode(token, scene, 'pages/goods/detail', '商品详情'));
  }

  async createActivityDataUrl(type: LegacyActivityCodeType, id: number, uid: number): Promise<string | null> {
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(uid) || uid < 0) throw new ValidateException('活动码参数错误');
    const descriptor = type === 1 ? { page: 'pages/activity/goods_details/index', scene: `id=${id}&spid=${uid}&type=1`, label: '秒杀' }
      : type === 3 ? { page: 'pages/activity/goods_details/index', scene: `id=${id}&spid=${uid}&type=3`, label: '拼团' }
        : type === 2 ? { page: 'pages/activity/goods_bargain_details/index', scene: `id=${id}&spid=${uid}`, label: '砍价' }
          : { page: 'pages/activity/goods_combination_status/index', scene: `id=${id}&spid=${uid}`, label: '拼团状态' };
    if (new TextEncoder().encode(descriptor.scene).byteLength > 32) throw new ValidateException('活动码场景参数过长');
    const credentials = await readRoutineCredentialsIfConfigured(this.container, this.env);
    if (!credentials) return null;
    return this.codeDataUrl(credentials, `activity:${type}:${id}:${uid}`,
      token => this.fetchUnlimitedCode(token, descriptor.scene, descriptor.page, descriptor.label));
  }

  async createUserSpreadDataUrl(uid: number): Promise<string | null> {
    if (!Number.isSafeInteger(uid) || uid <= 0) throw new ValidateException('用户ID错误');
    const credentials = await readRoutineCredentialsIfConfigured(this.container, this.env);
    if (!credentials) return null;
    return this.codeDataUrl(credentials, `user_spread:${uid}`, token => this.fetchInviteCode(token, uid));
  }

  async renderAgentInviteCode(uid: number, expires: number, signature: string): Promise<Response> {
    if (!await verifyAgentInviteSignature(uid, expires, signature, this.env.APP_KEY)) throw new ValidateException('员工邀请码已失效，请重新生成');
    await this.assertActiveAgent(uid);
    const credentials = await readRoutineCredentials(this.container, this.env);
    const image = await this.codeDataUrl(credentials, `division_agent:${uid}`, token => this.fetchInviteCode(token, uid));
    await this.assertActiveAgent(uid);
    await this.assertSource(credentials);
    const data = legacyShareDataImage(image);
    return this.imageResponse(base64ToBytes(data.base64), data.mime);
  }

  private async assertActiveAgent(uid: number): Promise<void> {
    if (!Number.isSafeInteger(uid) || uid <= 0) throw new ValidateException('代理商不存在');
    const [agent] = await this.container.db.select({ uid: user.uid, divisionType: user.divisionType,
      divisionStatus: user.divisionStatus, divisionEndTime: user.divisionEndTime }).from(user)
      .where(and(eq(user.uid, uid), eq(user.status, 1), eq(user.isDel, 0))).limit(1);
    if (!agent || agent.divisionType !== 2 || !agent.divisionStatus) throw new ValidateException('代理商不存在或已停用');
    if (agent.divisionEndTime > 0 && agent.divisionEndTime < Math.floor(Date.now() / 1000)) throw new ValidateException('代理商已到期');
  }

  private assertSource(credentials: RoutineCredentials): Promise<void> {
    return withRoutineCredentials(this.container, this.env, credentials.stamp, async () => undefined);
  }

  private async createFixedPathDataUrl(suffix: string, path: string, label: string, validate?: (image: string) => void): Promise<string | null> {
    const credentials = await readRoutineCredentialsIfConfigured(this.container, this.env);
    if (!credentials) return null;
    return this.codeDataUrl(credentials, suffix, token => this.fetchPathCode(token, path, label), validate);
  }

  /** All provider/cache work finishes outside the short source transactions.
   * Late cache writes stay in the old stamp key; no shared key is bare-deleted. */
  private async codeDataUrl(credentials: RoutineCredentials, suffix: string | null,
    load: (token: string) => Promise<{ bytes: Uint8Array; contentType: string }>, validate?: (image: string) => void): Promise<string> {
    const key = suffix === null ? null : `routine_code:v2:${credentials.stamp}:${suffix}`;
    if (key) {
      const cached = await cacheGet<CachedMiniProgramCode>(key, this.env);
      await this.assertSource(credentials);
      if (cached?.version === 2 && cached.stamp === credentials.stamp) {
        try {
          const image = `data:${cached.contentType};base64,${cached.base64}`;
          legacyShareDataImage(image); validate?.(image);
          return image;
        } catch { /* Invalid cached data is a miss, never adopted or restamped. */ }
      }
    }
    const code = await this.fetchWithTokenRefresh(credentials, load);
    const record: CachedMiniProgramCode = { version: 2, stamp: credentials.stamp, contentType: code.contentType, base64: bytesToBase64(code.bytes) };
    const image = `data:${record.contentType};base64,${record.base64}`;
    legacyShareDataImage(image); validate?.(image);
    if (key) await cacheSet(key, record, this.env, CODE_CACHE_TTL_SECONDS);
    await this.assertSource(credentials);
    return image;
  }

  private async fetchWithTokenRefresh(credentials: RoutineCredentials,
    load: (accessToken: string) => Promise<{ bytes: Uint8Array; contentType: string }>): Promise<{ bytes: Uint8Array; contentType: string }> {
    let accessToken = await getRoutineAccessToken(this.container, this.env, credentials, { fetcher: this.fetcher });
    let code: { bytes: Uint8Array; contentType: string };
    try { code = await load(accessToken); }
    catch (error) {
      await this.assertSource(credentials);
      if (!(error instanceof WechatMiniProgramApiError) || !INVALID_TOKEN_CODES.has(error.code)) throw error;
      await invalidateRoutineAccessToken(this.env, credentials);
      accessToken = await getRoutineAccessToken(this.container, this.env, credentials, { fetcher: this.fetcher, forceRefresh: true });
      code = await load(accessToken);
    }
    await this.assertSource(credentials);
    return code;
  }

  private fetchInviteCode(token: string, uid: number) {
    return this.fetchUnlimitedCode(token, String(uid), 'pages/users/user_spread_user/index', '员工邀请');
  }

  private fetchPathCode(token: string, path: string, label: string) {
    return this.fetchCode('getwxacode', token, { path, check_path: true, env_version: 'release', width: 430 }, label);
  }

  private fetchUnlimitedCode(token: string, scene: string, page: string, label: string) {
    return this.fetchCode('getwxacodeunlimit', token, { scene, page, check_path: true, env_version: 'release', width: 430 }, label);
  }

  private async fetchCode(endpoint: 'getwxacode' | 'getwxacodeunlimit', token: string, body: Record<string, unknown>, label: string) {
    const url = new URL(`https://api.weixin.qq.com/wxa/${endpoint}`); url.searchParams.set('access_token', token);
    const response = await readLegacyShareProvider(this.fetcher, url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }, { json: 32 * 1024, image: MAX_CODE_BYTES, timeout: 8_000 });
    const contentType = response.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
    if (contentType === 'application/json' || contentType === 'text/plain') {
      const data = await response.json() as WechatErrorResponse;
      const code = Number(data.errcode ?? response.status);
      throw new WechatMiniProgramApiError(Number.isSafeInteger(code) ? code : response.status, `生成小程序${label}码失败`);
    }
    if (!response.ok) throw new ValidateException(`微信返回的小程序${label}码无效`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    legacyShareDataImage(`data:${contentType};base64,${bytesToBase64(bytes)}`);
    return { bytes, contentType };
  }

  private imageResponse(bytes: Uint8Array, contentType: string): Response {
    return new Response(bytes, { status: 200, headers: { 'Content-Type': contentType, 'Content-Length': String(bytes.byteLength),
      'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' } });
  }
}
