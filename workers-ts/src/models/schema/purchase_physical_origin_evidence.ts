import { sql } from 'drizzle-orm';
import { check,index,integer,jsonb,pgTable,smallint,text,timestamp } from 'drizzle-orm/pg-core';
/** Structure only. Empty ORM construction needs explicit protected completion. */
export const storeOrderPurchasePhysicalOrigin=pgTable('store_order_purchase_physical_origin',{
  orderId:integer('order_id').primaryKey(),buyerId:integer('buyer_id').notNull(),version:text('version').notNull(),
  orderType:smallint('order_type').notNull(),totalNum:integer('total_num').notNull(),lines:jsonb('lines').notNull(),
  recordedAt:timestamp('recorded_at',{withTimezone:true}).notNull(),
},t=>[
  index('soppo_buyer_history').on(t.buyerId,t.orderId),
  check('store_order_purchase_physical_origin_order_id_check',sql`${t.orderId}>0`),
  check('store_order_purchase_physical_origin_buyer_id_check',sql`${t.buyerId}>=0`),
  check('store_order_purchase_physical_origin_version_check',sql`${t.version}='purchase-physical-origin-v1'`),
  check('store_order_purchase_physical_origin_order_type_check',sql`${t.orderType} BETWEEN 0 AND 8`),
  check('store_order_purchase_physical_origin_total_num_check',sql`${t.totalNum}>0`),
  check('store_order_purchase_physical_origin_lines_check',sql`jsonb_typeof(${t.lines})='array'
    AND jsonb_array_length(${t.lines}) BETWEEN 1 AND 200 AND octet_length(${t.lines}::text)<=131072`),
]);
