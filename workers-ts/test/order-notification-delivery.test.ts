import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createContainerFromDb } from "@/lib/di";
import { orderNotificationDelivery, systemConfig } from "@/models/schema";
import { financeMemoryPostgres } from "./helpers/financePostgres";
import type { Env, OrderMessage } from "@/env";
import { sendAliyunTemplateSms } from "@/services/message/SmsVerificationService";
import {
  consumeOrderNotificationDeliveryMessage,
  isOrderNotificationDeliveryMessage,
  OrderNotificationDeliveryService,
} from "@/services/order/OrderNotificationDeliveryService";
import { WechatNotificationProvider } from "@/services/wechat/WechatNotificationProvider";

function message() {
  return {
    action: "processOrderNotificationDelivery" as const,
    deliveryId: 17,
    eventKey: "order.delivery.notice:9",
    channel: "wechat_routine" as const,
  };
}

describe("外部通知投递账本", () => {
  it("严格识别仅含账本引用的 Queue 消息", () => {
    expect(isOrderNotificationDeliveryMessage(message())).toBe(true);
    expect(isOrderNotificationDeliveryMessage({ ...message(), deliveryId: 0 })).toBe(false);
    expect(isOrderNotificationDeliveryMessage({ ...message(), eventKey: "other:9" })).toBe(false);
    expect(isOrderNotificationDeliveryMessage({ ...message(), channel: "email" })).toBe(false);
    expect(message()).not.toHaveProperty("target");
    expect(message()).not.toHaveProperty("payload");
  });

  it("租约忙时重试，终态确认，不让 Queue 自行重复提供商调用", async () => {
    const ack = vi.fn();
    const retry = vi.fn();
    const busy = {
      processMessage: vi.fn().mockResolvedValue("busy"),
    } as unknown as OrderNotificationDeliveryService;
    await consumeOrderNotificationDeliveryMessage({
      body: message() as OrderMessage,
      attempts: 2,
      ack,
      retry,
    }, busy);
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(ack).not.toHaveBeenCalled();

    const terminal = {
      processMessage: vi.fn().mockResolvedValue("unknown"),
    } as unknown as OrderNotificationDeliveryService;
    await consumeOrderNotificationDeliveryMessage({
      body: message() as OrderMessage,
      attempts: 3,
      ack,
      retry,
    }, terminal);
    expect(ack).toHaveBeenCalledTimes(1);
  });

  it("迁移包含唯一渠道键、三类租约索引和结果未知终态", () => {
    const migration = readFileSync("migrations/0085_external_notification_delivery.sql", "utf8");
    const source = readFileSync("src/services/order/OrderNotificationDeliveryService.ts", "utf8");
    expect(migration).toContain('"ond_event_channel_uq"');
    expect(migration).toContain('"ond_dispatch_ready"');
    expect(migration).toContain('"ond_expired_queue_lease"');
    expect(migration).toContain('"ond_expired_provider_lease"');
    expect(migration).toContain("'UNKNOWN'");
    expect(source).toContain('status: "UNKNOWN"');
    expect(source).toContain("Never auto-resend that ambiguity");
    expect(source).not.toContain("console.log(claim.payload");
    expect(source).not.toContain("console.log(claim.target");
  });

  it("人工处置迁移与内嵌迁移一致，且审计表不复制目标或消息正文", () => {
    const migration = readFileSync("migrations/0086_notification_delivery_operations.sql", "utf8").replace(/\r\n/g, "\n").trim();
    const migrationService = readFileSync("src/services/MigrationService.ts", "utf8").replace(/\r\n/g, "\n");
    const embedded = migrationService.match(
      /private migration_0093\(\): string \{\s*return `([\s\S]*?)`;\s*\}/,
    )?.[1].trim();
    expect(embedded).toBe(migration);
    expect(migration).toContain('"onda_request_key_uq"');
    expect(migration).toContain("'CONFIRM_RETRY'");
    expect(migration).not.toContain('"target"');
    expect(migration).not.toContain('"payload"');
  });

  it("管理 API 不保存凭据，并对重复发送风险使用显式确认短语", () => {
    const controller = readFileSync("src/controllers/api/v1/AdminNotificationController.ts", "utf8");
    const service = readFileSync("src/services/order/OrderNotificationAdminService.ts", "utf8");
    expect(controller).toContain("短信凭据只能通过 Cloudflare Worker secrets 配置");
    expect(controller).toContain("CONFIRM_NOTIFICATION_RETRY_WITH_DUPLICATE_RISK");
    expect(controller).toContain("CLOSE_NOTIFICATION_WITHOUT_RETRY");
    expect(service).toContain('row.status !== "UNKNOWN" && row.status !== "DEAD"');
    expect(service).toContain("MAX_MANUAL_REPLAYS");
    expect(service).not.toContain("accessKeySecret:");
  });
});

describe("微信模板提供商请求", () => {
  let fixture: Awaited<ReturnType<typeof financeMemoryPostgres>>;
  beforeAll(async () => { fixture = await financeMemoryPostgres([systemConfig, orderNotificationDelivery]); });
  afterAll(async () => { await fixture.close(); });
  beforeEach(async () => {
    await fixture.reset();
    await fixture.db.insert(systemConfig).values([
      { menuName: "wechat_appid", value: '"official-app"' },
      { menuName: "wechat_appsecret", value: '"official-secret"' },
    ]);
  });
  function runtimeEnv() {
    const config = new Map([
      ["cfg_wechat_appid", "stale-official-app"],
      ["cfg_wechat_appsecret", "stale-official-secret"],
    ]);
    return {
      APP_KEY: "owned-notification-delivery-key",
      UPSTASH_REDIS_URL: "", UPSTASH_REDIS_TOKEN: "",
      CONFIG_KV: {
        get: async (key: string) => config.get(key) ?? null,
        put: async (key: string, value: string) => { config.set(key, value); },
        delete: async (key: string) => { config.delete(key); },
      },
    } as unknown as Env;
  }
  const officialPayload = () => ({ kind: "wechat_official" as const, data: { thing1: "商品" }, url: "" });
  async function queuedOfficial() {
    await fixture.db.insert(orderNotificationDelivery).values({ id: 17, outboxId: 1, eventKey: "order.delivery.notice:9",
      orderId: 9, userId: 1, noticeMark: "order_postage_success", channel: "wechat_official",
      target: "openid", templateCode: "template-id", payload: officialPayload(), status: "ENQUEUED" });
    return { ...message(), channel: "wechat_official" as const };
  }
  it("公众号模板数据使用 value 包装且不把 AppSecret 写入消息体", async () => {
    const env = runtimeEnv();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/cgi-bin/token")) {
        return Response.json({ access_token: "token", expires_in: 7200 });
      }
      return Response.json({ errcode: 0, errmsg: "ok", msgid: 123 });
    }) as unknown as typeof fetch;
    const provider = new WechatNotificationProvider(createContainerFromDb(fixture.db), env, fetcher);
    await expect(provider.sendOfficial("openid", "template-id", {
      kind: "wechat_official",
      data: { thing1: "商品" },
      url: "/pages/goods/order_details/index?order_id=1",
    })).resolves.toMatchObject({ providerReference: "123", responseCode: "0" });
    const sent = calls.find((call) => call.url.includes("message/template/send"));
    expect(sent).toBeTruthy();
    expect(JSON.parse(String(sent?.init?.body))).toEqual({
      touser: "openid",
      template_id: "template-id",
      url: "/pages/goods/order_details/index?order_id=1",
      data: { thing1: { value: "商品" } },
    });
    expect(String(sent?.init?.body)).not.toContain("official-secret");
    const tokenUrl = new URL(calls.find(call => call.url.includes("/cgi-bin/token"))!.url);
    expect(tokenUrl.searchParams.get("appid")).toBe("official-app");
    expect(tokenUrl.searchParams.get("secret")).toBe("official-secret");
  });

  it.each(["missing-secret", "missing-signature", "oversized-config"])("确定的配置错误 %s 无 HTTP 且投递为 DEAD", async fault => {
    const env = runtimeEnv(), queued = await queuedOfficial();
    if (fault === "missing-secret") await fixture.db.delete(systemConfig).where(eq(systemConfig.menuName, "wechat_appsecret"));
    if (fault === "missing-signature") env.APP_KEY = "";
    if (fault === "oversized-config") await fixture.db.insert(systemConfig).values(Array.from({ length: 63 }, () => ({ menuName: "wechat_appsecret", value: "shadow", sort: -1 })));
    const fetcher = vi.fn().mockRejectedValue(Error("No provider I/O allowed"));
    const service = new OrderNotificationDeliveryService(createContainerFromDb(fixture.db), env);
    await expect(service.processMessage(queued, fetcher)).resolves.toBe("dead");
    expect(fetcher).not.toHaveBeenCalled();
    expect((await fixture.db.select().from(orderNotificationDelivery))[0]).toMatchObject({ status: "DEAD", attemptCount: 1, leaseUntil: 0 });
    await expect(service.processMessage(queued, fetcher)).resolves.toBe("dead");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("SQL 故障保留 UNKNOWN 分类，不被误认为已知配置错误", async () => {
    const queued = await queuedOfficial(), fetcher = vi.fn().mockRejectedValue(Error("No provider I/O allowed"));
    await fixture.exec("ALTER TABLE system_config RENAME COLUMN menu_name TO unavailable_menu_name");
    try {
      await expect(new OrderNotificationDeliveryService(createContainerFromDb(fixture.db), runtimeEnv()).processMessage(queued, fetcher)).resolves.toBe("unknown");
      expect(fetcher).not.toHaveBeenCalled();
      expect((await fixture.db.select().from(orderNotificationDelivery))[0].status).toBe("UNKNOWN");
    } finally { await fixture.exec("ALTER TABLE system_config RENAME COLUMN unavailable_menu_name TO menu_name"); }
  });

  it("明确 invalid-token 拒绝后密钥被清空，不再次发送且投递为 DEAD", async () => {
    const queued = await queuedOfficial();
    let posts = 0, tokens = 0;
    const fetcher: typeof fetch = async input => {
      if (new URL(String(input)).pathname.endsWith("/token")) { tokens++; return Response.json({ access_token: "owned-token", expires_in: 7200 }); }
      posts++;
      await fixture.db.delete(systemConfig).where(eq(systemConfig.menuName, "wechat_appsecret"));
      return Response.json({ errcode: 40014 });
    };
    await expect(new OrderNotificationDeliveryService(createContainerFromDb(fixture.db), runtimeEnv()).processMessage(queued, fetcher)).resolves.toBe("dead");
    expect({ posts, tokens }).toEqual({ posts: 1, tokens: 1 });
    expect((await fixture.db.select().from(orderNotificationDelivery))[0].status).toBe("DEAD");
  });
});

describe("阿里云订单短信请求", () => {
  it("通用模板短信不依赖验证码 Redis，并保留外部跟踪键", async () => {
    const env = {
      ALIYUN_SMS_ACCESS_KEY_ID: "audit-access-key",
      ALIYUN_SMS_ACCESS_KEY_SECRET: "audit-access-secret",
      ALIYUN_SMS_SIGN_NAME: "audit-sign",
    } as unknown as Env;
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, _init?: RequestInit) => Response.json({
      Code: "OK",
      BizId: "biz-id",
      RequestId: "request-id",
    }));
    const fetcher = fetchMock as unknown as typeof fetch;

    await expect(sendAliyunTemplateSms(env, {
      phone: "13800000000",
      templateCode: "SMS_AUDIT",
      templateParams: { order_id: "ORDER-1" },
      outId: "order.delivery.notice:1:sms",
    }, fetcher)).resolves.toEqual({ bizId: "biz-id", requestId: "request-id" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = String(fetchMock.mock.calls[0]?.[1]?.body);
    expect(body).toContain("OutId=order.delivery.notice%3A1%3Asms");
    expect(body).not.toContain("audit-access-secret");
  });
});
