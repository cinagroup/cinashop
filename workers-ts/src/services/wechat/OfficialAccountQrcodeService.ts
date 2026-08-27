import { and, eq, sql } from "drizzle-orm";
import type { Env, OfficialAccountQrcodeMessage } from "@/env";
import type { Container } from "@/lib/di";
import { withTx } from "@/lib/di";
import { qrcode, wechatQrcode } from "@/models/schema";
import { SystemConfigService } from "@/services/system/SystemConfigService";
import { cacheDelete, cacheGet, cacheSet } from "@/utils/cache";
import { ValidateException } from "@/utils/errors";

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
    const current = await this.ensurePlaceholder(thirdType, thirdId);
    if (current.ticket && current.url && current.status === 1) {
      await this.synchronizeTarget(thirdType, thirdId, current.url);
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
      console.error(JSON.stringify({
        event: "official_qrcode_enqueue_failed",
        thirdType,
        thirdId,
        error: error instanceof Error ? error.message : String(error),
      }));
      return { status: "pending" as const, queued: false, url: "" };
    }
  }

  async processProvision(message: OfficialAccountQrcodeMessage) {
    assertTarget(message.thirdType, message.thirdId);
    const current = await this.ensurePlaceholder(message.thirdType, message.thirdId);
    if (current.ticket && current.url && current.status === 1) {
      await this.synchronizeTarget(message.thirdType, message.thirdId, current.url);
      return { status: "ready" as const, reused: true };
    }

    let accessToken = await this.getAccessToken();
    let provisioned: { ticket: string; url: string; qrcodeUrl: string; expireSeconds: number };
    try {
      provisioned = await this.createPermanent(accessToken, message.thirdType, message.thirdId);
    } catch (error) {
      if (!(error instanceof OfficialAccountApiError) || !INVALID_TOKEN_CODES.has(error.code)) {
        throw error;
      }
      const appId = await this.getAppId();
      await cacheDelete(`official_access_token:${appId}`, this.env);
      accessToken = await this.getAccessToken(true);
      provisioned = await this.createPermanent(accessToken, message.thirdType, message.thirdId);
    }

    const result = await withTx(this.container, async (tx) => {
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
      return { url: provisioned.url, reused: false };
    });
    await this.synchronizeTarget(message.thirdType, message.thirdId, result.url);
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

  private async synchronizeTarget(thirdType: string, thirdId: number, url: string): Promise<void> {
    if (thirdType !== "wechatqrcode") return;
    await this.container.db
      .update(wechatQrcode)
      .set({ image: url })
      .where(and(eq(wechatQrcode.id, thirdId), eq(wechatQrcode.isDel, 0)));
  }

  private async getAppId(): Promise<string> {
    const value = (await new SystemConfigService(this.container, this.env).get("wechat_appid"))?.trim() ?? "";
    if (!value) throw new ValidateException("公众号 AppID 未配置");
    return value;
  }

  private async getAccessToken(forceRefresh = false): Promise<string> {
    const config = new SystemConfigService(this.container, this.env);
    const values = await config.getMany(["wechat_appid", "wechat_appsecret"]);
    const appId = values.wechat_appid?.trim() ?? "";
    const secret = values.wechat_appsecret?.trim() ?? "";
    if (!appId || !secret) throw new ValidateException("公众号 AppID 或 AppSecret 未配置");
    const cacheKey = `official_access_token:${appId}`;
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
