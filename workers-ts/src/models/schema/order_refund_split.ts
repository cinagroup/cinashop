import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, varchar } from 'drizzle-orm/pg-core';

/** Registered materialization evidence. ORM table creation must be followed by
 * explicit empty-ledger protection completion before runtime commissioning.
 * Never repoint the original refund or delete this evidence with business rows. */
export const storeOrderRefundSplit = pgTable('store_order_refund_split', {
  refundId: integer('refund_id').primaryKey(),
  fingerprint: varchar('fingerprint', { length: 64 }).notNull(),
  uid: integer('uid').notNull(),
  supplierId: integer('supplier_id').notNull(),
  storeId: integer('store_id').notNull(),
  sourceOrderId: integer('source_order_id').notNull(),
  paymentOrderId: integer('payment_order_id').notNull(),
  selectedOrderId: integer('selected_order_id').notNull(),
  remainingOrderId: integer('remaining_order_id'),
  disposition: varchar('disposition', { length: 16 }).notNull(),
  previousRefundId: integer('previous_refund_id').notNull(),
  baseBranchId: varchar('base_branch_id', { length: 32 }),
  returnedPointBillIds: text('returned_point_bill_ids').notNull(),
  earnedIncomeScope: text('earned_income_scope').notNull(),
  invoiceAllocation: text('invoice_allocation').notNull().default('null'),
  sourceSnapshot: text('source_snapshot').notNull(),
  partitions: text('partitions').notNull(),
  addTime: integer('add_time').notNull(),
}, t => [
  index('sors_source_history').on(t.sourceOrderId, t.refundId),
  index('sors_payment_history').on(t.paymentOrderId, t.refundId),
  index('sors_remaining_history').on(t.remainingOrderId, t.refundId).where(sql`${t.remainingOrderId} IS NOT NULL`),
  check('sors_identity_ck', sql`${t.refundId} > 0 AND ${t.uid} > 0 AND ${t.supplierId} >= 0 AND ${t.storeId} >= 0
    AND ${t.sourceOrderId} > 0 AND ${t.paymentOrderId} > 0 AND ${t.selectedOrderId} > 0 AND ${t.addTime} > 0`),
  check('sors_fingerprint_ck', sql`${t.fingerprint} ~ '^[0-9a-f]{64}$'`),
  check('sors_branch_ck', sql`${t.baseBranchId} IS NULL OR ${t.baseBranchId} ~ '^[0-9a-f]{32}$'`),
  check('sors_generation_ck', sql`${t.previousRefundId} >= 0 AND ${t.previousRefundId} < ${t.refundId}
    AND octet_length(${t.returnedPointBillIds}) <= 16384 AND jsonb_typeof(${t.returnedPointBillIds}::jsonb) = 'array'
    AND jsonb_array_length(${t.returnedPointBillIds}::jsonb) <= 1024`),
  check('sors_income_ck', sql`octet_length(${t.earnedIncomeScope}) <= 2048 AND jsonb_typeof(${t.earnedIncomeScope}::jsonb) IN ('object', 'null')`),
  check('sors_invoice_ck', sql`octet_length(${t.invoiceAllocation}) <= 16384 AND jsonb_typeof(${t.invoiceAllocation}::jsonb) IN ('object', 'null')`),
  check('sors_disposition_ck', sql`(${t.disposition} = 'whole' AND ${t.remainingOrderId} IS NULL AND ${t.selectedOrderId} = ${t.sourceOrderId})
    OR (${t.disposition} = 'split' AND ${t.remainingOrderId} IS NOT NULL AND ${t.remainingOrderId} > 0 AND ${t.selectedOrderId} <> ${t.sourceOrderId}
      AND ${t.selectedOrderId} <> ${t.remainingOrderId})`),
  check('sors_snapshot_ck', sql`octet_length(${t.sourceSnapshot}) <= 16777216 AND jsonb_typeof(${t.sourceSnapshot}::jsonb) = 'object'
    AND octet_length(${t.partitions}) <= 131072 AND jsonb_typeof(${t.partitions}::jsonb) = 'array'`),
]);

/** A bounded, append-only baseline for each child of further fulfillment.
 * Only refund-generation orders use this table; public v2 activation is separate. */
export const storeOrderFulfillmentBranch = pgTable('store_order_fulfillment_branch', {
  id: varchar('id', { length: 32 }).primaryKey(),
  sourceBranchId: varchar('source_branch_id', { length: 32 }),
  sourceRefundId: integer('source_refund_id').notNull(),
  sourceOrderId: integer('source_order_id').notNull(),
  paymentOrderId: integer('payment_order_id').notNull(),
  childOrderId: integer('child_order_id').notNull(),
  uid: integer('uid').notNull(),
  supplierId: integer('supplier_id').notNull(),
  storeId: integer('store_id').notNull(),
  coveredRefunds: text('covered_refunds').notNull(),
  materializedRefunds: text('materialized_refunds').notNull(),
  returnedPointBillIds: text('returned_point_bill_ids').notNull(),
  partitions: text('partitions').notNull(),
  addTime: integer('add_time').notNull(),
}, t => [
  index('sofb_child_history').on(t.childOrderId, t.addTime),
  check('sofb_identity_ck', sql`${t.id} ~ '^[0-9a-f]{32}$' AND ${t.sourceOrderId} > 0 AND ${t.paymentOrderId} > 0
    AND ${t.childOrderId} > 0 AND ${t.uid} > 0 AND ${t.supplierId} >= 0 AND ${t.storeId} >= 0 AND ${t.addTime} > 0
    AND ${t.sourceRefundId} >= 0 AND (${t.sourceRefundId} > 0 OR ${t.sourceBranchId} IS NOT NULL)
    AND (${t.sourceBranchId} IS NULL OR (${t.sourceBranchId} ~ '^[0-9a-f]{32}$' AND ${t.sourceBranchId} <> ${t.id}))`),
  check('sofb_history_ck', sql`octet_length(${t.coveredRefunds}) <= 32768 AND jsonb_typeof(${t.coveredRefunds}::jsonb) = 'array'
    AND jsonb_array_length(${t.coveredRefunds}::jsonb) <= 201
    AND octet_length(${t.materializedRefunds}) <= 32768 AND jsonb_typeof(${t.materializedRefunds}::jsonb) = 'array'
    AND jsonb_array_length(${t.materializedRefunds}::jsonb) <= 201`),
  check('sofb_bills_ck', sql`octet_length(${t.returnedPointBillIds}) <= 16384 AND jsonb_typeof(${t.returnedPointBillIds}::jsonb) = 'array'
    AND jsonb_array_length(${t.returnedPointBillIds}::jsonb) <= 1024`),
  check('sofb_partitions_ck', sql`octet_length(${t.partitions}) <= 32768 AND jsonb_typeof(${t.partitions}::jsonb) = 'array'
    AND jsonb_array_length(${t.partitions}::jsonb) BETWEEN 1 AND 200`),
]);
