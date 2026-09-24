import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, jsonb, pgTable, smallint, text, timestamp } from 'drizzle-orm/pg-core';

/** Registered structural model. Raw ORM DDL has
 * no protection triggers. Complete its empty table explicitly before grants;
 * never adopt historical rows or treat table shape as purchase provenance. */
export const storeOrderPurchaseOrigin = pgTable('store_order_purchase_origin', {
  orderId: integer('order_id').primaryKey(),
  buyerId: integer('buyer_id').notNull(),
  version: text('version').notNull(),
  orderType: smallint('order_type').notNull(),
  totalNum: integer('total_num').notNull(),
  usedPoints: bigint('used_points', { mode: 'bigint' }).notNull(),
  lines: jsonb('lines').notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
}, t => [
  index('sopo_buyer_history').on(t.buyerId, t.orderId),
  check('store_order_purchase_origin_order_id_check', sql`${t.orderId} > 0`),
  check('store_order_purchase_origin_buyer_id_check', sql`${t.buyerId} >= 0`),
  check('store_order_purchase_origin_version_check', sql`${t.version} = 'purchase-origin-v1'`),
  check('store_order_purchase_origin_order_type_check', sql`${t.orderType} BETWEEN 0 AND 8`),
  check('store_order_purchase_origin_total_num_check', sql`${t.totalNum} > 0`),
  check('store_order_purchase_origin_used_points_check', sql`${t.usedPoints} >= 0`),
  check('store_order_purchase_origin_lines_check', sql`jsonb_typeof(${t.lines}) = 'array'
    AND jsonb_array_length(${t.lines}) BETWEEN 1 AND 200 AND octet_length(${t.lines}::text) <= 131072`),
]);
