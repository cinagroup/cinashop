import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  isNull,
  lt,
  notExists,
  sql,
} from "drizzle-orm";
import type {
  Env,
  OrderMessage,
  ScheduledMaintenanceMessage,
  SignReminderMessage,
} from "@/env";
import { withTx, type Container, type DbClient } from "@/lib/di";
import {
  systemConfig,
  systemMessage,
  systemNotification,
  user,
  userSign,
} from "@/models/schema";
import { normalizeConfigScalar } from "@/utils/config";
import { SIGN_LOCK_NAMESPACE, signDayWindow } from "@/utils/sign";

export const SIGN_REMINDER_MARK = "sign_remind_time";
export const SIGN_REMINDER_PAGE_SIZE = 80;
const SHANGHAI_OFFSET_SECONDS = 8 * 60 * 60;
const DAY_SECONDS = 24 * 60 * 60;
const REMINDER_MINUTE_OF_DAY = 10 * 60 + 25;

export type SignReminderDeliveryResult =
  | "created"
  | "already-created"
  | "expired"
  | "user-ineligible"
  | "preference-disabled"
  | "already-signed"
  | "template-missing"
  | "system-channel-disabled";

interface SignReminderProcessor {
  processMessage(message: SignReminderMessage): Promise<SignReminderDeliveryResult>;
}

type SignReminderQueueMessage = Pick<
  Message<OrderMessage>,
  "body" | "attempts" | "ack" | "retry"
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safePositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Stable Asia/Shanghai day number used by user_sign's unique expression index. */
export function signReminderShanghaiDay(scheduledAtMs: number): number {
  if (!safePositiveInteger(scheduledAtMs)) throw new Error("scheduledAt must be positive");
  return Math.floor((Math.floor(scheduledAtMs / 1_000) + SHANGHAI_OFFSET_SECONDS) / DAY_SECONDS);
}

/** The legacy type=4 timer is installed as 10/25, meaning daily at 10:25 Shanghai time. */
export function isSignReminderDispatchTime(scheduledAtMs: number): boolean {
  if (!safePositiveInteger(scheduledAtMs)) return false;
  const seconds = Math.floor(scheduledAtMs / 1_000);
  const localSeconds = ((seconds + SHANGHAI_OFFSET_SECONDS) % DAY_SECONDS + DAY_SECONDS)
    % DAY_SECONDS;
  return Math.floor(localSeconds / 60) === REMINDER_MINUTE_OF_DAY;
}

export function signReminderEventKey(shanghaiDay: number, userId: number): string {
  if (!Number.isSafeInteger(shanghaiDay) || shanghaiDay < 0 || !safePositiveInteger(userId)) {
    throw new Error("invalid sign reminder identity");
  }
  return `${SIGN_REMINDER_MARK}:${shanghaiDay}:${userId}`;
}

export function isSignReminderMessage(value: unknown): value is SignReminderMessage {
  if (!isRecord(value)) return false;
  if (
    value.action !== "processSignReminder"
    || value.job !== SIGN_REMINDER_MARK
    || !safePositiveInteger(value.scheduledAt)
    || !safePositiveInteger(value.userId)
    || typeof value.shanghaiDay !== "number"
    || !Number.isSafeInteger(value.shanghaiDay)
    || value.shanghaiDay < 0
    || typeof value.runId !== "string"
    || value.runId !== `scheduled:${value.scheduledAt}`
  ) {
    return false;
  }
  return value.shanghaiDay === signReminderShanghaiDay(value.scheduledAt);
}

export function signReminderRetryDelaySeconds(attempts: number): number {
  const normalized = Math.max(1, Math.trunc(attempts));
  return Math.min(30 * 2 ** Math.min(normalized - 1, 5), 900);
}

/** Queue wrapper kept separate so acknowledgement/retry behavior is directly testable. */
export async function consumeSignReminderQueueMessage(
  message: SignReminderQueueMessage,
  processor: SignReminderProcessor,
): Promise<void> {
  if (!isSignReminderMessage(message.body)) {
    throw new Error("Queue message is not a sign reminder event");
  }
  try {
    const result = await processor.processMessage(message.body);
    console.log(JSON.stringify({
      event: "sign_reminder_consumed",
      result,
      shanghaiDay: message.body.shanghaiDay,
      queueAttempt: message.attempts,
    }));
    message.ack();
  } catch (error) {
    const delaySeconds = signReminderRetryDelaySeconds(message.attempts);
    console.error(JSON.stringify({
      event: "sign_reminder_failed",
      shanghaiDay: message.body.shanghaiDay,
      queueAttempt: message.attempts,
      retryDelaySeconds: delaySeconds,
      error: error instanceof Error && /^[A-Za-z0-9_.:-]{1,96}$/.test(error.message)
        ? error.message
        : "sign_reminder_delivery_failed",
    }));
    message.retry({ delaySeconds });
  }
}

function renderTemplate(template: string, values: Readonly<Record<string, string>>): string {
  let rendered = template;
  for (const [key, value] of Object.entries(values)) {
    rendered = rendered.replaceAll(`{${key}}`, value);
  }
  return rendered;
}

async function siteName(db: DbClient): Promise<string> {
  const rows = await db
    .select({ value: systemConfig.value })
    .from(systemConfig)
    .where(and(eq(systemConfig.isStore, 0), eq(systemConfig.menuName, "site_name")))
    .orderBy(desc(systemConfig.sort), desc(systemConfig.id))
    .limit(1);
  return normalizeConfigScalar(rows[0]?.value ?? "");
}

export class SignReminderService implements SignReminderProcessor {
  constructor(
    private readonly container: Container,
    private readonly env: Pick<Env, "ORDER_QUEUE">,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  async scan(message: ScheduledMaintenanceMessage): Promise<Record<string, unknown>> {
    if (message.job !== SIGN_REMINDER_MARK) {
      throw new Error("unsupported_sign_reminder_job");
    }
    if (!isSignReminderDispatchTime(message.scheduledAt)) {
      return {
        event: "scheduled_sign_reminder_skipped",
        job: message.job,
        runId: message.runId,
        reason: "outside_legacy_1025_window",
      };
    }

    const scheduledSeconds = Math.floor(message.scheduledAt / 1_000);
    const day = signDayWindow(scheduledSeconds);
    const shanghaiDay = signReminderShanghaiDay(message.scheduledAt);
    const candidates = await withTx(this.container, (tx) => tx
      .select({ userId: user.uid })
      .from(user)
      .where(and(
        gt(user.uid, message.cursor),
        eq(user.isDel, 0),
        isNull(user.deleteTime),
        eq(user.status, 1),
        eq(user.signRemind, 1),
        notExists(
          tx
            .select({ value: sql<number>`1` })
            .from(userSign)
            .where(and(
              eq(userSign.uid, user.uid),
              gte(userSign.addTime, day.todayStart),
              lt(userSign.addTime, day.tomorrowStart),
            )),
        ),
      ))
      .orderBy(asc(user.uid))
      .limit(SIGN_REMINDER_PAGE_SIZE));
    const nextCursor = candidates.at(-1)?.userId ?? message.cursor;
    const hasMore = candidates.length === SIGN_REMINDER_PAGE_SIZE;
    const work: OrderMessage[] = candidates.map(({ userId }) => ({
      action: "processSignReminder",
      job: SIGN_REMINDER_MARK,
      runId: message.runId,
      scheduledAt: message.scheduledAt,
      userId,
      shanghaiDay,
    }));
    if (hasMore) work.push({ ...message, cursor: nextCursor });
    if (work.length) {
      await this.env.ORDER_QUEUE.sendBatch(
        work.map((body) => ({ body, contentType: "json" as const })),
      );
    }
    return {
      event: "scheduled_sign_reminder_scan",
      job: message.job,
      runId: message.runId,
      cursor: message.cursor,
      nextCursor,
      candidates: candidates.length,
      hasMore,
      shanghaiDay,
    };
  }

  async processMessage(message: SignReminderMessage): Promise<SignReminderDeliveryResult> {
    if (!isSignReminderMessage(message)) throw new Error("invalid_sign_reminder_message");
    if (signReminderShanghaiDay(this.nowMs()) !== message.shanghaiDay) return "expired";
    const eventKey = signReminderEventKey(message.shanghaiDay, message.userId);
    const day = signDayWindow(Math.floor(message.scheduledAt / 1_000));

    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${SIGN_LOCK_NAMESPACE}, ${message.userId})`);

      const existing = await tx
        .select({ mark: systemMessage.mark, userId: systemMessage.userId })
        .from(systemMessage)
        .where(eq(systemMessage.eventKey, eventKey))
        .limit(1);
      if (existing[0]) {
        if (existing[0].mark !== SIGN_REMINDER_MARK || existing[0].userId !== message.userId) {
          throw new Error("sign_reminder_event_key_conflict");
        }
        return "already-created";
      }

      const accounts = await tx
        .select({
          userId: user.uid,
          status: user.status,
          isDel: user.isDel,
          deleteTime: user.deleteTime,
          signRemind: user.signRemind,
        })
        .from(user)
        .where(eq(user.uid, message.userId))
        .limit(1);
      const account = accounts[0];
      if (!account || account.status !== 1 || account.isDel !== 0 || account.deleteTime !== null) {
        return "user-ineligible";
      }
      if (account.signRemind !== 1) return "preference-disabled";

      const signed = await tx
        .select({ id: userSign.id })
        .from(userSign)
        .where(and(
          eq(userSign.uid, message.userId),
          gte(userSign.addTime, day.todayStart),
          lt(userSign.addTime, day.tomorrowStart),
        ))
        .limit(1);
      if (signed[0]) return "already-signed";

      const templates = await tx
        .select({
          mark: systemNotification.mark,
          isSystem: systemNotification.isSystem,
          title: systemNotification.systemTitle,
          content: systemNotification.systemText,
        })
        .from(systemNotification)
        .where(eq(systemNotification.mark, SIGN_REMINDER_MARK))
        .orderBy(desc(systemNotification.id))
        .limit(2);
      if (templates.length > 1) throw new Error("duplicate_sign_reminder_template");
      const template = templates[0];
      if (!template) return "template-missing";
      if (template.isSystem !== 1) return "system-channel-disabled";

      const values = { site_name: await siteName(tx) };
      const title = renderTemplate(template.title, values);
      const content = renderTemplate(template.content, values);
      if ([...title].length > 256) throw new Error("sign_reminder_title_too_long");
      if ([...content].length > 10_000) throw new Error("sign_reminder_content_too_long");

      const inserted = await tx
        .insert(systemMessage)
        .values({
          eventKey,
          mark: SIGN_REMINDER_MARK,
          title,
          content,
          userId: message.userId,
          look: 0,
          type: 1,
          status: 1,
          addTime: Math.floor(this.nowMs() / 1_000),
          isDel: 0,
        })
        .onConflictDoNothing({ target: systemMessage.eventKey })
        .returning({ id: systemMessage.id });
      if (inserted[0]) return "created";

      const winner = await tx
        .select({ mark: systemMessage.mark, userId: systemMessage.userId })
        .from(systemMessage)
        .where(eq(systemMessage.eventKey, eventKey))
        .limit(1);
      if (!winner[0]) throw new Error("sign_reminder_idempotency_evidence_missing");
      if (winner[0].mark !== SIGN_REMINDER_MARK || winner[0].userId !== message.userId) {
        throw new Error("sign_reminder_event_key_conflict");
      }
      return "already-created";
    });
  }
}
