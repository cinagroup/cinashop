import { sql } from 'drizzle-orm';
import { bigint, index, integer, pgTable, uniqueIndex, uuid, varchar, check, foreignKey } from 'drizzle-orm/pg-core';
import { paymentReconciliationCase } from '../schema/payment_reconciliation';
import { offlineOrderPaymentSelection } from './offline_order_payment_selection';

/** Migration-registered trusted query attestation. Not a provider callback or raw signature archive. */
export const offlineOrderQueryEvidence = pgTable('offline_order_query_evidence', {
  id: uuid('id').primaryKey(), replayKey: uuid('replay_key').notNull(),
  caseId: bigint('case_id', { mode: 'number' }).notNull(),
  selectionKey: uuid('selection_key').notNull(),
  version: varchar('version', { length: 32 }).default('offline-query-v1').notNull(),
  identitySource: varchar('identity_source', { length: 32 }).$type<'wechat-signed-query' | 'alipay-direct-request-scope'>().notNull(),
  provider: varchar('provider', { length: 10 }).$type<'wechat' | 'alipay'>().notNull(),
  profile: varchar('profile', { length: 10 }).$type<'wechat' | 'routine' | 'alipay'>().notNull(),
  orderNo: varchar('order_no', { length: 32 }).notNull(), transactionId: varchar('transaction_id', { length: 50 }).notNull(),
  tradeState: varchar('trade_state', { length: 32 }).notNull(), amountCents: integer('amount_cents').notNull(),
  currency: varchar('currency', { length: 3 }).$type<'CNY'>().notNull(), providerEventTime: integer('provider_event_time').notNull(),
  evidenceHash: varchar('evidence_hash', { length: 64 }).notNull(), identityHash: varchar('identity_hash', { length: 64 }).notNull(),
  createdAt: integer('created_at').notNull(),
}, t => [uniqueIndex('ooqe_evidence_uq').on(t.evidenceHash), uniqueIndex('ooqe_replay_uq').on(t.replayKey),
  index('ooqe_case_idx').on(t.caseId, t.createdAt, t.id), index('ooqe_transaction_idx').on(t.provider, t.transactionId),
  foreignKey({ name: 'offline_order_query_evidence_case_id_fkey', columns: [t.caseId], foreignColumns: [paymentReconciliationCase.id] }).onDelete('restrict'),
  foreignKey({ name: 'offline_order_query_evidence_selection_key_fkey', columns: [t.selectionKey], foreignColumns: [offlineOrderPaymentSelection.selectionKey] }).onDelete('restrict'),
  check('ooqe_identity_ck', sql`version='offline-query-v1' AND case_id>0 AND order_no ~ '^xx[0-9a-f]{30}$'
    AND transaction_id ~ '^[A-Za-z0-9_-]{1,50}$' AND amount_cents>0 AND currency='CNY'
    AND provider_event_time>0 AND created_at>0 AND evidence_hash ~ '^[0-9a-f]{64}$' AND identity_hash ~ '^[0-9a-f]{64}$'
    AND ((provider='wechat' AND profile IN ('wechat','routine') AND trade_state='SUCCESS' AND identity_source='wechat-signed-query')
      OR (provider='alipay' AND profile='alipay' AND trade_state IN ('TRADE_SUCCESS','TRADE_FINISHED') AND identity_source='alipay-direct-request-scope'))`)
]);
