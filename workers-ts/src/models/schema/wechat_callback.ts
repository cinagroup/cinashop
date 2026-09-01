import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

export type WechatCallbackSource = "official" | "mini";
export type WechatCallbackEventStatus =
  | "RECEIVED"
  | "PROCESSING"
  | "APPLIED"
  | "APPLIED_NOOP"
  | "SUPERSEDED"
  | "IGNORED"
  | "FAILED"
  | "DEAD";
export type WechatCallbackOutboxStatus =
  | "PENDING"
  | "ENQUEUING"
  | "ENQUEUED"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED"
  | "DEAD";

/**
 * Signature-verified, allowlisted WeChat message/event evidence. Raw XML,
 * signatures, arbitrary provider fields and user message text are excluded.
 */
export const wechatCallbackEvent = pgTable(
  "wechat_callback_event",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    source: varchar("source", { length: 16 }).$type<WechatCallbackSource>().notNull(),
    eventKey: varchar("event_key", { length: 64 }).notNull(),
    replayKey: varchar("replay_key", { length: 36 }).notNull(),
    payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
    subjectKeyHash: varchar("subject_key_hash", { length: 64 }).notNull(),
    appId: varchar("app_id", { length: 64 }).notNull(),
    fromUser: varchar("from_user", { length: 128 }).notNull(),
    msgType: varchar("msg_type", { length: 32 }).default("").notNull(),
    eventType: varchar("event_type", { length: 64 }).default("").notNull(),
    eventTime: integer("event_time").default(0).notNull(),
    sequenceRank: integer("sequence_rank").default(0).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    replyPayload: jsonb("reply_payload").$type<Record<string, unknown>>().notNull(),
    status: varchar("status", { length: 16 })
      .$type<WechatCallbackEventStatus>()
      .default("RECEIVED")
      .notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    leaseUntil: integer("lease_until").default(0).notNull(),
    leaseToken: varchar("lease_token", { length: 36 }).default("").notNull(),
    lastErrorCode: varchar("last_error_code", { length: 64 }).default("").notNull(),
    receivedTime: integer("received_time").default(0).notNull(),
    processedTime: integer("processed_time").default(0).notNull(),
    retainUntil: integer("retain_until").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
  },
  (table) => [
    uniqueIndex("wcevt_source_event_uq").on(table.source, table.eventKey),
    uniqueIndex("wcevt_replay_key_uq").on(table.replayKey),
    index("wcevt_subject_order").on(
      table.source,
      table.subjectKeyHash,
      table.eventTime,
      table.sequenceRank,
      table.id,
    ),
    index("wcevt_actionable_status")
      .on(table.status, table.updateTime, table.id)
      .where(sql`${table.status} IN ('RECEIVED', 'FAILED', 'DEAD')`),
    index("wcevt_retention_due")
      .on(table.retainUntil, table.id)
      .where(sql`${table.status} IN ('APPLIED', 'APPLIED_NOOP', 'SUPERSEDED', 'IGNORED', 'DEAD')`),
    check("wcevt_source_ck", sql`${table.source} IN ('official', 'mini')`),
    check(
      "wcevt_hash_key_ck",
      sql`${table.eventKey} ~ '^[0-9a-f]{64}$'
        AND ${table.payloadHash} ~ '^[0-9a-f]{64}$'
        AND ${table.subjectKeyHash} ~ '^[0-9a-f]{64}$'
        AND ${table.replayKey} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`,
    ),
    check(
      "wcevt_payload_ck",
      sql`jsonb_typeof(${table.payload}) = 'object'
        AND jsonb_typeof(${table.replyPayload}) = 'object'`,
    ),
    check(
      "wcevt_status_ck",
      sql`${table.status} IN ('RECEIVED', 'PROCESSING', 'APPLIED', 'APPLIED_NOOP', 'SUPERSEDED', 'IGNORED', 'FAILED', 'DEAD')`,
    ),
    check(
      "wcevt_time_count_ck",
      sql`${table.eventTime} > 0 AND ${table.sequenceRank} >= 0
        AND ${table.attemptCount} >= 0 AND ${table.leaseUntil} >= 0
        AND ${table.receivedTime} >= 0 AND ${table.processedTime} >= 0
        AND ${table.retainUntil} >= ${table.receivedTime} AND ${table.updateTime} >= 0`,
    ),
  ],
);

export const wechatCallbackOutbox = pgTable(
  "wechat_callback_outbox",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    eventId: bigint("event_id", { mode: "number" })
      .notNull()
      .references(() => wechatCallbackEvent.id, { onDelete: "restrict" }),
    replayKey: varchar("replay_key", { length: 36 }).notNull(),
    status: varchar("status", { length: 16 })
      .$type<WechatCallbackOutboxStatus>()
      .default("PENDING")
      .notNull(),
    dispatchCount: integer("dispatch_count").default(0).notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    availableTime: integer("available_time").default(0).notNull(),
    leaseUntil: integer("lease_until").default(0).notNull(),
    leaseToken: varchar("lease_token", { length: 36 }).default("").notNull(),
    lastErrorCode: varchar("last_error_code", { length: 64 }).default("").notNull(),
    enqueuedTime: integer("enqueued_time").default(0).notNull(),
    processedTime: integer("processed_time").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
  },
  (table) => [
    uniqueIndex("wcout_event_uq").on(table.eventId),
    uniqueIndex("wcout_replay_key_uq").on(table.replayKey),
    index("wcout_dispatch_ready")
      .on(table.availableTime, table.id)
      .where(sql`${table.status} IN ('PENDING', 'FAILED')`),
    index("wcout_expired_lease")
      .on(table.leaseUntil, table.id)
      .where(sql`${table.status} IN ('ENQUEUING', 'ENQUEUED', 'PROCESSING')`),
    check(
      "wcout_replay_key_ck",
      sql`${table.replayKey} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`,
    ),
    check(
      "wcout_status_ck",
      sql`${table.status} IN ('PENDING', 'ENQUEUING', 'ENQUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'DEAD')`,
    ),
    check(
      "wcout_time_count_ck",
      sql`${table.dispatchCount} >= 0 AND ${table.attemptCount} >= 0
        AND ${table.availableTime} >= 0 AND ${table.leaseUntil} >= 0
        AND ${table.enqueuedTime} >= 0 AND ${table.processedTime} >= 0
        AND ${table.addTime} >= 0 AND ${table.updateTime} >= 0`,
    ),
  ],
);

/** Latest-applied fence for stateful subjects; additive scans still use event idempotency. */
export const wechatCallbackWatermark = pgTable(
  "wechat_callback_watermark",
  {
    source: varchar("source", { length: 16 }).$type<WechatCallbackSource>().notNull(),
    projectionType: varchar("projection_type", { length: 32 }).notNull(),
    subjectKeyHash: varchar("subject_key_hash", { length: 64 }).notNull(),
    lastEventId: bigint("last_event_id", { mode: "number" })
      .notNull()
      .references(() => wechatCallbackEvent.id, { onDelete: "restrict" }),
    lastEventKey: varchar("last_event_key", { length: 64 }).notNull(),
    lastEventTime: integer("last_event_time").default(0).notNull(),
    lastSequenceRank: integer("last_sequence_rank").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
  },
  (table) => [
    primaryKey({
      name: "wcwm_pkey",
      columns: [table.source, table.projectionType, table.subjectKeyHash],
    }),
    index("wcwm_last_event").on(table.lastEventId),
    check("wcwm_source_ck", sql`${table.source} IN ('official', 'mini')`),
    check(
      "wcwm_projection_ck",
      sql`${table.projectionType} IN ('follow', 'scan', 'card', 'payment', 'receipt', 'message', 'ignored')`,
    ),
    check(
      "wcwm_hash_time_ck",
      sql`${table.subjectKeyHash} ~ '^[0-9a-f]{64}$'
        AND ${table.lastEventKey} ~ '^[0-9a-f]{64}$'
        AND ${table.lastEventTime} > 0 AND ${table.lastSequenceRank} >= 0
        AND ${table.updateTime} >= 0`,
    ),
  ],
);

export type WechatCallbackEvent = typeof wechatCallbackEvent.$inferSelect;
export type WechatCallbackOutbox = typeof wechatCallbackOutbox.$inferSelect;
