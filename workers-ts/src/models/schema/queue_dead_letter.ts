import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  unique,
  varchar,
} from "drizzle-orm/pg-core";

export type QueueDeadLetterReplayPolicy =
  | "ALLOW"
  | "BLOCK_SENSITIVE"
  | "BLOCK_UNSUPPORTED";
export type QueueDeadLetterStatus = "OPEN" | "REPLAYING" | "REPLAYED" | "RESOLVED";

export const systemQueueDeadLetter = pgTable(
  "system_queue_dead_letter",
  {
    id: serial("id").primaryKey(),
    queueName: varchar("queue_name", { length: 128 }).notNull(),
    messageId: varchar("message_id", { length: 128 }).notNull(),
    messageTimestampMs: bigint("message_timestamp_ms", { mode: "number" }).default(0).notNull(),
    dlqAttempts: integer("dlq_attempts").default(1).notNull(),
    messageType: varchar("message_type", { length: 64 }).default("unknown").notNull(),
    body: jsonb("body").$type<unknown>().notNull(),
    bodySha256: varchar("body_sha256", { length: 64 }).notNull(),
    replayPolicy: varchar("replay_policy", { length: 24 })
      .$type<QueueDeadLetterReplayPolicy>()
      .default("BLOCK_UNSUPPORTED")
      .notNull(),
    status: varchar("status", { length: 16 })
      .$type<QueueDeadLetterStatus>()
      .default("OPEN")
      .notNull(),
    occurrenceCount: integer("occurrence_count").default(1).notNull(),
    replayCount: integer("replay_count").default(0).notNull(),
    firstSeenTime: integer("first_seen_time").default(0).notNull(),
    lastSeenTime: integer("last_seen_time").default(0).notNull(),
    replayRequestedTime: integer("replay_requested_time").default(0).notNull(),
    replayedTime: integer("replayed_time").default(0).notNull(),
    resolvedTime: integer("resolved_time").default(0).notNull(),
    replayLeaseUntil: integer("replay_lease_until").default(0).notNull(),
    replayToken: varchar("replay_token", { length: 36 }).default("").notNull(),
    replayRequestedBy: integer("replay_requested_by").default(0).notNull(),
    resolvedBy: integer("resolved_by").default(0).notNull(),
    replayReason: varchar("replay_reason", { length: 500 }).default("").notNull(),
    resolutionReason: varchar("resolution_reason", { length: 500 }).default("").notNull(),
    lastError: varchar("last_error", { length: 1000 }).default("").notNull(),
    addTime: integer("add_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
  },
  (table) => [
    unique("sqdl_queue_message_uq").on(table.queueName, table.messageId),
    index("sqdl_open_alerts").on(table.status, table.firstSeenTime, table.id),
    index("sqdl_type_status").on(table.messageType, table.status, table.id),
    index("sqdl_replay_lease")
      .on(table.replayLeaseUntil, table.id)
      .where(sql`${table.status} = 'REPLAYING'`),
    check(
      "sqdl_status_ck",
      sql`${table.status} IN ('OPEN', 'REPLAYING', 'REPLAYED', 'RESOLVED')`,
    ),
    check(
      "sqdl_replay_policy_ck",
      sql`${table.replayPolicy} IN ('ALLOW', 'BLOCK_SENSITIVE', 'BLOCK_UNSUPPORTED')`,
    ),
    check(
      "sqdl_count_ck",
      sql`${table.dlqAttempts} > 0 AND ${table.occurrenceCount} > 0 AND ${table.replayCount} >= 0`,
    ),
  ],
);

export type SystemQueueDeadLetter = typeof systemQueueDeadLetter.$inferSelect;
