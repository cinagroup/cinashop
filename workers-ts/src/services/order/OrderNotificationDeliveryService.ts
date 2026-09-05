import { and, asc, eq, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import type { Env, OrderMessage, OrderNotificationDeliveryMessage } from "@/env";
import type { Container } from "@/lib/di";
import { withTx } from "@/lib/di";
import {
  orderNotificationDelivery,
  type OrderNotificationChannel,
  type OrderNotificationDeliveryPayload,
  type SmsNotificationPayload,
  type WechatShippingNotificationPayload,
  type WechatTemplateNotificationPayload,
} from "@/models/schema";
import {
  AliyunSmsRejectedError,
  sendAliyunTemplateSms,
} from "@/services/message/SmsVerificationService";
import {
  WechatNotificationProvider,
  WechatProviderConfigurationError,
  WechatProviderRejectedError,
} from "@/services/wechat/WechatNotificationProvider";
import { NotFoundException, ValidateException } from "@/utils/errors";
import { emitOperationalEvent, operationalErrorCode } from "@/utils/observability";

const QUEUE_LEASE_SECONDS = 5 * 60;
const PROVIDER_LEASE_SECONDS = 2 * 60;
const MAX_PROVIDER_ATTEMPTS = 5;

type TerminalResult = "sent" | "skipped" | "unknown" | "dead";
type ProcessingResult = TerminalResult | "busy" | "already-sent" | "retry-scheduled";

interface ClaimedDelivery {
  id: number;
  eventKey: string;
  channel: OrderNotificationChannel;
  target: string;
  templateCode: string;
  payload: OrderNotificationDeliveryPayload;
  attemptCount: number;
  leaseToken: string;
}

interface ProviderResult {
  providerReference: string;
  requestId: string;
  responseCode: string;
}

function isChannel(value: unknown): value is OrderNotificationChannel {
  return ["sms", "wechat_official", "wechat_routine", "wechat_shipping"].includes(
    String(value),
  );
}

export function isOrderNotificationDeliveryMessage(
  value: unknown,
): value is OrderNotificationDeliveryMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<OrderNotificationDeliveryMessage>;
  return message.action === "processOrderNotificationDelivery" &&
    Number.isSafeInteger(message.deliveryId) && Number(message.deliveryId) > 0 &&
    typeof message.eventKey === "string" &&
    /^(?:(?:order\.delivery\.notice|order\.refund\.refused\.notice|withdrawal\.(?:approved|refused)\.notice):[1-9]\d*|order\.second_card\.(?:advent|expired)\.notice:[1-9]\d*:[1-9]\d*)$/.test(message.eventKey) &&
    isChannel(message.channel);
}

function retryDelaySeconds(attempt: number): number {
  return Math.min(60 * 2 ** Math.max(attempt - 1, 0), 3_600);
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidateException(`${label} 无效`);
  }
  return value as Record<string, unknown>;
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  const record = requireRecord(value, label);
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (!key || key.length > 64 || typeof entry !== "string" || [...entry].length > 500) {
      throw new ValidateException(`${label} 无效`);
    }
    output[key] = entry;
  }
  return output;
}

function assertPayload(
  channel: OrderNotificationChannel,
  value: unknown,
): asserts value is OrderNotificationDeliveryPayload {
  const payload = requireRecord(value, "外部通知载荷");
  if (payload.kind !== channel) throw new ValidateException("外部通知渠道与载荷不匹配");
  if (channel === "sms") {
    stringRecord(payload.params, "短信模板变量");
    return;
  }
  if (channel === "wechat_official" || channel === "wechat_routine") {
    stringRecord(payload.data, "微信模板变量");
    if (typeof payload.url !== "string" || payload.url.length > 512) {
      throw new ValidateException("微信通知跳转地址无效");
    }
    return;
  }
  if (
    typeof payload.transactionId !== "string" || !payload.transactionId ||
    !Number.isSafeInteger(payload.logisticsType) || Number(payload.logisticsType) < 1 ||
    Number(payload.logisticsType) > 4 || ![1, 2].includes(Number(payload.deliveryMode)) ||
    typeof payload.isAllDelivered !== "boolean" ||
    typeof payload.itemDescription !== "string" || payload.itemDescription.length > 1_024 ||
    typeof payload.trackingNumber !== "string" || payload.trackingNumber.length > 64 ||
    typeof payload.expressCompanyName !== "string" || payload.expressCompanyName.length > 64 ||
    typeof payload.receiverContact !== "string" || payload.receiverContact.length > 32 ||
    typeof payload.path !== "string" || payload.path.length > 512
  ) {
    throw new ValidateException("微信发货载荷无效");
  }
}

function isAliyunRetryable(code: string): boolean {
  return /^(?:isp\.ram_action_not_support|throttling|system\.error|isp\.system_error)/i.test(code);
}

export class OrderNotificationDeliveryService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  async dispatchPending(
    limit = 20,
    eventKey?: string,
  ): Promise<{ claimed: number; enqueued: number; unknown: number }> {
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 100));
    const now = Math.floor(Date.now() / 1_000);
    const leaseToken = crypto.randomUUID();
    const unknownRows = await this.markExpiredProviderCallsUnknown(now, eventKey);
    const eligible = or(
      and(
        inArray(orderNotificationDelivery.status, ["PENDING", "RETRYABLE"]),
        lte(orderNotificationDelivery.availableTime, now),
      ),
      and(
        inArray(orderNotificationDelivery.status, ["ENQUEUING", "ENQUEUED"]),
        lte(orderNotificationDelivery.leaseUntil, now),
      ),
    )!;
    const claimed = await withTx(this.container, async (tx) => {
      const conditions: SQL[] = [eligible];
      if (eventKey) conditions.push(eq(orderNotificationDelivery.eventKey, eventKey));
      const rows = await tx
        .select({
          id: orderNotificationDelivery.id,
          eventKey: orderNotificationDelivery.eventKey,
          channel: orderNotificationDelivery.channel,
        })
        .from(orderNotificationDelivery)
        .where(and(...conditions))
        .orderBy(asc(orderNotificationDelivery.id))
        .limit(boundedLimit)
        .for("update", { skipLocked: true });
      if (!rows.length) return rows;
      await tx.update(orderNotificationDelivery).set({
        status: "ENQUEUING",
        dispatchCount: sql`${orderNotificationDelivery.dispatchCount} + 1`,
        leaseToken,
        leaseUntil: now + QUEUE_LEASE_SECONDS,
        updateTime: now,
      }).where(inArray(orderNotificationDelivery.id, rows.map((row) => row.id)));
      return rows;
    });
    if (!claimed.length) return { claimed: 0, enqueued: 0, unknown: unknownRows };

    try {
      await this.env.ORDER_QUEUE.sendBatch(claimed.map((row) => ({
        body: {
          action: "processOrderNotificationDelivery" as const,
          deliveryId: row.id,
          eventKey: row.eventKey,
          channel: row.channel,
        },
        contentType: "json" as const,
      })));
      await withTx(this.container, async (tx) => {
        const transitioned = await tx.update(orderNotificationDelivery).set({
          status: "ENQUEUED",
          leaseToken: "",
          leaseUntil: now + QUEUE_LEASE_SECONDS,
          lastError: "",
          updateTime: now,
        }).where(and(
          inArray(orderNotificationDelivery.id, claimed.map((row) => row.id)),
          eq(orderNotificationDelivery.status, "ENQUEUING"),
          eq(orderNotificationDelivery.leaseToken, leaseToken),
        )).returning({ id: orderNotificationDelivery.id });
        if (transitioned.length !== claimed.length) {
          throw new Error("外部通知 Queue 投递状态迁移不完整");
        }
      });
      return { claimed: claimed.length, enqueued: claimed.length, unknown: unknownRows };
    } catch (error) {
      await withTx(this.container, async (tx) => {
        await tx.update(orderNotificationDelivery).set({
          status: "RETRYABLE",
          availableTime: now + 60,
          leaseToken: "",
          leaseUntil: 0,
          lastError: `Queue delivery failed: ${errorText(error)}`.slice(0, 1_000),
          updateTime: now,
        }).where(and(
          inArray(orderNotificationDelivery.id, claimed.map((row) => row.id)),
          eq(orderNotificationDelivery.status, "ENQUEUING"),
          eq(orderNotificationDelivery.leaseToken, leaseToken),
        ));
      });
      throw error;
    }
  }

  async processMessage(
    message: OrderNotificationDeliveryMessage,
    fetcher: typeof fetch = fetch,
  ): Promise<ProcessingResult> {
    const claim = await this.claim(message);
    if (typeof claim === "string") return claim;
    try {
      const result = await this.deliver(claim, fetcher);
      await this.finalize(claim, "SENT", result, "", Math.floor(Date.now() / 1_000));
      return "sent";
    } catch (error) {
      const now = Math.floor(Date.now() / 1_000);
      if (error instanceof WechatProviderConfigurationError) {
        await this.finalize(claim, "DEAD", undefined, errorText(error), now);
        return "dead";
      }
      if (error instanceof AliyunSmsRejectedError) {
        return this.recordRejected(claim, error.code, isAliyunRetryable(error.code), now);
      }
      if (error instanceof WechatProviderRejectedError) {
        return this.recordRejected(claim, String(error.code), error.retryable, now);
      }
      // The provider may have accepted the request before a timeout, disconnect,
      // invalid response, or Worker termination. Never auto-resend that ambiguity.
      await this.finalize(claim, "UNKNOWN", undefined, errorText(error), now);
      return "unknown";
    }
  }

  private async deliver(claim: ClaimedDelivery, fetcher: typeof fetch): Promise<ProviderResult> {
    assertPayload(claim.channel, claim.payload);
    if (!claim.target) throw new WechatProviderConfigurationError("通知目标尚未配置");
    if (claim.channel === "sms") {
      if (!claim.templateCode) throw new WechatProviderConfigurationError("短信模板尚未配置");
      if (
        !this.env.ALIYUN_SMS_ACCESS_KEY_ID || !this.env.ALIYUN_SMS_ACCESS_KEY_SECRET ||
        !this.env.ALIYUN_SMS_SIGN_NAME
      ) {
        throw new WechatProviderConfigurationError("短信服务尚未配置");
      }
      const payload = claim.payload as SmsNotificationPayload;
      const result = await sendAliyunTemplateSms(this.env, {
        phone: claim.target,
        templateCode: claim.templateCode,
        templateParams: payload.params,
        outId: `${claim.eventKey}:${claim.channel}`,
      }, fetcher);
      return {
        providerReference: result.bizId,
        requestId: result.requestId,
        responseCode: "OK",
      };
    }
    const provider = new WechatNotificationProvider(this.container, this.env, fetcher);
    if (claim.channel === "wechat_official") {
      if (!claim.templateCode) throw new WechatProviderConfigurationError("公众号模板尚未配置");
      return provider.sendOfficial(
        claim.target,
        claim.templateCode,
        claim.payload as WechatTemplateNotificationPayload,
      );
    }
    if (claim.channel === "wechat_routine") {
      if (!claim.templateCode) throw new WechatProviderConfigurationError("小程序模板尚未配置");
      return provider.sendRoutine(
        claim.target,
        claim.templateCode,
        claim.payload as WechatTemplateNotificationPayload,
      );
    }
    return provider.uploadShipping(
      claim.target,
      claim.payload as WechatShippingNotificationPayload,
    );
  }

  private async recordRejected(
    claim: ClaimedDelivery,
    code: string,
    retryable: boolean,
    now: number,
  ): Promise<"retry-scheduled" | "dead"> {
    const canRetry = retryable && claim.attemptCount < MAX_PROVIDER_ATTEMPTS;
    await this.finalize(
      claim,
      canRetry ? "RETRYABLE" : "DEAD",
      { providerReference: "", requestId: "", responseCode: code },
      `Provider rejected request: ${code}`,
      now,
      canRetry ? now + retryDelaySeconds(claim.attemptCount) : 0,
    );
    return canRetry ? "retry-scheduled" : "dead";
  }

  private async claim(
    message: OrderNotificationDeliveryMessage,
  ): Promise<ClaimedDelivery | "busy" | "already-sent" | TerminalResult> {
    const now = Math.floor(Date.now() / 1_000);
    const leaseToken = crypto.randomUUID();
    return withTx(this.container, async (tx) => {
      const rows = await tx.select().from(orderNotificationDelivery)
        .where(eq(orderNotificationDelivery.id, message.deliveryId)).limit(1).for("update");
      const row = rows[0];
      if (!row) throw new NotFoundException("外部通知投递不存在");
      if (row.eventKey !== message.eventKey || row.channel !== message.channel) {
        throw new ValidateException("外部通知消息与投递账本不匹配");
      }
      if (row.status === "SENT") return "already-sent";
      if (row.status === "SKIPPED") return "skipped";
      if (row.status === "UNKNOWN") return "unknown";
      if (row.status === "DEAD") return "dead";
      if (row.status === "PROCESSING") {
        if (row.leaseUntil > now) return "busy";
        await tx.update(orderNotificationDelivery).set({
          status: "UNKNOWN",
          leaseToken: "",
          leaseUntil: 0,
          lastError: "provider_result_unknown_after_expired_lease",
          updateTime: now,
        }).where(eq(orderNotificationDelivery.id, row.id));
        return "unknown";
      }
      if (row.status !== "ENQUEUED") return "busy";
      const attemptCount = row.attemptCount + 1;
      await tx.update(orderNotificationDelivery).set({
        status: "PROCESSING",
        attemptCount,
        leaseToken,
        leaseUntil: now + PROVIDER_LEASE_SECONDS,
        updateTime: now,
      }).where(eq(orderNotificationDelivery.id, row.id));
      return {
        id: row.id,
        eventKey: row.eventKey,
        channel: row.channel,
        target: row.target,
        templateCode: row.templateCode,
        payload: row.payload,
        attemptCount,
        leaseToken,
      };
    });
  }

  private async finalize(
    claim: ClaimedDelivery,
    status: "SENT" | "RETRYABLE" | "UNKNOWN" | "DEAD",
    result: ProviderResult | undefined,
    lastError: string,
    now: number,
    availableTime = 0,
  ): Promise<void> {
    const updated = await withTx(this.container, (tx) => tx
      .update(orderNotificationDelivery)
      .set({
        status,
        availableTime,
        leaseToken: "",
        leaseUntil: 0,
        providerReference: result?.providerReference ?? "",
        providerRequestId: result?.requestId ?? "",
        responseCode: result?.responseCode ?? "",
        lastError: lastError.slice(0, 1_000),
        sentTime: status === "SENT" ? now : 0,
        updateTime: now,
      })
      .where(and(
        eq(orderNotificationDelivery.id, claim.id),
        eq(orderNotificationDelivery.status, "PROCESSING"),
        eq(orderNotificationDelivery.leaseToken, claim.leaseToken),
      ))
      .returning({ id: orderNotificationDelivery.id }));
    if (!updated[0]) throw new Error("外部通知投递租约已失效");
  }

  private async markExpiredProviderCallsUnknown(now: number, eventKey?: string): Promise<number> {
    const conditions: SQL[] = [
      eq(orderNotificationDelivery.status, "PROCESSING"),
      lte(orderNotificationDelivery.leaseUntil, now),
    ];
    if (eventKey) conditions.push(eq(orderNotificationDelivery.eventKey, eventKey));
    const rows = await withTx(this.container, (tx) => tx
      .update(orderNotificationDelivery)
      .set({
        status: "UNKNOWN",
        leaseToken: "",
        leaseUntil: 0,
        lastError: "provider_result_unknown_after_expired_lease",
        updateTime: now,
      })
      .where(and(...conditions))
      .returning({ id: orderNotificationDelivery.id }));
    return rows.length;
  }
}

/** Narrow queue consumer keeps retry policy independent from provider payloads. */
export async function consumeOrderNotificationDeliveryMessage(
  message: Pick<Message<OrderMessage>, "body" | "attempts" | "ack" | "retry">,
  service: OrderNotificationDeliveryService,
): Promise<void> {
  if (!isOrderNotificationDeliveryMessage(message.body)) {
    throw new Error("Queue message is not an external notification delivery");
  }
  const body = message.body;
  const startedAt = Date.now();
  try {
    const result = await service.processMessage(body);
    if (result === "busy") {
      emitOperationalEvent("warn", {
        event: "order_notification_delivery_retried",
        component: "queue",
        operation: "notification_delivery",
        outcome: "retry",
        durationMs: Date.now() - startedAt,
        queueAttempt: message.attempts,
      });
      message.retry({ delaySeconds: Math.min(30 * 2 ** Math.max(message.attempts - 1, 0), 300) });
      return;
    }
    emitOperationalEvent(result === "unknown" || result === "dead" ? "error" : "info", {
      event: "order_notification_delivery_consumed",
      component: "queue",
      operation: "notification_delivery",
      outcome: result === "unknown" ? "unknown" : result === "dead" ? "failure" : "success",
      channel: body.channel,
      result,
      durationMs: Date.now() - startedAt,
      queueAttempt: message.attempts,
    });
    message.ack();
  } catch (error) {
    emitOperationalEvent("error", {
      event: "order_notification_delivery_failed",
      component: "queue",
      operation: "notification_delivery",
      outcome: "retry",
      channel: body.channel,
      durationMs: Date.now() - startedAt,
      queueAttempt: message.attempts,
      errorCode: operationalErrorCode(error),
    });
    message.retry({ delaySeconds: Math.min(30 * 2 ** Math.max(message.attempts - 1, 0), 300) });
  }
}
