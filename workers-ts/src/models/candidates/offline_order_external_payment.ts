import { sql } from 'drizzle-orm';
import { bigint, boolean, index, integer, jsonb, numeric, pgTable, uniqueIndex, uuid, varchar, check, foreignKey } from 'drizzle-orm/pg-core';
import { offlineOrderPaymentSelection } from './offline_order_payment_selection';
import { paymentCallbackEvent } from '../schema/payment_callback';
import { storeOrderEconomize } from '../schema/order_auxiliary';
import { userBill } from '../schema/order';
import { offlineOrderQueryEvidence } from './offline_order_query_evidence';

/** Migration-registered immutable attestation of the trusted ingress identity check.
 * No raw callback, secret or additional payer plaintext is persisted here.
 */
export const offlineOrderCallbackBinding = pgTable('offline_order_callback_binding', {
  eventId: bigint('event_id', { mode: 'number' }).primaryKey(),
  selectionKey: uuid('selection_key').notNull(),
  eventHash: varchar('event_hash', { length: 64 }).notNull(),
  identityHash: varchar('identity_hash', { length: 64 }).notNull(),
  createdAt: integer('created_at').notNull(),
}, t => [index('oocb_selection_idx').on(t.selectionKey),
  foreignKey({ name: 'offline_order_callback_binding_event_id_fkey', columns: [t.eventId], foreignColumns: [paymentCallbackEvent.id] }).onDelete('restrict'),
  foreignKey({ name: 'offline_order_callback_binding_selection_key_fkey', columns: [t.selectionKey], foreignColumns: [offlineOrderPaymentSelection.selectionKey] }).onDelete('restrict'),
  check('oocb_identity_ck', sql`event_id>0 AND created_at>0
    AND event_hash ~ '^[0-9a-f]{64}$' AND identity_hash ~ '^[0-9a-f]{64}$'`)
]);

export const offlineOrderExternalPayment = pgTable('offline_order_external_payment', {
  orderId: integer('order_id').primaryKey(),
  eventId: bigint('event_id', { mode: 'number' }),
  queryId: uuid('query_id'),
  uid: integer('uid').notNull(), orderNo: varchar('order_no', { length: 32 }).notNull(),
  version: varchar('version', { length: 32 }).default('offline-external-v1').notNull(),
  provider: varchar('provider', { length: 10 }).$type<'wechat' | 'alipay'>().notNull(),
  profile: varchar('profile', { length: 10 }).$type<'wechat' | 'routine' | 'alipay'>().notNull(),
  transactionId: varchar('transaction_id', { length: 50 }).notNull(),
  providerPaidAt: integer('provider_paid_at').notNull(),
  payPrice: numeric('pay_price', { precision: 10, scale: 2 }).notNull(),
  integralBefore: integer('integral_before').notNull(), integralAfter: integer('integral_after').notNull(),
  integralReward: integer('integral_reward').notNull(), integralRate: numeric('integral_rate', { precision: 14, scale: 6 }).notNull(),
  memberBonus: integer('member_bonus').notNull(), memberActive: boolean('member_active').notNull(),
  integralBillId: integer('integral_bill_id'),
  savingsId: integer('savings_id'),
  promoted: boolean('promoted').notNull(), policy: jsonb('policy').$type<Record<string, string>>().notNull(),
  paidAt: integer('paid_at').notNull(),
}, t => [uniqueIndex('ooep_order_no_uq').on(t.orderNo), uniqueIndex('ooep_event_uq').on(t.eventId), uniqueIndex('ooep_query_uq').on(t.queryId),
  uniqueIndex('ooep_transaction_uq').on(t.provider, t.transactionId), uniqueIndex('ooep_integral_uq').on(t.integralBillId),
  uniqueIndex('ooep_savings_uq').on(t.savingsId),
  foreignKey({ name: 'offline_order_external_payment_order_id_fkey', columns: [t.orderId], foreignColumns: [offlineOrderPaymentSelection.orderId] }).onDelete('restrict'),
  foreignKey({ name: 'offline_order_external_payment_event_id_fkey', columns: [t.eventId], foreignColumns: [offlineOrderCallbackBinding.eventId] }).onDelete('restrict'),
  foreignKey({ name: 'offline_order_external_payment_query_id_fkey', columns: [t.queryId], foreignColumns: [offlineOrderQueryEvidence.id] }).onDelete('restrict'),
  foreignKey({ name: 'offline_order_external_payment_integral_bill_id_fkey', columns: [t.integralBillId], foreignColumns: [userBill.id] }).onDelete('restrict'),
  foreignKey({ name: 'offline_order_external_payment_savings_id_fkey', columns: [t.savingsId], foreignColumns: [storeOrderEconomize.id] }).onDelete('restrict'),
  check('ooep_source_ck', sql`(event_id IS NOT NULL AND query_id IS NULL) OR (event_id IS NULL AND query_id IS NOT NULL)`),
  check('ooep_identity_ck', sql`order_id>0 AND (event_id IS NULL OR event_id>0) AND uid>0 AND order_no ~ '^xx[0-9a-f]{30}$'
    AND version='offline-external-v1' AND paid_at>0 AND provider_paid_at>=0
    AND ((provider='wechat' AND profile IN ('wechat','routine')) OR (provider='alipay' AND profile='alipay'))
    AND transaction_id ~ '^[A-Za-z0-9_-]{1,50}$'
    AND (integral_bill_id IS NULL OR integral_bill_id>0) AND (savings_id IS NULL OR savings_id>0)
    AND jsonb_typeof(policy)='object' AND octet_length(policy::text)<=4096`),
  check('ooep_amount_ck', sql`pay_price>0 AND pay_price<=21474836.47 AND pay_price<>'NaN'::numeric`),
  check('ooep_integral_ck', sql`integral_before>=0 AND integral_after>=0 AND integral_reward>=0
    AND integral_after::bigint=integral_before::bigint+integral_reward::bigint
    AND integral_rate>=0 AND integral_rate<>'NaN'::numeric AND member_bonus>=0 AND (member_active OR member_bonus=0)
    AND integral_reward=trunc(integral_rate*pay_price)+member_bonus
    AND ((integral_reward=0 AND integral_bill_id IS NULL) OR (integral_reward>0 AND integral_bill_id IS NOT NULL))`)
]);
