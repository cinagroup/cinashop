/** Durable, reference-only Queue work created after an external-contact projection. */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { workCallbackEvent } from "./work_callback";
import { workClientCurrent } from "./work_client_current";

export const WORK_CONTACT_ACTION_TYPES = [
  "WELCOME_SEND",
  "AUTO_TAG",
  "CLIENT_UID_LINK",
] as const;
export type WorkContactActionType = (typeof WORK_CONTACT_ACTION_TYPES)[number];

export const WORK_CONTACT_ACTION_STATUSES = [
  "PENDING",
  "ENQUEUING",
  "ENQUEUED",
  "PROCESSING",
  "RETRYABLE",
  "SUCCEEDED",
  "SKIPPED",
  "EXPIRED",
  "UNKNOWN",
  "DEAD",
  "CLOSED",
] as const;
export type WorkContactActionStatus = (typeof WORK_CONTACT_ACTION_STATUSES)[number];

export type WorkContactActionPayload = Record<string, unknown>;

export const workContactActionOutbox = pgTable(
  "work_contact_action_outbox",
  {
    id: serial("id").primaryKey(),
    eventId: integer("event_id").notNull(),
    eventKey: varchar("event_key", { length: 64 }).notNull(),
    actionKey: varchar("action_key", { length: 64 }).notNull(),
    actionType: varchar("action_type", { length: 24 })
      .$type<WorkContactActionType>()
      .notNull(),
    corpId: varchar("corp_id", { length: 18 }).notNull(),
    clientId: integer("client_id").notNull(),
    payload: jsonb("payload").$type<WorkContactActionPayload>().default({}).notNull(),
    payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
    status: varchar("status", { length: 16 })
      .$type<WorkContactActionStatus>()
      .default("PENDING")
      .notNull(),
    dispatchCount: integer("dispatch_count").default(0).notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    availableTime: integer("available_time").default(0).notNull(),
    deadlineTime: integer("deadline_time").default(0).notNull(),
    leaseUntil: integer("lease_until").default(0).notNull(),
    leaseToken: varchar("lease_token", { length: 36 }).default("").notNull(),
    lastErrorCode: varchar("last_error_code", { length: 64 }).default("").notNull(),
    providerCode: integer("provider_code"),
    enqueuedTime: integer("enqueued_time").default(0).notNull(),
    processedTime: integer("processed_time").default(0).notNull(),
    unknownTime: integer("unknown_time").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
  },
  (table) => [
    foreignKey({
      name: "wcao_event_fk",
      columns: [table.eventId],
      foreignColumns: [workCallbackEvent.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "wcao_client_fk",
      columns: [table.corpId, table.clientId],
      foreignColumns: [workClientCurrent.corpId, workClientCurrent.id],
    }).onDelete("restrict"),
    uniqueIndex("wcao_event_action_uq").on(table.eventId, table.actionType),
    uniqueIndex("wcao_action_key_uq").on(table.actionKey),
    index("wcao_dispatch_ready")
      .on(table.availableTime, table.deadlineTime, table.id)
      .where(sql`${table.status} IN ('PENDING','RETRYABLE')`),
    index("wcao_expired_lease")
      .on(table.leaseUntil, table.id)
      .where(sql`${table.status} IN ('ENQUEUING','ENQUEUED','PROCESSING')`),
    index("wcao_event_status").on(table.eventId, table.status, table.id),
    index("wcao_manual_queue")
      .on(table.status, table.updateTime, table.id)
      .where(sql`${table.status} IN ('UNKNOWN','DEAD')`),
    check("wcao_hashes_ck", sql`
      ${table.eventKey} ~ '^[0-9a-f]{64}$'
      AND ${table.actionKey} ~ '^[0-9a-f]{64}$'
      AND ${table.payloadHash} ~ '^[0-9a-f]{64}$'
    `),
    check("wcao_identity_ck", sql`
      ${table.corpId} ~ '^[A-Za-z0-9_-]{1,18}$' AND ${table.clientId} > 0
    `),
    check("wcao_action_type_ck", sql`
      ${table.actionType} IN ('WELCOME_SEND','AUTO_TAG','CLIENT_UID_LINK')
    `),
    check("wcao_status_ck", sql`
      ${table.status} IN (
        'PENDING','ENQUEUING','ENQUEUED','PROCESSING','RETRYABLE',
        'SUCCEEDED','SKIPPED','EXPIRED','UNKNOWN','DEAD','CLOSED'
      )
    `),
    check("wcao_payload_ck", sql`
      jsonb_typeof(${table.payload}) = 'object'
      AND octet_length(${table.payload}::text) <= 65536
    `),
    check("wcao_time_ck", sql`
      ${table.dispatchCount} >= 0 AND ${table.attemptCount} >= 0
      AND ${table.availableTime} >= 0 AND ${table.deadlineTime} >= 0
      AND ${table.leaseUntil} >= 0 AND ${table.enqueuedTime} >= 0
      AND ${table.processedTime} >= 0 AND ${table.unknownTime} >= 0
      AND ${table.addTime} >= 0 AND ${table.updateTime} >= 0
    `),
    check("wcao_welcome_deadline_ck", sql`
      ${table.actionType} <> 'WELCOME_SEND' OR ${table.deadlineTime} > 0
    `),
    check("wcao_lease_ck", sql`
      (${table.status} IN ('ENQUEUING','ENQUEUED','PROCESSING')
        AND ${table.leaseUntil} > 0 AND ${table.leaseToken} <> '')
      OR (${table.status} NOT IN ('ENQUEUING','ENQUEUED','PROCESSING')
        AND ${table.leaseUntil} = 0 AND ${table.leaseToken} = '')
    `),
  ],
);

export const workContactActionAudit = pgTable(
  "work_contact_action_audit",
  {
    id: serial("id").primaryKey(),
    actionId: integer("action_id").notNull(),
    requestKey: varchar("request_key", { length: 36 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    operation: varchar("operation", { length: 24 }).notNull(),
    fromStatus: varchar("from_status", { length: 16 })
      .$type<WorkContactActionStatus>()
      .notNull(),
    toStatus: varchar("to_status", { length: 16 })
      .$type<WorkContactActionStatus>()
      .notNull(),
    actorId: integer("actor_id").notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    riskAccepted: boolean("risk_accepted").default(false).notNull(),
    providerReferenceHash: varchar("provider_reference_hash", { length: 64 }),
    addTime: integer("add_time").default(0).notNull(),
  },
  (table) => [
    foreignKey({
      name: "wcaa_action_fk",
      columns: [table.actionId],
      foreignColumns: [workContactActionOutbox.id],
    }).onDelete("restrict"),
    uniqueIndex("wcaa_request_uq").on(table.actionId, table.requestKey),
    index("wcaa_action_time").on(table.actionId, table.addTime, table.id),
  ],
);

export type WorkContactActionOutbox = typeof workContactActionOutbox.$inferSelect;
export type WorkContactActionAudit = typeof workContactActionAudit.$inferSelect;
