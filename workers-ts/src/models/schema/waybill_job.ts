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

export type OrderWaybillActorType = "admin" | "supplier";
export type OrderWaybillFulfillmentMode = "whole" | "split";
export type OrderWaybillJobStatus =
  | "PENDING"
  | "ENQUEUING"
  | "ENQUEUED"
  | "PROCESSING"
  | "RETRYABLE"
  | "SENT"
  | "UNKNOWN"
  | "DEAD"
  | "CLOSED";
export type OrderWaybillJobActionType =
  | "APPLY_EXISTING"
  | "CONFIRM_ISSUED"
  | "CONFIRM_RETRY"
  | "CLOSE_NO_RETRY";

/** Durable intent for one electronic-waybill allocation and order fulfillment. */
export const orderWaybillJob = pgTable(
  "order_waybill_job",
  {
    id: serial("id").primaryKey(),
    eventKey: varchar("event_key", { length: 128 }).notNull(),
    requestKey: varchar("request_key", { length: 36 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    rootOrderId: integer("root_order_id").notNull(),
    orderId: integer("order_id").notNull(),
    orderNo: varchar("order_no", { length: 32 }).notNull(),
    supplierId: integer("supplier_id").notNull(),
    storeId: integer("store_id").default(0).notNull(),
    actorType: varchar("actor_type", { length: 16 }).$type<OrderWaybillActorType>().notNull(),
    actorId: integer("actor_id").notNull(),
    fulfillmentMode: varchar("fulfillment_mode", { length: 16 })
      .$type<OrderWaybillFulfillmentMode>().notNull(),
    cartSelection: varchar("cart_selection", { length: 16000 }).default("[]").notNull(),
    carrierId: integer("carrier_id").notNull(),
    carrierCode: varchar("carrier_code", { length: 50 }).notNull(),
    carrierName: varchar("carrier_name", { length: 64 }).notNull(),
    carrierConfig: varchar("carrier_config", { length: 2000 }).default("{}").notNull(),
    templateId: varchar("template_id", { length: 255 }).notNull(),
    cloudPrinterId: varchar("cloud_printer_id", { length: 50 }).default("").notNull(),
    senderName: varchar("sender_name", { length: 128 }).notNull(),
    senderPhone: varchar("sender_phone", { length: 32 }).notNull(),
    senderAddress: varchar("sender_address", { length: 255 }).notNull(),
    status: varchar("status", { length: 16 }).$type<OrderWaybillJobStatus>()
      .default("PENDING").notNull(),
    dispatchCount: integer("dispatch_count").default(0).notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    replayCount: integer("replay_count").default(0).notNull(),
    availableTime: integer("available_time").default(0).notNull(),
    leaseUntil: integer("lease_until").default(0).notNull(),
    leaseToken: varchar("lease_token", { length: 36 }).default("").notNull(),
    providerReference: varchar("provider_reference", { length: 255 }).default("").notNull(),
    responseCode: varchar("response_code", { length: 100 }).default("").notNull(),
    trackingNumber: varchar("tracking_number", { length: 64 }).default("").notNull(),
    labelUrl: varchar("label_url", { length: 255 }).default("").notNull(),
    payloadHash: varchar("payload_hash", { length: 64 }).default("").notNull(),
    fulfilledOrderId: integer("fulfilled_order_id").default(0).notNull(),
    remainingOrderId: integer("remaining_order_id").default(0).notNull(),
    lastError: varchar("last_error", { length: 1000 }).default("").notNull(),
    sentTime: integer("sent_time").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
  },
  (t) => [
    uniqueIndex("owj_event_key_uq").on(t.eventKey),
    uniqueIndex("owj_request_key_uq").on(t.requestKey),
    uniqueIndex("owj_active_root_uq").on(t.rootOrderId)
      .where(sql`${t.status} IN (
        'PENDING', 'ENQUEUING', 'ENQUEUED', 'PROCESSING', 'RETRYABLE', 'UNKNOWN', 'DEAD'
      )`),
    index("owj_owner_history").on(t.supplierId, t.id),
    index("owj_order_history").on(t.orderId, t.id),
    index("owj_dispatch_ready").on(t.availableTime, t.id)
      .where(sql`${t.status} IN ('PENDING', 'RETRYABLE')`),
    index("owj_expired_queue_lease").on(t.leaseUntil, t.id)
      .where(sql`${t.status} IN ('ENQUEUING', 'ENQUEUED')`),
    index("owj_expired_provider_lease").on(t.leaseUntil, t.id)
      .where(sql`${t.status} = 'PROCESSING'`),
    check("owj_actor_ck", sql`(
      ${t.actorType} IN ('admin', 'supplier') AND ${t.actorId} > 0 AND ${t.supplierId} >= 0
    )`),
    check("owj_mode_ck", sql`${t.fulfillmentMode} IN ('whole', 'split')`),
    check("owj_status_ck", sql`${t.status} IN (
      'PENDING', 'ENQUEUING', 'ENQUEUED', 'PROCESSING', 'RETRYABLE',
      'SENT', 'UNKNOWN', 'DEAD', 'CLOSED'
    )`),
    check("owj_identity_ck", sql`
      ${t.rootOrderId} > 0 AND ${t.orderId} > 0 AND ${t.carrierId} > 0
      AND ${t.storeId} >= 0 AND ${t.fulfilledOrderId} >= 0 AND ${t.remainingOrderId} >= 0
    `),
    check("owj_time_ck", sql`
      ${t.availableTime} >= 0 AND ${t.leaseUntil} >= 0 AND ${t.sentTime} >= 0
      AND ${t.addTime} >= 0 AND ${t.updateTime} >= 0
    `),
  ],
);

export type OrderWaybillJob = typeof orderWaybillJob.$inferSelect;

/** Immutable operator decisions; no recipient, sender, carrier secret, or provider payload. */
export const orderWaybillJobAction = pgTable(
  "order_waybill_job_action",
  {
    id: serial("id").primaryKey(),
    jobId: integer("job_id").notNull(),
    requestKey: varchar("request_key", { length: 36 }).notNull(),
    action: varchar("action", { length: 32 }).$type<OrderWaybillJobActionType>().notNull(),
    previousStatus: varchar("previous_status", { length: 16 })
      .$type<OrderWaybillJobStatus>().notNull(),
    nextStatus: varchar("next_status", { length: 16 }).$type<OrderWaybillJobStatus>().notNull(),
    actorType: varchar("actor_type", { length: 16 }).$type<OrderWaybillActorType>().notNull(),
    actorId: integer("actor_id").notNull(),
    supplierId: integer("supplier_id").notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    providerReference: varchar("provider_reference", { length: 255 }).default("").notNull(),
    trackingNumber: varchar("tracking_number", { length: 64 }).default("").notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    uniqueIndex("owja_request_key_uq").on(t.requestKey),
    index("owja_job").on(t.jobId, t.id),
    index("owja_actor_time").on(t.actorType, t.actorId, t.addTime, t.id),
    check("owja_action_ck", sql`${t.action} IN (
      'APPLY_EXISTING', 'CONFIRM_ISSUED', 'CONFIRM_RETRY', 'CLOSE_NO_RETRY'
    )`),
    check("owja_actor_ck", sql`
      ${t.actorType} IN ('admin', 'supplier') AND ${t.actorId} > 0 AND ${t.supplierId} >= 0
    `),
    check("owja_time_ck", sql`${t.addTime} >= 0`),
  ],
);

export type OrderWaybillJobAction = typeof orderWaybillJobAction.$inferSelect;
