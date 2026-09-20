import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, integer, numeric, pgTable, primaryKey, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { otherOrder } from '../schema/paid_membership';
import { user } from '../schema/user';

/** Migration-registered candidate; a bare ORM database still requires explicit
 * empty-ledger protection completion before any application writes.
 * Immutable admission identity, NOT proof of payment. Request keys never expire.
 */
export const offlineOrderAdmission = pgTable('offline_order_admission', {
  uid: integer('uid').notNull(),
  requestKey: uuid('request_key').notNull(),
  requestHash: varchar('request_hash', { length: 64 }).notNull(),
  orderId: integer('order_id').notNull(),
  orderNo: varchar('order_no', { length: 32 }).notNull(),
  version: varchar('version', { length: 32 }).default('offline-admission-v1').notNull(),
  rawPrice: numeric('raw_price', { precision: 10, scale: 2 }).notNull(),
  payPrice: numeric('pay_price', { precision: 10, scale: 2 }).notNull(),
  memberActive: boolean('member_active').notNull(),
  discountPercent: integer('discount_percent').notNull(),
  channel: varchar('channel', { length: 10 }).notNull(),
  createdAt: integer('created_at').notNull(),
}, t => [
  primaryKey({ name: 'ooa_pk', columns: [t.uid, t.requestKey] }),
  foreignKey({ name: 'ooa_user_fk', columns: [t.uid], foreignColumns: [user.uid] }).onDelete('restrict'),
  foreignKey({ name: 'ooa_order_fk', columns: [t.orderId], foreignColumns: [otherOrder.id] }).onDelete('restrict'),
  uniqueIndex('ooa_order_id_uq').on(t.orderId),
  uniqueIndex('ooa_order_no_uq').on(t.orderNo),
  index('ooa_user_history').on(t.uid, t.createdAt, t.orderId),
  check('ooa_identity_ck', sql`${t.uid} > 0 AND ${t.orderId} > 0 AND ${t.createdAt} > 0
    AND ${t.requestKey}::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND ${t.requestHash} ~ '^[0-9a-f]{64}$' AND ${t.orderNo} ~ '^xx[0-9a-f]{30}$'
    AND ${t.version} = 'offline-admission-v1' AND ${t.channel} IN ('wechat','weixinh5','routine','h5')`),
  check('ooa_pricing_ck', sql`${t.rawPrice} > 0 AND ${t.payPrice} >= 0
    AND ${t.discountPercent} BETWEEN 0 AND 100 AND (${t.memberActive} OR ${t.discountPercent} = 0)
    AND ${t.payPrice} = CASE WHEN ${t.discountPercent} = 0 THEN ${t.rawPrice}
      ELSE trunc(${t.rawPrice} * ${t.discountPercent} / 100, 2) END`),
]);
