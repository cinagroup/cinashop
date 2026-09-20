import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, primaryKey, text, timestamp, varchar } from 'drizzle-orm/pg-core';

/** Requires the explicit invoice protection protocol after ORM table creation. This records
 * reported issuance, not a fiscal provider's attestation or a credit note. */
export const storeOrderInvoiceEvidence = pgTable('store_order_invoice_evidence', {
  invoiceId: integer('invoice_id').notNull(),
  kind: varchar('kind', { length: 12 }).notNull(),
  documentNumber: varchar('document_number', { length: 50 }).notNull(),
  orderId: integer('order_id').notNull(),
  uid: integer('uid').notNull(),
  snapshot: text('snapshot').notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, t => [
  primaryKey({ name: 'soie_identity_pk', columns: [t.invoiceId, t.kind, t.documentNumber] }),
  index('soie_order_kind').on(t.orderId, t.kind),
  check('soie_identity_ck', sql`${t.invoiceId} > 0 AND ${t.orderId} > 0 AND ${t.uid} > 0
    AND ${t.kind} IN ('created','issued','unverified') AND (${t.kind}='issued' OR ${t.documentNumber}='')`),
  check('soie_snapshot_ck', sql`(octet_length(${t.snapshot}) <= 16384 AND jsonb_typeof(${t.snapshot}::jsonb)='object'
    AND ${t.snapshot}::jsonb @> '{"v":1}'::jsonb AND jsonb_typeof(${t.snapshot}::jsonb->'invoice')='object'
    AND (${t.snapshot}::jsonb->'invoice') ?& ARRAY['id','order_id','uid','category','is_invoice','invoice_number']
    AND (${t.snapshot}::jsonb->'invoice'->>'id')::integer=${t.invoiceId}
    AND (${t.snapshot}::jsonb->'invoice'->>'order_id')::integer=${t.orderId}
    AND (${t.snapshot}::jsonb->'invoice'->>'uid')::integer=${t.uid}
    AND jsonb_typeof(${t.snapshot}::jsonb->'invoice'->'is_invoice')='number'
    AND jsonb_typeof(${t.snapshot}::jsonb->'invoice'->'invoice_number')='string'
    AND (${t.kind}<>'issued' OR (${t.documentNumber}=${t.snapshot}::jsonb->'invoice'->>'invoice_number'
      AND ((${t.snapshot}::jsonb->'invoice'->>'is_invoice')::integer=1 OR ${t.documentNumber}<>'')))) IS TRUE`),
]);
