import type { Env } from "@/env";
import type { Container } from "@/lib/di";
import type {
  WechatShippingNotificationPayload,
  WechatTemplateNotificationPayload,
} from "@/models/schema";
import { SystemConfigService } from "@/services/system/SystemConfigService";
import { cacheDelete, cacheGet, cacheSet } from "@/utils/cache";

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

function maskedContact(value: string): string {
  return value.length >= 7 ? `${value.slice(0, 3)}****${value.slice(7)}` : value;
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
    const data = await this.postWithToken("official", "cgi-bin/message/template/send", {
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
    await this.postWithToken("routine", "cgi-bin/message/subscribe/send", {
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
    openid: string,
    payload: WechatShippingNotificationPayload,
  ): Promise<{ providerReference: string; requestId: string; responseCode: string }> {
    const merchantId = (await new SystemConfigService(this.container, this.env)
      .get("pay_weixin_mchid")).trim();
    if (!merchantId) throw new WechatProviderConfigurationError("微信商户号尚未配置");
    const expressCompany = payload.logisticsType === 1
      ? await this.deliveryId(payload.expressCompanyName)
      : "";
    const body: Record<string, unknown> = {
      order_key: {
        order_number_type: 2,
        mchid: merchantId,
        transaction_id: payload.transactionId,
      },
      logistics_type: payload.logisticsType,
      delivery_mode: payload.deliveryMode,
      upload_time: new Date().toISOString(),
      payer: { openid },
      shipping_list: [{
        tracking_no: payload.trackingNumber,
        express_company: expressCompany,
        item_desc: payload.itemDescription,
        contact: payload.receiverContact
          ? { receiver_contact: maskedContact(payload.receiverContact) }
          : {},
      }],
    };
    if (payload.deliveryMode === 2) body.is_all_delivered = payload.isAllDelivered;
    await this.postWithToken("routine", "wxa/sec/order/upload_shipping_info", body);
    return { providerReference: "", requestId: "", responseCode: "0" };
  }

  private async deliveryId(companyName: string): Promise<string> {
    const { appId } = await this.credentials("routine");
    const cacheKey = `wechat_shipping_delivery_list:${appId}`;
    let mapping = await cacheGet<Record<string, string>>(cacheKey, this.env);
    if (!mapping) {
      const data = await this.postWithToken(
        "routine",
        "cgi-bin/express/delivery/open_msg/get_delivery_list",
        {},
      );
      mapping = {};
      for (const item of data.delivery_list ?? []) {
        const name = item.delivery_name?.trim() ?? "";
        const id = item.delivery_id?.trim() ?? "";
        if (name && id) mapping[name] = id;
      }
      await cacheSet(cacheKey, mapping, this.env, 6 * 3_600);
    }
    return mapping[companyName] ?? "ZTO";
  }

  private async postWithToken(
    type: "official" | "routine",
    path: string,
    body: Record<string, unknown>,
  ): Promise<WechatResponse> {
    let token = await this.accessToken(type);
    try {
      return await this.post(path, token, body);
    } catch (error) {
      if (!(error instanceof WechatProviderRejectedError) || !INVALID_TOKEN_CODES.has(error.code)) {
        throw error;
      }
      await cacheDelete(await this.tokenCacheKey(type), this.env);
      token = await this.accessToken(type, true);
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

  private async accessToken(type: "official" | "routine", force = false): Promise<string> {
    const credentials = await this.credentials(type);
    const cacheKey = await this.tokenCacheKey(type, credentials.appId);
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

  private async credentials(type: "official" | "routine") {
    const config = new SystemConfigService(this.container, this.env);
    const appIdKey = type === "official" ? "wechat_appid" : "routine_appId";
    const secretKey = type === "official" ? "wechat_appsecret" : "routine_appsecret";
    const values = await config.getMany([appIdKey, secretKey]);
    const appId = values[appIdKey]?.trim() ?? "";
    const secret = values[secretKey]?.trim() ?? "";
    if (!appId || !secret) {
      throw new WechatProviderConfigurationError(
        type === "official" ? "公众号 AppID 或 AppSecret 尚未配置" : "小程序 AppID 或 AppSecret 尚未配置",
      );
    }
    return { appId, secret };
  }

  private async tokenCacheKey(type: "official" | "routine", appId?: string): Promise<string> {
    if (type === "official") return "wechat_access_token";
    const resolved = appId ?? (await this.credentials(type)).appId;
    return `routine_access_token:${resolved}`;
  }
}
