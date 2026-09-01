/**
 * Active provider-query reconciliation for externally initiated payments.
 * Only minimized transaction evidence is retained; payer and raw provider data
 * are deliberately excluded.
 */
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
import { sql } from "drizzle-orm";
import { paymentCallbackEvent } from "@/models/schema/payment_callback";

export type PaymentReconciliationStatus =
  | "OPEN"
  | "QUEUED"
  | "QUERYING"
  | "WAITING"
  | "SETTLED"
  | "CONFIRMED"
  | "NO_PAYMENT"
  | "UNKNOWN"
  | "CONFLICT"
  | "DEAD"
  | "CLOSED";

export type PaymentReconciliationProviderStatus =
  | "UNKNOWN"
  | "PENDING"
  | "SUCCESS"
  | "CLOSED"
  | "NOT_FOUND";

export type PaymentReconciliationActionType = "RETRY" | "ACCEPT_LOCAL" | "CLOSE";

export const paymentReconciliationCase = pgTable(
  "payment_reconciliation_case",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    replayKey: varchar("replay_key", { length: 36 }).notNull(),
    provider: varchar("provider", { length: 16 }).$type<"wechat" | "alipay">().notNull(),
    profile: varchar("profile", { length: 16 })
      .$type<"wechat" | "routine" | "app" | "alipay">().notNull(),
    orderDomain: varchar("order_domain", { length: 16 })
      .$type<"" | "store_order" | "recharge" | "membership">().default("").notNull(),
    orderNo: varchar("order_no", { length: 64 }).notNull(),
    expectedAmountCents: integer("expected_amount_cents").notNull(),
    currency: varchar("currency", { length: 3 }).$type<"CNY">().notNull(),
    status: varchar("status", { length: 16 })
      .$type<PaymentReconciliationStatus>().default("OPEN").notNull(),
    providerStatus: varchar("provider_status", { length: 16 })
      .$type<PaymentReconciliationProviderStatus>().default("UNKNOWN").notNull(),
    providerTransactionId: varchar("provider_transaction_id", { length: 100 })
      .default("").notNull(),
    providerEventTime: integer("provider_event_time").default(0).notNull(),
    callbackEventId: bigint("callback_event_id", { mode: "number" })
      .references(() => paymentCallbackEvent.id, { onDelete: "restrict" }),
    attemptCount: integer("attempt_count").default(0).notNull(),
    nextCheckTime: integer("next_check_time").default(0).notNull(),
    leaseUntil: integer("lease_until").default(0).notNull(),
    leaseToken: varchar("lease_token", { length: 36 }).default("").notNull(),
    lastQueryTime: integer("last_query_time").default(0).notNull(),
    lastErrorCode: varchar("last_error_code", { length: 64 }).default("").notNull(),
    initiatedTime: integer("initiated_time").default(0).notNull(),
    resolvedTime: integer("resolved_time").default(0).notNull(),
    retainUntil: integer("retain_until").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
  },
  (table) => [
    uniqueIndex("prc_replay_key_uq").on(table.replayKey),
    uniqueIndex("prc_provider_order_uq").on(table.provider, table.orderNo),
    index("prc_due").on(table.nextCheckTime, table.id)
      .where(sql`${table.status} IN ('OPEN', 'WAITING', 'UNKNOWN')`),
    index("prc_expired_lease").on(table.leaseUntil, table.id)
      .where(sql`${table.status} IN ('QUEUED', 'QUERYING')`),
    index("prc_attention").on(table.status, table.updateTime, table.id)
      .where(sql`${table.status} IN ('UNKNOWN', 'CONFLICT', 'DEAD')`),
    index("prc_retention").on(table.retainUntil, table.id)
      .where(sql`${table.status} IN ('SETTLED', 'CONFIRMED', 'NO_PAYMENT', 'CLOSED')`),
    check("prc_provider_profile_ck", sql`
      (${table.provider} = 'alipay' AND ${table.profile} = 'alipay')
      OR (${table.provider} = 'wechat' AND ${table.profile} IN ('wechat', 'routine', 'app'))
    `),
    check("prc_order_domain_ck", sql`
      ${table.orderDomain} IN ('', 'store_order', 'recharge', 'membership')
    `),
    check("prc_business_ck", sql`
      ${table.orderNo} ~ '^[A-Za-z0-9_-]{2,64}$' AND ${table.expectedAmountCents} > 0
      AND ${table.currency} = 'CNY'
      AND (${table.providerTransactionId} = ''
        OR ${table.providerTransactionId} ~ '^[A-Za-z0-9_-]{1,100}$')
    `),
    check("prc_status_ck", sql`
      ${table.status} IN (
        'OPEN', 'QUEUED', 'QUERYING', 'WAITING', 'SETTLED', 'CONFIRMED',
        'NO_PAYMENT', 'UNKNOWN', 'CONFLICT', 'DEAD', 'CLOSED'
      )
    `),
    check("prc_provider_status_ck", sql`
      ${table.providerStatus} IN ('UNKNOWN', 'PENDING', 'SUCCESS', 'CLOSED', 'NOT_FOUND')
    `),
    check("prc_replay_lease_ck", sql`
      ${table.replayKey} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND (${table.leaseToken} = '' OR ${table.leaseToken} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    `),
    check("prc_time_count_ck", sql`
      ${table.providerEventTime} >= 0 AND ${table.attemptCount} >= 0
      AND ${table.nextCheckTime} >= 0 AND ${table.leaseUntil} >= 0
      AND ${table.lastQueryTime} >= 0 AND ${table.initiatedTime} >= 0
      AND ${table.resolvedTime} >= 0 AND ${table.retainUntil} >= ${table.addTime}
      AND ${table.addTime} >= 0 AND ${table.updateTime} >= 0
    `),
  ],
);

export const paymentReconciliationAction = pgTable(
  "payment_reconciliation_action",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    caseId: bigint("case_id", { mode: "number" }).notNull()
      .references(() => paymentReconciliationCase.id, { onDelete: "restrict" }),
    actionKey: varchar("action_key", { length: 36 }).notNull(),
    adminId: integer("admin_id").notNull(),
    actionType: varchar("action_type", { length: 16 })
      .$type<PaymentReconciliationActionType>().notNull(),
    reasonCode: varchar("reason_code", { length: 64 }).notNull(),
    beforeStatus: varchar("before_status", { length: 16 })
      .$type<PaymentReconciliationStatus>().notNull(),
    afterStatus: varchar("after_status", { length: 16 })
      .$type<PaymentReconciliationStatus>().notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (table) => [
    uniqueIndex("pra_action_key_uq").on(table.actionKey),
    index("pra_case_history").on(table.caseId, table.id),
    check("pra_action_key_ck", sql`
      ${table.actionKey} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    `),
    check("pra_business_ck", sql`
      ${table.adminId} > 0 AND ${table.actionType} IN ('RETRY', 'ACCEPT_LOCAL', 'CLOSE')
      AND ${table.reasonCode} ~ '^[a-z][a-z0-9_]{2,63}$'
      AND ${table.beforeStatus} IN (
        'OPEN', 'QUEUED', 'QUERYING', 'WAITING', 'SETTLED', 'CONFIRMED',
        'NO_PAYMENT', 'UNKNOWN', 'CONFLICT', 'DEAD', 'CLOSED'
      )
      AND ${table.afterStatus} IN (
        'OPEN', 'QUEUED', 'QUERYING', 'WAITING', 'SETTLED', 'CONFIRMED',
        'NO_PAYMENT', 'UNKNOWN', 'CONFLICT', 'DEAD', 'CLOSED'
      )
      AND ${table.addTime} >= 0
    `),
  ],
);
