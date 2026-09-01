/**
 * Provider-verified payment callback ingress and durable Queue outbox.
 *
 * Only the settlement allowlist is stored. Raw/signature/decrypted payloads and
 * payer details must never enter either table or the Queue body.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  check,
  index,
  integer,
  pgTable,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

export type PaymentCallbackProvider = "wechat" | "alipay";
export type PaymentCallbackProfile = "wechat" | "routine" | "app" | "alipay";
export type PaymentCallbackOrderDomain = "" | "store_order" | "recharge" | "membership";
export type PaymentCallbackEventStatus =
  | "RECEIVED"
  | "PROCESSING"
  | "COMPLETED"
  | "IGNORED"
  | "UNKNOWN"
  | "FAILED"
  | "DEAD";
export type PaymentCallbackOutboxStatus =
  | "PENDING"
  | "ENQUEUING"
  | "ENQUEUED"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED"
  | "DEAD";

export const paymentCallbackEvent = pgTable(
  "payment_callback_event",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    provider: varchar("provider", { length: 16 }).$type<PaymentCallbackProvider>().notNull(),
    profile: varchar("profile", { length: 16 }).$type<PaymentCallbackProfile>().notNull(),
    providerEventId: varchar("provider_event_id", { length: 128 }).notNull(),
    replayKey: varchar("replay_key", { length: 36 }).notNull(),
    payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
    orderNo: varchar("order_no", { length: 64 }).notNull(),
    transactionId: varchar("transaction_id", { length: 100 }).notNull(),
    tradeState: varchar("trade_state", { length: 32 }).notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    providerEventTime: integer("provider_event_time").default(0).notNull(),
    orderDomain: varchar("order_domain", { length: 16 })
      .$type<PaymentCallbackOrderDomain>()
      .default("")
      .notNull(),
    status: varchar("status", { length: 16 })
      .$type<PaymentCallbackEventStatus>()
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
    uniqueIndex("pce_provider_event_uq").on(table.provider, table.providerEventId),
    uniqueIndex("pce_replay_key_uq").on(table.replayKey),
    index("pce_provider_transaction").on(table.provider, table.transactionId, table.id),
    index("pce_actionable_status")
      .on(table.status, table.updateTime, table.id)
      .where(sql`${table.status} IN ('RECEIVED', 'FAILED', 'UNKNOWN', 'DEAD')`),
    index("pce_retention_due")
      .on(table.retainUntil, table.id)
      .where(sql`${table.status} IN ('COMPLETED', 'IGNORED', 'UNKNOWN', 'DEAD')`),
    check(
      "pce_provider_profile_ck",
      sql`(${table.provider} = 'alipay' AND ${table.profile} = 'alipay')
        OR (${table.provider} = 'wechat' AND ${table.profile} IN ('wechat', 'routine', 'app'))`,
    ),
    check(
      "pce_replay_hash_ck",
      sql`${table.replayKey} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND ${table.payloadHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "pce_business_ck",
      sql`length(${table.providerEventId}) > 0 AND length(${table.orderNo}) > 0
        AND length(${table.transactionId}) > 0 AND length(${table.tradeState}) > 0
        AND ${table.amountCents} > 0 AND ${table.currency} = 'CNY'`,
    ),
    check(
      "pce_order_domain_ck",
      sql`${table.orderDomain} IN ('', 'store_order', 'recharge', 'membership')`,
    ),
    check(
      "pce_status_ck",
      sql`${table.status} IN ('RECEIVED', 'PROCESSING', 'COMPLETED', 'IGNORED', 'UNKNOWN', 'FAILED', 'DEAD')`,
    ),
    check(
      "pce_time_count_ck",
      sql`${table.providerEventTime} >= 0 AND ${table.attemptCount} >= 0
        AND ${table.leaseUntil} >= 0 AND ${table.receivedTime} >= 0
        AND ${table.processedTime} >= 0 AND ${table.retainUntil} >= ${table.receivedTime}
        AND ${table.updateTime} >= 0`,
    ),
  ],
);

export const paymentCallbackOutbox = pgTable(
  "payment_callback_outbox",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    eventId: bigint("event_id", { mode: "number" })
      .notNull()
      .references(() => paymentCallbackEvent.id, { onDelete: "restrict" }),
    replayKey: varchar("replay_key", { length: 36 }).notNull(),
    status: varchar("status", { length: 16 })
      .$type<PaymentCallbackOutboxStatus>()
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
    uniqueIndex("pco_event_uq").on(table.eventId),
    uniqueIndex("pco_replay_key_uq").on(table.replayKey),
    index("pco_dispatch_ready")
      .on(table.availableTime, table.id)
      .where(sql`${table.status} IN ('PENDING', 'FAILED')`),
    index("pco_expired_lease")
      .on(table.leaseUntil, table.id)
      .where(sql`${table.status} IN ('ENQUEUING', 'ENQUEUED', 'PROCESSING')`),
    check(
      "pco_replay_key_ck",
      sql`${table.replayKey} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`,
    ),
    check(
      "pco_status_ck",
      sql`${table.status} IN ('PENDING', 'ENQUEUING', 'ENQUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'DEAD')`,
    ),
    check(
      "pco_time_count_ck",
      sql`${table.dispatchCount} >= 0 AND ${table.attemptCount} >= 0
        AND ${table.availableTime} >= 0 AND ${table.leaseUntil} >= 0
        AND ${table.enqueuedTime} >= 0 AND ${table.processedTime} >= 0
        AND ${table.addTime} >= 0 AND ${table.updateTime} >= 0`,
    ),
  ],
);

export type PaymentCallbackEvent = typeof paymentCallbackEvent.$inferSelect;
export type PaymentCallbackOutbox = typeof paymentCallbackOutbox.$inferSelect;
