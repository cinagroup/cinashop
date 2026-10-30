import { and, eq, sql } from "drizzle-orm";
import type { Env, OfficialAccountQrcodeMessage } from "@/env";
import type { Container, DbClient } from "@/lib/di";
import { withTx } from "@/lib/di";
import { qrcode, wechatQrcode } from "@/models/schema";
import { readOfficialAccountCredentials, readOfficialAccountCredentialsInTx, officialCredentialCacheKey, type OfficialAccountCredentials } from "./OfficialAccountRuntimeConfig";
import { cacheDelete, cacheGet, cacheSet } from "@/utils/cache";
import { ServiceUnavailableException, ValidateException } from "@/utils/errors";
import { emitOperationalEvent, operationalErrorCode } from "@/utils/observability";
import { boundedProductShareFetch } from './ProductShareProviderPolicy';

const MAX_API_JSON_BYTES = 64 * 1024;
const ALLOWED_TYPES = new Set(["reply", "wechatqrcode"]);
const INVALID_TOKEN_CODES = new Set([40001, 40014, 42001]);

export class OfficialAccountApiError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "OfficialAccountApiError";
  }
}

function assertTarget(thirdType: string, thirdId: number): void {
  if (!ALLOWED_TYPES.has(thirdType)) throw new ValidateException("公众号二维码类型不受支持");
  if (!Number.isSafeInteger(thirdId) || thirdId <= 0) {
    throw new ValidateException("公众号二维码目标 ID 无效");
  }
}

function catalogLock(thirdType: string, thirdId: number) {
  return sql`SELECT pg_advisory_xact_lock(
    hashtextextended(${`official-qrcode:${thirdType}:${thirdId}`}, 0)
  )`;
}

async function readBoundedJson(response: Response): Promise<Record<string, unknown>> {
  const declared = Number(response.headers.get("Content-Length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_API_JSON_BYTES) {
    throw new ValidateException("微信接口返回数据过大");
  }
  if (!response.body) throw new ValidateException("微信接口未返回数据");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_API_JSON_BYTES) {
      await reader.cancel();
      throw new ValidateException("微信接口返回数据过大");
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
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("response is not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new ValidateException("微信接口返回数据格式错误");
  }
}

export function isOfficialAccountQrcodeMessage(
  value: unknown,
): value is OfficialAccountQrcodeMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return message.action === "provisionOfficialAccountQrcode"
    && typeof message.thirdType === "string"
    && ALLOWED_TYPES.has(message.thirdType)
    && Number.isSafeInteger(message.thirdId)
    && Number(message.thirdId) > 0;
}

export class OfficialAccountQrcodeService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  /** Versioned opaque legacy-share scene; permanence is explicit, not inferred
   * from an untrusted UID or a broadening of the channel/reply type catalogue. */
  async requestLegacyShare(scene: string, permanent: boolean, expectedAppId: string): Promise<{ ticket: string; url: string }> {
    if (!/^ls:[a-f0-9]{24}:(?:0|[1-9]\d{0,9}):[a-f0-9]{24}$/.test(scene)
      || new TextEncoder().encode(scene).length > 64 || permanent !== scene.includes(':0:')) {
      throw new ValidateException('分享公众号场景错误');
    }
    const bounded = new OfficialAccountQrcodeService(this.container, this.env, boundedProductShareFetch(this.fetcher));
    const create = async (token: string) => {
      const url = new URL('https://api.weixin.qq.com/cgi-bin/qrcode/create'); url.searchParams.set('access_token', token);
      const response = await bounded.fetcher(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(permanent ? {} : { expire_seconds: 2592000 }),
          action_name: permanent ? 'QR_LIMIT_STR_SCENE' : 'QR_STR_SCENE', action_info: { scene: { scene_str: scene } } }) });
      const data = await readBoundedJson(response), ticket = typeof data.ticket === 'string' ? data.ticket : '';
      if (!response.ok || !ticket || ticket.length > 255 || /[\u0000-\u001f\u007f]/u.test(ticket)) {
        throw new OfficialAccountApiError(Number(data.errcode ?? response.status), '生成分享公众号码失败');
      }
      return { ticket, url: `https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=${encodeURIComponent(ticket)}` };
    };
    const credentials = await readOfficialAccountCredentials(this.container, this.env);
    let token = await bounded.getAccessToken(false, expectedAppId, credentials);
    try { return await create(token); }
    catch (error) {
      if (!(error instanceof OfficialAccountApiError) || !INVALID_TOKEN_CODES.has(error.code)) throw error;
      await bounded.assertCurrentCredentials(credentials);
      await cacheDelete(officialCredentialCacheKey(credentials, 'access-token'), this.env);
      token = await bounded.getAccessToken(true, expectedAppId, credentials); return create(token);
    }
  }

  /** Temporary signed product scene; no permanent queue or qrcode-table DML. */
  async requestTemporaryProduct(scene:string):Promise<string>{
    if(!/^p:[1-9]\d{0,9}:[1-9]\d{0,9}:\d{1,10}:[a-f\d]{24}$/.test(scene)||new TextEncoder().encode(scene).byteLength>64)throw new ValidateException('商品分享场景无效');
    const bounded=new OfficialAccountQrcodeService(this.container,this.env,boundedProductShareFetch(this.fetcher));
    const create=async(token:string)=>{
      const url=new URL('https://api.weixin.qq.com/cgi-bin/qrcode/create');url.searchParams.set('access_token',token);
      const response=await bounded.fetcher(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expire_seconds:2592000,action_name:'QR_STR_SCENE',action_info:{scene:{scene_str:scene}}})});
      const data=await readBoundedJson(response),ticket=typeof data.ticket==='string'?data.ticket:'';
      if(!response.ok||!ticket||ticket.length>255||/[\u0000-\u001f\u007f]/.test(ticket))throw new OfficialAccountApiError(Number(data.errcode??response.status),'生成商品公众号分享码失败');
      return `https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=${encodeURIComponent(ticket)}`;
    };
    const credentials = await readOfficialAccountCredentials(this.container, this.env);
    let token=await bounded.getAccessToken(false, undefined, credentials);
    try{return await create(token);}catch(error){if(!(error instanceof OfficialAccountApiError)||!INVALID_TOKEN_CODES.has(error.code))throw error;await bounded.assertCurrentCredentials(credentials);await cacheDelete(officialCredentialCacheKey(credentials,'access-token'),this.env);token=await bounded.getAccessToken(true,undefined,credentials);return create(token);}
  }

  async status(thirdType: string, thirdId: number) {
    assertTarget(thirdType, thirdId);
    const rows = await this.container.db
      .select()
      .from(qrcode)
      .where(and(eq(qrcode.thirdType, thirdType), eq(qrcode.thirdId, thirdId)))
      .limit(1);
    const row = rows[0];
    return {
      status: row?.ticket && row.url && row.status === 1 ? "ready" as const : "pending" as const,
      url: row?.url ?? "",
      qrcodeUrl: row?.qrcodeUrl ?? "",
      scan: row?.scan ?? 0,
    };
  }

  async requestPermanent(thirdType: string, thirdId: number) {
    assertTarget(thirdType, thirdId);
    await this.ensurePlaceholder(thirdType, thirdId);
    const current = await this.readyTarget(thirdType, thirdId);
    if (current) {
      return { status: "ready" as const, queued: false, url: current.url };
    }
    const message: OfficialAccountQrcodeMessage = {
      action: "provisionOfficialAccountQrcode",
      thirdType: thirdType as OfficialAccountQrcodeMessage["thirdType"],
      thirdId,
    };
    try {
      await this.env.ORDER_QUEUE.send(message);
      return { status: "pending" as const, queued: true, url: "" };
    } catch (error) {
      emitOperationalEvent("error", {
        event: "official_qrcode_enqueue_failed",
        component: "queue",
        operation: "official_qrcode",
        outcome: "failure",
        thirdType,
        errorCode: operationalErrorCode(error),
      });
      return { status: "pending" as const, queued: false, url: "" };
    }
  }

  async processProvision(message: OfficialAccountQrcodeMessage) {
    assertTarget(message.thirdType, message.thirdId);
    await this.ensurePlaceholder(message.thirdType, message.thirdId);
    const current = await this.readyTarget(message.thirdType, message.thirdId);
    if (current) {
      return { status: "ready" as const, reused: true };
    }

    const credentials = await readOfficialAccountCredentials(this.container, this.env);
    let accessToken = await this.getAccessToken(false, undefined, credentials);
    let provisioned: { ticket: string; url: string; qrcodeUrl: string; expireSeconds: number };
    try {
      provisioned = await this.createPermanent(accessToken, message.thirdType, message.thirdId);
    } catch (error) {
      if (!(error instanceof OfficialAccountApiError) || !INVALID_TOKEN_CODES.has(error.code)) {
        throw error;
      }
      await this.assertCurrentCredentials(credentials);
      await cacheDelete(officialCredentialCacheKey(credentials, 'access-token'), this.env);
      accessToken = await this.getAccessToken(true, undefined, credentials);
      provisioned = await this.createPermanent(accessToken, message.thirdType, message.thirdId);
    }

    const result = await withTx(this.container, async (tx) => {
      await this.provisionBarrier(tx);
      const currentCredentials = await readOfficialAccountCredentialsInTx(tx, this.env);
      if (currentCredentials.stamp !== credentials.stamp) throw new ValidateException('公众号账户配置已变化，旧二维码结果不能保存');
      await tx.execute(catalogLock(message.thirdType, message.thirdId));
      const latest = await tx
        .select()
        .from(qrcode)
        .where(and(
          eq(qrcode.thirdType, message.thirdType),
          eq(qrcode.thirdId, message.thirdId),
        ))
        .for("update")
        .limit(1);
      if (latest[0]?.ticket && latest[0].url && latest[0].status === 1) {
        await this.synchronizeTarget(tx, message.thirdType, message.thirdId, latest[0].url);
        return { url: latest[0].url, reused: true };
      }
      const now = String(Math.floor(Date.now() / 1000));
      await tx
        .insert(qrcode)
        .values({
          thirdType: message.thirdType,
          thirdId: message.thirdId,
          ticket: provisioned.ticket,
          expireSeconds: provisioned.expireSeconds,
          status: 1,
          addTime: now,
          url: provisioned.url,
          qrcodeUrl: provisioned.qrcodeUrl,
          scan: 0,
          type: 2,
        })
        .onConflictDoUpdate({
          target: [qrcode.thirdType, qrcode.thirdId],
          set: {
            ticket: provisioned.ticket,
            expireSeconds: provisioned.expireSeconds,
            status: 1,
            addTime: now,
            url: provisioned.url,
            qrcodeUrl: provisioned.qrcodeUrl,
            type: 2,
          },
        });
      await this.synchronizeTarget(tx, message.thirdType, message.thirdId, provisioned.url);
      return { url: provisioned.url, reused: false };
    });
    return { status: "ready" as const, reused: result.reused };
  }

  private async ensurePlaceholder(thirdType: string, thirdId: number) {
    return withTx(this.container, async (tx) => {
      await tx.execute(catalogLock(thirdType, thirdId));
      const existing = await tx
        .select()
        .from(qrcode)
        .where(and(eq(qrcode.thirdType, thirdType), eq(qrcode.thirdId, thirdId)))
        .limit(1);
      if (existing[0]) return existing[0];
      const inserted = await tx
        .insert(qrcode)
        .values({
          thirdType,
          thirdId,
          ticket: "",
          expireSeconds: 0,
          status: 0,
          addTime: String(Math.floor(Date.now() / 1000)),
          url: "",
          qrcodeUrl: "",
          scan: 0,
          type: 2,
        })
        .returning();
      return inserted[0];
    });
  }

  private async provisionBarrier(tx: DbClient): Promise<void> {
    await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
    await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
    // Coordinate only the reviewed base author and permanent provisioner.
    // App's SELECT-only config privilege cannot acquire a SHARE table lock;
    // maintenance/raw SQL writers are outside this advisory protocol.
    // All remote I/O finishes before the short gate -> qrcode publication fence.
    const [gate] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock_shared(731659,0) AS locked`);
    if (gate?.locked !== true) throw new ServiceUnavailableException('公众号账户配置正在更新，请稍后重试');
    await tx.execute(sql`LOCK TABLE ${qrcode} IN ROW EXCLUSIVE MODE NOWAIT`);
  }

  private async readyTarget(thirdType: string, thirdId: number) {
    return withTx(this.container, async tx => {
      await this.provisionBarrier(tx);
      await tx.execute(catalogLock(thirdType, thirdId));
      const [row] = await tx.select().from(qrcode).where(and(eq(qrcode.thirdType, thirdType), eq(qrcode.thirdId, thirdId)))
        .for('update', { noWait: true }).limit(1);
      if (!row?.ticket || !row.url || row.status !== 1) return null;
      await this.synchronizeTarget(tx, thirdType, thirdId, row.url);
      return row;
    });
  }

  private async synchronizeTarget(tx: DbClient, thirdType: string, thirdId: number, url: string): Promise<void> {
    if (thirdType !== "wechatqrcode") return;
    await tx.update(wechatQrcode).set({ image: url })
      .where(and(eq(wechatQrcode.id, thirdId), eq(wechatQrcode.isDel, 0)));
  }

  private async assertCurrentCredentials(expected: OfficialAccountCredentials): Promise<void> {
    const current = await readOfficialAccountCredentials(this.container, this.env);
    if (current.stamp !== expected.stamp) throw new ValidateException('公众号账户配置已变化，请稍后重试');
  }

  private async getAccessToken(forceRefresh = false, expectedAppId?: string, snapshot?: OfficialAccountCredentials): Promise<string> {
    const credentials = snapshot ?? await readOfficialAccountCredentials(this.container, this.env);
    const { appId, secret } = credentials;
    if (expectedAppId !== undefined && appId !== expectedAppId) throw new ValidateException('分享公众号账户配置已变化，请稍后重试');
    const cacheKey = officialCredentialCacheKey(credentials, 'access-token');
    if (!forceRefresh) {
      const cached = await cacheGet<string>(cacheKey, this.env);
      if (cached) return cached;
    }
    const url = new URL("https://api.weixin.qq.com/cgi-bin/token");
    url.search = new URLSearchParams({
      grant_type: "client_credential",
      appid: appId,
      secret,
    }).toString();
    const response = await this.fetcher(url, { method: "GET" });
    const data = await readBoundedJson(response);
    const accessToken = typeof data.access_token === "string" ? data.access_token : "";
    if (!response.ok || !accessToken) {
      throw new OfficialAccountApiError(
        Number(data.errcode ?? response.status),
        `获取公众号 access_token 失败: ${data.errmsg ?? response.statusText}`,
      );
    }
    await cacheSet(
      cacheKey,
      accessToken,
      this.env,
      Math.max(60, Number(data.expires_in ?? 7200) - 200),
    );
    return accessToken;
  }

  private async createPermanent(accessToken: string, thirdType: string, thirdId: number) {
    const url = new URL("https://api.weixin.qq.com/cgi-bin/qrcode/create");
    url.searchParams.set("access_token", accessToken);
    const response = await this.fetcher(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_name: "QR_LIMIT_STR_SCENE",
        action_info: { scene: { scene_str: `${thirdType}:${thirdId}` } },
      }),
    });
    const data = await readBoundedJson(response);
    const ticket = typeof data.ticket === "string" ? data.ticket : "";
    if (!response.ok || !ticket) {
      throw new OfficialAccountApiError(
        Number(data.errcode ?? response.status),
        `生成公众号二维码失败: ${data.errmsg ?? response.statusText}`,
      );
    }
    const qrcodeUrl = typeof data.url === "string" ? data.url : "";
    const imageUrl = `https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=${encodeURIComponent(ticket)}`;
    if (ticket.length > 255 || qrcodeUrl.length > 255 || imageUrl.length > 255) {
      throw new ValidateException("微信返回的二维码字段超过旧库长度限制");
    }
    return {
      ticket,
      qrcodeUrl,
      url: imageUrl,
      expireSeconds: Number.isSafeInteger(data.expire_seconds) ? Number(data.expire_seconds) : 0,
    };
  }
}
