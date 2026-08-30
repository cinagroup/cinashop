import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type {
  OrderMessage,
  WorkCallbackDispatchMessage,
  WorkCallbackOutboxMessage,
} from "@/env";
import type { Container, DbClient } from "@/lib/di";
import { createContainerFromDb, withTx } from "@/lib/di";
import {
  workClient,
  workClientFollow,
  workCallbackEvent,
  workCallbackOutbox,
  workCallbackWatermark,
  type WorkCallbackPayload,
} from "@/models/schema";
import {
  decryptCallbackCipher,
  encryptedXmlValue,
  normalizeDecryptedCallback,
  shaHex,
  validateCallbackSecret,
  verifyCallbackSignature,
  type CallbackQuery,
} from "@/services/work/EnterpriseWechatCallbackCrypto";
import { isEnterpriseWechatCorpId } from "@/services/work/EnterpriseWechatProviderClient";

const DISPATCH_LEASE_SECONDS = 120;
const DELIVERY_LEASE_SECONDS = 600;
const PROCESS_LEASE_SECONDS = 120;
const MAX_ATTEMPTS = 8;

export class EnterpriseWechatCallbackError extends Error {
  constructor(
    readonly errorCode: string,
    readonly kind: "configuration" | "authentication" | "input" | "storage",
  ) {
    super(errorCode);
    this.name = "EnterpriseWechatCallbackError";
  }
}

interface CallbackConfig {
  corpId: string;
  token: string;
  aesKey: string;
}

interface ClaimedCallback {
  outboxId: number;
  eventId: number;
  eventKey: string;
  subjectKeyHash: string;
  eventTime: number;
  sequenceRank: number;
  msgType: string;
  eventType: string;
  changeType: string;
  corpId: string;
  payload: WorkCallbackPayload;
  leaseToken: string;
  attemptCount: number;
}

type CallbackProcessResult =
  | "applied"
  | "applied-noop"
  | "refresh-required"
  | "ignored"
  | "superseded"
  | "already-completed"
  | "busy"
  | "dead";

export interface WorkCallbackEnvironment {
  WECHAT_WORK_CALLBACK_TOKEN?: string;
  WECHAT_WORK_CALLBACK_AES_KEY?: string;
  ORDER_QUEUE: Queue<OrderMessage>;
}

function isRecognizedEvent(event: Pick<ClaimedCallback, "msgType" | "eventType" | "changeType">): boolean {
  if (event.msgType !== "event") return false;
  const changes: Record<string, Set<string>> = {
    change_contact: new Set([
      "create_user", "update_user", "delete_user",
      "create_party", "update_party", "delete_party",
    ]),
    change_external_contact: new Set([
      "add_external_contact", "edit_external_contact", "del_external_contact",
      "del_follow_user",
    ]),
    change_external_chat: new Set(["create", "update", "dismiss"]),
    change_external_tag: new Set(["create", "update", "delete"]),
  };
  const allowed = changes[event.eventType];
  return Boolean(allowed?.has(event.changeType));
}

function isFollowRemovalEvent(
  event: Pick<ClaimedCallback, "msgType" | "eventType" | "changeType">,
): boolean {
  return event.msgType === "event"
    && event.eventType === "change_external_contact"
    && (event.changeType === "del_external_contact" || event.changeType === "del_follow_user");
}

function projectionIdentifier(payload: WorkCallbackPayload, field: string): string {
  const value = typeof payload[field] === "string" ? payload[field] as string : "";
  if (
    !value
    || new TextEncoder().encode(value).byteLength > 64
    || /[\u0000-\u001f\u007f]/.test(value)
  ) throw new Error("callback_projection_field_invalid");
  return value;
}

function retryDelay(attempt: number): number {
  return Math.min(30 * 2 ** Math.max(0, Math.min(attempt, MAX_ATTEMPTS) - 1), 3600);
}

function errorCode(error: unknown): string {
  if (error instanceof EnterpriseWechatCallbackError) return error.errorCode.slice(0, 64);
  const candidate = error instanceof Error ? error.message : String(error);
  return /^[a-z0-9_:-]{1,64}$/i.test(candidate) ? candidate : "callback_processing_failed";
}

function callbackMessage(event: { outboxId: number; eventId: number; eventKey: string }): WorkCallbackOutboxMessage {
  return {
    action: "processWorkCallbackOutbox",
    outboxId: event.outboxId,
    eventId: event.eventId,
    eventKey: event.eventKey,
  };
}

export function isWorkCallbackOutboxMessage(value: unknown): value is WorkCallbackOutboxMessage {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).length === 4
    && ["action", "outboxId", "eventId", "eventKey"].every((key) => Object.hasOwn(item, key))
    && item.action === "processWorkCallbackOutbox"
    && Number.isSafeInteger(item.outboxId) && Number(item.outboxId) > 0
    && Number.isSafeInteger(item.eventId) && Number(item.eventId) > 0
    && typeof item.eventKey === "string"
    && /^[0-9a-f]{64}$/.test(item.eventKey);
}

export function isWorkCallbackDispatchMessage(value: unknown): value is WorkCallbackDispatchMessage {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).length === 2
    && item.action === "dispatchWorkCallbackOutbox"
    && typeof item.scheduledAt === "number"
    && Number.isSafeInteger(item.scheduledAt)
    && item.scheduledAt > 0;
}

export class EnterpriseWechatCallbackService {
  constructor(
    private readonly container: Container,
    private readonly env: WorkCallbackEnvironment,
  ) {}

  async verifyUrl(query: CallbackQuery, encryptedEcho: string): Promise<string> {
    const config = await this.config();
    try {
      await verifyCallbackSignature(query, encryptedEcho, config.token);
      return decryptCallbackCipher(encryptedEcho, config.aesKey, config.corpId);
    } catch (error) {
      throw this.protocolError(error);
    }
  }

  async receive(query: CallbackQuery, wrapperXml: string): Promise<{
    eventId: number;
    outboxId: number;
    eventKey: string;
    duplicate: boolean;
  }> {
    const config = await this.config();
    let normalized: ReturnType<typeof normalizeDecryptedCallback>;
    let payloadHash: string;
    let eventKey: string;
    let subjectKeyHash: string;
    try {
      const encrypted = encryptedXmlValue(wrapperXml);
      await verifyCallbackSignature(query, encrypted, config.token);
      const decrypted = decryptCallbackCipher(encrypted, config.aesKey, config.corpId);
      normalized = normalizeDecryptedCallback(decrypted, config.corpId);
      const canonical = JSON.stringify(normalized.payload);
      payloadHash = await shaHex("SHA-256", canonical);
      eventKey = await shaHex("SHA-256", `${config.corpId}\0${payloadHash}`);
      subjectKeyHash = await shaHex(
        "SHA-256",
        `${config.corpId}\0${normalized.subjectKey}`,
      );
    } catch (error) {
      throw this.protocolError(error);
    }

    const now = Math.floor(Date.now() / 1000);
    try {
      return await withTx(this.container, async (tx) => {
        const inserted = await tx.insert(workCallbackEvent).values({
          eventKey,
          payloadHash,
          subjectKeyHash,
          corpId: normalized.corpId,
          msgType: normalized.msgType,
          eventType: normalized.eventType,
          changeType: normalized.changeType,
          eventTime: normalized.eventTime,
          sequenceRank: normalized.sequenceRank,
          payload: normalized.payload,
          status: "RECEIVED",
          receivedTime: now,
          updateTime: now,
        }).onConflictDoNothing({ target: workCallbackEvent.eventKey }).returning({
          id: workCallbackEvent.id,
        });

        const rows = await tx.select({
          id: workCallbackEvent.id,
          payloadHash: workCallbackEvent.payloadHash,
          subjectKeyHash: workCallbackEvent.subjectKeyHash,
          corpId: workCallbackEvent.corpId,
          eventTime: workCallbackEvent.eventTime,
          sequenceRank: workCallbackEvent.sequenceRank,
        }).from(workCallbackEvent).where(eq(workCallbackEvent.eventKey, eventKey)).limit(1);
        const event = rows[0];
        if (!event) throw new Error("callback_event_insert_failed");
        if (
          event.payloadHash !== payloadHash
          || event.subjectKeyHash !== subjectKeyHash
          || event.corpId !== normalized.corpId
          || event.eventTime !== normalized.eventTime
          || event.sequenceRank !== normalized.sequenceRank
        ) throw new Error("callback_event_immutable_conflict");

        await tx.insert(workCallbackOutbox).values({
          eventId: event.id,
          eventKey,
          status: "PENDING",
          availableTime: now,
          addTime: now,
          updateTime: now,
        }).onConflictDoNothing({ target: workCallbackOutbox.eventId });
        const outboxRows = await tx.select({
          id: workCallbackOutbox.id,
          eventKey: workCallbackOutbox.eventKey,
        }).from(workCallbackOutbox).where(eq(workCallbackOutbox.eventId, event.id)).limit(1);
        const outbox = outboxRows[0];
        if (!outbox || outbox.eventKey !== eventKey) {
          throw new Error("callback_outbox_immutable_conflict");
        }
        return {
          eventId: event.id,
          outboxId: outbox.id,
          eventKey,
          duplicate: inserted.length === 0,
        };
      });
    } catch (error) {
      if (error instanceof EnterpriseWechatCallbackError) throw error;
      throw new EnterpriseWechatCallbackError(errorCode(error), "storage");
    }
  }

  async dispatchPending(limit = 20, onlyOutboxId?: number): Promise<{ claimed: number; enqueued: number }> {
    const bounded = Math.max(1, Math.min(Math.trunc(limit), 100));
    const now = Math.floor(Date.now() / 1000);
    const leaseToken = crypto.randomUUID();
    const eligible = or(
      and(
        inArray(workCallbackOutbox.status, ["PENDING", "FAILED"]),
        lte(workCallbackOutbox.availableTime, now),
      ),
      and(
        inArray(workCallbackOutbox.status, ["ENQUEUING", "ENQUEUED", "PROCESSING"]),
        lte(workCallbackOutbox.leaseUntil, now),
      ),
    );
    const claimed = await withTx(this.container, async (tx) => {
      const rows = await tx.select({
        outboxId: workCallbackOutbox.id,
        eventId: workCallbackOutbox.eventId,
        eventKey: workCallbackOutbox.eventKey,
      }).from(workCallbackOutbox)
        .where(onlyOutboxId
          ? and(eq(workCallbackOutbox.id, onlyOutboxId), eligible)
          : eligible)
        .orderBy(asc(workCallbackOutbox.id))
        .limit(bounded)
        .for("update", { skipLocked: true });
      if (!rows.length) return rows;
      await tx.update(workCallbackOutbox).set({
        status: "ENQUEUING",
        dispatchCount: sql`${workCallbackOutbox.dispatchCount} + 1`,
        leaseUntil: now + DISPATCH_LEASE_SECONDS,
        leaseToken,
        updateTime: now,
      }).where(inArray(workCallbackOutbox.id, rows.map((row) => row.outboxId)));
      return rows;
    });
    if (!claimed.length) return { claimed: 0, enqueued: 0 };

    try {
      await this.env.ORDER_QUEUE.sendBatch(claimed.map((event) => ({
        body: callbackMessage(event),
        contentType: "json" as const,
      })));
      await withTx(this.container, (tx) => tx.update(workCallbackOutbox).set({
          status: "ENQUEUED",
          leaseUntil: now + DELIVERY_LEASE_SECONDS,
          leaseToken: "",
          lastErrorCode: "",
          enqueuedTime: now,
          updateTime: now,
        }).where(and(
          inArray(workCallbackOutbox.id, claimed.map((row) => row.outboxId)),
          eq(workCallbackOutbox.status, "ENQUEUING"),
          eq(workCallbackOutbox.leaseToken, leaseToken),
        )));
      return { claimed: claimed.length, enqueued: claimed.length };
    } catch (error) {
      await withTx(this.container, (tx) => tx.update(workCallbackOutbox).set({
          status: "FAILED",
          leaseUntil: 0,
          leaseToken: "",
          availableTime: now + 60,
          lastErrorCode: "queue_dispatch_failed",
          updateTime: now,
        }).where(and(
          inArray(workCallbackOutbox.id, claimed.map((row) => row.outboxId)),
          eq(workCallbackOutbox.status, "ENQUEUING"),
          eq(workCallbackOutbox.leaseToken, leaseToken),
        )));
      throw error;
    }
  }

  async dispatchById(outboxId: number): Promise<{ claimed: number; enqueued: number }> {
    return this.dispatchPending(1, outboxId);
  }

  async processMessage(message: WorkCallbackOutboxMessage): Promise<CallbackProcessResult> {
    const claim = await this.claim(message);
    if (typeof claim === "string") return claim;
    try {
      return await this.applyOrdering(claim);
    } catch (error) {
      await this.recordFailure(claim, error);
      throw error;
    }
  }

  private async config(): Promise<CallbackConfig> {
    let rawCorpId: string;
    try {
      rawCorpId = await withTx(this.container, (tx) =>
        createContainerFromDb(tx).systemConfigDao.getValue("wechat_work_corpid"));
    } catch (error) {
      throw new EnterpriseWechatCallbackError(errorCode(error), "storage");
    }
    const corpId = typeof rawCorpId === "string" ? rawCorpId.trim() : "";
    const token = this.env.WECHAT_WORK_CALLBACK_TOKEN?.trim() ?? "";
    const aesKey = this.env.WECHAT_WORK_CALLBACK_AES_KEY?.trim() ?? "";
    if (!isEnterpriseWechatCorpId(corpId)) {
      throw new EnterpriseWechatCallbackError("callback_corp_id_unconfigured", "configuration");
    }
    try {
      validateCallbackSecret(token, aesKey);
    } catch (error) {
      throw new EnterpriseWechatCallbackError(errorCode(error), "configuration");
    }
    return { corpId, token, aesKey };
  }

  private protocolError(error: unknown): EnterpriseWechatCallbackError {
    const code = errorCode(error);
    const authentication = code === "callback_signature_invalid"
      || code === "callback_receive_id_mismatch"
      || code === "callback_corp_mismatch";
    return new EnterpriseWechatCallbackError(code, authentication ? "authentication" : "input");
  }

  private async claim(message: WorkCallbackOutboxMessage): Promise<ClaimedCallback | "already-completed" | "busy" | "dead"> {
    const now = Math.floor(Date.now() / 1000);
    const leaseToken = crypto.randomUUID();
    return withTx(this.container, async (tx) => {
      const rows = await tx.select({
        outboxId: workCallbackOutbox.id,
        eventId: workCallbackOutbox.eventId,
        eventKey: workCallbackOutbox.eventKey,
        outboxStatus: workCallbackOutbox.status,
        outboxLeaseUntil: workCallbackOutbox.leaseUntil,
        attemptCount: workCallbackOutbox.attemptCount,
        subjectKeyHash: workCallbackEvent.subjectKeyHash,
        eventTime: workCallbackEvent.eventTime,
        sequenceRank: workCallbackEvent.sequenceRank,
        msgType: workCallbackEvent.msgType,
        eventType: workCallbackEvent.eventType,
        changeType: workCallbackEvent.changeType,
        corpId: workCallbackEvent.corpId,
        payload: workCallbackEvent.payload,
      }).from(workCallbackOutbox)
        .innerJoin(workCallbackEvent, eq(workCallbackEvent.id, workCallbackOutbox.eventId))
        .where(eq(workCallbackOutbox.id, message.outboxId))
        .limit(1)
        .for("update", { of: workCallbackOutbox });
      const row = rows[0];
      if (!row || row.eventId !== message.eventId || row.eventKey !== message.eventKey) {
        throw new Error("callback_queue_message_mismatch");
      }
      if (row.outboxStatus === "COMPLETED") return "already-completed";
      if (row.outboxStatus === "DEAD") return "dead";
      if (row.outboxStatus === "PROCESSING" && row.outboxLeaseUntil > now) return "busy";
      const attemptCount = row.attemptCount + 1;
      if (attemptCount > MAX_ATTEMPTS) {
        await tx.update(workCallbackOutbox).set({
          status: "DEAD", leaseUntil: 0, leaseToken: "",
          lastErrorCode: "attempt_limit_exceeded", updateTime: now,
        }).where(eq(workCallbackOutbox.id, row.outboxId));
        await tx.update(workCallbackEvent).set({
          status: "DEAD", projectionStatus: "DEAD",
          lastErrorCode: "attempt_limit_exceeded", updateTime: now,
        }).where(eq(workCallbackEvent.id, row.eventId));
        return "dead";
      }
      await tx.update(workCallbackOutbox).set({
        status: "PROCESSING",
        attemptCount,
        leaseUntil: now + PROCESS_LEASE_SECONDS,
        leaseToken,
        updateTime: now,
      }).where(eq(workCallbackOutbox.id, row.outboxId));
      await tx.update(workCallbackEvent).set({
        status: "PROCESSING",
        projectionStatus: "PROCESSING",
        attemptCount,
        leaseUntil: now + PROCESS_LEASE_SECONDS,
        leaseToken,
        updateTime: now,
      }).where(eq(workCallbackEvent.id, row.eventId));
      return { ...row, leaseToken, attemptCount };
    });
  }

  private async applyOrdering(
    claim: ClaimedCallback,
  ): Promise<"applied" | "applied-noop" | "refresh-required" | "ignored" | "superseded"> {
    const now = Math.floor(Date.now() / 1000);
    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${claim.subjectKeyHash}, 0))`);
      const outboxRows = await tx.select({
        status: workCallbackOutbox.status,
        leaseToken: workCallbackOutbox.leaseToken,
      }).from(workCallbackOutbox).where(eq(workCallbackOutbox.id, claim.outboxId)).limit(1).for("update");
      if (outboxRows[0]?.status !== "PROCESSING" || outboxRows[0].leaseToken !== claim.leaseToken) {
        throw new Error("callback_processing_lease_lost");
      }

      let result: "applied" | "applied-noop" | "refresh-required" | "ignored" | "superseded"
        = "refresh-required";
      let projectionStatus = "REFRESH_REQUIRED";
      if (!isRecognizedEvent(claim)) {
        result = "ignored";
        projectionStatus = "IGNORED";
      } else {
        const watermarkRows = await tx.select().from(workCallbackWatermark)
          .where(eq(workCallbackWatermark.subjectKeyHash, claim.subjectKeyHash))
          .limit(1)
          .for("update");
        const watermark = watermarkRows[0];
        const older = watermark && (
          watermark.eventTime > claim.eventTime
          || (watermark.eventTime === claim.eventTime && watermark.sequenceRank > claim.sequenceRank)
          || (watermark.eventTime === claim.eventTime
            && watermark.sequenceRank === claim.sequenceRank
            && watermark.eventId > claim.eventId)
        );
        if (older) {
          result = "superseded";
          projectionStatus = "SUPERSEDED";
        } else {
          if (
            !watermark
            || watermark.eventTime < claim.eventTime
            || watermark.sequenceRank < claim.sequenceRank
            || (watermark.eventTime === claim.eventTime
              && watermark.sequenceRank === claim.sequenceRank
              && watermark.eventId < claim.eventId)
          ) {
            await tx.insert(workCallbackWatermark).values({
              subjectKeyHash: claim.subjectKeyHash,
              eventTime: claim.eventTime,
              sequenceRank: claim.sequenceRank,
              eventId: claim.eventId,
              eventKey: claim.eventKey,
              updateTime: now,
            }).onConflictDoUpdate({
              target: workCallbackWatermark.subjectKeyHash,
              set: {
                eventTime: claim.eventTime,
                sequenceRank: claim.sequenceRank,
                eventId: claim.eventId,
                eventKey: claim.eventKey,
                updateTime: now,
              },
            });
          }
          if (isFollowRemovalEvent(claim)) {
            const changed = await this.applyFollowRemoval(tx, claim, now);
            result = changed ? "applied" : "applied-noop";
            projectionStatus = changed ? "APPLIED" : "APPLIED_NOOP";
          }
        }
      }

      await tx.update(workCallbackEvent).set({
        status: "ORDERED",
        projectionStatus,
        leaseUntil: 0,
        leaseToken: "",
        lastErrorCode: "",
        processedTime: now,
        updateTime: now,
      }).where(and(
        eq(workCallbackEvent.id, claim.eventId),
        eq(workCallbackEvent.leaseToken, claim.leaseToken),
      ));
      await tx.update(workCallbackOutbox).set({
        status: "COMPLETED",
        leaseUntil: 0,
        leaseToken: "",
        lastErrorCode: "",
        processedTime: now,
        updateTime: now,
      }).where(and(
        eq(workCallbackOutbox.id, claim.outboxId),
        eq(workCallbackOutbox.leaseToken, claim.leaseToken),
      ));
      return result;
    });
  }

  private async applyFollowRemoval(
    tx: DbClient,
    claim: ClaimedCallback,
    now: number,
  ): Promise<boolean> {
    const externalUserid = projectionIdentifier(claim.payload, "ExternalUserID");
    const userid = projectionIdentifier(claim.payload, "UserID");
    const clients = await tx.select({ id: workClient.id }).from(workClient).where(and(
      eq(workClient.corpId, claim.corpId),
      eq(workClient.externalUserid, externalUserid),
      isNull(workClient.deleteTime),
    )).limit(2).for("update");
    if (clients.length > 1) throw new Error("callback_client_identity_ambiguous");
    if (!clients[0]) return false;

    const updated = await tx.update(workClientFollow).set({
      isDelUser: 1,
      updateTime: now,
    }).where(and(
      eq(workClientFollow.clientId, clients[0].id),
      eq(workClientFollow.userid, userid),
      eq(workClientFollow.isDelUser, 0),
    )).returning({ id: workClientFollow.id });
    if (updated.length > 1) throw new Error("callback_follow_identity_ambiguous");
    return updated.length === 1;
  }

  private async recordFailure(claim: ClaimedCallback, error: unknown): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const dead = claim.attemptCount >= MAX_ATTEMPTS;
    const code = errorCode(error);
    await withTx(this.container, async (tx) => {
      await tx.update(workCallbackOutbox).set({
        status: dead ? "DEAD" : "FAILED",
        leaseUntil: 0,
        leaseToken: "",
        lastErrorCode: code,
        availableTime: dead ? 0 : now + retryDelay(claim.attemptCount),
        updateTime: now,
      }).where(and(
        eq(workCallbackOutbox.id, claim.outboxId),
        eq(workCallbackOutbox.leaseToken, claim.leaseToken),
      ));
      await tx.update(workCallbackEvent).set({
        status: dead ? "DEAD" : "FAILED",
        projectionStatus: dead ? "DEAD" : "FAILED",
        leaseUntil: 0,
        leaseToken: "",
        lastErrorCode: code,
        updateTime: now,
      }).where(and(
        eq(workCallbackEvent.id, claim.eventId),
        eq(workCallbackEvent.leaseToken, claim.leaseToken),
      ));
    });
  }
}

interface WorkCallbackQueueMessageControl {
  body: WorkCallbackOutboxMessage;
  attempts: number;
  ack(): void;
  retry(options: { delaySeconds: number }): void;
}

/** Keep Queue acknowledgement coupled to the durable callback process result. */
export async function consumeWorkCallbackQueueMessage(
  message: WorkCallbackQueueMessageControl,
  service: Pick<EnterpriseWechatCallbackService, "processMessage">,
): Promise<void> {
  try {
    const result = await service.processMessage(message.body);
    if (result === "busy") {
      message.retry({ delaySeconds: 30 });
      return;
    }
    console.log(JSON.stringify({
      event: "work_callback_pipeline_consumed",
      eventId: message.body.eventId,
      outboxId: message.body.outboxId,
      result,
      queueAttempt: message.attempts,
    }));
    message.ack();
  } catch (error) {
    const delaySeconds = Math.min(30 * 2 ** Math.max(message.attempts - 1, 0), 900);
    console.error(JSON.stringify({
      event: "work_callback_pipeline_failed",
      eventId: message.body.eventId,
      outboxId: message.body.outboxId,
      queueAttempt: message.attempts,
      retryDelaySeconds: delaySeconds,
      error: error instanceof Error && /^[a-z0-9_:-]{1,64}$/i.test(error.message)
        ? error.message
        : "callback_processing_failed",
    }));
    message.retry({ delaySeconds });
  }
}
