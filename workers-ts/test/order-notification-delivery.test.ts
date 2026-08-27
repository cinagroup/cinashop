import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Env, OrderMessage } from "@/env";
import { sendAliyunTemplateSms } from "@/services/message/SmsVerificationService";
import {
  consumeOrderNotificationDeliveryMessage,
  isOrderNotificationDeliveryMessage,
  type OrderNotificationDeliveryService,
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
    const migration = readFileSync("migrations/0086_notification_delivery_operations.sql", "utf8").trim();
    const migrationService = readFileSync("src/services/MigrationService.ts", "utf8");
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
  it("公众号模板数据使用 value 包装且不把 AppSecret 写入消息体", async () => {
    const config = new Map([
      ["cfg_wechat_appid", "official-app"],
      ["cfg_wechat_appsecret", "official-secret"],
    ]);
    const env = {
      CONFIG_KV: {
        get: async (key: string) => config.get(key) ?? null,
        put: async () => undefined,
        delete: async () => undefined,
      },
    } as unknown as Env;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/cgi-bin/token")) {
        return Response.json({ access_token: "token", expires_in: 7200 });
      }
      return Response.json({ errcode: 0, errmsg: "ok", msgid: 123 });
    }) as unknown as typeof fetch;
    const provider = new WechatNotificationProvider({} as never, env, fetcher);
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
