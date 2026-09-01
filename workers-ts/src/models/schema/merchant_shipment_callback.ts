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

export type MerchantShipmentCallbackEventStatus =
  | "RECEIVED"
  | "PROCESSING"
  | "APPLIED"
  | "APPLIED_NOOP"
  | "SUPERSEDED"
  | "IGNORED"
  | "CONFLICT"
  | "FAILED"
  | "DEAD";

export type MerchantShipmentCallbackOutboxStatus =
  | "PENDING"
  | "ENQUEUING"
  | "ENQUEUED"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED"
  | "DEAD";

/**
 * Signature-verified Kuaidi100 order callbacks. Raw form bodies, signatures,
 * courier PII, fee details and label image contents are never persisted.
 */
export const merchantShipmentCallbackEvent = pgTable(
  "merchant_shipment_callback_event",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    provider: varchar("provider", { length: 24 }).default("kuaidi100").notNull(),
    eventKey: varchar("event_key", { length: 64 }).notNull(),
    replayKey: varchar("replay_key", { length: 36 }).notNull(),
    payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
    subjectKeyHash: varchar("subject_key_hash", { length: 64 }).notNull(),
    taskId: varchar("task_id", { length: 128 }).notNull(),
    providerOrderId: varchar("provider_order_id", { length: 128 }).default("").notNull(),
    carrierCode: varchar("carrier_code", { length: 50 }).default("").notNull(),
    trackingNumber: varchar("tracking_number", { length: 64 }).default("").notNull(),
    callbackStatus: varchar("callback_status", { length: 16 }).default("").notNull(),
    orderStatus: varchar("order_status", { length: 16 }).default("").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: varchar("status", { length: 16 })
      .$type<MerchantShipmentCallbackEventStatus>()
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
    uniqueIndex("mscevt_provider_event_uq").on(table.provider, table.eventKey),
    uniqueIndex("mscevt_replay_key_uq").on(table.replayKey),
    index("mscevt_subject_order").on(table.provider, table.subjectKeyHash, table.id),
    index("mscevt_actionable_status")
      .on(table.status, table.updateTime, table.id)
      .where(sql`${table.status} IN ('RECEIVED', 'FAILED', 'DEAD')`),
    index("mscevt_retention_due")
      .on(table.retainUntil, table.id)
      .where(sql`${table.status} IN ('APPLIED', 'APPLIED_NOOP', 'SUPERSEDED', 'IGNORED', 'CONFLICT', 'DEAD')`),
    check("mscevt_provider_ck", sql`${table.provider} = 'kuaidi100'`),
    check(
      "mscevt_hash_key_ck",
      sql`${table.eventKey} ~ '^[0-9a-f]{64}$'
        AND ${table.payloadHash} ~ '^[0-9a-f]{64}$'
        AND ${table.subjectKeyHash} ~ '^[0-9a-f]{64}$'
        AND ${table.replayKey} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`,
    ),
    check(
      "mscevt_identifier_ck",
      sql`btrim(${table.taskId}) <> '' AND ${table.taskId} !~ '[[:cntrl:]]'
        AND ${table.providerOrderId} !~ '[[:cntrl:]]'
        AND ${table.carrierCode} !~ '[[:cntrl:]]'
        AND ${table.trackingNumber} !~ '[[:cntrl:]]'
        AND ${table.callbackStatus} ~ '^[0-9]{1,3}$'
        AND ${table.orderStatus} ~ '^[0-9]{1,3}$'`,
    ),
    check("mscevt_payload_ck", sql`jsonb_typeof(${table.payload}) = 'object'`),
    check(
      "mscevt_status_ck",
      sql`${table.status} IN ('RECEIVED', 'PROCESSING', 'APPLIED', 'APPLIED_NOOP', 'SUPERSEDED', 'IGNORED', 'CONFLICT', 'FAILED', 'DEAD')`,
    ),
    check(
      "mscevt_time_count_ck",
      sql`${table.attemptCount} >= 0 AND ${table.leaseUntil} >= 0
        AND ${table.receivedTime} >= 0 AND ${table.processedTime} >= 0
        AND ${table.retainUntil} >= ${table.receivedTime} AND ${table.updateTime} >= 0`,
    ),
  ],
);

export const merchantShipmentCallbackOutbox = pgTable(
  "merchant_shipment_callback_outbox",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    eventId: bigint("event_id", { mode: "number" })
      .notNull()
      .references(() => merchantShipmentCallbackEvent.id, { onDelete: "restrict" }),
    replayKey: varchar("replay_key", { length: 36 }).notNull(),
    status: varchar("status", { length: 16 })
      .$type<MerchantShipmentCallbackOutboxStatus>()
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
    uniqueIndex("mscout_event_uq").on(table.eventId),
    uniqueIndex("mscout_replay_key_uq").on(table.replayKey),
    index("mscout_dispatch_ready")
      .on(table.availableTime, table.id)
      .where(sql`${table.status} IN ('PENDING', 'FAILED')`),
    index("mscout_expired_lease")
      .on(table.leaseUntil, table.id)
      .where(sql`${table.status} IN ('ENQUEUING', 'ENQUEUED', 'PROCESSING')`),
    check(
      "mscout_replay_key_ck",
      sql`${table.replayKey} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`,
    ),
    check(
      "mscout_status_ck",
      sql`${table.status} IN ('PENDING', 'ENQUEUING', 'ENQUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'DEAD')`,
    ),
    check(
      "mscout_time_count_ck",
      sql`${table.dispatchCount} >= 0 AND ${table.attemptCount} >= 0
        AND ${table.availableTime} >= 0 AND ${table.leaseUntil} >= 0
        AND ${table.enqueuedTime} >= 0 AND ${table.processedTime} >= 0
        AND ${table.addTime} >= 0 AND ${table.updateTime} >= 0`,
    ),
  ],
);

/** Latest accepted state/meta fence per provider task subject. */
export const merchantShipmentCallbackWatermark = pgTable(
  "merchant_shipment_callback_watermark",
  {
    provider: varchar("provider", { length: 24 }).default("kuaidi100").notNull(),
    projectionType: varchar("projection_type", { length: 16 }).notNull(),
    subjectKeyHash: varchar("subject_key_hash", { length: 64 }).notNull(),
    lastEventId: bigint("last_event_id", { mode: "number" })
      .notNull()
      .references(() => merchantShipmentCallbackEvent.id, { onDelete: "restrict" }),
    lastEventKey: varchar("last_event_key", { length: 64 }).notNull(),
    lastState: varchar("last_state", { length: 32 }).notNull(),
    lastRank: integer("last_rank").default(0).notNull(),
    terminal: smallint("terminal").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
  },
  (table) => [
    primaryKey({
      name: "mscwm_pkey",
      columns: [table.provider, table.projectionType, table.subjectKeyHash],
    }),
    index("mscwm_last_event").on(table.lastEventId),
    check("mscwm_provider_ck", sql`${table.provider} = 'kuaidi100'`),
    check(
      "mscwm_projection_ck",
      sql`${table.projectionType} IN ('order_state', 'metadata', 'ignored')`,
    ),
    check(
      "mscwm_state_ck",
      sql`${table.lastState} IN (
        'ORDER_CREATED', 'ACCEPTED', 'COLLECTING', 'PICKED_UP', 'IN_TRANSIT',
        'DELIVERING', 'SIGNED', 'ABNORMAL_SIGNED', 'SETTLED', 'REASSIGNED',
        'CANCEL_REQUESTED', 'CANCELLED',
        'PICKUP_FAILED', 'ORDER_FAILED', 'RESURRECTED', 'LABEL_CREATED',
        'LABEL_FAILED', 'WEIGHT_CHANGED', 'UNKNOWN'
      )`,
    ),
    check(
      "mscwm_hash_rank_ck",
      sql`${table.subjectKeyHash} ~ '^[0-9a-f]{64}$'
        AND ${table.lastEventKey} ~ '^[0-9a-f]{64}$'
        AND ${table.lastRank} >= 0 AND ${table.terminal} IN (0, 1)
        AND ${table.updateTime} >= 0`,
    ),
  ],
);

export type MerchantShipmentCallbackEvent = typeof merchantShipmentCallbackEvent.$inferSelect;
