import {
  index,
  integer,
  pgTable,
  serial,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * 第三方原路退款状态。
 *
 * store_order_refund 继续保存售后业务状态；本表只保存支付渠道状态，避免把
 * “渠道已受理”误当成“用户已收到退款”。一条售后单只允许对应一个稳定的
 * 商户退款单号，渠道重试始终复用该号码。
 */
export const storeOrderRefundPayment = pgTable(
  "store_order_refund_payment",
  {
    id: serial("id").primaryKey(),
    refundId: integer("refund_id").notNull(),
    storeOrderId: integer("store_order_id").notNull(),
    provider: varchar("provider", { length: 16 }).notNull(),
    outRefundNo: varchar("out_refund_no", { length: 64 }).notNull(),
    providerRefundId: varchar("provider_refund_id", { length: 100 }).default("").notNull(),
    /** CREATED/REQUESTING/PROCESSING/SUCCESS/CLOSED/ABNORMAL/FAILED/UNKNOWN */
    providerStatus: varchar("provider_status", { length: 24 }).default("CREATED").notNull(),
    requestAmount: integer("request_amount").default(0).notNull(),
    totalAmount: integer("total_amount").default(0).notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    requestTime: integer("request_time").default(0).notNull(),
    queryTime: integer("query_time").default(0).notNull(),
    notifyTime: integer("notify_time").default(0).notNull(),
    successTime: integer("success_time").default(0).notNull(),
    lastError: varchar("last_error", { length: 512 }).default("").notNull(),
    addTime: integer("add_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
  },
  (t) => [
    uniqueIndex("sorp_refund_id_uq").on(t.refundId),
    uniqueIndex("sorp_out_refund_no_uq").on(t.outRefundNo),
    index("sorp_order_id").on(t.storeOrderId),
    index("sorp_provider_status").on(t.provider, t.providerStatus),
  ],
);
