import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, varchar } from 'drizzle-orm/pg-core';

/** ORM table creation requires the explicit invoice protection protocol. */
export const storeOrderInvoiceAllocation = pgTable('store_order_invoice_allocation', {
  id: varchar('id', { length: 32 }).primaryKey(),
  sourceInvoiceId: integer('source_invoice_id').notNull(),
  sourceOrderId: integer('source_order_id').notNull(),
  paymentOrderId: integer('payment_order_id').notNull(),
  uid: integer('uid').notNull(),
  reason: varchar('reason', { length: 16 }).notNull(),
  sourceSnapshot: text('source_snapshot').notNull(),
  targets: text('targets').notNull(),
  addTime: integer('add_time').notNull(),
}, t => [
  index('soia_source_history').on(t.sourceInvoiceId, t.addTime),
  check('soia_identity_ck', sql`${t.id} ~ '^[0-9a-f]{32}$' AND ${t.sourceInvoiceId} > 0
    AND ${t.sourceOrderId} > 0 AND ${t.paymentOrderId} > 0 AND ${t.uid} > 0 AND ${t.addTime} > 0
    AND ${t.reason} IN ('fulfillment','supplier')`),
  check('soia_snapshot_ck', sql`(octet_length(${t.sourceSnapshot}) <= 16384
    AND jsonb_typeof(${t.sourceSnapshot}::jsonb)='object'
    AND (${t.sourceSnapshot}::jsonb->>'id')::integer=${t.sourceInvoiceId}
    AND (${t.sourceSnapshot}::jsonb->>'orderId')::integer=${t.sourceOrderId}
    AND (${t.sourceSnapshot}::jsonb->>'uid')::integer=${t.uid}) IS TRUE`),
  check('soia_targets_ck', sql`(octet_length(${t.targets}) <= 65536
    AND jsonb_typeof(${t.targets}::jsonb)='array' AND jsonb_array_length(${t.targets}::jsonb) BETWEEN 2 AND 200) IS TRUE`),
]);
