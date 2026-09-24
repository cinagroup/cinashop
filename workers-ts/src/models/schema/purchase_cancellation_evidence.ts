import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, jsonb, pgTable, smallint, text, timestamp } from 'drizzle-orm/pg-core';

/** Registered structural model. ORM DDL does not
 * install the order transition/deferred validation/immutability triggers. Its
 * exact empty table must be explicitly completed before any runtime grants. */
export const storeOrderPurchaseCancellation = pgTable('store_order_purchase_cancellation', {
  orderId: integer('order_id').primaryKey(),
  buyerId: integer('buyer_id').notNull(),
  version: text('version').notNull(),
  orderType: smallint('order_type').notNull(),
  totalNum: integer('total_num').notNull(),
  restoredPoints: bigint('restored_points', { mode:'bigint' }).notNull(),
  lines: jsonb('lines').notNull(),
  originRecordedAt: timestamp('origin_recorded_at', { withTimezone:true }).notNull(),
  cancelledAt: timestamp('cancelled_at', { withTimezone:true }).notNull(),
}, t => [
  index('sopc_buyer_history').on(t.buyerId,t.orderId),
  check('store_order_purchase_cancellation_order_id_check',sql`${t.orderId} > 0`),
  check('store_order_purchase_cancellation_buyer_id_check',sql`${t.buyerId} >= 0`),
  check('store_order_purchase_cancellation_version_check',sql`${t.version} = 'purchase-cancellation-v1'`),
  check('store_order_purchase_cancellation_order_type_check',sql`${t.orderType} BETWEEN 0 AND 8`),
  check('store_order_purchase_cancellation_total_num_check',sql`${t.totalNum} > 0`),
  check('store_order_purchase_cancellation_restored_points_check',sql`${t.restoredPoints} BETWEEN 0 AND 9999999999`),
  check('store_order_purchase_cancellation_lines_check',sql`jsonb_typeof(${t.lines}) = 'array'
    AND jsonb_array_length(${t.lines}) BETWEEN 1 AND 200 AND octet_length(${t.lines}::text) <= 131072`),
]);
