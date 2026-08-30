/**
 * Durable Enterprise WeChat callback ingress.
 *
 * Decrypted callback XML is reduced to a strict field allowlist before it is
 * stored. Queue messages carry only database identifiers and hashes; business
 * identifiers never leave PostgreSQL through the queue body.
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

export type WorkCallbackPayload = Record<string, string | number>;

export const workCallbackEvent = pgTable(
  "work_callback_event",
  {
    id: serial("id").primaryKey(),
    eventKey: varchar("event_key", { length: 64 }).notNull(),
    payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
    subjectKeyHash: varchar("subject_key_hash", { length: 64 }).notNull(),
    corpId: varchar("corp_id", { length: 64 }).notNull(),
    msgType: varchar("msg_type", { length: 64 }).default("").notNull(),
    eventType: varchar("event_type", { length: 64 }).default("").notNull(),
    changeType: varchar("change_type", { length: 64 }).default("").notNull(),
    eventTime: integer("event_time").default(0).notNull(),
    sequenceRank: integer("sequence_rank").default(0).notNull(),
    payload: jsonb("payload").$type<WorkCallbackPayload>().notNull(),
    /** Durable callback pipeline: RECEIVED/PROCESSING/ORDERED/FAILED/DEAD. */
    status: varchar("status", { length: 16 }).default("RECEIVED").notNull(),
    /** PENDING/PROCESSING/REFRESH_REQUIRED/APPLIED/APPLIED_NOOP/SUPERSEDED/IGNORED/FAILED/DEAD */
    projectionStatus: varchar("projection_status", { length: 16 }).default("PENDING").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    leaseUntil: integer("lease_until").default(0).notNull(),
    leaseToken: varchar("lease_token", { length: 36 }).default("").notNull(),
    lastErrorCode: varchar("last_error_code", { length: 64 }).default("").notNull(),
    receivedTime: integer("received_time").default(0).notNull(),
    processedTime: integer("processed_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
  },
  (table) => [
    uniqueIndex("wce_event_key_uq").on(table.eventKey),
    index("wce_subject_order").on(
      table.subjectKeyHash,
      table.eventTime,
      table.sequenceRank,
      table.id,
    ),
    index("wce_status_time").on(table.status, table.updateTime, table.id),
    index("wce_projection_status_time").on(
      table.projectionStatus,
      table.updateTime,
      table.id,
    ),
  ],
);

export const workCallbackOutbox = pgTable(
  "work_callback_outbox",
  {
    id: serial("id").primaryKey(),
    eventId: integer("event_id").notNull(),
    eventKey: varchar("event_key", { length: 64 }).notNull(),
    /** PENDING/ENQUEUING/ENQUEUED/PROCESSING/COMPLETED/FAILED/DEAD */
    status: varchar("status", { length: 16 }).default("PENDING").notNull(),
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
    uniqueIndex("wco_event_id_uq").on(table.eventId),
    uniqueIndex("wco_event_key_uq").on(table.eventKey),
    index("wco_dispatch_ready")
      .on(table.availableTime, table.id)
      .where(sql`${table.status} IN ('PENDING', 'FAILED')`),
    index("wco_expired_lease")
      .on(table.leaseUntil, table.id)
      .where(sql`${table.status} IN ('ENQUEUING', 'ENQUEUED', 'PROCESSING')`),
  ],
);

export const workCallbackWatermark = pgTable("work_callback_watermark", {
  subjectKeyHash: varchar("subject_key_hash", { length: 64 }).primaryKey(),
  eventTime: integer("event_time").default(0).notNull(),
  sequenceRank: integer("sequence_rank").default(0).notNull(),
  eventId: integer("event_id").notNull(),
  eventKey: varchar("event_key", { length: 64 }).notNull(),
  updateTime: integer("update_time").default(0).notNull(),
});

export type WorkCallbackEvent = typeof workCallbackEvent.$inferSelect;
export type WorkCallbackOutbox = typeof workCallbackOutbox.$inferSelect;
