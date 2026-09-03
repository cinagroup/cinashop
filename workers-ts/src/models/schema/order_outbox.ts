/**
 * 订单领域事务 outbox。
 *
 * 支付状态与事件在同一 PostgreSQL 事务提交；Cloudflare Queue 只负责加速投递，
 * 定时扫描负责补偿“数据库已提交但 Queue 投递失败/结果未知”的窗口。
 */
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

export interface OrderPaidOutboxPayload {
  orderId: number;
  orderNo: string;
}

export interface OrderDeliveryNoticeOutboxPayload {
  orderId: number;
  orderNo: string;
  userId: number;
  deliveryType: "express" | "send" | "fictitious";
  deliveryName: string;
  deliveryId: string;
  userAddress: string;
}

export interface OrderRefundRefusedNoticeOutboxPayload {
  orderId: number;
  orderNo: string;
  refundId: number;
  userId: number;
  payPrice: string;
}

export interface OrderSecondCardNoticeOutboxPayload {
  orderId: number;
  orderNo: string;
  cartInfoId: number;
  userId: number;
  kind: "advent" | "expired";
  writeEnd: number;
  payTime: number;
  storeName: string;
}

export type OrderOutboxPayload =
  | OrderPaidOutboxPayload
  | OrderDeliveryNoticeOutboxPayload
  | OrderRefundRefusedNoticeOutboxPayload
  | OrderSecondCardNoticeOutboxPayload;

export const storeOrderOutbox = pgTable(
  "store_order_outbox",
  {
    id: serial("id").primaryKey(),
    eventKey: varchar("event_key", { length: 128 }).notNull(),
    aggregateType: varchar("aggregate_type", { length: 32 }).default("order").notNull(),
    aggregateId: integer("aggregate_id").notNull(),
    eventType: varchar("event_type", { length: 64 }).notNull(),
    payload: jsonb("payload").$type<OrderOutboxPayload>().notNull(),
    /** PENDING/ENQUEUING/ENQUEUED/PROCESSING/COMPLETED/FAILED/DEAD */
    status: varchar("status", { length: 16 }).default("PENDING").notNull(),
    dispatchCount: integer("dispatch_count").default(0).notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    replayCount: integer("replay_count").default(0).notNull(),
    availableTime: integer("available_time").default(0).notNull(),
    leaseUntil: integer("lease_until").default(0).notNull(),
    leaseToken: varchar("lease_token", { length: 36 }).default("").notNull(),
    lastError: varchar("last_error", { length: 1000 }).default("").notNull(),
    enqueuedTime: integer("enqueued_time").default(0).notNull(),
    processedTime: integer("processed_time").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
  },
  (t) => [
    check("soob_event_type_ck", sql`${t.eventType} IN (
      'order.paid',
      'order.delivery.notice',
      'order.refund.refused.notice',
      'order.second_card.advent.notice',
      'order.second_card.expired.notice'
    )`),
    uniqueIndex("soob_event_key_uq").on(t.eventKey),
    index("soob_aggregate").on(t.aggregateType, t.aggregateId),
    index("soob_dispatch_ready")
      .on(t.availableTime, t.id)
      .where(sql`${t.status} IN ('PENDING', 'FAILED')`),
    index("soob_expired_lease")
      .on(t.leaseUntil, t.id)
      .where(sql`${t.status} IN ('ENQUEUING', 'ENQUEUED', 'PROCESSING')`),
  ],
);

export type StoreOrderOutbox = typeof storeOrderOutbox.$inferSelect;
