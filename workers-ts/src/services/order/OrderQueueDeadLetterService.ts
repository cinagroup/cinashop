import type { OrderMessage } from "@/env";
import type { Container, DbClient } from "@/lib/di";
import { withTx } from "@/lib/di";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import type {
  QueueDeadLetterReplayPolicy,
  QueueDeadLetterStatus,
} from "@/models/schema";
import {
  systemQueueDeadLetter,
  type SystemQueueDeadLetter,
} from "@/models/schema";
import { isSmsVerificationMessage } from "@/services/message/SmsVerificationService";
import { isSignReminderMessage } from "@/services/message/SignReminderService";
import {
  isOrderNotificationOutboxMessage,
  isOrderPaidOutboxMessage,
} from "@/services/order/OrderOutboxService";
import {
  isPinkTimeoutMessage,
  isScheduledMaintenanceMessage,
  isScheduledOrderMessage,
} from "@/services/order/ScheduledMaintenanceService";
import { isAttachmentObjectCleanupMessage } from "@/services/system/AttachmentService";
import { isOfficialAccountQrcodeMessage } from "@/services/wechat/OfficialAccountQrcodeService";
import {
  isWorkCallbackDispatchMessage,
  isWorkCallbackOutboxMessage,
} from "@/services/work/EnterpriseWechatCallbackService";
import {
  isPaymentCallbackDispatchMessage,
  isPaymentCallbackMessage,
} from "@/services/payment/PaymentCallbackEventService";
import { NotFoundException, ValidateException } from "@/utils/errors";
import { emitOperationalEvent, operationalErrorCode } from "@/utils/observability";

type JsonPrimitive = string | number | boolean | null;
export type SafeJsonValue = JsonPrimitive | SafeJsonValue[] | { [key: string]: SafeJsonValue };

export interface PreparedOrderQueueDeadLetter {
  messageType: string;
  replayPolicy: QueueDeadLetterReplayPolicy;
  body: SafeJsonValue;
  replayMessage?: OrderMessage;
}

export interface ArchivedOrderQueueDeadLetter {
  id: number;
  duplicate: boolean;
  status: QueueDeadLetterStatus;
  messageType: string;
  replayPolicy: QueueDeadLetterReplayPolicy;
  occurrenceCount: number;
}

export interface OrderQueueDeadLetterListQuery {
  status?: string;
  messageType?: string;
  afterId?: number;
  limit?: number;
}

interface ReplayClaim {
  id: number;
  token: string;
  body: OrderMessage;
  replayCount: number;
}

const STATUS_VALUES = new Set<QueueDeadLetterStatus>([
  "OPEN",
  "REPLAYING",
  "REPLAYED",
  "RESOLVED",
]);
const REPLAY_LEASE_SECONDS = 120;
const MAX_REPLAY_COUNT = 20;
const MAX_UNKNOWN_DEPTH = 12;
const MAX_UNKNOWN_ENTRIES = 2_000;
const MAX_ARCHIVED_STRING = 8_192;
const SENSITIVE_KEY = /(?:authorization|password|passwd|secret|token|api[_-]?key|private[_-]?key|code)/i;
const PHONE_KEY = /(?:phone|mobile|tel)$/i;

/** Admin list projection deliberately omits the internal replay lease token. */
export const orderQueueDeadLetterAdminListColumns = {
  id: systemQueueDeadLetter.id,
  queueName: systemQueueDeadLetter.queueName,
  messageId: systemQueueDeadLetter.messageId,
  messageTimestampMs: systemQueueDeadLetter.messageTimestampMs,
  dlqAttempts: systemQueueDeadLetter.dlqAttempts,
  messageType: systemQueueDeadLetter.messageType,
  body: systemQueueDeadLetter.body,
  bodySha256: systemQueueDeadLetter.bodySha256,
  replayPolicy: systemQueueDeadLetter.replayPolicy,
  status: systemQueueDeadLetter.status,
  occurrenceCount: systemQueueDeadLetter.occurrenceCount,
  replayCount: systemQueueDeadLetter.replayCount,
  firstSeenTime: systemQueueDeadLetter.firstSeenTime,
  lastSeenTime: systemQueueDeadLetter.lastSeenTime,
  replayRequestedTime: systemQueueDeadLetter.replayRequestedTime,
  replayedTime: systemQueueDeadLetter.replayedTime,
  resolvedTime: systemQueueDeadLetter.resolvedTime,
  replayLeaseUntil: systemQueueDeadLetter.replayLeaseUntil,
  replayRequestedBy: systemQueueDeadLetter.replayRequestedBy,
  resolvedBy: systemQueueDeadLetter.resolvedBy,
  replayReason: systemQueueDeadLetter.replayReason,
  resolutionReason: systemQueueDeadLetter.resolutionReason,
  lastError: systemQueueDeadLetter.lastError,
  addTime: systemQueueDeadLetter.addTime,
  updateTime: systemQueueDeadLetter.updateTime,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isLegacyOrderMessage(value: unknown): value is OrderMessage {
  if (!isRecord(value)) return false;
  return new Set(["compute", "delCart", "sendNotice", "cancelOrder"]).has(String(value.action))
    && typeof value.orderId === "string"
    && value.orderId.length > 0
    && value.orderId.length <= 64
    && Number.isSafeInteger(value.uid)
    && Number(value.uid) > 0;
}

function maskPhone(value: string): string {
  if (value.length < 7) return "[REDACTED]";
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}

function safeString(value: string): string {
  return [...value].slice(0, MAX_ARCHIVED_STRING).join("");
}

function sanitizeUnknownQueueBody(value: unknown): SafeJsonValue {
  const seen = new WeakSet<object>();
  let entries = 0;

  const visit = (candidate: unknown, key: string, depth: number): SafeJsonValue => {
    entries += 1;
    if (entries > MAX_UNKNOWN_ENTRIES) return "[TRUNCATED]";
    if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
    if (PHONE_KEY.test(key) && typeof candidate === "string") return maskPhone(candidate);
    if (candidate === null || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "string") return safeString(candidate);
    if (typeof candidate === "number") return Number.isFinite(candidate) ? candidate : String(candidate);
    if (typeof candidate === "bigint") return candidate.toString();
    if (candidate instanceof Date) return Number.isFinite(candidate.getTime())
      ? candidate.toISOString()
      : "[INVALID_DATE]";
    if (depth >= MAX_UNKNOWN_DEPTH) return "[MAX_DEPTH]";
    if (!candidate || typeof candidate !== "object") return `[${typeof candidate}]`;
    if (seen.has(candidate)) return "[CIRCULAR]";
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      return candidate.slice(0, MAX_UNKNOWN_ENTRIES).map((item) => visit(item, key, depth + 1));
    }
    const result: Record<string, SafeJsonValue> = {};
    for (const [childKey, childValue] of Object.entries(candidate)) {
      if (entries > MAX_UNKNOWN_ENTRIES) break;
      result[safeString(childKey)] = visit(childValue, childKey, depth + 1);
    }
    return result;
  };

  return visit(value, "", 0);
}

function messageAction(value: unknown): string {
  if (!isRecord(value) || typeof value.action !== "string") return "unknown";
  const action = value.action.trim();
  return /^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(action) ? action : "unknown";
}

/** Classify before persistence so sensitive or unsupported messages can never be replayed. */
export function prepareOrderQueueDeadLetter(value: unknown): PreparedOrderQueueDeadLetter {
  if (isOrderPaidOutboxMessage(value) || isOrderNotificationOutboxMessage(value)) {
    return {
      messageType: value.action,
      replayPolicy: "ALLOW",
      body: sanitizeUnknownQueueBody(value),
      replayMessage: value,
    };
  }
  if (isScheduledMaintenanceMessage(value)) {
    return {
      messageType: value.action,
      replayPolicy: "ALLOW",
      body: sanitizeUnknownQueueBody(value),
      replayMessage: value,
    };
  }
  if (isScheduledOrderMessage(value)) {
    return {
      messageType: value.action,
      replayPolicy: "ALLOW",
      body: sanitizeUnknownQueueBody(value),
      replayMessage: value,
    };
  }
  if (isPinkTimeoutMessage(value)) {
    return {
      messageType: value.action,
      replayPolicy: "ALLOW",
      body: sanitizeUnknownQueueBody(value),
      replayMessage: value,
    };
  }
  if (isSignReminderMessage(value)) {
    return {
      messageType: value.action,
      replayPolicy: "ALLOW",
      body: sanitizeUnknownQueueBody(value),
      replayMessage: value,
    };
  }
  if (isAttachmentObjectCleanupMessage(value)) {
    return {
      messageType: value.action,
      replayPolicy: "ALLOW",
      body: sanitizeUnknownQueueBody(value),
      replayMessage: value,
    };
  }
  if (isOfficialAccountQrcodeMessage(value)) {
    return {
      messageType: value.action,
      replayPolicy: "ALLOW",
      body: sanitizeUnknownQueueBody(value),
      replayMessage: value,
    };
  }
  if (isWorkCallbackOutboxMessage(value) || isWorkCallbackDispatchMessage(value)) {
    return {
      messageType: value.action,
      replayPolicy: "ALLOW",
      body: sanitizeUnknownQueueBody(value),
      replayMessage: value,
    };
  }
  if (isPaymentCallbackMessage(value) || isPaymentCallbackDispatchMessage(value)) {
    return {
      messageType: value.action,
      replayPolicy: "ALLOW",
      body: sanitizeUnknownQueueBody(value),
      replayMessage: value,
    };
  }
  if (isSmsVerificationMessage(value)) {
    return {
      messageType: value.action,
      replayPolicy: "BLOCK_SENSITIVE",
      body: sanitizeUnknownQueueBody(value),
    };
  }
  if (isLegacyOrderMessage(value)) {
    return {
      messageType: messageAction(value),
      replayPolicy: "BLOCK_UNSUPPORTED",
      body: sanitizeUnknownQueueBody(value),
    };
  }
  return {
    messageType: messageAction(value),
    replayPolicy: "BLOCK_UNSUPPORTED",
    body: sanitizeUnknownQueueBody(value),
  };
}

function canonicalJson(value: SafeJsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

async function sha256(value: SafeJsonValue): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(value)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function positiveInt(value: unknown, label: string, maximum = 2_147_483_647): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new ValidateException(`${label}无效`);
  }
  return parsed;
}

function operationReason(value: unknown, label: string): string {
  if (typeof value !== "string") throw new ValidateException(`${label}不能为空`);
  const reason = value.trim();
  if (reason.length < 8 || [...reason].length > 500 || /[\u0000-\u001f\u007f]/.test(reason)) {
    throw new ValidateException(`${label}必须为8到500个可见字符`);
  }
  return reason;
}

function queueName(value: string): string {
  const name = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) {
    throw new Error("Dead-letter queue name is invalid");
  }
  return name;
}

function messageId(value: string): string {
  const id = value.trim();
  if (!id || id.length > 128 || /[\u0000-\u001f\u007f]/.test(id)) {
    throw new Error("Dead-letter message id is invalid");
  }
  return id;
}

function messageTimestamp(value: Date): number {
  const timestamp = value instanceof Date ? value.getTime() : Number.NaN;
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : Date.now();
}

async function selectForReplay(tx: DbClient, id: number): Promise<SystemQueueDeadLetter> {
  const rows = await tx
    .select()
    .from(systemQueueDeadLetter)
    .where(eq(systemQueueDeadLetter.id, id))
    .for("update")
    .limit(1);
  if (!rows[0]) throw new NotFoundException("死信记录不存在");
  return rows[0];
}

export class OrderQueueDeadLetterService {
  constructor(
    private readonly container: Container,
    private readonly orderQueue: Pick<Queue<OrderMessage>, "send">,
  ) {}

  async archive(
    sourceQueue: string,
    message: Pick<Message<unknown>, "id" | "timestamp" | "body" | "attempts">,
    now = Math.floor(Date.now() / 1_000),
  ): Promise<ArchivedOrderQueueDeadLetter> {
    const source = queueName(sourceQueue);
    const id = messageId(message.id);
    const attempts = positiveInt(message.attempts, "DLQ投递次数", 1_000_000);
    const prepared = prepareOrderQueueDeadLetter(message.body);
    const bodyHash = await sha256(prepared.body);

    return withTx(this.container, async (tx) => {
      const inserted = await tx
        .insert(systemQueueDeadLetter)
        .values({
          queueName: source,
          messageId: id,
          messageTimestampMs: messageTimestamp(message.timestamp),
          dlqAttempts: attempts,
          messageType: prepared.messageType,
          body: prepared.body,
          bodySha256: bodyHash,
          replayPolicy: prepared.replayPolicy,
          status: "OPEN",
          occurrenceCount: 1,
          firstSeenTime: now,
          lastSeenTime: now,
          addTime: now,
          updateTime: now,
        })
        .onConflictDoNothing({
          target: [systemQueueDeadLetter.queueName, systemQueueDeadLetter.messageId],
        })
        .returning();
      if (inserted[0]) {
        return {
          id: inserted[0].id,
          duplicate: false,
          status: inserted[0].status,
          messageType: inserted[0].messageType,
          replayPolicy: inserted[0].replayPolicy,
          occurrenceCount: inserted[0].occurrenceCount,
        };
      }

      const duplicate = await tx
        .update(systemQueueDeadLetter)
        .set({
          occurrenceCount: sql`${systemQueueDeadLetter.occurrenceCount} + 1`,
          dlqAttempts: sql`GREATEST(${systemQueueDeadLetter.dlqAttempts}, ${attempts})`,
          lastSeenTime: now,
          updateTime: now,
        })
        .where(and(
          eq(systemQueueDeadLetter.queueName, source),
          eq(systemQueueDeadLetter.messageId, id),
          eq(systemQueueDeadLetter.bodySha256, bodyHash),
        ))
        .returning();
      if (!duplicate[0]) {
        throw new Error("Dead-letter message id was reused with a different body");
      }
      return {
        id: duplicate[0].id,
        duplicate: true,
        status: duplicate[0].status,
        messageType: duplicate[0].messageType,
        replayPolicy: duplicate[0].replayPolicy,
        occurrenceCount: duplicate[0].occurrenceCount,
      };
    });
  }

  async list(query: OrderQueueDeadLetterListQuery = {}) {
    const status = query.status?.trim().toUpperCase();
    if (status && !STATUS_VALUES.has(status as QueueDeadLetterStatus)) {
      throw new ValidateException("死信状态无效");
    }
    const messageType = query.messageType?.trim();
    if (messageType && !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(messageType)) {
      throw new ValidateException("消息类型无效");
    }
    const afterId = query.afterId === undefined ? 0 : positiveInt(query.afterId, "游标");
    const limit = query.limit === undefined ? 20 : positiveInt(query.limit, "每页数量", 100);

    return withTx(this.container, async (tx) => {
      const conditions = [];
      if (status) conditions.push(eq(systemQueueDeadLetter.status, status as QueueDeadLetterStatus));
      if (messageType) conditions.push(eq(systemQueueDeadLetter.messageType, messageType));
      if (afterId) conditions.push(lt(systemQueueDeadLetter.id, afterId));
      const rows = await tx
        .select(orderQueueDeadLetterAdminListColumns)
        .from(systemQueueDeadLetter)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(systemQueueDeadLetter.id))
        .limit(limit);
      const summary = await tx.select({
        openCount: sql<number>`count(*) FILTER (WHERE ${systemQueueDeadLetter.status} = 'OPEN')::int`,
        replayingCount: sql<number>`count(*) FILTER (WHERE ${systemQueueDeadLetter.status} = 'REPLAYING')::int`,
        blockedCount: sql<number>`count(*) FILTER (
          WHERE ${systemQueueDeadLetter.status} = 'OPEN'
            AND ${systemQueueDeadLetter.replayPolicy} <> 'ALLOW'
        )::int`,
        oldestOpenTime: sql<number>`COALESCE(
          min(${systemQueueDeadLetter.firstSeenTime}) FILTER (
            WHERE ${systemQueueDeadLetter.status} = 'OPEN'
          ), 0
        )::int`,
      }).from(systemQueueDeadLetter);
      return {
        list: rows,
        nextAfterId: rows.length === limit ? rows.at(-1)?.id ?? null : null,
        alert: summary[0] ?? {
          openCount: 0,
          replayingCount: 0,
          blockedCount: 0,
          oldestOpenTime: 0,
        },
      };
    });
  }

  async replay(
    idValue: unknown,
    operatorIdValue: unknown,
    reasonValue: unknown,
    now = Math.floor(Date.now() / 1_000),
  ) {
    const id = positiveInt(idValue, "死信ID");
    const operatorId = positiveInt(operatorIdValue, "管理员ID");
    const reason = operationReason(reasonValue, "重放原因");
    const token = crypto.randomUUID();

    const claim = await withTx(this.container, async (tx): Promise<ReplayClaim> => {
      const row = await selectForReplay(tx, id);
      if (row.replayPolicy !== "ALLOW") throw new ValidateException("该消息包含敏感数据或类型未受支持，禁止重放");
      if (row.status === "REPLAYED") throw new ValidateException("该死信已经重放");
      if (row.status === "RESOLVED") throw new ValidateException("该死信已经人工解决");
      if (row.status === "REPLAYING" && row.replayLeaseUntil >= now) {
        throw new ValidateException("该死信正在重放，请勿重复操作");
      }
      if (row.replayCount >= MAX_REPLAY_COUNT) throw new ValidateException("该死信已达到最大人工重放次数");

      const prepared = prepareOrderQueueDeadLetter(row.body);
      if (prepared.replayPolicy !== "ALLOW" || !prepared.replayMessage) {
        throw new ValidateException("归档消息已经无法通过当前消息契约校验");
      }
      if (await sha256(prepared.body) !== row.bodySha256) {
        throw new ValidateException("归档消息完整性校验失败");
      }
      const updated = await tx
        .update(systemQueueDeadLetter)
        .set({
          status: "REPLAYING",
          replayCount: sql`${systemQueueDeadLetter.replayCount} + 1`,
          replayRequestedTime: now,
          replayLeaseUntil: now + REPLAY_LEASE_SECONDS,
          replayToken: token,
          replayRequestedBy: operatorId,
          replayReason: reason,
          lastError: "",
          updateTime: now,
        })
        .where(eq(systemQueueDeadLetter.id, id))
        .returning({ replayCount: systemQueueDeadLetter.replayCount });
      if (!updated[0]) throw new Error("Dead-letter replay claim disappeared");
      return { id, token, body: prepared.replayMessage, replayCount: updated[0].replayCount };
    });

    try {
      await this.orderQueue.send(claim.body);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      try {
        await withTx(this.container, async (tx) => {
          await tx
            .update(systemQueueDeadLetter)
            .set({
              status: "OPEN",
              replayLeaseUntil: 0,
              replayToken: "",
              lastError: errorMessage.slice(0, 1_000),
              updateTime: now,
            })
            .where(and(
              eq(systemQueueDeadLetter.id, id),
              eq(systemQueueDeadLetter.replayToken, token),
            ));
        });
      } catch (recordError) {
        emitOperationalEvent("error", {
          event: "order_queue_dead_letter_replay_failure_record_failed",
          component: "dlq",
          operation: "replay_failure_record",
          outcome: "failure",
          errorCode: operationalErrorCode(recordError),
        });
      }
      throw error;
    }

    const completed = await withTx(this.container, async (tx) => {
      const rows = await tx
        .update(systemQueueDeadLetter)
        .set({
          status: "REPLAYED",
          replayedTime: now,
          replayLeaseUntil: 0,
          replayToken: "",
          updateTime: now,
        })
        .where(and(
          eq(systemQueueDeadLetter.id, id),
          eq(systemQueueDeadLetter.replayToken, token),
          eq(systemQueueDeadLetter.status, "REPLAYING"),
        ))
        .returning();
      if (!rows[0]) throw new Error("Dead-letter replay completion lost its lease");
      return rows[0];
    });
    return { ...completed, replayCount: claim.replayCount };
  }

  async resolve(
    idValue: unknown,
    operatorIdValue: unknown,
    reasonValue: unknown,
    now = Math.floor(Date.now() / 1_000),
  ) {
    const id = positiveInt(idValue, "死信ID");
    const operatorId = positiveInt(operatorIdValue, "管理员ID");
    const reason = operationReason(reasonValue, "解决说明");
    return withTx(this.container, async (tx) => {
      const row = await selectForReplay(tx, id);
      if (row.status === "REPLAYED") throw new ValidateException("已重放的死信无需再标记解决");
      if (row.status === "RESOLVED") throw new ValidateException("该死信已经人工解决");
      if (row.status === "REPLAYING" && row.replayLeaseUntil >= now) {
        throw new ValidateException("该死信正在重放，暂不能标记解决");
      }
      const rows = await tx
        .update(systemQueueDeadLetter)
        .set({
          status: "RESOLVED",
          resolvedTime: now,
          resolvedBy: operatorId,
          resolutionReason: reason,
          replayLeaseUntil: 0,
          replayToken: "",
          updateTime: now,
        })
        .where(eq(systemQueueDeadLetter.id, id))
        .returning();
      if (!rows[0]) throw new Error("Dead-letter resolution update disappeared");
      return rows[0];
    });
  }
}
