import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  serial,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

export type OrderPrintTrigger = "created" | "paid" | "manual";
export type OrderPrintProvider = "yilianyun" | "feieyun";
export type OrderPrintActorType = "system" | "admin" | "supplier";
export type OrderPrintJobStatus =
  | "PENDING"
  | "ENQUEUING"
  | "ENQUEUED"
  | "PROCESSING"
  | "RETRYABLE"
  | "SENT"
  | "UNKNOWN"
  | "DEAD"
  | "CLOSED";
export type OrderPrintJobActionType = "CONFIRM_SENT" | "CONFIRM_RETRY" | "CLOSE_NO_RETRY";

/** Durable evidence for one order x printer provider side effect. */
export const orderPrintJob = pgTable(
  "order_print_job",
  {
    id: serial("id").primaryKey(),
    eventKey: varchar("event_key", { length: 128 }).notNull(),
    requestKey: varchar("request_key", { length: 36 }).default("").notNull(),
    orderId: integer("order_id").notNull(),
    orderNo: varchar("order_no", { length: 32 }).notNull(),
    printerId: integer("printer_id").notNull(),
    supplierId: integer("supplier_id").notNull(),
    trigger: varchar("trigger", { length: 16 }).$type<OrderPrintTrigger>().notNull(),
    provider: varchar("provider", { length: 16 }).$type<OrderPrintProvider>().notNull(),
    actorType: varchar("actor_type", { length: 16 }).$type<OrderPrintActorType>().notNull(),
    actorId: integer("actor_id").default(0).notNull(),
    status: varchar("status", { length: 16 }).$type<OrderPrintJobStatus>()
      .default("PENDING").notNull(),
    dispatchCount: integer("dispatch_count").default(0).notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    replayCount: integer("replay_count").default(0).notNull(),
    availableTime: integer("available_time").default(0).notNull(),
    leaseUntil: integer("lease_until").default(0).notNull(),
    leaseToken: varchar("lease_token", { length: 36 }).default("").notNull(),
    providerReference: varchar("provider_reference", { length: 255 }).default("").notNull(),
    providerRequestId: varchar("provider_request_id", { length: 255 }).default("").notNull(),
    responseCode: varchar("response_code", { length: 100 }).default("").notNull(),
    contentHash: varchar("content_hash", { length: 64 }).default("").notNull(),
    lastError: varchar("last_error", { length: 1000 }).default("").notNull(),
    sentTime: integer("sent_time").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
  },
  (t) => [
    uniqueIndex("opj_event_key_uq").on(t.eventKey),
    uniqueIndex("opj_manual_request_printer_uq").on(t.requestKey, t.printerId)
      .where(sql`${t.requestKey} <> ''`),
    index("opj_manual_request").on(t.requestKey, t.id).where(sql`${t.requestKey} <> ''`),
    index("opj_owner_history").on(t.supplierId, t.id),
    index("opj_order_history").on(t.orderId, t.id),
    index("opj_dispatch_ready").on(t.availableTime, t.id)
      .where(sql`${t.status} IN ('PENDING', 'RETRYABLE')`),
    index("opj_expired_queue_lease").on(t.leaseUntil, t.id)
      .where(sql`${t.status} IN ('ENQUEUING', 'ENQUEUED')`),
    index("opj_expired_provider_lease").on(t.leaseUntil, t.id)
      .where(sql`${t.status} = 'PROCESSING'`),
    check("opj_trigger_ck", sql`${t.trigger} IN ('created', 'paid', 'manual')`),
    check("opj_provider_ck", sql`${t.provider} IN ('yilianyun', 'feieyun')`),
    check("opj_actor_ck", sql`(
      (${t.actorType} = 'system' AND ${t.actorId} = 0)
      OR (${t.actorType} IN ('admin', 'supplier') AND ${t.actorId} > 0)
    )`),
    check("opj_status_ck", sql`${t.status} IN (
      'PENDING', 'ENQUEUING', 'ENQUEUED', 'PROCESSING', 'RETRYABLE',
      'SENT', 'UNKNOWN', 'DEAD', 'CLOSED'
    )`),
    check("opj_identity_ck", sql`
      ${t.orderId} > 0 AND ${t.printerId} > 0 AND ${t.supplierId} >= 0
    `),
    check("opj_time_ck", sql`
      ${t.availableTime} >= 0 AND ${t.leaseUntil} >= 0 AND ${t.sentTime} >= 0
      AND ${t.addTime} >= 0 AND ${t.updateTime} >= 0
    `),
  ],
);

export type OrderPrintJob = typeof orderPrintJob.$inferSelect;

/** Immutable human decisions; intentionally contains no receipt payload or credentials. */
export const orderPrintJobAction = pgTable(
  "order_print_job_action",
  {
    id: serial("id").primaryKey(),
    jobId: integer("job_id").notNull(),
    requestKey: varchar("request_key", { length: 36 }).notNull(),
    action: varchar("action", { length: 32 }).$type<OrderPrintJobActionType>().notNull(),
    previousStatus: varchar("previous_status", { length: 16 })
      .$type<OrderPrintJobStatus>().notNull(),
    nextStatus: varchar("next_status", { length: 16 }).$type<OrderPrintJobStatus>().notNull(),
    actorType: varchar("actor_type", { length: 16 }).$type<Exclude<OrderPrintActorType, "system">>()
      .notNull(),
    actorId: integer("actor_id").notNull(),
    supplierId: integer("supplier_id").notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    providerReference: varchar("provider_reference", { length: 255 }).default("").notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    uniqueIndex("opja_request_key_uq").on(t.requestKey),
    index("opja_job").on(t.jobId, t.id),
    index("opja_actor_time").on(t.actorType, t.actorId, t.addTime, t.id),
    check("opja_action_ck", sql`${t.action} IN (
      'CONFIRM_SENT', 'CONFIRM_RETRY', 'CLOSE_NO_RETRY'
    )`),
    check("opja_actor_ck", sql`
      ${t.actorType} IN ('admin', 'supplier') AND ${t.actorId} > 0 AND ${t.supplierId} >= 0
    `),
    check("opja_time_ck", sql`${t.addTime} >= 0`),
  ],
);

export type OrderPrintJobAction = typeof orderPrintJobAction.$inferSelect;
