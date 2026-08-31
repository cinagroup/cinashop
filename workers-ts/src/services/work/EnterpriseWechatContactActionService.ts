import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lte,
  sql,
} from "drizzle-orm";
import type {
  OrderMessage,
  WorkContactActionDispatchMessage,
  WorkContactActionMessage,
} from "@/env";
import type { Container, DbClient } from "@/lib/di";
import { withTx } from "@/lib/di";
import {
  user,
  wechatUser,
  workCallbackEvent,
  workCallbackOutbox,
  workChannelCode,
  workClientCurrent,
  workContactActionAudit,
  workContactActionOutbox,
  workExternalTagCurrent,
  workWelcome,
  workWelcomeRelation,
  type WorkCallbackPayload,
  type WorkContactActionPayload,
  type WorkContactActionStatus,
  type WorkContactActionType,
} from "@/models/schema";
import {
  EnterpriseWechatProviderClient,
  EnterpriseWechatProviderError,
} from "@/services/work/EnterpriseWechatProviderClient";
import { shaHex } from "@/services/work/EnterpriseWechatCallbackCrypto";
import { ValidateException } from "@/utils/errors";
import { emitOperationalEvent, operationalErrorCode } from "@/utils/observability";

const ACTION_AUTHORITY = "verified";
const DISPATCH_LEASE_SECONDS = 60;
const PROCESS_LEASE_SECONDS = 60;
const WELCOME_TTL_SECONDS = 20;
const UID_LINK_TTL_SECONDS = 7 * 24 * 60 * 60;
const CALLBACK_PAYLOAD_RETENTION_SECONDS = 30 * 24 * 60 * 60;
const MAX_PROVIDER_ATTEMPTS = 5;
const MAX_UID_LINK_ATTEMPTS = 12;
const TERMINAL_STATUSES: WorkContactActionStatus[] = [
  "SUCCEEDED",
  "SKIPPED",
  "EXPIRED",
  "UNKNOWN",
  "DEAD",
  "CLOSED",
];
const SCRUB_PAYLOAD_STATUSES: WorkContactActionStatus[] = [
  "SUCCEEDED",
  "SKIPPED",
  "EXPIRED",
  "CLOSED",
];

export interface ContactActionClaim {
  eventId: number;
  eventKey: string;
  corpId: string;
  changeType: string;
  receivedTime: number;
  payload: WorkCallbackPayload;
}

export interface WorkContactActionEnvironment {
  ORDER_QUEUE: Queue<OrderMessage>;
  CONFIG_KV?: KVNamespace;
  WECHAT_WORK_EXTERNAL_CONTACT_SECRET?: string;
  WECHAT_WORK_CONTACT_ACTION_AUTHORITY?: string;
}

export interface WorkContactActionProvider {
  sendWelcome(
    welcomeCode: string,
    message: { text?: { content: string }; attachments?: unknown[] },
  ): Promise<void>;
  markExternalContactTags(
    userid: string,
    externalUserid: string,
    addTags: string[],
    removeTags?: string[],
  ): Promise<void>;
}

export type WorkContactActionProviderFactory = (corpId: string) => WorkContactActionProvider;

type ProjectedResult = "applied" | "applied-noop" | "refresh-required" | "superseded" | "ignored";

interface DraftAction {
  type: WorkContactActionType;
  payload: WorkContactActionPayload;
  status: WorkContactActionStatus;
  errorCode: string;
  deadlineTime: number;
  channelId?: number;
}

interface ClaimedAction {
  id: number;
  eventId: number;
  eventKey: string;
  actionKey: string;
  actionType: WorkContactActionType;
  corpId: string;
  clientId: number;
  payload: WorkContactActionPayload;
  deadlineTime: number;
  attemptCount: number;
  leaseToken: string;
  callbackPayload: WorkCallbackPayload;
}

type ProcessResult =
  | "succeeded"
  | "skipped"
  | "expired"
  | "unknown"
  | "dead"
  | "already-terminal"
  | "busy"
  | { kind: "deferred"; delaySeconds: number }
  | { kind: "parked" };

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function cleanString(value: unknown, maxBytes: number, allowEmpty = false): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (
    (!allowEmpty && !normalized)
    || utf8Bytes(normalized) > maxBytes
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) return null;
  return normalized;
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseTagIds(value: string): string[] | null {
  if (!value.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length > 100) return null;
  const tags: string[] = [];
  for (const value of parsed) {
    const tag = cleanString(value, 128);
    if (!tag || !/^[A-Za-z0-9_@.-]+$/.test(tag)) return null;
    tags.push(tag);
  }
  return [...new Set(tags)].sort();
}

function channelIdFromState(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^channelCode-([1-9]\d{0,9})$/.exec(value);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id <= 2_147_483_647 ? id : null;
}

function directMediaId(value: unknown): string | null {
  const mediaId = cleanString(value, 512);
  return mediaId && /^[A-Za-z0-9_@.-]+$/.test(mediaId) ? mediaId : null;
}

function normalizeWelcomeAttachments(value: unknown): unknown[] | null {
  if (value === null || value === undefined || value === "") return [];
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed) || parsed.length > 9) return null;
  const output: unknown[] = [];
  for (const raw of parsed) {
    if (!isRecord(raw)) return null;
    const msgtype = cleanString(raw.msgtype, 32);
    if (msgtype === "image") {
      const image = isRecord(raw.image) ? raw.image : {};
      const mediaId = directMediaId(image.media_id);
      if (!mediaId) return null;
      output.push({ msgtype, image: { media_id: mediaId } });
      continue;
    }
    if (msgtype === "miniprogram") {
      const mini = isRecord(raw.miniprogram) ? raw.miniprogram : {};
      const appid = cleanString(mini.appid, 128);
      const title = cleanString(mini.title, 128);
      const page = cleanString(mini.page, 1024);
      const picMediaId = directMediaId(mini.pic_media_id);
      if (!appid || !title || !page || !picMediaId) return null;
      output.push({
        msgtype,
        miniprogram: {
          appid,
          title,
          page,
          pic_media_id: picMediaId,
        },
      });
      continue;
    }
    if (msgtype === "video" || msgtype === "file") {
      const content = isRecord(raw[msgtype]) ? raw[msgtype] as Record<string, unknown> : {};
      const mediaId = directMediaId(content.media_id);
      if (!mediaId) return null;
      output.push({ msgtype, [msgtype]: { media_id: mediaId } });
      continue;
    }
    // PHP's resolver did not emit link attachments. Keep that behavior.
    if (msgtype === "link") continue;
    return null;
  }
  return output;
}

function welcomeMessage(
  raw: Record<string, unknown>,
  clientName: string,
): { message?: WorkContactActionPayload; error?: string } {
  const textRecord = isRecord(raw.text) ? raw.text : {};
  const rawContent = typeof textRecord.content === "string" ? textRecord.content : "";
  const replaced = rawContent.replaceAll("##客户名称##", clientName).trim();
  if (utf8Bytes(replaced) > 4_000 || /[\u0000]/.test(replaced)) {
    return { error: "welcome_text_invalid" };
  }
  const attachments = normalizeWelcomeAttachments(raw.attachments);
  if (!attachments) return { error: "welcome_media_not_materialized" };
  if (!replaced && attachments.length === 0) return {};
  const message: WorkContactActionPayload = {};
  if (replaced) message.text = { content: replaced };
  if (attachments.length > 0) message.attachments = attachments;
  return { message };
}

function safeErrorCode(error: unknown): string {
  if (error instanceof EnterpriseWechatProviderError) {
    return `${error.operation}_${error.kind}`.slice(0, 64);
  }
  const candidate = error instanceof Error ? error.message : String(error);
  return /^[a-z0-9_:-]{1,64}$/i.test(candidate)
    ? candidate
    : "work_contact_action_failed";
}

function retryDelay(attempt: number, providerDelay = 0): number {
  return Math.min(Math.max(30 * 2 ** Math.max(attempt - 1, 0), providerDelay), 3600);
}

export function isWorkContactActionMessage(value: unknown): value is WorkContactActionMessage {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 3
    && row.action === "processWorkContactAction"
    && Number.isSafeInteger(row.actionId)
    && Number(row.actionId) > 0
    && typeof row.actionKey === "string"
    && /^[0-9a-f]{64}$/.test(row.actionKey);
}

export function isWorkContactActionDispatchMessage(
  value: unknown,
): value is WorkContactActionDispatchMessage {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 2
    && row.action === "dispatchWorkContactActions"
    && typeof row.scheduledAt === "number"
    && Number.isSafeInteger(row.scheduledAt)
    && row.scheduledAt > 0;
}

export class EnterpriseWechatContactActionService {
  constructor(
    private readonly container: Container,
    private readonly env: WorkContactActionEnvironment,
    private readonly providerFactory: WorkContactActionProviderFactory = (corpId) => {
      if (!env.CONFIG_KV) {
        throw new EnterpriseWechatProviderError(
          "configuration",
          "work_contact_action_provider_config",
          -1,
          0,
        );
      }
      return new EnterpriseWechatProviderClient({
        CONFIG_KV: env.CONFIG_KV,
        WECHAT_WORK_EXTERNAL_CONTACT_SECRET: env.WECHAT_WORK_EXTERNAL_CONTACT_SECRET,
      }, { corpId });
    },
  ) {}

  enabled(): boolean {
    return this.env.WECHAT_WORK_CONTACT_ACTION_AUTHORITY?.trim() === ACTION_AUTHORITY;
  }

  /** Called inside the callback projection transaction. */
  async enqueueProjectedClientActions(
    tx: DbClient,
    claim: ContactActionClaim,
    result: ProjectedResult,
    now: number,
  ): Promise<number[]> {
    if (
      !this.enabled()
      || claim.changeType !== "add_external_contact" && claim.changeType !== "edit_external_contact"
      || result !== "applied" && result !== "applied-noop"
    ) return [];

    const externalUserid = typeof claim.payload.ExternalUserID === "string"
      ? claim.payload.ExternalUserID
      : "";
    const userid = typeof claim.payload.UserID === "string"
      ? claim.payload.UserID.toLowerCase()
      : "";
    const clients = await tx.select({
      id: workClientCurrent.id,
      name: workClientCurrent.name,
      unionid: workClientCurrent.unionid,
    }).from(workClientCurrent).where(and(
      eq(workClientCurrent.corpId, claim.corpId),
      eq(workClientCurrent.externalUserid, externalUserid),
      eq(workClientCurrent.lifecycleState, "ACTIVE"),
    )).limit(2).for("update");
    if (clients.length !== 1) throw new Error("contact_action_client_identity_ambiguous");
    const client = clients[0];

    const drafts: DraftAction[] = [];
    const unionidHash = client.unionid
      ? await shaHex("SHA-256", client.unionid)
      : "";
    drafts.push({
      type: "CLIENT_UID_LINK",
      payload: { unionid_hash: unionidHash },
      status: "PENDING",
      errorCode: "",
      deadlineTime: now + UID_LINK_TTL_SECONDS,
    });

    if (claim.changeType === "add_external_contact") {
      const channelId = channelIdFromState(claim.payload.State);
      let channel: {
        id: number;
        labelId: string;
        welcomeType: number;
        welcomeWords: string;
      } | undefined;
      if (channelId) {
        const rows = await tx.select({
          id: workChannelCode.id,
          labelId: workChannelCode.labelId,
          welcomeType: workChannelCode.welcomeType,
          welcomeWords: workChannelCode.welcomeWords,
        }).from(workChannelCode).where(and(
          eq(workChannelCode.id, channelId),
          isNull(workChannelCode.deleteTime),
        )).limit(1).for("update");
        channel = rows[0];
      }

      const welcomeDraft = await this.welcomeDraft(
        tx,
        claim,
        userid,
        client.name ?? "",
        channel,
        now,
      );
      if (channel) welcomeDraft.channelId = channel.id;
      drafts.unshift(welcomeDraft);
      drafts.splice(1, 0, await this.tagDraft(tx, claim.corpId, channel));
    }

    const insertedIds: number[] = [];
    for (const draft of drafts) {
      const canonical = JSON.stringify(draft.payload);
      const actionKey = await shaHex(
        "SHA-256",
        `${claim.eventKey}\0${draft.type}`,
      );
      const payloadHash = await shaHex("SHA-256", canonical);
      const inserted = await tx.insert(workContactActionOutbox).values({
        eventId: claim.eventId,
        eventKey: claim.eventKey,
        actionKey,
        actionType: draft.type,
        corpId: claim.corpId,
        clientId: client.id,
        payload: draft.payload,
        payloadHash,
        status: draft.status,
        availableTime: now,
        deadlineTime: draft.deadlineTime,
        lastErrorCode: draft.errorCode,
        processedTime: TERMINAL_STATUSES.includes(draft.status) ? now : 0,
        addTime: now,
        updateTime: now,
      }).onConflictDoNothing({
        target: [workContactActionOutbox.eventId, workContactActionOutbox.actionType],
      }).returning({ id: workContactActionOutbox.id });
      if (inserted[0]) {
        insertedIds.push(inserted[0].id);
        if (draft.type === "WELCOME_SEND" && draft.channelId) {
          await tx.update(workChannelCode).set({
            clientNum: sql`${workChannelCode.clientNum} + 1`,
            updateTime: now,
          }).where(eq(workChannelCode.id, draft.channelId));
        }
      } else {
        const existing = await tx.select({
          actionKey: workContactActionOutbox.actionKey,
          payloadHash: workContactActionOutbox.payloadHash,
          clientId: workContactActionOutbox.clientId,
        }).from(workContactActionOutbox).where(and(
          eq(workContactActionOutbox.eventId, claim.eventId),
          eq(workContactActionOutbox.actionType, draft.type),
        )).limit(1);
        if (
          existing[0]?.actionKey !== actionKey
          || existing[0]?.payloadHash !== payloadHash
          || existing[0]?.clientId !== client.id
        ) throw new Error("contact_action_immutable_conflict");
      }
    }

    await tx.update(workCallbackEvent).set({
      payloadRetainedUntil: Math.max(
        now + CALLBACK_PAYLOAD_RETENTION_SECONDS,
        claim.changeType === "add_external_contact"
          ? now + CALLBACK_PAYLOAD_RETENTION_SECONDS
          : now + UID_LINK_TTL_SECONDS,
      ),
      updateTime: now,
    }).where(eq(workCallbackEvent.id, claim.eventId));
    return insertedIds;
  }

  private async welcomeDraft(
    tx: DbClient,
    claim: ContactActionClaim,
    userid: string,
    clientName: string,
    channel: { welcomeType: number; welcomeWords: string } | undefined,
    now: number,
  ): Promise<DraftAction> {
    const deadlineTime = Math.max(1, claim.receivedTime + WELCOME_TTL_SECONDS);
    if (deadlineTime <= now) {
      return {
        type: "WELCOME_SEND", payload: {}, status: "EXPIRED",
        errorCode: "welcome_code_expired_before_enqueue", deadlineTime,
      };
    }
    const welcomeCode = cleanString(claim.payload.WelcomeCode, 512);
    if (!welcomeCode) {
      return {
        type: "WELCOME_SEND", payload: {}, status: "DEAD",
        errorCode: "welcome_code_missing", deadlineTime,
      };
    }

    let raw: Record<string, unknown> | null = null;
    if (channel && channel.welcomeType === 0) {
      raw = parseJsonRecord(channel.welcomeWords);
      if (!raw) {
        return {
          type: "WELCOME_SEND", payload: {}, status: "DEAD",
          errorCode: "channel_welcome_invalid_json", deadlineTime,
        };
      }
    }
    if (!raw) {
      const assigned = await tx.select({
        content: workWelcome.content,
        attachments: workWelcome.attachments,
        }).from(workWelcomeRelation)
        .innerJoin(workWelcome, eq(workWelcome.id, workWelcomeRelation.welcomeId))
        .where(and(
          sql`lower(${workWelcomeRelation.userid}) = ${userid}`,
          isNull(workWelcome.deleteTime),
        ))
        .orderBy(desc(workWelcome.sort), desc(workWelcome.createTime), desc(workWelcome.id))
        .limit(1);
      const fallback = assigned[0] ? assigned : await tx.select({
        content: workWelcome.content,
        attachments: workWelcome.attachments,
      }).from(workWelcome).where(and(
        eq(workWelcome.type, 0),
        isNull(workWelcome.deleteTime),
      )).orderBy(desc(workWelcome.sort), desc(workWelcome.createTime), desc(workWelcome.id)).limit(1);
      const selected = fallback[0];
      raw = selected
        ? { text: { content: selected.content ?? "" }, attachments: selected.attachments ?? [] }
        : { text: { content: "" }, attachments: [] };
    }
    const normalized = welcomeMessage(raw, clientName);
    if (normalized.error) {
      return {
        type: "WELCOME_SEND", payload: {}, status: "DEAD",
        errorCode: normalized.error, deadlineTime,
      };
    }
    if (!normalized.message) {
      return {
        type: "WELCOME_SEND", payload: {}, status: "SKIPPED",
        errorCode: "welcome_message_empty", deadlineTime,
      };
    }
    return {
      type: "WELCOME_SEND",
      payload: { message: normalized.message },
      status: "PENDING",
      errorCode: "",
      deadlineTime,
    };
  }

  private async tagDraft(
    tx: DbClient,
    corpId: string,
    channel: { labelId: string } | undefined,
  ): Promise<DraftAction> {
    if (!channel) {
      return {
        type: "AUTO_TAG", payload: {}, status: "SKIPPED",
        errorCode: "channel_not_resolved", deadlineTime: 0,
      };
    }
    const tagIds = parseTagIds(channel.labelId);
    if (!tagIds) {
      return {
        type: "AUTO_TAG", payload: {}, status: "DEAD",
        errorCode: "channel_tag_invalid_json", deadlineTime: 0,
      };
    }
    if (tagIds.length === 0) {
      return {
        type: "AUTO_TAG", payload: {}, status: "SKIPPED",
        errorCode: "channel_tag_empty", deadlineTime: 0,
      };
    }
    const tags = await tx.select({ tagId: workExternalTagCurrent.tagId })
      .from(workExternalTagCurrent).where(and(
        eq(workExternalTagCurrent.corpId, corpId),
        eq(workExternalTagCurrent.strategyId, 0),
        eq(workExternalTagCurrent.lifecycleState, "ACTIVE"),
        inArray(workExternalTagCurrent.tagId, tagIds),
      ));
    if (new Set(tags.map((tag) => tag.tagId)).size !== tagIds.length) {
      return {
        type: "AUTO_TAG", payload: { add_tag: tagIds }, status: "DEAD",
        errorCode: "channel_tag_catalog_unresolved", deadlineTime: 0,
      };
    }
    return {
      type: "AUTO_TAG", payload: { add_tag: tagIds }, status: "PENDING",
      errorCode: "", deadlineTime: 0,
    };
  }

  async dispatchForEvent(eventId: number): Promise<{ claimed: number; enqueued: number }> {
    return this.dispatchPending(3, eventId);
  }

  async dispatchPending(
    limit = 20,
    eventId?: number,
  ): Promise<{ claimed: number; enqueued: number }> {
    const bounded = Math.max(1, Math.min(Math.trunc(limit), 100));
    const now = nowSeconds();
    await this.recoverExpiredLeases(now);
    await this.expireWelcomeActions(now);
    if (!this.enabled()) return { claimed: 0, enqueued: 0 };

    const leaseToken = crypto.randomUUID();
    const claimed = await withTx(this.container, async (tx) => {
      const rows = await tx.select({
        id: workContactActionOutbox.id,
        actionKey: workContactActionOutbox.actionKey,
      }).from(workContactActionOutbox).where(and(
        inArray(workContactActionOutbox.status, ["PENDING", "RETRYABLE"]),
        lte(workContactActionOutbox.availableTime, now),
        eventId ? eq(workContactActionOutbox.eventId, eventId) : undefined,
      )).orderBy(
        asc(sql`CASE ${workContactActionOutbox.actionType}
          WHEN 'WELCOME_SEND' THEN 0 WHEN 'AUTO_TAG' THEN 1 ELSE 2 END`),
        asc(workContactActionOutbox.id),
      ).limit(bounded).for("update", { skipLocked: true });
      if (rows.length === 0) return [];
      await tx.update(workContactActionOutbox).set({
        status: "ENQUEUING",
        leaseToken,
        leaseUntil: now + DISPATCH_LEASE_SECONDS,
        dispatchCount: sql`${workContactActionOutbox.dispatchCount} + 1`,
        updateTime: now,
      }).where(inArray(workContactActionOutbox.id, rows.map((row) => row.id)));
      return rows;
    });

    let enqueued = 0;
    for (const row of claimed) {
      try {
        await this.env.ORDER_QUEUE.send({
          action: "processWorkContactAction",
          actionId: row.id,
          actionKey: row.actionKey,
        });
        await withTx(this.container, async (tx) => {
          await tx.update(workContactActionOutbox).set({
            status: "ENQUEUED",
            enqueuedTime: nowSeconds(),
            updateTime: nowSeconds(),
          }).where(and(
            eq(workContactActionOutbox.id, row.id),
            eq(workContactActionOutbox.status, "ENQUEUING"),
            eq(workContactActionOutbox.leaseToken, leaseToken),
          ));
        });
        enqueued += 1;
      } catch {
        await withTx(this.container, async (tx) => {
          await tx.update(workContactActionOutbox).set({
            status: "RETRYABLE",
            availableTime: nowSeconds() + 30,
            leaseUntil: 0,
            leaseToken: "",
            lastErrorCode: "contact_action_enqueue_failed",
            updateTime: nowSeconds(),
          }).where(and(
            eq(workContactActionOutbox.id, row.id),
            eq(workContactActionOutbox.status, "ENQUEUING"),
            eq(workContactActionOutbox.leaseToken, leaseToken),
          ));
        });
        throw new Error("contact_action_enqueue_failed");
      }
    }
    return { claimed: claimed.length, enqueued };
  }

  async processMessage(message: WorkContactActionMessage): Promise<ProcessResult> {
    const claim = await this.claim(message);
    if (typeof claim === "string" || "kind" in claim) return claim;
    if (claim.actionType === "CLIENT_UID_LINK") return this.processUidLink(claim);

    try {
      const provider = this.providerFactory(claim.corpId);
      if (claim.actionType === "WELCOME_SEND") {
        const welcomeCode = typeof claim.callbackPayload.WelcomeCode === "string"
          ? claim.callbackPayload.WelcomeCode
          : "";
        const rawMessage = isRecord(claim.payload.message) ? claim.payload.message : null;
        if (!welcomeCode || !rawMessage) throw new Error("welcome_action_payload_invalid");
        await provider.sendWelcome(welcomeCode, rawMessage as {
          text?: { content: string };
          attachments?: unknown[];
        });
      } else {
        const userid = typeof claim.callbackPayload.UserID === "string"
          ? claim.callbackPayload.UserID.toLowerCase()
          : "";
        const externalUserid = typeof claim.callbackPayload.ExternalUserID === "string"
          ? claim.callbackPayload.ExternalUserID
          : "";
        const addTags = Array.isArray(claim.payload.add_tag)
          ? claim.payload.add_tag.filter((tag): tag is string => typeof tag === "string")
          : [];
        if (!userid || !externalUserid || addTags.length === 0) {
          throw new Error("tag_action_payload_invalid");
        }
        await provider.markExternalContactTags(userid, externalUserid, addTags);
      }
    } catch (error) {
      return this.recordProviderFailure(claim, error);
    }
    // Deliberately outside the provider catch. If this persistence step is
    // unavailable or has an unknown commit outcome, Queue retry must not turn
    // a successful remote write into a known failure or resend it. The expired
    // PROCESSING lease fence below converges the action to UNKNOWN instead.
    await this.finalize(claim, "SUCCEEDED", "", null);
    return "succeeded";
  }

  private async claim(
    message: WorkContactActionMessage,
  ): Promise<ClaimedAction | "already-terminal" | "busy" | "expired" | "unknown" | { kind: "deferred"; delaySeconds: number } | { kind: "parked" }> {
    const now = nowSeconds();
    const leaseToken = crypto.randomUUID();
    return withTx(this.container, async (tx) => {
      const rows = await tx.select({
        id: workContactActionOutbox.id,
        eventId: workContactActionOutbox.eventId,
        eventKey: workContactActionOutbox.eventKey,
        actionKey: workContactActionOutbox.actionKey,
        actionType: workContactActionOutbox.actionType,
        corpId: workContactActionOutbox.corpId,
        clientId: workContactActionOutbox.clientId,
        payload: workContactActionOutbox.payload,
        status: workContactActionOutbox.status,
        availableTime: workContactActionOutbox.availableTime,
        deadlineTime: workContactActionOutbox.deadlineTime,
        leaseUntil: workContactActionOutbox.leaseUntil,
        attemptCount: workContactActionOutbox.attemptCount,
      }).from(workContactActionOutbox)
        .where(eq(workContactActionOutbox.id, message.actionId))
        .limit(1).for("update");
      const row = rows[0];
      if (!row || row.actionKey !== message.actionKey) {
        throw new Error("contact_action_queue_message_mismatch");
      }
      if (TERMINAL_STATUSES.includes(row.status)) return "already-terminal";
      if (row.status === "PROCESSING" && row.leaseUntil > now) return "busy";
      if (
        row.status === "PROCESSING"
        && row.leaseUntil <= now
        && row.actionType !== "CLIENT_UID_LINK"
      ) {
        await tx.update(workContactActionOutbox).set({
          status: "UNKNOWN",
          leaseUntil: 0,
          leaseToken: "",
          lastErrorCode: "contact_action_provider_lease_expired",
          processedTime: now,
          unknownTime: now,
          updateTime: now,
        }).where(eq(workContactActionOutbox.id, row.id));
        return "unknown";
      }
      if (row.actionType === "WELCOME_SEND" && row.deadlineTime <= now) {
        await tx.update(workContactActionOutbox).set({
          status: "EXPIRED", payload: {}, leaseUntil: 0, leaseToken: "",
          lastErrorCode: "welcome_code_expired", processedTime: now, updateTime: now,
        }).where(eq(workContactActionOutbox.id, row.id));
        return "expired";
      }
      if (!this.enabled()) {
        await tx.update(workContactActionOutbox).set({
          status: "RETRYABLE", availableTime: now + 900,
          leaseUntil: 0, leaseToken: "", lastErrorCode: "contact_action_disabled",
          updateTime: now,
        }).where(eq(workContactActionOutbox.id, row.id));
        return { kind: "parked" as const };
      }
      if (row.status === "RETRYABLE" && row.availableTime > now) {
        return {
          kind: "deferred" as const,
          delaySeconds: Math.min(Math.max(row.availableTime - now, 1), 900),
        };
      }
      const attemptCount = row.attemptCount + 1;
      const maxAttempts = row.actionType === "CLIENT_UID_LINK"
        ? MAX_UID_LINK_ATTEMPTS
        : MAX_PROVIDER_ATTEMPTS;
      if (attemptCount > maxAttempts) {
        await tx.update(workContactActionOutbox).set({
          status: "DEAD", leaseUntil: 0, leaseToken: "",
          lastErrorCode: "contact_action_attempt_limit", processedTime: now, updateTime: now,
        }).where(eq(workContactActionOutbox.id, row.id));
        return "already-terminal";
      }
      const callbacks = await tx.select({
        eventKey: workCallbackEvent.eventKey,
        corpId: workCallbackEvent.corpId,
        payload: workCallbackEvent.payload,
      }).from(workCallbackEvent).where(eq(workCallbackEvent.id, row.eventId)).limit(1);
      const callback = callbacks[0];
      if (!callback || callback.eventKey !== row.eventKey || callback.corpId !== row.corpId) {
        throw new Error("contact_action_callback_mismatch");
      }
      await tx.update(workContactActionOutbox).set({
        status: "PROCESSING",
        attemptCount,
        leaseUntil: now + PROCESS_LEASE_SECONDS,
        leaseToken,
        updateTime: now,
      }).where(eq(workContactActionOutbox.id, row.id));
      return {
        ...row,
        attemptCount,
        leaseToken,
        callbackPayload: callback.payload,
      };
    });
  }

  private async processUidLink(claim: ClaimedAction): Promise<ProcessResult> {
    const now = nowSeconds();
    return withTx(this.container, async (tx) => {
      const actionRows = await tx.select({
        status: workContactActionOutbox.status,
        leaseToken: workContactActionOutbox.leaseToken,
      }).from(workContactActionOutbox).where(eq(workContactActionOutbox.id, claim.id))
        .limit(1).for("update");
      if (
        actionRows[0]?.status !== "PROCESSING"
        || actionRows[0].leaseToken !== claim.leaseToken
      ) throw new Error("contact_action_processing_lease_lost");
      const clients = await tx.select({
        uid: workClientCurrent.uid,
        unionid: workClientCurrent.unionid,
        lifecycleState: workClientCurrent.lifecycleState,
      }).from(workClientCurrent).where(and(
        eq(workClientCurrent.corpId, claim.corpId),
        eq(workClientCurrent.id, claim.clientId),
      )).limit(1).for("update");
      const client = clients[0];
      if (!client || client.lifecycleState !== "ACTIVE") {
        await this.finalizeInTx(tx, claim, "SKIPPED", "client_not_active", null, now);
        return "skipped";
      }
      if (!client.unionid) {
        await this.finalizeInTx(tx, claim, "SKIPPED", "client_unionid_missing", null, now);
        return "skipped";
      }
      const currentHash = await shaHex("SHA-256", client.unionid);
      if (claim.payload.unionid_hash !== currentHash) {
        await this.finalizeInTx(tx, claim, "SKIPPED", "client_unionid_superseded", null, now);
        return "skipped";
      }
      const identities = await tx.selectDistinct({ uid: wechatUser.uid })
        .from(wechatUser)
        .innerJoin(user, eq(user.uid, wechatUser.uid))
        .where(and(
          eq(wechatUser.unionid, client.unionid),
          eq(wechatUser.isDel, 0),
          eq(user.isDel, 0),
          isNull(user.deleteTime),
          eq(user.status, 1),
          sql`${wechatUser.uid} > 0`,
        )).orderBy(asc(wechatUser.uid)).limit(3);
      if (identities.length === 0) {
        if (claim.attemptCount < MAX_UID_LINK_ATTEMPTS && claim.deadlineTime > now) {
          await tx.update(workContactActionOutbox).set({
            status: "RETRYABLE",
            availableTime: now + retryDelay(claim.attemptCount),
            leaseUntil: 0,
            leaseToken: "",
            lastErrorCode: "client_unionid_not_linkable",
            updateTime: now,
          }).where(and(
            eq(workContactActionOutbox.id, claim.id),
            eq(workContactActionOutbox.status, "PROCESSING"),
            eq(workContactActionOutbox.leaseToken, claim.leaseToken),
          ));
          return { kind: "deferred", delaySeconds: retryDelay(claim.attemptCount) };
        }
        await this.finalizeInTx(tx, claim, "SKIPPED", "client_unionid_not_linkable", null, now);
        return "skipped";
      }
      if (identities.length !== 1) {
        await this.finalizeInTx(tx, claim, "DEAD", "client_unionid_ambiguous", null, now);
        return "dead";
      }
      const uid = identities[0].uid;
      if (client.uid !== null && client.uid !== uid) {
        await this.finalizeInTx(tx, claim, "DEAD", "client_uid_conflict", null, now);
        return "dead";
      }
      if (client.uid === null) {
        const linked = await tx.update(workClientCurrent).set({ uid, updateTime: now })
          .where(and(
            eq(workClientCurrent.corpId, claim.corpId),
            eq(workClientCurrent.id, claim.clientId),
            isNull(workClientCurrent.uid),
          )).returning({ id: workClientCurrent.id });
        if (linked.length !== 1) throw new Error("client_uid_link_lost");
      }
      await this.finalizeInTx(tx, claim, "SUCCEEDED", "", null, now);
      return "succeeded";
    });
  }

  private async recordProviderFailure(
    claim: ClaimedAction,
    error: unknown,
  ): Promise<ProcessResult> {
    const code = safeErrorCode(error);
    const providerCode = error instanceof EnterpriseWechatProviderError
      ? error.providerCode
      : null;
    if (error instanceof EnterpriseWechatProviderError && error.kind === "unknown") {
      await this.finalize(claim, "UNKNOWN", code, providerCode);
      return "unknown";
    }
    if (error instanceof EnterpriseWechatProviderError && error.kind === "retryable") {
      const now = nowSeconds();
      const delay = retryDelay(claim.attemptCount, error.retryAfterSeconds ?? 0);
      if (claim.actionType === "WELCOME_SEND" && now + delay >= claim.deadlineTime) {
        await this.finalize(claim, "EXPIRED", "welcome_retry_window_expired", providerCode);
        return "expired";
      }
      if (claim.attemptCount < MAX_PROVIDER_ATTEMPTS) {
        await withTx(this.container, async (tx) => {
          const updated = await tx.update(workContactActionOutbox).set({
            status: "RETRYABLE",
            availableTime: now + delay,
            leaseUntil: 0,
            leaseToken: "",
            lastErrorCode: code,
            providerCode,
            updateTime: now,
          }).where(and(
            eq(workContactActionOutbox.id, claim.id),
            eq(workContactActionOutbox.status, "PROCESSING"),
            eq(workContactActionOutbox.leaseToken, claim.leaseToken),
          )).returning({ id: workContactActionOutbox.id });
          if (updated.length !== 1) throw new Error("contact_action_processing_lease_lost");
        });
        return { kind: "deferred", delaySeconds: Math.min(delay, 900) };
      }
    }
    await this.finalize(claim, "DEAD", code, providerCode);
    return "dead";
  }

  private async finalize(
    claim: ClaimedAction,
    status: Extract<WorkContactActionStatus, "SUCCEEDED" | "SKIPPED" | "EXPIRED" | "UNKNOWN" | "DEAD">,
    errorCode: string,
    providerCode: number | null,
  ): Promise<void> {
    await withTx(this.container, (tx) =>
      this.finalizeInTx(tx, claim, status, errorCode, providerCode, nowSeconds()));
  }

  private async finalizeInTx(
    tx: DbClient,
    claim: Pick<ClaimedAction, "id" | "leaseToken">,
    status: Extract<WorkContactActionStatus, "SUCCEEDED" | "SKIPPED" | "EXPIRED" | "UNKNOWN" | "DEAD">,
    errorCode: string,
    providerCode: number | null,
    now: number,
  ): Promise<void> {
    const updated = await tx.update(workContactActionOutbox).set({
      status,
      payload: SCRUB_PAYLOAD_STATUSES.includes(status) ? {} : undefined,
      leaseUntil: 0,
      leaseToken: "",
      lastErrorCode: errorCode,
      providerCode,
      processedTime: now,
      unknownTime: status === "UNKNOWN" ? now : 0,
      updateTime: now,
    }).where(and(
      eq(workContactActionOutbox.id, claim.id),
      eq(workContactActionOutbox.status, "PROCESSING"),
      eq(workContactActionOutbox.leaseToken, claim.leaseToken),
    )).returning({ id: workContactActionOutbox.id });
    if (updated.length !== 1) throw new Error("contact_action_processing_lease_lost");
  }

  private async recoverExpiredLeases(now: number): Promise<void> {
    await withTx(this.container, async (tx) => {
      await tx.update(workContactActionOutbox).set({
        status: "RETRYABLE",
        availableTime: now,
        leaseUntil: 0,
        leaseToken: "",
        lastErrorCode: "contact_action_dispatch_lease_expired",
        updateTime: now,
      }).where(and(
        inArray(workContactActionOutbox.status, ["ENQUEUING", "ENQUEUED"]),
        lte(workContactActionOutbox.leaseUntil, now),
      ));
      await tx.update(workContactActionOutbox).set({
        status: "RETRYABLE",
        availableTime: now,
        leaseUntil: 0,
        leaseToken: "",
        lastErrorCode: "contact_action_local_lease_expired",
        updateTime: now,
      }).where(and(
        eq(workContactActionOutbox.status, "PROCESSING"),
        eq(workContactActionOutbox.actionType, "CLIENT_UID_LINK"),
        lte(workContactActionOutbox.leaseUntil, now),
      ));
      await tx.update(workContactActionOutbox).set({
        status: "UNKNOWN",
        leaseUntil: 0,
        leaseToken: "",
        lastErrorCode: "contact_action_provider_lease_expired",
        processedTime: now,
        unknownTime: now,
        updateTime: now,
      }).where(and(
        eq(workContactActionOutbox.status, "PROCESSING"),
        inArray(workContactActionOutbox.actionType, ["WELCOME_SEND", "AUTO_TAG"]),
        lte(workContactActionOutbox.leaseUntil, now),
      ));
    });
  }

  private async expireWelcomeActions(now: number): Promise<void> {
    await withTx(this.container, async (tx) => {
      await tx.update(workContactActionOutbox).set({
        status: "EXPIRED",
        payload: {},
        leaseUntil: 0,
        leaseToken: "",
        lastErrorCode: "welcome_code_expired",
        processedTime: now,
        updateTime: now,
      }).where(and(
        eq(workContactActionOutbox.actionType, "WELCOME_SEND"),
        inArray(workContactActionOutbox.status, ["PENDING", "RETRYABLE"]),
        lte(workContactActionOutbox.deadlineTime, now),
      ));
    });
  }

  async redactCompletedCallbackPayloads(limit = 100): Promise<number> {
    const bounded = Math.max(1, Math.min(Math.trunc(limit), 500));
    const now = nowSeconds();
    return withTx(this.container, async (tx) => {
      const candidates = await tx.select({ id: workCallbackEvent.id })
        .from(workCallbackEvent)
        .innerJoin(workCallbackOutbox, eq(workCallbackOutbox.eventId, workCallbackEvent.id))
        .where(and(
          eq(workCallbackEvent.status, "ORDERED"),
          eq(workCallbackEvent.payloadRedactedTime, 0),
          lte(workCallbackEvent.payloadRetainedUntil, now),
          eq(workCallbackOutbox.status, "COMPLETED"),
          sql`NOT EXISTS (
            SELECT 1 FROM work_contact_action_outbox AS action_row
            WHERE action_row.event_id = ${workCallbackEvent.id}
              AND action_row.status NOT IN ('SUCCEEDED','SKIPPED','EXPIRED','CLOSED')
          )`,
        )).orderBy(asc(workCallbackEvent.id)).limit(bounded)
        .for("update", { skipLocked: true });
      if (candidates.length === 0) return 0;
      const rows = await tx.update(workCallbackEvent).set({
        payload: sql`jsonb_strip_nulls(jsonb_build_object(
          'MsgType', ${workCallbackEvent.msgType},
          'Event', ${workCallbackEvent.eventType},
          'ChangeType', ${workCallbackEvent.changeType},
          'CreateTime', ${workCallbackEvent.eventTime}
        ))`,
        payloadRedactedTime: now,
        updateTime: now,
      }).where(inArray(workCallbackEvent.id, candidates.map((row) => row.id)))
        .returning({ id: workCallbackEvent.id });
      return rows.length;
    });
  }

  async listForAdmin(query: Record<string, string>) {
    const page = Math.max(1, Math.min(Number(query.page) || 1, 100_000));
    const limit = Math.max(1, Math.min(Number(query.limit) || 20, 100));
    const status = query.status?.trim().toUpperCase();
    const actionType = query.action_type?.trim().toUpperCase();
    const where = and(
      status && (WORK_CONTACT_ACTION_STATUSES as readonly string[]).includes(status)
        ? eq(workContactActionOutbox.status, status as WorkContactActionStatus)
        : undefined,
      actionType && ["WELCOME_SEND", "AUTO_TAG", "CLIENT_UID_LINK"].includes(actionType)
        ? eq(workContactActionOutbox.actionType, actionType as WorkContactActionType)
        : undefined,
    );
    const [rows, totals] = await Promise.all([
      this.container.db.select({
        id: workContactActionOutbox.id,
        actionType: workContactActionOutbox.actionType,
        status: workContactActionOutbox.status,
        attemptCount: workContactActionOutbox.attemptCount,
        dispatchCount: workContactActionOutbox.dispatchCount,
        deadlineTime: workContactActionOutbox.deadlineTime,
        lastErrorCode: workContactActionOutbox.lastErrorCode,
        providerCode: workContactActionOutbox.providerCode,
        processedTime: workContactActionOutbox.processedTime,
        updateTime: workContactActionOutbox.updateTime,
      }).from(workContactActionOutbox).where(where)
        .orderBy(desc(workContactActionOutbox.updateTime), desc(workContactActionOutbox.id))
        .limit(limit).offset((page - 1) * limit),
      this.container.db.select({ count: sql<number>`count(*)::integer` })
        .from(workContactActionOutbox).where(where),
    ]);
    return {
      list: rows.map((row) => ({
        id: row.id,
        action_type: row.actionType,
        status: row.status,
        attempt_count: row.attemptCount,
        dispatch_count: row.dispatchCount,
        deadline_time: row.deadlineTime,
        last_error_code: row.lastErrorCode,
        provider_code: row.providerCode,
        processed_time: row.processedTime,
        update_time: row.updateTime,
      })),
      count: Number(totals[0]?.count ?? 0),
      pii_display: "none",
      queue_payload: "references_only",
      remote_write_authority: this.enabled() ? "verified" : "disabled",
    };
  }

  async decide(
    actorId: number,
    actionId: number,
    input: {
      request_key?: unknown;
      operation?: unknown;
      reason?: unknown;
      risk_accepted?: unknown;
      provider_reference?: unknown;
    },
  ) {
    if (!Number.isSafeInteger(actorId) || actorId <= 0) throw new ValidateException("管理员身份无效");
    if (!Number.isSafeInteger(actionId) || actionId <= 0) throw new ValidateException("动作编号无效");
    const requestKey = typeof input.request_key === "string"
      ? input.request_key.trim().toLowerCase()
      : "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestKey)) {
      throw new ValidateException("request_key 必须是 UUID");
    }
    const operation = typeof input.operation === "string"
      ? input.operation.trim().toUpperCase()
      : "";
    if (!["CONFIRM_SUCCEEDED", "RETRY_WITH_RISK", "CLOSE"].includes(operation)) {
      throw new ValidateException("人工处置类型无效");
    }
    const reason = typeof input.reason === "string" ? input.reason.trim() : "";
    if (reason.length < 8 || reason.length > 500 || /[\u0000-\u001f\u007f]/.test(reason)) {
      throw new ValidateException("处置理由长度必须为 8 到 500 个可见字符");
    }
    const riskAccepted = input.risk_accepted === true;
    if (operation === "RETRY_WITH_RISK" && !riskAccepted) {
      throw new ValidateException("重放前必须明确接受重复副作用风险");
    }
    const providerReference = typeof input.provider_reference === "string"
      ? input.provider_reference.trim()
      : "";
    if (utf8Bytes(providerReference) > 256 || /[\u0000-\u001f\u007f]/.test(providerReference)) {
      throw new ValidateException("提供商参考号无效");
    }
    const providerReferenceHash = providerReference
      ? await shaHex("SHA-256", providerReference)
      : null;
    const requestHash = await shaHex("SHA-256", JSON.stringify({
      operation,
      reason,
      riskAccepted,
      providerReferenceHash,
    }));
    const now = nowSeconds();
    return withTx(this.container, async (tx) => {
      const existing = await tx.select({
        requestHash: workContactActionAudit.requestHash,
        toStatus: workContactActionAudit.toStatus,
      }).from(workContactActionAudit).where(and(
        eq(workContactActionAudit.actionId, actionId),
        eq(workContactActionAudit.requestKey, requestKey),
      )).limit(1);
      if (existing[0]) {
        if (existing[0].requestHash !== requestHash) {
          throw new ValidateException("同一 request_key 的处置内容冲突");
        }
        return { status: existing[0].toStatus, replayed: true };
      }
      const actions = await tx.select({
        actionType: workContactActionOutbox.actionType,
        status: workContactActionOutbox.status,
      }).from(workContactActionOutbox).where(eq(workContactActionOutbox.id, actionId))
        .limit(1).for("update");
      const action = actions[0];
      if (!action || !["UNKNOWN", "DEAD"].includes(action.status)) {
        throw new ValidateException("只有 UNKNOWN 或 DEAD 动作可人工处置");
      }
      let toStatus: WorkContactActionStatus;
      if (operation === "CONFIRM_SUCCEEDED") {
        if (action.status !== "UNKNOWN") {
          throw new ValidateException("只有 UNKNOWN 动作可人工确认为成功");
        }
        toStatus = "SUCCEEDED";
      }
      else if (operation === "CLOSE") toStatus = "CLOSED";
      else {
        if (action.actionType === "WELCOME_SEND") {
          throw new ValidateException("欢迎码为单次凭据，UNKNOWN/DEAD 不允许重发");
        }
        toStatus = "RETRYABLE";
      }
      await tx.insert(workContactActionAudit).values({
        actionId,
        requestKey,
        requestHash,
        operation,
        fromStatus: action.status,
        toStatus,
        actorId,
        reason,
        riskAccepted,
        providerReferenceHash,
        addTime: now,
      });
      const updated = await tx.update(workContactActionOutbox).set({
        status: toStatus,
        payload: toStatus === "SUCCEEDED" || toStatus === "CLOSED" ? {} : undefined,
        availableTime: toStatus === "RETRYABLE" ? now : 0,
        leaseUntil: 0,
        leaseToken: "",
        lastErrorCode: toStatus === "RETRYABLE" ? "manual_retry_authorized" : "",
        processedTime: toStatus === "RETRYABLE" ? 0 : now,
        unknownTime: 0,
        updateTime: now,
      }).where(and(
        eq(workContactActionOutbox.id, actionId),
        eq(workContactActionOutbox.status, action.status),
      )).returning({ id: workContactActionOutbox.id });
      if (updated.length !== 1) throw new Error("contact_action_manual_fence_lost");
      return { status: toStatus, replayed: false };
    });
  }
}

export interface WorkContactActionQueueMessageControl {
  body: WorkContactActionMessage;
  attempts: number;
  ack(): void;
  retry(options: { delaySeconds: number }): void;
}

export async function consumeWorkContactActionMessage(
  message: WorkContactActionQueueMessageControl,
  service: Pick<EnterpriseWechatContactActionService, "processMessage">,
): Promise<void> {
  const startedAt = Date.now();
  try {
    const result = await service.processMessage(message.body);
    if (result === "busy") {
      emitOperationalEvent("warn", {
        event: "work_contact_action_retried",
        component: "queue",
        operation: "work_contact_action",
        outcome: "retry",
        durationMs: Date.now() - startedAt,
        queueAttempt: message.attempts,
      });
      message.retry({ delaySeconds: 15 });
      return;
    }
    if (typeof result === "object" && result.kind === "deferred") {
      emitOperationalEvent("warn", {
        event: "work_contact_action_retried",
        component: "queue",
        operation: "work_contact_action",
        outcome: "retry",
        durationMs: Date.now() - startedAt,
        queueAttempt: message.attempts,
        retryDelaySeconds: result.delaySeconds,
      });
      message.retry({ delaySeconds: result.delaySeconds });
      return;
    }
    if (typeof result === "object" && result.kind === "parked") {
      emitOperationalEvent("warn", {
        event: "work_contact_action_parked",
        component: "queue",
        operation: "work_contact_action",
        outcome: "unknown",
        durationMs: Date.now() - startedAt,
        queueAttempt: message.attempts,
      });
      message.ack();
      return;
    }
    emitOperationalEvent("info", {
      event: "work_contact_action_consumed",
      component: "queue",
      operation: "work_contact_action",
      outcome: "success",
      result: typeof result === "string" ? result : "completed",
      durationMs: Date.now() - startedAt,
      queueAttempt: message.attempts,
    });
    message.ack();
  } catch (error) {
    const delaySeconds = Math.min(30 * 2 ** Math.max(message.attempts - 1, 0), 900);
    emitOperationalEvent("error", {
      event: "work_contact_action_failed",
      component: "queue",
      operation: "work_contact_action",
      outcome: "retry",
      durationMs: Date.now() - startedAt,
      queueAttempt: message.attempts,
      retryDelaySeconds: delaySeconds,
      errorCode: operationalErrorCode(error, safeErrorCode(error)),
    });
    message.retry({ delaySeconds });
  }
}

const WORK_CONTACT_ACTION_STATUSES = [
  "PENDING", "ENQUEUING", "ENQUEUED", "PROCESSING", "RETRYABLE",
  "SUCCEEDED", "SKIPPED", "EXPIRED", "UNKNOWN", "DEAD", "CLOSED",
] as const;
