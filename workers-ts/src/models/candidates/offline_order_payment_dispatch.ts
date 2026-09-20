import { sql } from 'drizzle-orm';
import { bigint, integer, pgTable, text, uniqueIndex, uuid, varchar, check, foreignKey } from 'drizzle-orm/pg-core';
import { offlineOrderPaymentSelection } from './offline_order_payment_selection';
import { paymentReconciliationCase } from '@/models/schema/payment_reconciliation';

/** Migration-registered candidate. Payment entrance artifact, NEVER collection evidence. */
export const offlineOrderPaymentDispatch = pgTable('offline_order_payment_dispatch', {
  selectionKey: uuid('selection_key').primaryKey(),
  attemptKey: uuid('attempt_key').notNull(),
  caseId: bigint('case_id', { mode: 'number' }).notNull(),
  state: varchar('state', { length: 10 }).$type<'ISSUING' | 'READY' | 'UNKNOWN'>().notNull(),
  ticketPayload: text('ticket_payload').default('').notNull(),
  ticketHash: varchar('ticket_hash', { length: 64 }).default('').notNull(),
  createdAt: integer('created_at').notNull(),
  finishedAt: integer('finished_at').default(0).notNull(),
  displayUntil: integer('display_until').default(0).notNull(),
}, t => [uniqueIndex('oopd_attempt_uq').on(t.attemptKey), uniqueIndex('oopd_case_uq').on(t.caseId),
  foreignKey({ name: 'offline_order_payment_dispatch_selection_key_fkey', columns: [t.selectionKey], foreignColumns: [offlineOrderPaymentSelection.selectionKey] }).onDelete('restrict'),
  foreignKey({ name: 'offline_order_payment_dispatch_case_id_fkey', columns: [t.caseId], foreignColumns: [paymentReconciliationCase.id] }).onDelete('restrict'),
  check('oopd_identity_ck', sql`attempt_key::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND case_id>0 AND created_at>0`),
  check('oopd_state_ck', sql`
    (state='ISSUING' AND finished_at=0 AND display_until=0 AND ticket_payload='' AND ticket_hash='')
    OR (state='UNKNOWN' AND finished_at>=created_at AND display_until=0 AND ticket_payload='' AND ticket_hash='')
    OR (state='READY' AND finished_at>=created_at AND display_until=created_at+300
      AND octet_length(ticket_payload) BETWEEN 2 AND 8192 AND ticket_hash ~ '^[0-9a-f]{64}$')`)
]);
