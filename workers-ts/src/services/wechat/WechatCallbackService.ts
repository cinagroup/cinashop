import {
  and,
  asc,
  eq,
  inArray,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type {
  Env,
  WechatCallbackDispatchMessage,
  WechatCallbackOutboxMessage,
} from "@/env";
import type { Container } from "@/lib/di";
import { createContainerFromDb, withTx } from "@/lib/di";
import {
  qrcode,
  storeOrder,
  userCard,
  wechatCallbackEvent,
  wechatCallbackOutbox,
  wechatCallbackWatermark,
  wechatCard,
  wechatKey,
  wechatMessage,
  wechatQrcode,
  wechatQrcodeRecord,
  wechatReply,
  wechatUser,
  type WechatCallbackEvent,
} from "@/models/schema";
import { completeOrderReceipt, decimalToCents } from "@/services/order/OrderBrokerageService";
import {
  PaymentCallbackEventService,
  type VerifiedPaymentCallback,
} from "@/services/payment/PaymentCallbackEventService";
import { findRechargeOrderByOrderId } from "@/services/payment/RechargePaymentService";
import { SystemConfigService } from "@/services/system/SystemConfigService";
import { UserFinanceService } from "@/services/user/UserFinanceService";
import { findMembershipOrderByOrderId } from "@/services/user/PaidMembershipService";
import { emitOperationalEvent, operationalErrorCode } from "@/utils/observability";
import { WechatAuthService, type OfficialSubscriberProfile } from "./WechatAuthService";
import {
  buildWechatReplyXml,
  decryptWechatCallback,
  encryptWechatReply,
  normalizeWechatCallback,
  validateWechatCallbackSecret,
  verifyWechatEncryptedSignature,
  verifyWechatPlainChallenge,
  wechatCallbackSha,
  wechatEncryptedXmlValue,
  type NormalizedWechatCallback,
  type WechatCallbackQuery,
  type WechatCallbackSource,
} from "./WechatCallbackCrypto";

const DISPATCH_LEASE_SECONDS = 120;
const DELIVERY_LEASE_SECONDS = 600;
const PROCESS_LEASE_SECONDS = 120;
const MAX_ATTEMPTS = 8;
const RETENTION_SECONDS = 400 * 24 * 60 * 60;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface CallbackConfig {
  appId: string;
  token: string;
  aesKey: string;
}

interface ReceiveResult {
  eventId: number;
  outboxId: number;
  replayKey: string;
  duplicate: boolean;
  responseBody: string;
}

interface ClaimedCallback {
  event: WechatCallbackEvent;
  outboxId: number;
  leaseToken: string;
  attemptCount: number;
}

interface PreparedProjection {
  uid?: number;
  profile?: OfficialSubscriberProfile;
  payment?: { outboxId: number; terminalConflict: boolean };
  receiptApplied?: boolean;
}

type ProjectionType = "follow" | "scan" | "card" | "payment" | "receipt" | "message" | "ignored";
type ProcessResult = "completed" | "already-completed" | "busy" | "dead" | { kind: "deferred"; delaySeconds: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function callbackMessage(input: {
  outboxId: number;
  eventId: number;
  replayKey: string;
}): WechatCallbackOutboxMessage {
  return { action: "processWechatCallbackOutbox", ...input };
}

export function isWechatCallbackOutboxMessage(value: unknown): value is WechatCallbackOutboxMessage {
  if (!isRecord(value)) return false;
  return Object.keys(value).length === 4
    && value.action === "processWechatCallbackOutbox"
    && Number.isSafeInteger(value.outboxId) && Number(value.outboxId) > 0
    && Number.isSafeInteger(value.eventId) && Number(value.eventId) > 0
    && typeof value.replayKey === "string" && UUID_V4.test(value.replayKey);
}

export function isWechatCallbackDispatchMessage(value: unknown): value is WechatCallbackDispatchMessage {
  return isRecord(value)
    && Object.keys(value).length === 2
    && value.action === "dispatchWechatCallbackOutbox"
    && Number.isSafeInteger(value.scheduledAt)
    && Number(value.scheduledAt) > 0;
}

function projectionType(event: Pick<WechatCallbackEvent, "source" | "msgType" | "eventType">): ProjectionType {
  if (event.msgType !== "event") return event.source === "official" ? "message" : "ignored";
  if (["subscribe", "unsubscribe"].includes(event.eventType)) return "follow";
  if (event.eventType === "scan") return "scan";
  if (["user_get_card", "submit_membercard_user_info", "user_del_card"].includes(event.eventType)) return "card";
  if (event.eventType === "funds_order_pay") return "payment";
  if (event.eventType === "trade_manage_order_settlement") return "receipt";
  if (["click", "view"].includes(event.eventType) && event.source === "official") return "message";
  return "ignored";
}

function retryDelay(attempt: number): number {
  return Math.min(30 * 2 ** Math.max(0, Math.min(attempt, MAX_ATTEMPTS) - 1), 3600);
}

function callbackErrorCode(error: unknown): string {
  const candidate = error instanceof Error ? error.message : String(error);
  return /^[a-z0-9_:-]{1,64}$/i.test(candidate)
    ? candidate.toLowerCase()
    : "wechat_callback_processing_failed";
}

function canonicalNormalized(callback: NormalizedWechatCallback): string {
  return JSON.stringify({
    source: callback.source,
    appId: callback.appId,
    msgType: callback.msgType,
    eventType: callback.eventType,
    eventTime: callback.eventTime,
    sequenceRank: callback.sequenceRank,
    subjectKey: callback.subjectKey,
    recognized: callback.recognized,
    payload: callback.payload,
  });
}

function parseReplyData(value: string | null): Record<string, unknown> {
  if (!value || value.length > 200_000) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function replySnapshot(type: string, dataValue: string | null): Record<string, unknown> {
  const data = parseReplyData(dataValue);
  if (type === "text") {
    const content = String(data.content ?? "").slice(0, 20_000);
    return content ? { type, content } : { type: "none" };
  }
  if (type === "image" || type === "voice") {
    const mediaId = String(data.media_id ?? data.mediaId ?? "").slice(0, 64);
    return mediaId ? { type, mediaId } : { type: "none" };
  }
  if (type === "news") {
    const title = String(data.title ?? "").slice(0, 255);
    const url = String(data.url ?? "").slice(0, 2_000);
    return title && url ? {
      type,
      title,
      description: String(data.synopsis ?? data.description ?? "").slice(0, 500),
      image: String(data.image ?? (Array.isArray(data.image_input) ? data.image_input[0] : "") ?? "").slice(0, 2_000),
      url,
    } : { type: "none" };
  }
  return { type: "none" };
}

function newerThanWatermark(event: WechatCallbackEvent, watermark: {
  lastEventTime: number;
  lastSequenceRank: number;
  lastEventId: number;
}): boolean {
  if (event.eventTime !== watermark.lastEventTime) return event.eventTime > watermark.lastEventTime;
  if (event.sequenceRank !== watermark.lastSequenceRank) return event.sequenceRank > watermark.lastSequenceRank;
  return event.id > watermark.lastEventId;
}

export class WechatCallbackService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  private async config(source: WechatCallbackSource): Promise<CallbackConfig> {
    const appIdKey = source === "official" ? "wechat_appid" : "routine_appId";
    const appId = await new SystemConfigService(this.container, this.env).get(appIdKey);
    const token = source === "official"
      ? this.env.WECHAT_OFFICIAL_CALLBACK_TOKEN ?? ""
      : this.env.WECHAT_MINI_CALLBACK_TOKEN ?? "";
    const aesKey = source === "official"
      ? this.env.WECHAT_OFFICIAL_CALLBACK_AES_KEY ?? ""
      : this.env.WECHAT_MINI_CALLBACK_AES_KEY ?? "";
    if (!appId || appId.length > 64) throw new Error("wechat_callback_app_id_invalid");
    validateWechatCallbackSecret(token, aesKey);
    return { appId, token, aesKey };
  }

  async verifyChallenge(
    source: WechatCallbackSource,
    query: WechatCallbackQuery,
    echo: string,
  ): Promise<string> {
    const config = await this.config(source);
    if (query.msgSignature) {
      await verifyWechatEncryptedSignature(query, echo, config.token);
      return decryptWechatCallback(echo, config.aesKey, config.appId);
    }
    await verifyWechatPlainChallenge(query, echo, config.token);
    return echo;
  }

  async receiveEncrypted(
    source: WechatCallbackSource,
    query: WechatCallbackQuery,
    outerXml: string,
  ): Promise<ReceiveResult> {
    const config = await this.config(source);
    if (!query.msgSignature) throw new Error("wechat_callback_encrypted_mode_required");
    const encrypted = wechatEncryptedXmlValue(outerXml);
    await verifyWechatEncryptedSignature(query, encrypted, config.token);
    const plaintext = decryptWechatCallback(encrypted, config.aesKey, config.appId);
    const normalized = await normalizeWechatCallback(plaintext, source, config.appId);
    const reply = await this.resolveReply(normalized);
    const persisted = await this.persist(normalized, reply);
    const replyXml = buildWechatReplyXml({
      toUser: normalized.payload.fromUser,
      fromUser: normalized.payload.toUser,
      createTime: normalized.eventTime,
      reply: persisted.reply,
    });
    return {
      ...persisted,
      responseBody: replyXml
        ? await encryptWechatReply(replyXml, config.token, config.aesKey, config.appId)
        : "success",
    };
  }

  private async resolveReply(callback: NormalizedWechatCallback): Promise<Record<string, unknown>> {
    if (callback.source !== "official") return { type: "none" };
    return withTx(this.container, async (tx) => {
      let directReplyId = 0;
      if (callback.payload.ticket) {
        const qrRows = await tx.select({ thirdType: qrcode.thirdType, thirdId: qrcode.thirdId })
          .from(qrcode)
          .where(and(eq(qrcode.ticket, callback.payload.ticket), eq(qrcode.status, 1)))
          .orderBy(asc(qrcode.id))
          .limit(2);
        if (qrRows.length > 1) throw new Error("wechat_callback_qrcode_ambiguous");
        if (qrRows[0]?.thirdType === "reply") directReplyId = qrRows[0].thirdId;
      }
      if (directReplyId > 0) {
        const rows = await tx.select().from(wechatReply).where(and(
          eq(wechatReply.id, directReplyId), eq(wechatReply.status, 1), eq(wechatReply.hide, 0),
        )).limit(1);
        if (rows[0]) return replySnapshot(rows[0].type, rows[0].data);
      }
      const lookup = callback.replyLookupKey;
      if (lookup) {
        const keys = lookup === "subscribe" ? [lookup] : [lookup, "default"];
        const rows = await tx.select({
          keyId: wechatKey.id,
          key: wechatKey.keys,
          reply: wechatReply,
        }).from(wechatKey)
          .innerJoin(wechatReply, eq(wechatReply.id, wechatKey.replyId))
          .where(and(
            inArray(wechatKey.keys, keys),
            eq(wechatReply.status, 1),
            eq(wechatReply.hide, 0),
          ))
          .orderBy(sql`CASE WHEN ${wechatKey.keys} = ${lookup} THEN 0 ELSE 1 END`, asc(wechatKey.id), asc(wechatReply.id))
          .limit(1);
        if (rows[0]) return replySnapshot(rows[0].reply.type, rows[0].reply.data);
        return { type: "transfer" };
      }
      return { type: "none" };
    });
  }

  private async persist(
    callback: NormalizedWechatCallback,
    reply: Record<string, unknown>,
  ): Promise<{
    eventId: number;
    outboxId: number;
    replayKey: string;
    duplicate: boolean;
    reply: Record<string, unknown>;
  }> {
    const canonical = canonicalNormalized(callback);
    const [payloadHash, subjectKeyHash, eventKey] = await Promise.all([
      wechatCallbackSha("SHA-256", canonical),
      wechatCallbackSha("SHA-256", callback.subjectKey),
      wechatCallbackSha(
        "SHA-256",
        callback.payload.msgId
          ? `${callback.source}:${callback.appId}:msg:${callback.payload.msgId}`
          : canonical,
      ),
    ]);
    const now = Math.floor(Date.now() / 1000);
    const replayKey = crypto.randomUUID();
    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${callback.source}:${eventKey}`}, 0))`);
      const inserted = await tx.insert(wechatCallbackEvent).values({
        source: callback.source,
        eventKey,
        replayKey,
        payloadHash,
        subjectKeyHash,
        appId: callback.appId,
        fromUser: callback.payload.fromUser,
        msgType: callback.msgType,
        eventType: callback.eventType,
        eventTime: callback.eventTime,
        sequenceRank: callback.sequenceRank,
        payload: { ...callback.payload },
        replyPayload: reply,
        status: "RECEIVED",
        receivedTime: now,
        retainUntil: now + RETENTION_SECONDS,
        updateTime: now,
      }).onConflictDoNothing({
        target: [wechatCallbackEvent.source, wechatCallbackEvent.eventKey],
      }).returning({ id: wechatCallbackEvent.id });
      const events = await tx.select().from(wechatCallbackEvent).where(and(
        eq(wechatCallbackEvent.source, callback.source),
        eq(wechatCallbackEvent.eventKey, eventKey),
      )).limit(1).for("update");
      const event = events[0];
      if (!event) throw new Error("wechat_callback_event_insert_failed");
      if (
        event.payloadHash !== payloadHash
        || event.appId !== callback.appId
        || event.subjectKeyHash !== subjectKeyHash
        || event.eventTime !== callback.eventTime
        || event.sequenceRank !== callback.sequenceRank
      ) throw new Error("wechat_callback_immutable_conflict");
      await tx.insert(wechatCallbackOutbox).values({
        eventId: event.id,
        replayKey: event.replayKey,
        status: "PENDING",
        availableTime: now,
        addTime: now,
        updateTime: now,
      }).onConflictDoNothing({ target: wechatCallbackOutbox.eventId });
      const outboxes = await tx.select({
        id: wechatCallbackOutbox.id,
        replayKey: wechatCallbackOutbox.replayKey,
      }).from(wechatCallbackOutbox).where(eq(wechatCallbackOutbox.eventId, event.id)).limit(1);
      const outbox = outboxes[0];
      if (!outbox || outbox.replayKey !== event.replayKey) {
        throw new Error("wechat_callback_outbox_immutable_conflict");
      }
      return {
        eventId: event.id,
        outboxId: outbox.id,
        replayKey: event.replayKey,
        duplicate: inserted.length === 0,
        reply: event.replyPayload,
      };
    });
  }

  async dispatchPending(limit = 20, onlyOutboxId?: number): Promise<{ claimed: number; enqueued: number }> {
    const bounded = Math.max(1, Math.min(Math.trunc(limit), 100));
    const now = Math.floor(Date.now() / 1000);
    const leaseToken = crypto.randomUUID();
    const eligible = or(
      and(inArray(wechatCallbackOutbox.status, ["PENDING", "FAILED"]), lte(wechatCallbackOutbox.availableTime, now)),
      and(inArray(wechatCallbackOutbox.status, ["ENQUEUING", "ENQUEUED", "PROCESSING"]), lte(wechatCallbackOutbox.leaseUntil, now)),
    );
    const claimed = await withTx(this.container, async (tx) => {
      const rows = await tx.select({
        outboxId: wechatCallbackOutbox.id,
        eventId: wechatCallbackOutbox.eventId,
        replayKey: wechatCallbackOutbox.replayKey,
      }).from(wechatCallbackOutbox)
        .where(onlyOutboxId ? and(eq(wechatCallbackOutbox.id, onlyOutboxId), eligible) : eligible)
        .orderBy(asc(wechatCallbackOutbox.id)).limit(bounded).for("update", { skipLocked: true });
      if (!rows.length) return rows;
      await tx.update(wechatCallbackOutbox).set({
        status: "ENQUEUING",
        dispatchCount: sql`${wechatCallbackOutbox.dispatchCount} + 1`,
        leaseUntil: now + DISPATCH_LEASE_SECONDS,
        leaseToken,
        updateTime: now,
      }).where(inArray(wechatCallbackOutbox.id, rows.map((row) => row.outboxId)));
      return rows;
    });
    if (!claimed.length) return { claimed: 0, enqueued: 0 };
    try {
      await this.env.ORDER_QUEUE.sendBatch(claimed.map((event) => ({
        body: callbackMessage(event),
        contentType: "json" as const,
      })));
      await withTx(this.container, (tx) => tx.update(wechatCallbackOutbox).set({
        status: "ENQUEUED",
        leaseUntil: now + DELIVERY_LEASE_SECONDS,
        leaseToken: "",
        lastErrorCode: "",
        enqueuedTime: now,
        updateTime: now,
      }).where(and(
        inArray(wechatCallbackOutbox.id, claimed.map((row) => row.outboxId)),
        eq(wechatCallbackOutbox.status, "ENQUEUING"),
        eq(wechatCallbackOutbox.leaseToken, leaseToken),
      )));
      return { claimed: claimed.length, enqueued: claimed.length };
    } catch (error) {
      await withTx(this.container, (tx) => tx.update(wechatCallbackOutbox).set({
        status: "FAILED",
        leaseUntil: 0,
        leaseToken: "",
        availableTime: now + 60,
        lastErrorCode: "queue_dispatch_failed",
        updateTime: now,
      }).where(and(
        inArray(wechatCallbackOutbox.id, claimed.map((row) => row.outboxId)),
        eq(wechatCallbackOutbox.status, "ENQUEUING"),
        eq(wechatCallbackOutbox.leaseToken, leaseToken),
      )));
      throw error;
    }
  }

  dispatchById(outboxId: number): Promise<{ claimed: number; enqueued: number }> {
    return this.dispatchPending(1, outboxId);
  }

  async processMessage(message: WechatCallbackOutboxMessage): Promise<ProcessResult> {
    const claim = await this.claim(message);
    if (typeof claim === "string" || "kind" in claim) return claim;
    try {
      const type = projectionType(claim.event);
      if (type !== "scan" && await this.isSuperseded(claim.event, type)) {
        await this.finish(claim, type, {}, "SUPERSEDED");
        return "completed";
      }
      const prepared = await this.prepareProjection(claim.event, type);
      await this.finish(claim, type, prepared);
      if (prepared.payment && !prepared.payment.terminalConflict) {
        try {
          await new PaymentCallbackEventService(this.container, this.env)
            .dispatchById(prepared.payment.outboxId);
        } catch (error) {
          emitOperationalEvent("error", {
            event: "payment_callback_failed",
            component: "queue",
            operation: "wechat_social_payment_dispatch",
            outcome: "failure",
            errorCode: operationalErrorCode(error, "callback_dispatch_failed"),
          });
        }
      }
      return "completed";
    } catch (error) {
      if (await this.recordFailure(claim, error)) return "dead";
      throw error;
    }
  }

  private async claim(message: WechatCallbackOutboxMessage): Promise<ClaimedCallback | Exclude<ProcessResult, "completed">> {
    const now = Math.floor(Date.now() / 1000);
    const leaseToken = crypto.randomUUID();
    return withTx(this.container, async (tx) => {
      const outboxes = await tx.select().from(wechatCallbackOutbox)
        .where(eq(wechatCallbackOutbox.id, message.outboxId)).limit(1).for("update");
      const outbox = outboxes[0];
      const events = await tx.select().from(wechatCallbackEvent)
        .where(eq(wechatCallbackEvent.id, message.eventId)).limit(1).for("update");
      const event = events[0];
      if (!outbox || !event || outbox.eventId !== event.id
        || outbox.replayKey !== message.replayKey || event.replayKey !== message.replayKey) {
        throw new Error("wechat_callback_queue_message_mismatch");
      }
      if (outbox.status === "COMPLETED") return "already-completed";
      if (outbox.status === "DEAD" || event.status === "DEAD") return "dead";
      if (outbox.status === "PROCESSING" && outbox.leaseUntil > now) return "busy";
      if (outbox.availableTime > now) return { kind: "deferred" as const, delaySeconds: outbox.availableTime - now };
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${event.source}:${event.subjectKeyHash}`}, 0))`);
      const active = await tx.select({ id: wechatCallbackEvent.id }).from(wechatCallbackEvent).where(and(
        eq(wechatCallbackEvent.source, event.source),
        eq(wechatCallbackEvent.subjectKeyHash, event.subjectKeyHash),
        eq(wechatCallbackEvent.status, "PROCESSING"),
        sql`${wechatCallbackEvent.id} <> ${event.id}`,
        sql`${wechatCallbackEvent.leaseUntil} > ${now}`,
      )).limit(1);
      if (active[0]) return "busy";
      const attemptCount = Math.max(outbox.attemptCount, event.attemptCount) + 1;
      if (attemptCount > MAX_ATTEMPTS) {
        await tx.update(wechatCallbackOutbox).set({ status: "DEAD", leaseUntil: 0, leaseToken: "", lastErrorCode: "wechat_callback_attempts_exhausted", updateTime: now })
          .where(eq(wechatCallbackOutbox.id, outbox.id));
        await tx.update(wechatCallbackEvent).set({ status: "DEAD", leaseUntil: 0, leaseToken: "", lastErrorCode: "wechat_callback_attempts_exhausted", processedTime: now, updateTime: now })
          .where(eq(wechatCallbackEvent.id, event.id));
        return "dead";
      }
      await tx.update(wechatCallbackOutbox).set({ status: "PROCESSING", attemptCount, leaseUntil: now + PROCESS_LEASE_SECONDS, leaseToken, updateTime: now })
        .where(eq(wechatCallbackOutbox.id, outbox.id));
      await tx.update(wechatCallbackEvent).set({ status: "PROCESSING", attemptCount, leaseUntil: now + PROCESS_LEASE_SECONDS, leaseToken, updateTime: now })
        .where(eq(wechatCallbackEvent.id, event.id));
      return { event, outboxId: outbox.id, leaseToken, attemptCount };
    });
  }

  private async isSuperseded(event: WechatCallbackEvent, type: ProjectionType): Promise<boolean> {
    const rows = await withTx(this.container, (tx) => tx.select().from(wechatCallbackWatermark).where(and(
        eq(wechatCallbackWatermark.source, event.source),
        eq(wechatCallbackWatermark.projectionType, type),
        eq(wechatCallbackWatermark.subjectKeyHash, event.subjectKeyHash),
      )).limit(1));
    return !!rows[0] && !newerThanWatermark(event, rows[0]);
  }

  private async prepareProjection(event: WechatCallbackEvent, type: ProjectionType): Promise<PreparedProjection> {
    const payload = event.payload;
    const openid = String(payload.fromUser ?? event.fromUser);
    if (type === "follow" && event.eventType === "subscribe") {
      const createUser = await new SystemConfigService(this.container, this.env).get("create_wechat_user");
      if (["1", "true", "yes", "on"].includes(createUser.trim().toLowerCase())) {
        const prepared = await new WechatAuthService(this.container, this.env)
          .reconcileOfficialSubscriber(openid);
        await this.bindScanReferral(event, prepared.uid);
        return prepared;
      }
      const rows = await withTx(this.container, (tx) => tx.select({ uid: wechatUser.uid }).from(wechatUser).where(and(
          eq(wechatUser.openid, openid), eq(wechatUser.userType, "wechat"), eq(wechatUser.isDel, 0),
        )).limit(1));
      const prepared = { uid: rows[0]?.uid };
      await this.bindScanReferral(event, prepared.uid);
      return prepared;
    }
    if (type === "scan") {
      const users = await withTx(this.container, (tx) => tx.select({ uid: wechatUser.uid }).from(wechatUser).where(and(
          eq(wechatUser.openid, openid), eq(wechatUser.userType, "wechat"), eq(wechatUser.isDel, 0),
        )).limit(1));
      const uid = users[0]?.uid;
      await this.bindScanReferral(event, uid);
      return { uid };
    }
    if (type === "card" && event.eventType === "submit_membercard_user_info") {
      return {
        uid: await new WechatAuthService(this.container, this.env).reconcileOfficialMemberCard(
          openid,
          String(payload.cardId ?? ""),
          String(payload.cardCode ?? ""),
        ),
      };
    }
    if (type === "card") {
      const users = await withTx(this.container, (tx) => tx.select({ uid: wechatUser.uid }).from(wechatUser).where(and(
          eq(wechatUser.openid, openid), eq(wechatUser.userType, "wechat"), eq(wechatUser.isDel, 0),
        )).limit(1));
      return { uid: users[0]?.uid };
    }
    if (type === "payment") return { payment: await this.bridgePayment(event) };
    if (type === "receipt") return { receiptApplied: await this.applyReceipt(String(payload.orderNo ?? "")) };
    return {};
  }

  private async bindScanReferral(event: WechatCallbackEvent, uid?: number): Promise<void> {
    const ticket = String(event.payload.ticket ?? "");
    if (!uid || !ticket) return;
    const channels = await withTx(this.container, (tx) => tx.select({ uid: wechatQrcode.uid }).from(qrcode)
        .innerJoin(wechatQrcode, and(eq(qrcode.thirdType, "wechatqrcode"), eq(qrcode.thirdId, wechatQrcode.id)))
        .where(and(eq(qrcode.ticket, ticket), eq(qrcode.status, 1), eq(wechatQrcode.isDel, 0)))
        .limit(2));
    if (channels.length > 1) throw new Error("wechat_callback_qrcode_ambiguous");
    const spreadUid = channels[0]?.uid ?? 0;
    if (spreadUid > 0 && spreadUid !== uid) {
      // bindSpread is an independently idempotent local effect. It completes
      // before the callback projection transaction and is safe on redelivery.
      await new UserFinanceService(this.container).bindSpread(uid, spreadUid);
    }
  }

  private async bridgePayment(event: WechatCallbackEvent): Promise<{ outboxId: number; terminalConflict: boolean }> {
    const orderNo = String(event.payload.orderNo ?? "");
    const transactionId = String(event.payload.transactionId ?? "");
    const [store, recharge, membership] = await withTx(this.container, async (tx) => {
      const scoped = createContainerFromDb(tx);
      return Promise.all([
        scoped.storeOrderDao.findByOrderId(orderNo),
        findRechargeOrderByOrderId(scoped, orderNo),
        findMembershipOrderByOrderId(scoped, orderNo),
      ]);
    });
    if ([store, recharge, membership].filter(Boolean).length !== 1) {
      throw new Error(store || recharge || membership ? "order_domain_conflict" : "order_missing");
    }
    const amountCents = decimalToCents(String(store?.payPrice ?? recharge?.price ?? membership?.payPrice));
    const callback: VerifiedPaymentCallback = {
      provider: "wechat",
      profile: event.source === "mini" ? "routine" : "wechat",
      providerEventId: `social:${event.eventKey}`,
      orderNo,
      transactionId,
      tradeState: "SUCCESS",
      amountCents,
      currency: "CNY",
      providerEventTime: event.eventTime,
    };
    const result = await new PaymentCallbackEventService(this.container, this.env).receive(callback);
    return { outboxId: result.outboxId, terminalConflict: result.terminalConflict };
  }

  private async applyReceipt(providerOrderNo: string): Promise<boolean> {
    const candidates = [providerOrderNo];
    const parts = providerOrderNo.split("_");
    if (parts.length === 2 && parts[1]) candidates.push(parts[1]);
    const targets = await withTx(this.container, async (tx) => {
      const rows = await tx.select({ id: storeOrder.id, pid: storeOrder.pid }).from(storeOrder)
        .where(inArray(storeOrder.orderId, [...new Set(candidates)])).limit(2);
      if (rows.length > 1) throw new Error("wechat_callback_order_ambiguous");
      const order = rows[0];
      if (!order) return [];
      return order.pid === -1
        ? tx.select({ id: storeOrder.id }).from(storeOrder).where(and(
          eq(storeOrder.pid, order.id), eq(storeOrder.paid, 1), eq(storeOrder.status, 1),
        )).orderBy(asc(storeOrder.id))
        : [{ id: order.id }];
    });
    if (!targets.length) return false;
    let applied = false;
    for (const target of targets) {
      applied = await completeOrderReceipt(this.container, this.env, {
        orderId: target.id,
        actor: "scheduled",
        requireSystemVisible: true,
        message: "微信订单结算通知确认收货",
      }) || applied;
    }
    return applied;
  }

  private async finish(
    claim: ClaimedCallback,
    type: ProjectionType,
    prepared: PreparedProjection,
    forcedStatus?: "SUPERSEDED",
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await withTx(this.container, async (tx) => {
      const watermarks = await tx.select().from(wechatCallbackWatermark).where(and(
        eq(wechatCallbackWatermark.source, claim.event.source),
        eq(wechatCallbackWatermark.projectionType, type),
        eq(wechatCallbackWatermark.subjectKeyHash, claim.event.subjectKeyHash),
      )).limit(1).for("update");
      const watermark = watermarks[0];
      const additive = type === "scan";
      const superseded = forcedStatus === "SUPERSEDED"
        || (!additive && !!watermark && !newerThanWatermark(claim.event, watermark));
      let applied = false;
      // A QR subscribe event carries two semantics: stateful follow state and
      // an additive scan. A late subscribe must not regress follow state, but
      // its unique scan still counts exactly once with the event transaction.
      if (type === "follow" && claim.event.payload.ticket) {
        applied = await this.applyQrProjectionTx(tx, claim.event, prepared.uid, 1);
      }
      if (!superseded) {
        applied = await this.applyProjectionTx(tx, claim.event, type, prepared) || applied;
      }
      if (!watermark || newerThanWatermark(claim.event, watermark)) {
        await tx.insert(wechatCallbackWatermark).values({
          source: claim.event.source,
          projectionType: type,
          subjectKeyHash: claim.event.subjectKeyHash,
          lastEventId: claim.event.id,
          lastEventKey: claim.event.eventKey,
          lastEventTime: claim.event.eventTime,
          lastSequenceRank: claim.event.sequenceRank,
          updateTime: now,
        }).onConflictDoUpdate({
          target: [
            wechatCallbackWatermark.source,
            wechatCallbackWatermark.projectionType,
            wechatCallbackWatermark.subjectKeyHash,
          ],
          set: {
            lastEventId: claim.event.id,
            lastEventKey: claim.event.eventKey,
            lastEventTime: claim.event.eventTime,
            lastSequenceRank: claim.event.sequenceRank,
            updateTime: now,
          },
        });
      }
      const status = superseded ? "SUPERSEDED" : type === "ignored" ? "IGNORED" : applied ? "APPLIED" : "APPLIED_NOOP";
      const outboxes = await tx.update(wechatCallbackOutbox).set({
        status: "COMPLETED", leaseUntil: 0, leaseToken: "", lastErrorCode: "", processedTime: now, updateTime: now,
      }).where(and(
        eq(wechatCallbackOutbox.id, claim.outboxId),
        eq(wechatCallbackOutbox.status, "PROCESSING"),
        eq(wechatCallbackOutbox.leaseToken, claim.leaseToken),
      )).returning({ id: wechatCallbackOutbox.id });
      const events = await tx.update(wechatCallbackEvent).set({
        status, leaseUntil: 0, leaseToken: "", lastErrorCode: "", processedTime: now, updateTime: now,
      }).where(and(
        eq(wechatCallbackEvent.id, claim.event.id),
        eq(wechatCallbackEvent.status, "PROCESSING"),
        eq(wechatCallbackEvent.leaseToken, claim.leaseToken),
      )).returning({ id: wechatCallbackEvent.id });
      if (outboxes.length !== 1 || events.length !== 1) throw new Error("wechat_callback_processing_fence_lost");
    });
  }

  private async applyProjectionTx(
    tx: Parameters<Parameters<typeof withTx>[1]>[0],
    event: WechatCallbackEvent,
    type: ProjectionType,
    prepared: PreparedProjection,
  ): Promise<boolean> {
    const payload = event.payload;
    const openid = String(payload.fromUser ?? event.fromUser);
    if (type === "follow") {
      const subscribe = event.eventType === "subscribe" ? 1 : 0;
      const profile = prepared.profile;
      const updated = await tx.update(wechatUser).set({
        subscribe,
        subscribeTime: subscribe ? profile?.subscribeTime ?? event.eventTime : 0,
        ...(profile ? {
          unionid: profile.unionid,
          nickname: profile.nickname,
          headimgurl: profile.avatar,
          sex: profile.sex,
          language: profile.language,
          city: profile.city,
          province: profile.province,
          country: profile.country,
        } : {}),
      }).where(and(eq(wechatUser.openid, openid), eq(wechatUser.userType, "wechat"), eq(wechatUser.isDel, 0)))
        .returning({ id: wechatUser.id });
      return updated.length > 0;
    }
    if (type === "scan") {
      return this.applyQrProjectionTx(tx, event, prepared.uid, 0);
    }
    if (type === "card") {
      const cardId = String(payload.cardId ?? "");
      const code = String(payload.cardCode ?? "");
      const catalogs = await tx.select({ id: wechatCard.id }).from(wechatCard).where(and(
        eq(wechatCard.cardId, cardId), eq(wechatCard.status, 1), eq(wechatCard.isDel, 0),
      )).orderBy(asc(wechatCard.id)).limit(2);
      if (catalogs.length > 1) throw new Error("wechat_callback_card_catalog_ambiguous");
      const catalog = catalogs[0];
      if (event.eventType === "user_get_card") {
        if (!catalog) return false;
        const existing = await tx.select({ id: userCard.id }).from(userCard).where(and(
          eq(userCard.openid, openid), eq(userCard.cardId, cardId), eq(userCard.isDel, 0),
        )).orderBy(asc(userCard.id)).limit(2).for("update");
        if (existing.length > 1) throw new Error("wechat_callback_card_claim_ambiguous");
        if (existing[0]) {
          await tx.update(userCard).set({ code, staffId: Number(payload.outerId ?? 0) }).where(eq(userCard.id, existing[0].id));
        } else {
          await tx.insert(userCard).values({
            uid: prepared.uid ?? 0,
            spreadUid: 0,
            wechatCardId: catalog.id,
            cardId,
            code,
            storeId: 0,
            staffId: Number(payload.outerId ?? 0),
            openid,
            isSubmit: 0,
            submitTime: 0,
            isDel: 0,
            delTime: 0,
            addTime: event.eventTime,
          });
        }
        return true;
      }
      const existing = await tx.select({ id: userCard.id }).from(userCard).where(and(
        eq(userCard.openid, openid), eq(userCard.cardId, cardId), eq(userCard.isDel, 0),
      )).orderBy(asc(userCard.id)).limit(2).for("update");
      if (existing.length > 1) throw new Error("wechat_callback_card_claim_ambiguous");
      if (!existing[0]) return false;
      if (event.eventType === "submit_membercard_user_info") {
        await tx.update(userCard).set({ uid: prepared.uid ?? 0, isSubmit: 1, submitTime: event.eventTime })
          .where(eq(userCard.id, existing[0].id));
      } else {
        await tx.update(userCard).set({ isDel: 1, delTime: event.eventTime }).where(eq(userCard.id, existing[0].id));
      }
      return true;
    }
    if (type === "message") {
      await tx.insert(wechatMessage).values({
        openid,
        type: event.msgType === "event" ? event.eventType : event.msgType,
        result: JSON.stringify({
          source: event.source,
          msg_type: event.msgType,
          event_type: event.eventType,
          event_key: event.eventKey,
        }).slice(0, 512),
        addTime: event.eventTime,
      });
      return true;
    }
    if (type === "payment") return !!prepared.payment;
    if (type === "receipt") return prepared.receiptApplied === true;
    return false;
  }

  private async applyQrProjectionTx(
    tx: Parameters<Parameters<typeof withTx>[1]>[0],
    event: WechatCallbackEvent,
    uid: number | undefined,
    isFollow: 0 | 1,
  ): Promise<boolean> {
    const ticket = String(event.payload.ticket ?? "");
    if (!ticket) return false;
    const rows = await tx.select({ qr: qrcode, channel: wechatQrcode }).from(qrcode)
      .leftJoin(wechatQrcode, and(eq(qrcode.thirdType, "wechatqrcode"), eq(qrcode.thirdId, wechatQrcode.id)))
      .where(and(eq(qrcode.ticket, ticket), eq(qrcode.status, 1)))
      .orderBy(asc(qrcode.id)).limit(2).for("update", { of: qrcode });
    if (rows.length > 1) throw new Error("wechat_callback_qrcode_ambiguous");
    const row = rows[0];
    if (!row) return false;
    await tx.update(qrcode).set({ scan: sql`${qrcode.scan} + 1` }).where(eq(qrcode.id, row.qr.id));
    if (!row.channel || row.channel.isDel !== 0) return true;
    await tx.update(wechatQrcode).set({
      scan: sql`${wechatQrcode.scan} + 1`,
      ...(isFollow ? { follow: sql`${wechatQrcode.follow} + 1` } : {}),
    }).where(eq(wechatQrcode.id, row.channel.id));
    let resolvedUid = uid ?? 0;
    if (!resolvedUid) {
      const users = await tx.select({ uid: wechatUser.uid }).from(wechatUser).where(and(
        eq(wechatUser.openid, event.fromUser),
        eq(wechatUser.userType, "wechat"),
        eq(wechatUser.isDel, 0),
      )).limit(1);
      resolvedUid = users[0]?.uid ?? 0;
    }
    await tx.insert(wechatQrcodeRecord).values({
      qid: row.channel.id,
      uid: resolvedUid,
      isFollow,
      addTime: event.eventTime,
    });
    return true;
  }

  private async recordFailure(claim: ClaimedCallback, error: unknown): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    const dead = claim.attemptCount >= MAX_ATTEMPTS;
    const errorCode = callbackErrorCode(error);
    return withTx(this.container, async (tx) => {
      const outboxes = await tx.update(wechatCallbackOutbox).set({
        status: dead ? "DEAD" : "FAILED",
        leaseUntil: 0,
        leaseToken: "",
        lastErrorCode: errorCode,
        availableTime: dead ? 0 : now + retryDelay(claim.attemptCount),
        updateTime: now,
      }).where(and(
        eq(wechatCallbackOutbox.id, claim.outboxId),
        eq(wechatCallbackOutbox.status, "PROCESSING"),
        eq(wechatCallbackOutbox.leaseToken, claim.leaseToken),
      )).returning({ id: wechatCallbackOutbox.id });
      const events = await tx.update(wechatCallbackEvent).set({
        status: dead ? "DEAD" : "FAILED",
        leaseUntil: 0,
        leaseToken: "",
        lastErrorCode: errorCode,
        processedTime: dead ? now : 0,
        updateTime: now,
      }).where(and(
        eq(wechatCallbackEvent.id, claim.event.id),
        eq(wechatCallbackEvent.status, "PROCESSING"),
        eq(wechatCallbackEvent.leaseToken, claim.leaseToken),
      )).returning({ id: wechatCallbackEvent.id });
      if (!outboxes.length && !events.length) return false;
      if (outboxes.length !== 1 || events.length !== 1) throw new Error("wechat_callback_failure_fence_lost");
      return dead;
    });
  }
}

interface QueueControl {
  body: WechatCallbackOutboxMessage;
  attempts: number;
  ack(): void;
  retry(options: { delaySeconds: number }): void;
}

export async function consumeWechatCallbackMessage(
  message: QueueControl,
  service: Pick<WechatCallbackService, "processMessage">,
): Promise<void> {
  try {
    const result = await service.processMessage(message.body);
    if (result === "busy") {
      message.retry({ delaySeconds: 30 });
      return;
    }
    if (typeof result === "object") {
      message.retry({ delaySeconds: result.delaySeconds });
      return;
    }
    message.ack();
  } catch (error) {
    const delaySeconds = Math.min(30 * 2 ** Math.max(message.attempts - 1, 0), 900);
    emitOperationalEvent("error", {
      event: "wechat_callback_projection_failed",
      component: "queue",
      operation: "wechat_callback_projection",
      outcome: "retry",
      queueAttempt: message.attempts,
      retryDelaySeconds: delaySeconds,
      errorCode: operationalErrorCode(error),
    });
    message.retry({ delaySeconds });
  }
}
