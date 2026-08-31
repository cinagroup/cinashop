import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  lte,
  ne,
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
import {
  EnterpriseWechatProviderClient,
  EnterpriseWechatProviderError,
  isEnterpriseWechatCorpId,
} from "@/services/work/EnterpriseWechatProviderClient";
import {
  EnterpriseWechatMemberProjectionError,
  isMemberProjectionEvent,
  memberProjectionIdentity,
  prepareMemberProjection,
  type PreparedMemberProjection,
} from "@/services/work/EnterpriseWechatMemberProjection";
import {
  applyMemberCurrentProjection,
  compareMemberProjectionFence,
  lockMemberProjectionIdentities,
  recordParkedMemberProjectionSeen,
  recordMemberProjectionSeen,
} from "@/services/work/EnterpriseWechatMemberCurrentService";
import {
  EnterpriseWechatDepartmentProjectionError,
  isDepartmentProjectionEvent,
  prepareDepartmentProjection,
  type PreparedDepartmentProjection,
} from "@/services/work/EnterpriseWechatDepartmentProjection";
import {
  applyDepartmentCurrentProjection,
  lockDepartmentProjectionCorp,
  recordDepartmentProjectionSeen,
} from "@/services/work/EnterpriseWechatDepartmentCurrentService";
import {
  EnterpriseWechatClientProjectionError,
  isClientProjectionEvent,
  prepareClientProjection,
  type PreparedClientProjection,
} from "@/services/work/EnterpriseWechatClientProjection";
import {
  applyClientCurrentProjection,
  lockClientProjectionIdentity,
  recordClientProjectionSeen,
} from "@/services/work/EnterpriseWechatClientCurrentService";
import {
  EnterpriseWechatGroupChatProjectionError,
  isGroupChatProjectionEvent,
  prepareGroupChatProjection,
  type PreparedGroupChatProjection,
} from "@/services/work/EnterpriseWechatGroupChatProjection";
import {
  applyGroupChatCurrentProjection,
  lockGroupChatProjectionIdentity,
  recordGroupChatProjectionSeen,
} from "@/services/work/EnterpriseWechatGroupChatCurrentService";
import {
  EnterpriseWechatExternalTagProjectionError,
  isExternalTagProjectionEvent,
  prepareExternalTagProjection,
  type PreparedExternalTagProjection,
} from "@/services/work/EnterpriseWechatExternalTagProjection";
import {
  applyExternalTagCurrentProjection,
  lockExternalTagProjectionCatalog,
  recordExternalTagProjectionSeen,
} from "@/services/work/EnterpriseWechatExternalTagCurrentService";

const DISPATCH_LEASE_SECONDS = 120;
const DELIVERY_LEASE_SECONDS = 600;
const PROCESS_LEASE_SECONDS = 120;
const MAX_ATTEMPTS = 8;
const MEMBER_PROJECTION_DISABLED = "member_projection_disabled";
const DEPARTMENT_PROJECTION_DISABLED = "department_projection_disabled";
const CLIENT_PROJECTION_DISABLED = "client_projection_disabled";
const GROUP_CHAT_PROJECTION_DISABLED = "group_chat_projection_disabled";
const EXTERNAL_TAG_PROJECTION_DISABLED = "external_tag_projection_disabled";
const MAX_DISPATCH_DRAIN_ITEMS = 100;

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
  clientProfileFenceEventIdAtFetch?: number;
}

type CallbackProcessResult =
  | "applied"
  | "applied-noop"
  | "refresh-required"
  | "ignored"
  | "superseded"
  | "already-completed"
  | "busy"
  | "dead"
  | { kind: "deferred"; delaySeconds: number }
  | { kind: "parked" };

export interface WorkCallbackEnvironment {
  WECHAT_WORK_CALLBACK_TOKEN?: string;
  WECHAT_WORK_CALLBACK_AES_KEY?: string;
  CONFIG_KV?: KVNamespace;
  WECHAT_WORK_CORP_SECRET?: string;
  WECHAT_WORK_AGENT_SECRET?: string;
  WECHAT_WORK_DIRECTORY_SECRET?: string;
  WECHAT_WORK_DIRECTORY_FULL_VISIBILITY?: string;
  WECHAT_WORK_MEMBER_CURRENT_AUTHORITY?: string;
  WECHAT_WORK_DEPARTMENT_CURRENT_AUTHORITY?: string;
  WECHAT_WORK_EXTERNAL_CONTACT_SECRET?: string;
  WECHAT_WORK_EXTERNAL_CONTACT_FULL_VISIBILITY?: string;
  WECHAT_WORK_CLIENT_CURRENT_AUTHORITY?: string;
  WECHAT_WORK_GROUP_CHAT_CURRENT_AUTHORITY?: string;
  WECHAT_WORK_TAG_CURRENT_AUTHORITY?: string;
  ORDER_QUEUE: Queue<OrderMessage>;
}

type DirectoryProjectionProvider = Partial<Pick<
  EnterpriseWechatProviderClient,
  | "directoryMember"
  | "directoryDepartment"
  | "externalContact"
  | "externalGroupChat"
  | "corpTagList"
  | "strategyTagList"
>>;
export type DirectoryMemberProviderFactory = (corpId: string) => DirectoryProjectionProvider;

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
    change_external_tag: new Set(["create", "update", "delete", "shuffle"]),
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
  if (error instanceof EnterpriseWechatMemberProjectionError) return error.errorCode.slice(0, 64);
  if (error instanceof EnterpriseWechatDepartmentProjectionError) return error.errorCode.slice(0, 64);
  if (error instanceof EnterpriseWechatClientProjectionError) return error.errorCode.slice(0, 64);
  if (error instanceof EnterpriseWechatGroupChatProjectionError) return error.errorCode.slice(0, 64);
  if (error instanceof EnterpriseWechatExternalTagProjectionError) return error.errorCode.slice(0, 64);
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
    private readonly directoryProviderFactory: DirectoryMemberProviderFactory = (corpId) => {
      if (!env.CONFIG_KV) {
        throw new EnterpriseWechatProviderError("configuration", "work_provider_config", -1, 0);
      }
      return new EnterpriseWechatProviderClient({
        CONFIG_KV: env.CONFIG_KV,
        WECHAT_WORK_CORP_SECRET: env.WECHAT_WORK_CORP_SECRET,
        WECHAT_WORK_AGENT_SECRET: env.WECHAT_WORK_AGENT_SECRET,
        WECHAT_WORK_DIRECTORY_SECRET: env.WECHAT_WORK_DIRECTORY_SECRET,
        WECHAT_WORK_EXTERNAL_CONTACT_SECRET: env.WECHAT_WORK_EXTERNAL_CONTACT_SECRET,
      }, { corpId });
    },
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
    const failedEligibility = or(
      and(
        lte(workCallbackOutbox.availableTime, now),
        ne(workCallbackOutbox.lastErrorCode, MEMBER_PROJECTION_DISABLED),
        ne(workCallbackOutbox.lastErrorCode, DEPARTMENT_PROJECTION_DISABLED),
        ne(workCallbackOutbox.lastErrorCode, CLIENT_PROJECTION_DISABLED),
        ne(workCallbackOutbox.lastErrorCode, GROUP_CHAT_PROJECTION_DISABLED),
        ne(workCallbackOutbox.lastErrorCode, EXTERNAL_TAG_PROJECTION_DISABLED),
      ),
      this.memberCurrentAuthorityEnabled()
        ? eq(workCallbackOutbox.lastErrorCode, MEMBER_PROJECTION_DISABLED)
        : sql`false`,
      this.departmentCurrentAuthorityEnabled()
        ? eq(workCallbackOutbox.lastErrorCode, DEPARTMENT_PROJECTION_DISABLED)
        : sql`false`,
      this.clientCurrentAuthorityEnabled()
        && this.externalContactFullVisibilityEnabled()
        ? eq(workCallbackOutbox.lastErrorCode, CLIENT_PROJECTION_DISABLED)
        : sql`false`,
      this.groupChatCurrentAuthorityEnabled()
        && this.externalContactFullVisibilityEnabled()
        ? eq(workCallbackOutbox.lastErrorCode, GROUP_CHAT_PROJECTION_DISABLED)
        : sql`false`,
      this.externalTagCurrentAuthorityEnabled()
        && this.externalContactFullVisibilityEnabled()
        ? eq(workCallbackOutbox.lastErrorCode, EXTERNAL_TAG_PROJECTION_DISABLED)
        : sql`false`,
    );
    const eligible = or(
      and(
        eq(workCallbackOutbox.status, "PENDING"),
        lte(workCallbackOutbox.availableTime, now),
      ),
      and(
        eq(workCallbackOutbox.status, "FAILED"),
        failedEligibility,
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

  /**
   * Drain a bounded number of durable outbox pages from one scheduled root job.
   * Parked member/department rows are selected automatically only after their
   * authority gate opens; the global item cap prevents one replay backlog from
   * monopolizing a Worker invocation.
   */
  async dispatchPendingPages(
    pageSize = 20,
    maxPages = 5,
  ): Promise<{ claimed: number; enqueued: number; batches: number }> {
    const boundedPageSize = Math.max(1, Math.min(Math.trunc(pageSize), 100));
    const boundedPageCount = Math.max(1, Math.min(
      Math.trunc(maxPages),
      Math.ceil(MAX_DISPATCH_DRAIN_ITEMS / boundedPageSize),
    ));
    let claimed = 0;
    let enqueued = 0;
    let batches = 0;
    for (let page = 0; page < boundedPageCount; page += 1) {
      const remaining = MAX_DISPATCH_DRAIN_ITEMS - claimed;
      if (remaining <= 0) break;
      const batchSize = Math.min(boundedPageSize, remaining);
      const result = await this.dispatchPending(batchSize);
      claimed += result.claimed;
      enqueued += result.enqueued;
      if (result.claimed > 0) batches += 1;
      if (result.claimed < batchSize) break;
    }
    return { claimed, enqueued, batches };
  }

  async dispatchById(outboxId: number): Promise<{ claimed: number; enqueued: number }> {
    return this.dispatchPending(1, outboxId);
  }

  async processMessage(message: WorkCallbackOutboxMessage): Promise<CallbackProcessResult> {
    let claim: Awaited<ReturnType<EnterpriseWechatCallbackService["claim"]>>;
    try {
      claim = await this.claim(message);
    } catch (error) {
      if (
        (
          error instanceof EnterpriseWechatMemberProjectionError
          || error instanceof EnterpriseWechatDepartmentProjectionError
          || error instanceof EnterpriseWechatClientProjectionError
          || error instanceof EnterpriseWechatGroupChatProjectionError
          || error instanceof EnterpriseWechatExternalTagProjectionError
        )
        && error.terminal
        && await this.recordClaimTerminalFailure(message, error)
      ) return "dead";
      throw error;
    }
    if (typeof claim === "string" || "kind" in claim) return claim;
    try {
      let memberProjection: PreparedMemberProjection | undefined;
      let memberTargetSubjectKeyHash: string | undefined;
      let departmentProjection: PreparedDepartmentProjection | undefined;
      let clientProjection: PreparedClientProjection | undefined;
      let groupChatProjection: PreparedGroupChatProjection | undefined;
      let externalTagProjection: PreparedExternalTagProjection | undefined;
      if (isMemberProjectionEvent(claim)) {
        const identity = memberProjectionIdentity(claim);
        memberTargetSubjectKeyHash = await shaHex(
          "SHA-256",
          `${claim.corpId}\0member:${identity.targetUserid}`,
        );
        // delete_user is callback-authoritative and must not even construct a
        // provider client: this keeps deletion independent from provider config.
        memberProjection = await prepareMemberProjection(
          claim,
          claim.changeType === "delete_user"
            ? undefined
            : this.directoryMemberProvider(claim.corpId),
        );
      } else if (isDepartmentProjectionEvent(claim)) {
        // delete_party is callback-authoritative and remains independent from
        // every provider credential and visibility gate.
        departmentProjection = await prepareDepartmentProjection(
          claim,
          claim.changeType === "delete_party"
            ? undefined
            : this.directoryDepartmentProvider(claim.corpId),
        );
      } else if (isClientProjectionEvent(claim)) {
        // Relationship deletion is callback-authoritative and never depends on
        // an external-contact credential or visibility configuration.
        clientProjection = await prepareClientProjection(
          claim,
          claim.changeType === "del_external_contact"
            || claim.changeType === "del_follow_user"
            ? undefined
            : this.externalContactProvider(claim.corpId),
        );
      } else if (isGroupChatProjectionEvent(claim)) {
        // dismiss is callback-authoritative and must not construct a provider.
        groupChatProjection = await prepareGroupChatProjection(
          claim,
          claim.changeType === "dismiss"
            ? undefined
            : this.externalGroupChatProvider(claim.corpId),
        );
      } else if (isExternalTagProjectionEvent(claim)) {
        // Delete is callback-authoritative. Create/update/shuffle fetch their
        // scoped authoritative catalog outside every database transaction.
        externalTagProjection = await prepareExternalTagProjection(
          claim,
          claim.changeType === "delete"
            ? undefined
            : this.externalTagProvider(claim.corpId),
        );
      }
      return await this.applyOrdering(
        claim,
        memberProjection,
        memberTargetSubjectKeyHash,
        departmentProjection,
        clientProjection,
        groupChatProjection,
        externalTagProjection,
      );
    } catch (error) {
      if (await this.recordFailure(claim, error)) return "dead";
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

  private async claim(message: WorkCallbackOutboxMessage): Promise<
    ClaimedCallback | "already-completed" | "busy" | "dead" | "superseded"
      | { kind: "deferred"; delaySeconds: number } | { kind: "parked" }
  > {
    const now = Math.floor(Date.now() / 1000);
    const leaseToken = crypto.randomUUID();
    return withTx(this.container, async (tx) => {
      const outboxRows = await tx.select({
        outboxId: workCallbackOutbox.id,
        eventId: workCallbackOutbox.eventId,
        eventKey: workCallbackOutbox.eventKey,
        outboxStatus: workCallbackOutbox.status,
        outboxLeaseUntil: workCallbackOutbox.leaseUntil,
        outboxAvailableTime: workCallbackOutbox.availableTime,
        attemptCount: workCallbackOutbox.attemptCount,
      }).from(workCallbackOutbox)
        .where(eq(workCallbackOutbox.id, message.outboxId))
        .limit(1)
        .for("update");
      const outbox = outboxRows[0];
      if (
        !outbox
        || outbox.eventId !== message.eventId
        || outbox.eventKey !== message.eventKey
      ) throw new Error("callback_queue_message_mismatch");

      const eventRows = await tx.select({
        eventKey: workCallbackEvent.eventKey,
        subjectKeyHash: workCallbackEvent.subjectKeyHash,
        eventTime: workCallbackEvent.eventTime,
        sequenceRank: workCallbackEvent.sequenceRank,
        msgType: workCallbackEvent.msgType,
        eventType: workCallbackEvent.eventType,
        changeType: workCallbackEvent.changeType,
        corpId: workCallbackEvent.corpId,
        payload: workCallbackEvent.payload,
      }).from(workCallbackEvent)
        .where(eq(workCallbackEvent.id, outbox.eventId))
        .limit(1)
        .for("update");
      const event = eventRows[0];
      if (!event || event.eventKey !== outbox.eventKey) {
        throw new Error("callback_queue_message_mismatch");
      }
      const row = { ...outbox, ...event };
      if (row.outboxStatus === "COMPLETED") return "already-completed";
      if (row.outboxStatus === "DEAD") return "dead";
      if (row.outboxStatus === "PROCESSING" && row.outboxLeaseUntil > now) return "busy";
      if (isMemberProjectionEvent(row) && !this.memberCurrentProjectionEnabled(row)) {
        await recordParkedMemberProjectionSeen(tx, row, now);
        const parkedOutboxes = await tx.update(workCallbackOutbox).set({
          status: "FAILED",
          leaseUntil: 0,
          leaseToken: "",
          availableTime: now + 900,
          lastErrorCode: MEMBER_PROJECTION_DISABLED,
          updateTime: now,
        }).where(eq(workCallbackOutbox.id, row.outboxId)).returning({ id: workCallbackOutbox.id });
        const parkedEvents = await tx.update(workCallbackEvent).set({
          status: "FAILED",
          projectionStatus: "REFRESH_REQUIRED",
          leaseUntil: 0,
          leaseToken: "",
          lastErrorCode: MEMBER_PROJECTION_DISABLED,
          updateTime: now,
        }).where(eq(workCallbackEvent.id, row.eventId)).returning({ id: workCallbackEvent.id });
        if (parkedOutboxes.length !== 1 || parkedEvents.length !== 1) {
          throw new Error("callback_member_park_lost");
        }
        return { kind: "parked" as const };
      }
      if (isDepartmentProjectionEvent(row) && !this.departmentCurrentProjectionEnabled(row)) {
        const seen = await recordDepartmentProjectionSeen(tx, row, now);
        if (seen === "superseded") {
          const completedEvents = await tx.update(workCallbackEvent).set({
            status: "ORDERED",
            projectionStatus: "SUPERSEDED",
            leaseUntil: 0,
            leaseToken: "",
            lastErrorCode: "",
            processedTime: now,
            updateTime: now,
          }).where(eq(workCallbackEvent.id, row.eventId)).returning({ id: workCallbackEvent.id });
          const completedOutboxes = await tx.update(workCallbackOutbox).set({
            status: "COMPLETED",
            leaseUntil: 0,
            leaseToken: "",
            lastErrorCode: "",
            processedTime: now,
            updateTime: now,
          }).where(eq(workCallbackOutbox.id, row.outboxId)).returning({ id: workCallbackOutbox.id });
          if (completedEvents.length !== 1 || completedOutboxes.length !== 1) {
            throw new Error("callback_department_superseded_finalize_lost");
          }
          return "superseded";
        }
        const parkedOutboxes = await tx.update(workCallbackOutbox).set({
          status: "FAILED",
          leaseUntil: 0,
          leaseToken: "",
          availableTime: now + 900,
          lastErrorCode: DEPARTMENT_PROJECTION_DISABLED,
          updateTime: now,
        }).where(eq(workCallbackOutbox.id, row.outboxId)).returning({ id: workCallbackOutbox.id });
        const parkedEvents = await tx.update(workCallbackEvent).set({
          status: "FAILED",
          projectionStatus: "REFRESH_REQUIRED",
          leaseUntil: 0,
          leaseToken: "",
          lastErrorCode: DEPARTMENT_PROJECTION_DISABLED,
          updateTime: now,
        }).where(eq(workCallbackEvent.id, row.eventId)).returning({ id: workCallbackEvent.id });
        if (parkedOutboxes.length !== 1 || parkedEvents.length !== 1) {
          throw new Error("callback_department_park_lost");
        }
        return { kind: "parked" as const };
      }
      if (isClientProjectionEvent(row) && !this.clientCurrentProjectionEnabled(row)) {
        const seen = await recordClientProjectionSeen(tx, row, now);
        if (seen === "superseded") {
          const completedEvents = await tx.update(workCallbackEvent).set({
            status: "ORDERED",
            projectionStatus: "SUPERSEDED",
            leaseUntil: 0,
            leaseToken: "",
            lastErrorCode: "",
            processedTime: now,
            updateTime: now,
          }).where(eq(workCallbackEvent.id, row.eventId)).returning({ id: workCallbackEvent.id });
          const completedOutboxes = await tx.update(workCallbackOutbox).set({
            status: "COMPLETED",
            leaseUntil: 0,
            leaseToken: "",
            lastErrorCode: "",
            processedTime: now,
            updateTime: now,
          }).where(eq(workCallbackOutbox.id, row.outboxId)).returning({ id: workCallbackOutbox.id });
          if (completedEvents.length !== 1 || completedOutboxes.length !== 1) {
            throw new Error("callback_client_superseded_finalize_lost");
          }
          return "superseded";
        }
        const parkedOutboxes = await tx.update(workCallbackOutbox).set({
          status: "FAILED",
          leaseUntil: 0,
          leaseToken: "",
          availableTime: now + 900,
          lastErrorCode: CLIENT_PROJECTION_DISABLED,
          updateTime: now,
        }).where(eq(workCallbackOutbox.id, row.outboxId)).returning({ id: workCallbackOutbox.id });
        const parkedEvents = await tx.update(workCallbackEvent).set({
          status: "FAILED",
          projectionStatus: "REFRESH_REQUIRED",
          leaseUntil: 0,
          leaseToken: "",
          lastErrorCode: CLIENT_PROJECTION_DISABLED,
          updateTime: now,
        }).where(eq(workCallbackEvent.id, row.eventId)).returning({ id: workCallbackEvent.id });
        if (parkedOutboxes.length !== 1 || parkedEvents.length !== 1) {
          throw new Error("callback_client_park_lost");
        }
        return { kind: "parked" as const };
      }
      if (isGroupChatProjectionEvent(row) && !this.groupChatCurrentProjectionEnabled(row)) {
        const seen = await recordGroupChatProjectionSeen(tx, row, now);
        if (seen === "superseded") {
          const completedEvents = await tx.update(workCallbackEvent).set({
            status: "ORDERED",
            projectionStatus: "SUPERSEDED",
            leaseUntil: 0,
            leaseToken: "",
            lastErrorCode: "",
            processedTime: now,
            updateTime: now,
          }).where(eq(workCallbackEvent.id, row.eventId)).returning({ id: workCallbackEvent.id });
          const completedOutboxes = await tx.update(workCallbackOutbox).set({
            status: "COMPLETED",
            leaseUntil: 0,
            leaseToken: "",
            lastErrorCode: "",
            processedTime: now,
            updateTime: now,
          }).where(eq(workCallbackOutbox.id, row.outboxId)).returning({ id: workCallbackOutbox.id });
          if (completedEvents.length !== 1 || completedOutboxes.length !== 1) {
            throw new Error("callback_group_chat_superseded_finalize_lost");
          }
          return "superseded";
        }
        const parkedOutboxes = await tx.update(workCallbackOutbox).set({
          status: "FAILED",
          leaseUntil: 0,
          leaseToken: "",
          availableTime: now + 900,
          lastErrorCode: GROUP_CHAT_PROJECTION_DISABLED,
          updateTime: now,
        }).where(eq(workCallbackOutbox.id, row.outboxId)).returning({ id: workCallbackOutbox.id });
        const parkedEvents = await tx.update(workCallbackEvent).set({
          status: "FAILED",
          projectionStatus: "REFRESH_REQUIRED",
          leaseUntil: 0,
          leaseToken: "",
          lastErrorCode: GROUP_CHAT_PROJECTION_DISABLED,
          updateTime: now,
        }).where(eq(workCallbackEvent.id, row.eventId)).returning({ id: workCallbackEvent.id });
        if (parkedOutboxes.length !== 1 || parkedEvents.length !== 1) {
          throw new Error("callback_group_chat_park_lost");
        }
        return { kind: "parked" as const };
      }
      if (isExternalTagProjectionEvent(row) && !this.externalTagCurrentProjectionEnabled(row)) {
        const seen = await recordExternalTagProjectionSeen(tx, row, now);
        if (seen === "superseded") {
          const completedEvents = await tx.update(workCallbackEvent).set({
            status: "ORDERED",
            projectionStatus: "SUPERSEDED",
            leaseUntil: 0,
            leaseToken: "",
            lastErrorCode: "",
            processedTime: now,
            updateTime: now,
          }).where(eq(workCallbackEvent.id, row.eventId)).returning({ id: workCallbackEvent.id });
          const completedOutboxes = await tx.update(workCallbackOutbox).set({
            status: "COMPLETED",
            leaseUntil: 0,
            leaseToken: "",
            lastErrorCode: "",
            processedTime: now,
            updateTime: now,
          }).where(eq(workCallbackOutbox.id, row.outboxId)).returning({ id: workCallbackOutbox.id });
          if (completedEvents.length !== 1 || completedOutboxes.length !== 1) {
            throw new Error("callback_external_tag_superseded_finalize_lost");
          }
          return "superseded";
        }
        const parkedOutboxes = await tx.update(workCallbackOutbox).set({
          status: "FAILED",
          leaseUntil: 0,
          leaseToken: "",
          availableTime: now + 900,
          lastErrorCode: EXTERNAL_TAG_PROJECTION_DISABLED,
          updateTime: now,
        }).where(eq(workCallbackOutbox.id, row.outboxId)).returning({ id: workCallbackOutbox.id });
        const parkedEvents = await tx.update(workCallbackEvent).set({
          status: "FAILED",
          projectionStatus: "REFRESH_REQUIRED",
          leaseUntil: 0,
          leaseToken: "",
          lastErrorCode: EXTERNAL_TAG_PROJECTION_DISABLED,
          updateTime: now,
        }).where(eq(workCallbackEvent.id, row.eventId)).returning({ id: workCallbackEvent.id });
        if (parkedOutboxes.length !== 1 || parkedEvents.length !== 1) {
          throw new Error("callback_external_tag_park_lost");
        }
        return { kind: "parked" as const };
      }
      if (row.outboxStatus === "FAILED" && row.outboxAvailableTime > now) {
        return {
          kind: "deferred" as const,
          delaySeconds: Math.min(Math.max(row.outboxAvailableTime - now, 1), 900),
        };
      }
      const attemptCount = row.attemptCount + 1;
      if (attemptCount > MAX_ATTEMPTS) {
        const deadOutboxes = await tx.update(workCallbackOutbox).set({
          status: "DEAD", leaseUntil: 0, leaseToken: "",
          lastErrorCode: "attempt_limit_exceeded", updateTime: now,
        }).where(eq(workCallbackOutbox.id, row.outboxId)).returning({ id: workCallbackOutbox.id });
        const deadEvents = await tx.update(workCallbackEvent).set({
          status: "DEAD", projectionStatus: "DEAD",
          lastErrorCode: "attempt_limit_exceeded", updateTime: now,
        }).where(eq(workCallbackEvent.id, row.eventId)).returning({ id: workCallbackEvent.id });
        if (deadOutboxes.length !== 1 || deadEvents.length !== 1) {
          throw new Error("callback_attempt_limit_finalize_lost");
        }
        return "dead";
      }

      if (isMemberProjectionEvent(row)) {
        try {
          memberProjectionIdentity(row);
        } catch (error) {
          if (!(error instanceof EnterpriseWechatMemberProjectionError) || !error.terminal) {
            throw error;
          }
          const code = errorCode(error);
          const deadEvents = await tx.update(workCallbackEvent).set({
            status: "DEAD",
            projectionStatus: "DEAD",
            leaseUntil: 0,
            leaseToken: "",
            lastErrorCode: code,
            processedTime: now,
            updateTime: now,
          }).where(eq(workCallbackEvent.id, row.eventId)).returning({ id: workCallbackEvent.id });
          const deadOutboxes = await tx.update(workCallbackOutbox).set({
            status: "DEAD",
            leaseUntil: 0,
            leaseToken: "",
            lastErrorCode: code,
            processedTime: now,
            updateTime: now,
          }).where(eq(workCallbackOutbox.id, row.outboxId)).returning({ id: workCallbackOutbox.id });
          if (deadEvents.length !== 1 || deadOutboxes.length !== 1) {
            throw new Error("callback_member_claim_dead_finalize_lost");
          }
          return "dead";
        }
        const seen = await recordMemberProjectionSeen(tx, row, now);
        if (seen === "superseded") {
          const completedEvents = await tx.update(workCallbackEvent).set({
            status: "ORDERED",
            projectionStatus: "SUPERSEDED",
            leaseUntil: 0,
            leaseToken: "",
            lastErrorCode: "",
            processedTime: now,
            updateTime: now,
          }).where(eq(workCallbackEvent.id, row.eventId)).returning({ id: workCallbackEvent.id });
          const completedOutboxes = await tx.update(workCallbackOutbox).set({
            status: "COMPLETED",
            leaseUntil: 0,
            leaseToken: "",
            lastErrorCode: "",
            processedTime: now,
            updateTime: now,
          }).where(eq(workCallbackOutbox.id, row.outboxId)).returning({ id: workCallbackOutbox.id });
          if (completedEvents.length !== 1 || completedOutboxes.length !== 1) {
            throw new Error("callback_superseded_finalize_lost");
          }
          return "superseded";
        }
      } else if (isDepartmentProjectionEvent(row)) {
        const seen = await recordDepartmentProjectionSeen(tx, row, now);
        if (seen === "superseded") {
          const completedEvents = await tx.update(workCallbackEvent).set({
            status: "ORDERED",
            projectionStatus: "SUPERSEDED",
            leaseUntil: 0,
            leaseToken: "",
            lastErrorCode: "",
            processedTime: now,
            updateTime: now,
          }).where(eq(workCallbackEvent.id, row.eventId)).returning({ id: workCallbackEvent.id });
          const completedOutboxes = await tx.update(workCallbackOutbox).set({
            status: "COMPLETED",
            leaseUntil: 0,
            leaseToken: "",
            lastErrorCode: "",
            processedTime: now,
            updateTime: now,
          }).where(eq(workCallbackOutbox.id, row.outboxId)).returning({ id: workCallbackOutbox.id });
          if (completedEvents.length !== 1 || completedOutboxes.length !== 1) {
            throw new Error("callback_department_superseded_finalize_lost");
          }
          return "superseded";
        }
      } else if (isClientProjectionEvent(row)) {
        const seen = await recordClientProjectionSeen(tx, row, now);
        if (seen === "superseded") {
          const completedEvents = await tx.update(workCallbackEvent).set({
            status: "ORDERED",
            projectionStatus: "SUPERSEDED",
            leaseUntil: 0,
            leaseToken: "",
            lastErrorCode: "",
            processedTime: now,
            updateTime: now,
          }).where(eq(workCallbackEvent.id, row.eventId)).returning({ id: workCallbackEvent.id });
          const completedOutboxes = await tx.update(workCallbackOutbox).set({
            status: "COMPLETED",
            leaseUntil: 0,
            leaseToken: "",
            lastErrorCode: "",
            processedTime: now,
            updateTime: now,
          }).where(eq(workCallbackOutbox.id, row.outboxId)).returning({ id: workCallbackOutbox.id });
          if (completedEvents.length !== 1 || completedOutboxes.length !== 1) {
            throw new Error("callback_client_superseded_finalize_lost");
          }
          return "superseded";
        }
      } else if (isGroupChatProjectionEvent(row)) {
        const seen = await recordGroupChatProjectionSeen(tx, row, now);
        if (seen === "superseded") {
          const completedEvents = await tx.update(workCallbackEvent).set({
            status: "ORDERED",
            projectionStatus: "SUPERSEDED",
            leaseUntil: 0,
            leaseToken: "",
            lastErrorCode: "",
            processedTime: now,
            updateTime: now,
          }).where(eq(workCallbackEvent.id, row.eventId)).returning({ id: workCallbackEvent.id });
          const completedOutboxes = await tx.update(workCallbackOutbox).set({
            status: "COMPLETED",
            leaseUntil: 0,
            leaseToken: "",
            lastErrorCode: "",
            processedTime: now,
            updateTime: now,
          }).where(eq(workCallbackOutbox.id, row.outboxId)).returning({ id: workCallbackOutbox.id });
          if (completedEvents.length !== 1 || completedOutboxes.length !== 1) {
            throw new Error("callback_group_chat_superseded_finalize_lost");
          }
          return "superseded";
        }
      } else if (isExternalTagProjectionEvent(row)) {
        const seen = await recordExternalTagProjectionSeen(tx, row, now);
        if (seen === "superseded") {
          const completedEvents = await tx.update(workCallbackEvent).set({
            status: "ORDERED",
            projectionStatus: "SUPERSEDED",
            leaseUntil: 0,
            leaseToken: "",
            lastErrorCode: "",
            processedTime: now,
            updateTime: now,
          }).where(eq(workCallbackEvent.id, row.eventId)).returning({ id: workCallbackEvent.id });
          const completedOutboxes = await tx.update(workCallbackOutbox).set({
            status: "COMPLETED",
            leaseUntil: 0,
            leaseToken: "",
            lastErrorCode: "",
            processedTime: now,
            updateTime: now,
          }).where(eq(workCallbackOutbox.id, row.outboxId)).returning({ id: workCallbackOutbox.id });
          if (completedEvents.length !== 1 || completedOutboxes.length !== 1) {
            throw new Error("callback_external_tag_superseded_finalize_lost");
          }
          return "superseded";
        }
      }

      const processingOutboxes = await tx.update(workCallbackOutbox).set({
        status: "PROCESSING",
        attemptCount,
        leaseUntil: now + PROCESS_LEASE_SECONDS,
        leaseToken,
        updateTime: now,
      }).where(eq(workCallbackOutbox.id, row.outboxId)).returning({ id: workCallbackOutbox.id });
      const processingEvents = await tx.update(workCallbackEvent).set({
        status: "PROCESSING",
        projectionStatus: "PROCESSING",
        attemptCount,
        leaseUntil: now + PROCESS_LEASE_SECONDS,
        leaseToken,
        updateTime: now,
      }).where(eq(workCallbackEvent.id, row.eventId)).returning({ id: workCallbackEvent.id });
      if (processingOutboxes.length !== 1 || processingEvents.length !== 1) {
        throw new Error("callback_processing_claim_lost");
      }
      return { ...row, leaseToken, attemptCount };
    });
  }

  private async applyOrdering(
    claim: ClaimedCallback,
    memberProjection?: PreparedMemberProjection,
    memberTargetSubjectKeyHash?: string,
    departmentProjection?: PreparedDepartmentProjection,
    clientProjection?: PreparedClientProjection,
    groupChatProjection?: PreparedGroupChatProjection,
    externalTagProjection?: PreparedExternalTagProjection,
  ): Promise<"applied" | "applied-noop" | "refresh-required" | "ignored" | "superseded"> {
    const now = Math.floor(Date.now() / 1000);
    return withTx(this.container, async (tx) => {
      const outboxRows = await tx.select({
        status: workCallbackOutbox.status,
        leaseToken: workCallbackOutbox.leaseToken,
      }).from(workCallbackOutbox).where(eq(workCallbackOutbox.id, claim.outboxId)).limit(1).for("update");
      if (outboxRows[0]?.status !== "PROCESSING" || outboxRows[0].leaseToken !== claim.leaseToken) {
        throw new Error("callback_processing_lease_lost");
      }
      const eventRows = await tx.select({
        status: workCallbackEvent.status,
        leaseToken: workCallbackEvent.leaseToken,
      }).from(workCallbackEvent).where(eq(workCallbackEvent.id, claim.eventId)).limit(1).for("update");
      if (eventRows[0]?.status !== "PROCESSING" || eventRows[0].leaseToken !== claim.leaseToken) {
        throw new Error("callback_processing_lease_lost");
      }

      const memberEvent = isMemberProjectionEvent(claim);
      const departmentEvent = isDepartmentProjectionEvent(claim);
      const clientEvent = isClientProjectionEvent(claim);
      const groupChatEvent = isGroupChatProjectionEvent(claim);
      const externalTagEvent = isExternalTagProjectionEvent(claim);
      if (memberEvent && this.memberCurrentProjectionEnabled(claim)) {
        if (!memberProjection || !memberTargetSubjectKeyHash) {
          throw new Error("callback_member_projection_missing");
        }
        // Lock identities before any subject watermark. Cross-subject rename
        // transactions therefore share one deterministic lock order.
        await lockMemberProjectionIdentities(tx, claim);
      } else if (departmentEvent && this.departmentCurrentProjectionEnabled(claim)) {
        if (!departmentProjection) {
          throw new Error("callback_department_projection_missing");
        }
        // Department hierarchy/root invariants are tenant-wide. Acquire this
        // before generic watermarks so every C4 transaction has one lock order.
        await lockDepartmentProjectionCorp(tx, claim.corpId);
      } else if (clientEvent && this.clientCurrentProjectionEnabled(claim)) {
        if (!clientProjection) {
          throw new Error("callback_client_projection_missing");
        }
        // Every relationship of one external contact uses the same tenant and
        // client lock before its relationship-scoped generic watermark.
        await lockClientProjectionIdentity(
          tx,
          claim.corpId,
          clientProjection.externalUserid,
        );
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${claim.subjectKeyHash}, 0))`);
      } else if (groupChatEvent && this.groupChatCurrentProjectionEnabled(claim)) {
        if (!groupChatProjection) {
          throw new Error("callback_group_chat_projection_missing");
        }
        await lockGroupChatProjectionIdentity(tx, claim.corpId, groupChatProjection.chatId);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${claim.subjectKeyHash}, 0))`);
      } else if (externalTagEvent && this.externalTagCurrentProjectionEnabled(claim)) {
        if (!externalTagProjection) {
          throw new Error("callback_external_tag_projection_missing");
        }
        await lockExternalTagProjectionCatalog(
          tx,
          claim.corpId,
          externalTagProjection.identity.strategyId,
        );
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${claim.subjectKeyHash}, 0))`);
      } else if (!memberEvent && !departmentEvent && !clientEvent && !groupChatEvent && !externalTagEvent) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${claim.subjectKeyHash}, 0))`);
      }
      const targetSubjectHash = memberEvent ? memberTargetSubjectKeyHash as string : undefined;

      let result: "applied" | "applied-noop" | "refresh-required" | "ignored" | "superseded"
        = "refresh-required";
      let projectionStatus = "REFRESH_REQUIRED";
      if (!isRecognizedEvent(claim)) {
        result = "ignored";
        projectionStatus = "IGNORED";
      } else {
        const watermarkHashes = [...new Set([
          claim.subjectKeyHash,
          ...(targetSubjectHash && targetSubjectHash !== claim.subjectKeyHash
            ? [targetSubjectHash]
            : []),
        ])].sort();
        const watermarkRows = await tx.select().from(workCallbackWatermark)
          .where(inArray(workCallbackWatermark.subjectKeyHash, watermarkHashes))
          .orderBy(asc(workCallbackWatermark.subjectKeyHash))
          .for("update");
        const incomingFence = {
          eventTime: claim.eventTime,
          sequenceRank: claim.sequenceRank,
          eventId: claim.eventId,
        };
        const older = watermarkRows.some((watermark) => compareMemberProjectionFence({
          eventTime: watermark.eventTime,
          sequenceRank: watermark.sequenceRank,
          eventId: watermark.eventId,
        }, incomingFence) > 0);
        if (older) {
          if (
            (
              groupChatEvent
              && groupChatProjection?.kind === "absent"
              && claim.changeType === "dismiss"
            ) || (
              externalTagEvent
              && externalTagProjection?.kind === "absent"
              && claim.changeType === "delete"
            )
          ) {
            // Terminal group/tag deletion must still reach its dedicated fence
            // when an impossible later-timestamp update advanced the generic
            // subject watermark first.
            result = groupChatEvent
              ? await applyGroupChatCurrentProjection(
                  tx,
                  claim,
                  groupChatProjection as PreparedGroupChatProjection,
                  now,
                )
              : await applyExternalTagCurrentProjection(
                  tx,
                  claim,
                  externalTagProjection as PreparedExternalTagProjection,
                  now,
                );
            projectionStatus = result === "applied"
              ? "APPLIED"
              : result === "applied-noop"
                ? "APPLIED_NOOP"
                : result === "superseded"
                  ? "SUPERSEDED"
                  : "REFRESH_REQUIRED";
            if (result === "applied" || result === "applied-noop") {
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
          } else {
            if (memberEvent && memberProjection) {
            // A newer target watermark suppresses stale provider business data,
            // but must not suppress an older authoritative rename edge. The
            // member service may still collapse a target-first provisional row
            // into the stable source identity and propagate its tombstone.
              await applyMemberCurrentProjection(tx, claim, memberProjection, now, true);
            }
            result = "superseded";
            projectionStatus = "SUPERSEDED";
          }
        } else {
          const subjectWatermark = watermarkRows.find(
            (watermark) => watermark.subjectKeyHash === claim.subjectKeyHash,
          );
          if (!subjectWatermark || compareMemberProjectionFence(incomingFence, {
            eventTime: subjectWatermark.eventTime,
            sequenceRank: subjectWatermark.sequenceRank,
            eventId: subjectWatermark.eventId,
          }) > 0) {
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
          if (clientEvent && clientProjection) {
            result = await applyClientCurrentProjection(
              tx,
              claim,
              clientProjection,
              now,
            );
            // A delete that loses its phase-3 direct fence race must not leak
            // through the compatibility write and tombstone the legacy row.
            if (clientProjection.kind === "absent" && result !== "superseded") {
              const legacyChanged = await this.applyFollowRemoval(tx, claim, now);
              if (legacyChanged && result === "applied-noop") result = "applied";
            }
            projectionStatus = result === "applied"
              ? "APPLIED"
              : result === "applied-noop"
                ? "APPLIED_NOOP"
                : result === "superseded"
                  ? "SUPERSEDED"
                  : "REFRESH_REQUIRED";
          } else if (groupChatEvent && groupChatProjection) {
            result = await applyGroupChatCurrentProjection(
              tx,
              claim,
              groupChatProjection,
              now,
            );
            projectionStatus = result === "applied"
              ? "APPLIED"
              : result === "applied-noop"
                ? "APPLIED_NOOP"
                : result === "superseded"
                ? "SUPERSEDED"
                  : "REFRESH_REQUIRED";
          } else if (externalTagEvent && externalTagProjection) {
            result = await applyExternalTagCurrentProjection(
              tx,
              claim,
              externalTagProjection,
              now,
            );
            projectionStatus = result === "applied"
              ? "APPLIED"
              : result === "applied-noop"
                ? "APPLIED_NOOP"
                : result === "superseded"
                  ? "SUPERSEDED"
                  : "REFRESH_REQUIRED";
          } else if (isFollowRemovalEvent(claim)) {
            const changed = await this.applyFollowRemoval(tx, claim, now);
            result = changed ? "applied" : "applied-noop";
            projectionStatus = changed ? "APPLIED" : "APPLIED_NOOP";
          } else if (memberEvent && memberProjection) {
            result = await applyMemberCurrentProjection(tx, claim, memberProjection, now);
            projectionStatus = result === "applied"
              ? "APPLIED"
              : result === "applied-noop"
                ? "APPLIED_NOOP"
                : result === "superseded"
                  ? "SUPERSEDED"
                  : "REFRESH_REQUIRED";

            if (
              memberProjection.kind === "snapshot"
              && memberProjection.renamed
              && (result === "applied" || result === "applied-noop")
              && targetSubjectHash
              && targetSubjectHash !== claim.subjectKeyHash
            ) {
              const targetWatermark = watermarkRows.find(
                (watermark) => watermark.subjectKeyHash === targetSubjectHash,
              );
              if (!targetWatermark || compareMemberProjectionFence(incomingFence, {
                eventTime: targetWatermark.eventTime,
                sequenceRank: targetWatermark.sequenceRank,
                eventId: targetWatermark.eventId,
              }) > 0) {
                await tx.insert(workCallbackWatermark).values({
                  subjectKeyHash: targetSubjectHash,
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
            }
          } else if (departmentEvent && departmentProjection) {
            result = await applyDepartmentCurrentProjection(
              tx,
              claim,
              departmentProjection,
              now,
            );
            projectionStatus = result === "applied"
              ? "APPLIED"
              : result === "applied-noop"
                ? "APPLIED_NOOP"
                : result === "superseded"
                  ? "SUPERSEDED"
                  : "REFRESH_REQUIRED";
          }
        }
      }

      const finalizedEvents = await tx.update(workCallbackEvent).set({
        status: "ORDERED",
        projectionStatus,
        leaseUntil: 0,
        leaseToken: "",
        lastErrorCode: "",
        processedTime: now,
        updateTime: now,
      }).where(and(
        eq(workCallbackEvent.id, claim.eventId),
        eq(workCallbackEvent.status, "PROCESSING"),
        eq(workCallbackEvent.leaseToken, claim.leaseToken),
      )).returning({ id: workCallbackEvent.id });
      const finalizedOutboxes = await tx.update(workCallbackOutbox).set({
        status: "COMPLETED",
        leaseUntil: 0,
        leaseToken: "",
        lastErrorCode: "",
        processedTime: now,
        updateTime: now,
      }).where(and(
        eq(workCallbackOutbox.id, claim.outboxId),
        eq(workCallbackOutbox.status, "PROCESSING"),
        eq(workCallbackOutbox.leaseToken, claim.leaseToken),
      )).returning({ id: workCallbackOutbox.id });
      if (finalizedEvents.length !== 1 || finalizedOutboxes.length !== 1) {
        throw new Error("callback_processing_lease_lost");
      }
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

  private memberCurrentProjectionEnabled(
    event: Pick<ClaimedCallback, "changeType">,
  ): boolean {
    return event.changeType === "delete_user"
      || this.memberCurrentAuthorityEnabled();
  }

  private memberCurrentAuthorityEnabled(): boolean {
    return this.env.WECHAT_WORK_MEMBER_CURRENT_AUTHORITY?.trim() === "verified";
  }

  private departmentCurrentProjectionEnabled(
    event: Pick<ClaimedCallback, "changeType">,
  ): boolean {
    return event.changeType === "delete_party"
      || this.departmentCurrentAuthorityEnabled();
  }

  private departmentCurrentAuthorityEnabled(): boolean {
    return this.env.WECHAT_WORK_DEPARTMENT_CURRENT_AUTHORITY?.trim() === "verified";
  }

  private clientCurrentProjectionEnabled(
    event: Pick<ClaimedCallback, "changeType">,
  ): boolean {
    return event.changeType === "del_external_contact"
      || event.changeType === "del_follow_user"
      || (
        this.clientCurrentAuthorityEnabled()
        && this.externalContactFullVisibilityEnabled()
      );
  }

  private clientCurrentAuthorityEnabled(): boolean {
    return this.env.WECHAT_WORK_CLIENT_CURRENT_AUTHORITY?.trim() === "verified";
  }

  private groupChatCurrentProjectionEnabled(
    event: Pick<ClaimedCallback, "changeType">,
  ): boolean {
    return event.changeType === "dismiss"
      || (
        this.groupChatCurrentAuthorityEnabled()
        && this.externalContactFullVisibilityEnabled()
      );
  }

  private groupChatCurrentAuthorityEnabled(): boolean {
    return this.env.WECHAT_WORK_GROUP_CHAT_CURRENT_AUTHORITY?.trim() === "verified";
  }

  private externalTagCurrentProjectionEnabled(
    event: Pick<ClaimedCallback, "changeType">,
  ): boolean {
    return event.changeType === "delete"
      || (
        this.externalTagCurrentAuthorityEnabled()
        && this.externalContactFullVisibilityEnabled()
      );
  }

  private externalTagCurrentAuthorityEnabled(): boolean {
    return this.env.WECHAT_WORK_TAG_CURRENT_AUTHORITY?.trim() === "verified";
  }

  private externalContactFullVisibilityEnabled(): boolean {
    return this.env.WECHAT_WORK_EXTERNAL_CONTACT_FULL_VISIBILITY?.trim() === "verified";
  }

  private directoryMemberProvider(
    corpId: string,
  ): Pick<EnterpriseWechatProviderClient, "directoryMember"> {
    if (this.env.WECHAT_WORK_DIRECTORY_FULL_VISIBILITY !== "verified") {
      throw new EnterpriseWechatProviderError("configuration", "directory_visibility_gate", -1, 0);
    }
    const provider = this.directoryProviderFactory(corpId);
    if (typeof provider.directoryMember !== "function") {
      throw new EnterpriseWechatProviderError(
        "configuration",
        "directory_provider_config",
        -1,
        0,
      );
    }
    return {
      directoryMember: provider.directoryMember.bind(provider),
    };
  }

  private directoryDepartmentProvider(
    corpId: string,
  ): Pick<EnterpriseWechatProviderClient, "directoryDepartment"> {
    if (this.env.WECHAT_WORK_DIRECTORY_FULL_VISIBILITY !== "verified") {
      throw new EnterpriseWechatProviderError("configuration", "directory_visibility_gate", -1, 0);
    }
    const provider = this.directoryProviderFactory(corpId);
    if (typeof provider.directoryDepartment !== "function") {
      throw new EnterpriseWechatProviderError(
        "configuration",
        "directory_provider_config",
        -1,
        0,
      );
    }
    return {
      directoryDepartment: provider.directoryDepartment.bind(provider),
    };
  }

  private externalContactProvider(
    corpId: string,
  ): Pick<EnterpriseWechatProviderClient, "externalContact"> {
    if (!this.externalContactFullVisibilityEnabled()) {
      throw new EnterpriseWechatProviderError(
        "configuration",
        "external_contact_visibility_gate",
        -1,
        0,
      );
    }
    const provider = this.directoryProviderFactory(corpId);
    if (typeof provider.externalContact !== "function") {
      throw new EnterpriseWechatProviderError(
        "configuration",
        "external_contact_provider_config",
        -1,
        0,
      );
    }
    return {
      externalContact: provider.externalContact.bind(provider),
    };
  }

  private externalGroupChatProvider(
    corpId: string,
  ): Pick<EnterpriseWechatProviderClient, "externalGroupChat"> {
    if (!this.externalContactFullVisibilityEnabled()) {
      throw new EnterpriseWechatProviderError(
        "configuration",
        "external_group_chat_visibility_gate",
        -1,
        0,
      );
    }
    const provider = this.directoryProviderFactory(corpId);
    if (typeof provider.externalGroupChat !== "function") {
      throw new EnterpriseWechatProviderError(
        "configuration",
        "external_group_chat_provider_config",
        -1,
        0,
      );
    }
    return {
      externalGroupChat: provider.externalGroupChat.bind(provider),
    };
  }

  private externalTagProvider(
    corpId: string,
  ): Pick<EnterpriseWechatProviderClient, "corpTagList" | "strategyTagList"> {
    if (!this.externalContactFullVisibilityEnabled()) {
      throw new EnterpriseWechatProviderError(
        "configuration",
        "external_tag_visibility_gate",
        -1,
        0,
      );
    }
    const provider = this.directoryProviderFactory(corpId);
    if (
      typeof provider.corpTagList !== "function"
      || typeof provider.strategyTagList !== "function"
    ) {
      throw new EnterpriseWechatProviderError(
        "configuration",
        "external_tag_provider_config",
        -1,
        0,
      );
    }
    return {
      corpTagList: provider.corpTagList.bind(provider),
      strategyTagList: provider.strategyTagList.bind(provider),
    };
  }

  /**
   * Claim/phase-1 failures must roll their transaction back completely before
   * a poison message is marked DEAD. This fresh transaction is fenced by the
   * original queue identity and never overwrites a completed or live lease.
   */
  private async recordClaimTerminalFailure(
    message: WorkCallbackOutboxMessage,
    error:
      | EnterpriseWechatMemberProjectionError
      | EnterpriseWechatDepartmentProjectionError
      | EnterpriseWechatClientProjectionError
      | EnterpriseWechatGroupChatProjectionError,
  ): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    const code = errorCode(error);
    return withTx(this.container, async (tx) => {
      const outboxes = await tx.select().from(workCallbackOutbox).where(
        eq(workCallbackOutbox.id, message.outboxId),
      ).limit(1).for("update");
      const outbox = outboxes[0];
      if (
        !outbox
        || outbox.eventId !== message.eventId
        || outbox.eventKey !== message.eventKey
      ) throw new Error("callback_queue_message_mismatch");
      if (outbox.status === "DEAD") return true;
      if (
        outbox.status === "COMPLETED"
        || (outbox.status === "PROCESSING" && outbox.leaseUntil > now)
      ) return false;

      const events = await tx.select().from(workCallbackEvent).where(
        eq(workCallbackEvent.id, message.eventId),
      ).limit(1).for("update");
      const event = events[0];
      if (!event || event.eventKey !== message.eventKey) {
        throw new Error("callback_queue_message_mismatch");
      }
      if (
        event.status === "ORDERED"
        || (event.status === "PROCESSING" && event.leaseUntil > now)
      ) return false;
      const outboxFence = outbox.status === "PROCESSING"
        ? and(
            eq(workCallbackOutbox.status, "PROCESSING"),
            eq(workCallbackOutbox.leaseToken, outbox.leaseToken),
            eq(workCallbackOutbox.leaseUntil, outbox.leaseUntil),
          )
        : eq(workCallbackOutbox.status, outbox.status);
      const eventFence = event.status === "PROCESSING"
        ? and(
            eq(workCallbackEvent.status, "PROCESSING"),
            eq(workCallbackEvent.leaseToken, event.leaseToken),
            eq(workCallbackEvent.leaseUntil, event.leaseUntil),
          )
        : eq(workCallbackEvent.status, event.status);
      const deadOutboxes = await tx.update(workCallbackOutbox).set({
        status: "DEAD",
        attemptCount: outbox.attemptCount + 1,
        leaseUntil: 0,
        leaseToken: "",
        availableTime: 0,
        lastErrorCode: code,
        processedTime: now,
        updateTime: now,
      }).where(and(
        eq(workCallbackOutbox.id, message.outboxId),
        outboxFence,
      )).returning({ id: workCallbackOutbox.id });
      const deadEvents = await tx.update(workCallbackEvent).set({
        status: "DEAD",
        projectionStatus: "DEAD",
        attemptCount: event.attemptCount + 1,
        leaseUntil: 0,
        leaseToken: "",
        lastErrorCode: code,
        processedTime: now,
        updateTime: now,
      }).where(and(
        eq(workCallbackEvent.id, message.eventId),
        eventFence,
      )).returning({ id: workCallbackEvent.id });
      if (deadOutboxes.length !== 1 || deadEvents.length !== 1) {
        throw new Error("callback_member_claim_dead_finalize_lost");
      }
      return true;
    });
  }

  private async recordFailure(claim: ClaimedCallback, error: unknown): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    const terminal = error instanceof EnterpriseWechatMemberProjectionError
      ? error.terminal
      : error instanceof EnterpriseWechatDepartmentProjectionError
        ? error.terminal
        : error instanceof EnterpriseWechatClientProjectionError
          ? error.terminal
          : error instanceof EnterpriseWechatGroupChatProjectionError
            ? error.terminal
            : error instanceof EnterpriseWechatExternalTagProjectionError
              ? error.terminal
              : error instanceof EnterpriseWechatProviderError && error.kind === "terminal";
    const dead = terminal || claim.attemptCount >= MAX_ATTEMPTS;
    const code = errorCode(error);
    const providerDelay = error instanceof EnterpriseWechatProviderError
      ? error.retryAfterSeconds ?? 0
      : 0;
    const availableTime = now + Math.max(retryDelay(claim.attemptCount), providerDelay);
    return withTx(this.container, async (tx) => {
      const failedOutboxes = await tx.update(workCallbackOutbox).set({
        status: dead ? "DEAD" : "FAILED",
        leaseUntil: 0,
        leaseToken: "",
        lastErrorCode: code,
        availableTime: dead ? 0 : availableTime,
        updateTime: now,
      }).where(and(
        eq(workCallbackOutbox.id, claim.outboxId),
        eq(workCallbackOutbox.status, "PROCESSING"),
        eq(workCallbackOutbox.leaseToken, claim.leaseToken),
      )).returning({ id: workCallbackOutbox.id });
      const failedEvents = await tx.update(workCallbackEvent).set({
        status: dead ? "DEAD" : "FAILED",
        projectionStatus: dead ? "DEAD" : "FAILED",
        leaseUntil: 0,
        leaseToken: "",
        lastErrorCode: code,
        updateTime: now,
      }).where(and(
        eq(workCallbackEvent.id, claim.eventId),
        eq(workCallbackEvent.status, "PROCESSING"),
        eq(workCallbackEvent.leaseToken, claim.leaseToken),
      )).returning({ id: workCallbackEvent.id });
      if (failedOutboxes.length === 0 && failedEvents.length === 0) return false;
      if (failedOutboxes.length !== 1 || failedEvents.length !== 1) {
        throw new Error("callback_processing_failure_fence_lost");
      }
      return dead;
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
    if (typeof result === "object" && result.kind === "deferred") {
      message.retry({ delaySeconds: result.delaySeconds });
      return;
    }
    if (typeof result === "object" && result.kind === "parked") {
      console.log(JSON.stringify({
        event: "work_callback_pipeline_parked",
        eventId: message.body.eventId,
        outboxId: message.body.outboxId,
        queueAttempt: message.attempts,
      }));
      // The durable outbox is FAILED with a future available_time. Ack this
      // delivery; dispatch excludes the parked error while authority is off,
      // then bounded cron pages replay the same event after the gate opens.
      message.ack();
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
    const providerDelay = error instanceof EnterpriseWechatProviderError
      ? error.retryAfterSeconds ?? 0
      : 0;
    const delaySeconds = Math.min(Math.max(
      30 * 2 ** Math.max(message.attempts - 1, 0),
      providerDelay,
    ), 900);
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
