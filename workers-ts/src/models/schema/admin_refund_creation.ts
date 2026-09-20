import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, primaryKey, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

/** Immutable creation identity, not a payment settlement receipt. No expiry or
 * cascading FK may release an original request key. Abandonment has no refund. */
export const adminRefundCreation = pgTable('admin_refund_creation', {
  adminId: integer('admin_id').notNull(),
  requestKey: uuid('request_key').notNull(),
  requestHash: varchar('request_hash', { length: 64 }).notNull(),
  orderId: integer('order_id').notNull(),
  refundId: integer('refund_id'),
  outcome: varchar('outcome', { length: 16 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`clock_timestamp()`).notNull(),
}, t => [
  primaryKey({ name: 'arc_pk', columns: [t.adminId, t.requestKey] }),
  index('arc_order_history').on(t.orderId, t.createdAt, t.adminId, t.requestKey),
  check('arc_identity_ck', sql`${t.adminId} > 0 AND ${t.orderId} > 0`),
  check('arc_key_ck', sql`${t.requestKey}::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`),
  check('arc_hash_ck', sql`${t.requestHash} ~ '^[0-9a-f]{64}$'`),
  check('arc_outcome_ck', sql`
    (${t.outcome} = 'created' AND ${t.refundId} IS NOT NULL AND ${t.refundId} > 0) OR
    (${t.outcome} = 'abandoned' AND ${t.refundId} IS NULL)
  `),
]);
