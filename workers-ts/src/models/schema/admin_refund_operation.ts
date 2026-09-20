import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, primaryKey, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

/** Immutable, content-free evidence. No FK cascade or expiry may erase a used
 * operation key. Provider admission is explicitly not a settlement receipt. */
export const adminRefundOperation = pgTable('admin_refund_operation', {
  adminId: integer('admin_id').notNull(),
  requestKey: uuid('request_key').notNull(),
  requestHash: varchar('request_hash', { length: 64 }).notNull(),
  refundId: integer('refund_id').notNull(),
  action: varchar('action', { length: 8 }).notNull(),
  outcome: varchar('outcome', { length: 24 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`clock_timestamp()`).notNull(),
}, t => [
  primaryKey({ name: 'aro_pk', columns: [t.adminId, t.requestKey] }),
  index('aro_refund_history').on(t.refundId, t.createdAt, t.adminId, t.requestKey),
  check('aro_identity_ck', sql`${t.adminId} > 0 AND ${t.refundId} > 0`),
  check('aro_hash_ck', sql`${t.requestHash} ~ '^[0-9a-f]{64}$'`),
  check('aro_key_ck', sql`${t.requestKey}::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`),
  check('aro_outcome_ck', sql`
    (${t.action} = 'return' AND ${t.outcome} IN ('return-approved','abandoned')) OR
    (${t.action} = 'refuse' AND ${t.outcome} IN ('refused','abandoned')) OR
    (${t.action} = 'refund' AND ${t.outcome} IN ('balance-settled','provider-admitted','abandoned'))
  `),
]);
