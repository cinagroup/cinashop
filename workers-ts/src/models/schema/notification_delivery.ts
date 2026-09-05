import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

export type OrderNotificationChannel =
  | "sms"
  | "wechat_official"
  | "wechat_routine"
  | "wechat_shipping";

export type OrderNotificationDeliveryStatus =
  | "PENDING"
  | "ENQUEUING"
  | "ENQUEUED"
  | "PROCESSING"
  | "RETRYABLE"
  | "SENT"
  | "SKIPPED"
  | "UNKNOWN"
  | "DEAD";

export type OrderNotificationDeliveryActionType =
  | "CONFIRM_SENT"
  | "CONFIRM_RETRY"
  | "CLOSE_NO_RETRY";

export interface SmsNotificationPayload {
  kind: "sms";
  params: Record<string, string>;
}

export interface WechatTemplateNotificationPayload {
  kind: "wechat_official" | "wechat_routine";
  data: Record<string, string>;
  url: string;
}

export interface WechatShippingNotificationPayload {
  kind: "wechat_shipping";
  transactionId: string;
  logisticsType: number;
  deliveryMode: 1 | 2;
  isAllDelivered: boolean;
  itemDescription: string;
  trackingNumber: string;
  expressCompanyName: string;
  receiverContact: string;
  path: string;
}

export type OrderNotificationDeliveryPayload =
  | SmsNotificationPayload
  | WechatTemplateNotificationPayload
  | WechatShippingNotificationPayload;

/**
 * Durable evidence for one provider side effect.
 *
 * Queue messages contain only the row ID and immutable event key. Targets and
 * rendered payloads stay in PostgreSQL and must never be written to Worker logs.
 */
export const orderNotificationDelivery = pgTable(
  "order_notification_delivery",
  {
    id: serial("id").primaryKey(),
    outboxId: integer("outbox_id").notNull(),
    eventKey: varchar("event_key", { length: 128 }).notNull(),
    orderId: integer("order_id"),
    withdrawalId: integer("withdrawal_id"),
    userId: integer("user_id").notNull(),
    noticeMark: varchar("notice_mark", { length: 50 }).notNull(),
    channel: varchar("channel", { length: 32 }).$type<OrderNotificationChannel>().notNull(),
    target: varchar("target", { length: 255 }).default("").notNull(),
    templateCode: varchar("template_code", { length: 100 }).default("").notNull(),
    payload: jsonb("payload").$type<OrderNotificationDeliveryPayload>().notNull(),
    /** PENDING/ENQUEUING/ENQUEUED/PROCESSING/RETRYABLE/SENT/SKIPPED/UNKNOWN/DEAD */
    status: varchar("status", { length: 16 })
      .$type<OrderNotificationDeliveryStatus>()
      .default("PENDING")
      .notNull(),
    dispatchCount: integer("dispatch_count").default(0).notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    replayCount: integer("replay_count").default(0).notNull(),
    availableTime: integer("available_time").default(0).notNull(),
    leaseUntil: integer("lease_until").default(0).notNull(),
    leaseToken: varchar("lease_token", { length: 36 }).default("").notNull(),
    providerReference: varchar("provider_reference", { length: 255 }).default("").notNull(),
    providerRequestId: varchar("provider_request_id", { length: 255 }).default("").notNull(),
    responseCode: varchar("response_code", { length: 100 }).default("").notNull(),
    lastError: varchar("last_error", { length: 1000 }).default("").notNull(),
    sentTime: integer("sent_time").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
  },
  (t) => [
    uniqueIndex("ond_event_channel_uq").on(t.eventKey, t.channel),
    index("ond_outbox").on(t.outboxId, t.id),
    index("ond_order").on(t.orderId, t.id),
    index("ond_withdrawal").on(t.withdrawalId, t.id).where(sql`${t.withdrawalId} IS NOT NULL`),
    check("ond_subject_ck", sql`(${t.withdrawalId} IS NULL AND ${t.orderId} IS NOT NULL)
      OR (${t.withdrawalId} IS NOT NULL AND ${t.withdrawalId} > 0 AND ${t.orderId} IS NULL)`),
    index("ond_dispatch_ready")
      .on(t.availableTime, t.id)
      .where(sql`${t.status} IN ('PENDING', 'RETRYABLE')`),
    index("ond_expired_queue_lease")
      .on(t.leaseUntil, t.id)
      .where(sql`${t.status} IN ('ENQUEUING', 'ENQUEUED')`),
    index("ond_expired_provider_lease")
      .on(t.leaseUntil, t.id)
      .where(sql`${t.status} = 'PROCESSING'`),
    check("ond_channel_ck", sql`${t.channel} IN (
      'sms', 'wechat_official', 'wechat_routine', 'wechat_shipping'
    )`),
    check("ond_status_ck", sql`${t.status} IN (
      'PENDING', 'ENQUEUING', 'ENQUEUED', 'PROCESSING', 'RETRYABLE',
      'SENT', 'SKIPPED', 'UNKNOWN', 'DEAD'
    )`),
    check("ond_time_ck", sql`
      ${t.availableTime} >= 0 AND ${t.leaseUntil} >= 0 AND ${t.sentTime} >= 0
      AND ${t.addTime} >= 0 AND ${t.updateTime} >= 0
    `),
  ],
);

export type OrderNotificationDelivery = typeof orderNotificationDelivery.$inferSelect;

/** Immutable operator decisions for UNKNOWN/DEAD provider outcomes. */
export const orderNotificationDeliveryAction = pgTable(
  "order_notification_delivery_action",
  {
    id: serial("id").primaryKey(),
    deliveryId: integer("delivery_id").notNull(),
    requestKey: varchar("request_key", { length: 36 }).notNull(),
    action: varchar("action", { length: 32 })
      .$type<OrderNotificationDeliveryActionType>()
      .notNull(),
    previousStatus: varchar("previous_status", { length: 16 })
      .$type<OrderNotificationDeliveryStatus>()
      .notNull(),
    nextStatus: varchar("next_status", { length: 16 })
      .$type<OrderNotificationDeliveryStatus>()
      .notNull(),
    adminId: integer("admin_id").notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    providerReference: varchar("provider_reference", { length: 255 }).default("").notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    uniqueIndex("onda_request_key_uq").on(t.requestKey),
    index("onda_delivery").on(t.deliveryId, t.id),
    index("onda_admin_time").on(t.adminId, t.addTime, t.id),
    check("onda_action_ck", sql`${t.action} IN (
      'CONFIRM_SENT', 'CONFIRM_RETRY', 'CLOSE_NO_RETRY'
    )`),
    check("onda_admin_time_ck", sql`${t.adminId} > 0 AND ${t.addTime} >= 0`),
  ],
);

export type OrderNotificationDeliveryAction =
  typeof orderNotificationDeliveryAction.$inferSelect;
