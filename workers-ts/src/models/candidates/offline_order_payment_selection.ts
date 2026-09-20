import { sql } from 'drizzle-orm';
import { integer, numeric, pgTable, uniqueIndex, uuid, varchar, check, foreignKey } from 'drizzle-orm/pg-core';
import { offlineOrderAdmission } from './offline_order_admission';

/** Migration-registered candidate: immutable payment path, never proof of collection.
 * Payer ID is a bounded internal request snapshot, not a public response field.
 */
export const offlineOrderPaymentSelection = pgTable('offline_order_payment_selection', {
  orderId: integer('order_id').primaryKey(),
  selectionKey: uuid('selection_key').notNull(),
  uid: integer('uid').notNull(),
  orderNo: varchar('order_no', { length: 32 }).notNull(),
  version: varchar('version', { length: 32 }).default('offline-payment-v1').notNull(),
  rail: varchar('rail', { length: 10 }).$type<'yue' | 'wechat' | 'alipay'>().notNull(),
  profile: varchar('profile', { length: 10 }).$type<'' | 'wechat' | 'routine' | 'alipay'>().notNull(),
  transactionType: varchar('transaction_type', { length: 10 }).$type<'' | 'jsapi' | 'h5' | 'wap'>().notNull(),
  appId: varchar('app_id', { length: 64 }).notNull(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull(),
  payerId: varchar('payer_id', { length: 100 }).notNull(),
  currency: varchar('currency', { length: 3 }).default('CNY').notNull(),
  payPrice: numeric('pay_price', { precision: 10, scale: 2 }).notNull(),
  createdAt: integer('created_at').notNull(),
}, t => [uniqueIndex('oops_key_uq').on(t.selectionKey), uniqueIndex('oops_order_no_uq').on(t.orderNo),
  foreignKey({ name: 'offline_order_payment_selection_order_id_fkey', columns: [t.orderId], foreignColumns: [offlineOrderAdmission.orderId] }).onDelete('restrict'),
  check('oops_identity_ck', sql`order_id>0 AND uid>0 AND order_no ~ '^xx[0-9a-f]{30}$'
    AND selection_key::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND version='offline-payment-v1' AND currency='CNY' AND created_at>0`),
  check('oops_price_ck', sql`pay_price>0 AND pay_price<>'NaN'::numeric
    AND (rail='yue' OR pay_price<=21474836.47)`),
  check('oops_rail_ck', sql`
    (rail='yue' AND profile='' AND transaction_type='' AND app_id='' AND merchant_id='' AND payer_id='')
    OR (rail IN ('wechat','alipay') AND app_id ~ '^[A-Za-z0-9_-]{1,64}$' AND merchant_id ~ '^[A-Za-z0-9_-]{1,64}$'
      AND ((rail='wechat' AND profile IN ('wechat','routine')
        AND ((transaction_type='jsapi' AND payer_id ~ '^[A-Za-z0-9_-]{1,100}$')
          OR (transaction_type='h5' AND profile='wechat' AND payer_id='')))
      OR (rail='alipay' AND profile='alipay' AND transaction_type='wap' AND payer_id='')))`)
]);
