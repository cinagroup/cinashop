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
  smallint,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { storeDeliveryOrder } from "./order_delivery";

export type CityDeliveryCallbackEventStatus =
  | "RECEIVED"
  | "PROCESSING"
  | "APPLIED"
  | "APPLIED_NOOP"
  | "SUPERSEDED"
  | "IGNORED"
  | "CONFLICT"
  | "FAILED"
  | "DEAD";

export type CityDeliveryCallbackOutboxStatus =
  | "PENDING"
  | "ENQUEUING"
  | "ENQUEUED"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED"
  | "DEAD";

/**
 * Authenticated Dada/UU callback/query evidence. Rider fields and cancellation
 * text exist only to bridge the durable consumer and are blanked at terminal
 * processing; raw bodies, URL tokens and signatures are never stored.
 */
export const cityDeliveryCallbackEvent = pgTable(
  "city_delivery_callback_event",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    provider: varchar("provider", { length: 16 }).$type<"dada" | "uu">().default("dada").notNull(),
    source: varchar("source", { length: 12 }).$type<"callback" | "query">().notNull(),
    eventKey: varchar("event_key", { length: 64 }).notNull(),
    replayKey: varchar("replay_key", { length: 36 }).notNull(),
    payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
    subjectKeyHash: varchar("subject_key_hash", { length: 64 }).notNull(),
    clientId: varchar("client_id", { length: 64 }).notNull(),
    providerOrderId: varchar("provider_order_id", { length: 32 }).notNull(),
    providerStatus: varchar("provider_status", { length: 4 }).notNull(),
    providerUpdateTime: integer("provider_update_time").notNull(),
    repeatReasonType: smallint("repeat_reason_type").default(0).notNull(),
    cancelFrom: smallint("cancel_from").default(0).notNull(),
    finishCode: varchar("finish_code", { length: 32 }).default("").notNull(),
    riderName: varchar("rider_name", { length: 64 }).default("").notNull(),
    riderMobile: varchar("rider_mobile", { length: 32 }).default("").notNull(),
    reasonText: varchar("reason_text", { length: 255 }).default("").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: varchar("status", { length: 16 })
      .$type<CityDeliveryCallbackEventStatus>()
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
    uniqueIndex("cdcevt_provider_event_uq").on(table.provider, table.eventKey),
    uniqueIndex("cdcevt_replay_key_uq").on(table.replayKey),
    index("cdcevt_subject_order").on(table.provider, table.subjectKeyHash, table.providerUpdateTime, table.id),
    index("cdcevt_actionable_status")
      .on(table.status, table.updateTime, table.id)
      .where(sql`${table.status} IN ('RECEIVED', 'FAILED', 'DEAD')`),
    index("cdcevt_retention_due")
      .on(table.retainUntil, table.id)
      .where(sql`${table.status} IN ('APPLIED', 'APPLIED_NOOP', 'SUPERSEDED', 'IGNORED', 'CONFLICT', 'DEAD')`),
    check("cdcevt_provider_ck", sql`${table.provider} IN ('dada', 'uu')`),
    check("cdcevt_source_ck", sql`${table.source} IN ('callback', 'query')`),
    check(
      "cdcevt_hash_key_ck",
      sql`${table.eventKey} ~ '^[0-9a-f]{64}$'
        AND ${table.payloadHash} ~ '^[0-9a-f]{64}$'
        AND ${table.subjectKeyHash} ~ '^[0-9a-f]{64}$'
        AND ${table.replayKey} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`,
    ),
    check(
      "cdcevt_identifier_ck",
      sql`btrim(${table.clientId}) <> '' AND btrim(${table.providerOrderId}) <> ''
        AND ${table.providerOrderId} ~ '^[A-Za-z0-9._:-]{1,32}$'
        AND ${table.providerStatus} ~ '^-?[0-9]{1,4}$'`,
    ),
    check(
      "cdcevt_provider_values_ck",
      sql`${table.providerUpdateTime} > 0
        AND ${table.repeatReasonType} BETWEEN 0 AND 2
        AND ${table.cancelFrom} BETWEEN 0 AND 3`,
    ),
    check("cdcevt_payload_ck", sql`jsonb_typeof(${table.payload}) = 'object'`),
    check(
      "cdcevt_status_ck",
      sql`${table.status} IN ('RECEIVED', 'PROCESSING', 'APPLIED', 'APPLIED_NOOP', 'SUPERSEDED', 'IGNORED', 'CONFLICT', 'FAILED', 'DEAD')`,
    ),
    check(
      "cdcevt_time_count_ck",
      sql`${table.attemptCount} >= 0 AND ${table.leaseUntil} >= 0
        AND ${table.receivedTime} >= 0 AND ${table.processedTime} >= 0
        AND ${table.retainUntil} >= ${table.receivedTime} AND ${table.updateTime} >= 0`,
    ),
  ],
);

export const cityDeliveryCallbackOutbox = pgTable(
  "city_delivery_callback_outbox",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    eventId: bigint("event_id", { mode: "number" })
      .notNull()
      .references(() => cityDeliveryCallbackEvent.id, { onDelete: "restrict" }),
    replayKey: varchar("replay_key", { length: 36 }).notNull(),
    status: varchar("status", { length: 16 })
      .$type<CityDeliveryCallbackOutboxStatus>()
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
    uniqueIndex("cdcout_event_uq").on(table.eventId),
    uniqueIndex("cdcout_replay_key_uq").on(table.replayKey),
    index("cdcout_dispatch_ready")
      .on(table.availableTime, table.id)
      .where(sql`${table.status} IN ('PENDING', 'FAILED')`),
    index("cdcout_expired_lease")
      .on(table.leaseUntil, table.id)
      .where(sql`${table.status} IN ('ENQUEUING', 'ENQUEUED', 'PROCESSING')`),
    check(
      "cdcout_replay_key_ck",
      sql`${table.replayKey} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`,
    ),
    check(
      "cdcout_status_ck",
      sql`${table.status} IN ('PENDING', 'ENQUEUING', 'ENQUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'DEAD')`,
    ),
    check(
      "cdcout_time_count_ck",
      sql`${table.dispatchCount} >= 0 AND ${table.attemptCount} >= 0
        AND ${table.availableTime} >= 0 AND ${table.leaseUntil} >= 0
        AND ${table.enqueuedTime} >= 0 AND ${table.processedTime} >= 0
        AND ${table.addTime} >= 0 AND ${table.updateTime} >= 0`,
    ),
  ],
);

export const cityDeliveryCallbackWatermark = pgTable(
  "city_delivery_callback_watermark",
  {
    provider: varchar("provider", { length: 16 }).$type<"dada" | "uu">().default("dada").notNull(),
    subjectKeyHash: varchar("subject_key_hash", { length: 64 }).notNull(),
    lastEventId: bigint("last_event_id", { mode: "number" })
      .notNull()
      .references(() => cityDeliveryCallbackEvent.id, { onDelete: "restrict" }),
    lastEventKey: varchar("last_event_key", { length: 64 }).notNull(),
    lastState: varchar("last_state", { length: 32 }).notNull(),
    lastRank: integer("last_rank").default(0).notNull(),
    providerUpdateTime: integer("provider_update_time").default(0).notNull(),
    terminal: smallint("terminal").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
  },
  (table) => [
    primaryKey({ name: "cdcwm_pkey", columns: [table.provider, table.subjectKeyHash] }),
    index("cdcwm_last_event").on(table.lastEventId),
    check("cdcwm_provider_ck", sql`${table.provider} IN ('dada', 'uu')`),
    check(
      "cdcwm_state_ck",
      sql`${table.lastState} IN (
        'WAITING_ACCEPT', 'RIDER_CANCELLED', 'APPENDED_WAITING', 'WAITING_PICKUP',
        'RIDER_AT_STORE', 'DELIVERING', 'ARRIVED_DESTINATION', 'DELIVERED',
        'CANCELLED', 'RETURNING', 'RETURNED',
        'AFTERSALE_RETURNED', 'ORDER_FAILED', 'UNKNOWN'
      )`,
    ),
    check(
      "cdcwm_hash_rank_ck",
      sql`${table.subjectKeyHash} ~ '^[0-9a-f]{64}$'
        AND ${table.lastEventKey} ~ '^[0-9a-f]{64}$'
        AND ${table.lastRank} >= 0 AND ${table.providerUpdateTime} > 0
        AND ${table.terminal} IN (0, 1) AND ${table.updateTime} >= 0`,
    ),
  ],
);

export type CityDeliveryReconciliationStatus = "PENDING" | "QUERYING" | "RESOLVED" | "DEAD";

/** Durable active-query schedule. Provider I/O is always outside transactions. */
export const cityDeliveryReconciliationCase = pgTable(
  "city_delivery_reconciliation_case",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    provider: varchar("provider", { length: 16 }).$type<"dada" | "uu">().default("dada").notNull(),
    subjectKeyHash: varchar("subject_key_hash", { length: 64 }).notNull(),
    deliveryOrderId: integer("delivery_order_id")
      .notNull()
      .references(() => storeDeliveryOrder.id, { onDelete: "restrict" }),
    status: varchar("status", { length: 16 })
      .$type<CityDeliveryReconciliationStatus>()
      .default("PENDING")
      .notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    nextAttemptTime: integer("next_attempt_time").default(0).notNull(),
    leaseUntil: integer("lease_until").default(0).notNull(),
    leaseToken: varchar("lease_token", { length: 36 }).default("").notNull(),
    lastEventId: bigint("last_event_id", { mode: "number" })
      .references(() => cityDeliveryCallbackEvent.id, { onDelete: "restrict" }),
    lastErrorCode: varchar("last_error_code", { length: 64 }).default("").notNull(),
    addTime: integer("add_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
    resolvedTime: integer("resolved_time").default(0).notNull(),
  },
  (table) => [
    uniqueIndex("cdcrc_provider_subject_uq").on(table.provider, table.subjectKeyHash),
    uniqueIndex("cdcrc_delivery_order_uq").on(table.deliveryOrderId),
    index("cdcrc_due")
      .on(table.nextAttemptTime, table.id)
      .where(sql`${table.status} = 'PENDING'`),
    index("cdcrc_expired_lease")
      .on(table.leaseUntil, table.id)
      .where(sql`${table.status} = 'QUERYING'`),
    index("cdcrc_last_event").on(table.lastEventId),
    check("cdcrc_provider_ck", sql`${table.provider} IN ('dada', 'uu')`),
    check(
      "cdcrc_status_ck",
      sql`${table.status} IN ('PENDING', 'QUERYING', 'RESOLVED', 'DEAD')`,
    ),
    check(
      "cdcrc_hash_time_ck",
      sql`${table.subjectKeyHash} ~ '^[0-9a-f]{64}$'
        AND ${table.attemptCount} >= 0 AND ${table.nextAttemptTime} >= 0
        AND ${table.leaseUntil} >= 0 AND ${table.addTime} >= 0
        AND ${table.updateTime} >= 0 AND ${table.resolvedTime} >= 0`,
    ),
  ],
);

export type CityDeliveryCallbackEvent = typeof cityDeliveryCallbackEvent.$inferSelect;
export type CityDeliveryReconciliationCase = typeof cityDeliveryReconciliationCase.$inferSelect;
