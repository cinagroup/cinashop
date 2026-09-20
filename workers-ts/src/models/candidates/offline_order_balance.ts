import { sql } from 'drizzle-orm';
import { boolean, integer, jsonb, numeric, pgTable, uniqueIndex, varchar, check, foreignKey } from 'drizzle-orm/pg-core';
import { offlineOrderPaymentSelection } from './offline_order_payment_selection';
import { userMoney } from '../schema/user_center';
import { userBill } from '../schema/order';
import { storeOrderEconomize } from '../schema/order_auxiliary';

/** Migration-registered wallet-only candidate. Install its checked SQL, never bare ORM.
 * One receipt binds the debit and optional gifts to an admitted type=3 order.
 * No provider payment, refund, membership activation or public route implied.
 */
export const offlineOrderBalance = pgTable('offline_order_balance', {
  orderId: integer('order_id').primaryKey(),
  uid: integer('uid').notNull(),
  orderNo: varchar('order_no', { length: 32 }).notNull(),
  version: varchar('version', { length: 32 }).default('offline-balance-v1').notNull(),
  payPrice: numeric('pay_price', { precision: 10, scale: 2 }).notNull(),
  balanceBefore: numeric('balance_before', { precision: 12, scale: 2 }).notNull(),
  balanceAfter: numeric('balance_after', { precision: 12, scale: 2 }).notNull(),
  moneyId: integer('money_id').notNull(),
  integralBefore: integer('integral_before').notNull(),
  integralAfter: integer('integral_after').notNull(),
  integralReward: integer('integral_reward').notNull(),
  integralRate: numeric('integral_rate', { precision: 14, scale: 6 }).notNull(),
  memberBonus: integer('member_bonus').notNull(),
  memberActive: boolean('member_active').notNull(),
  integralBillId: integer('integral_bill_id'),
  savingsId: integer('savings_id'),
  promoted: boolean('promoted').notNull(),
  /** Bounded, normalized policy inputs; audit evidence, not a replay authority. */
  policy: jsonb('policy').$type<Record<string, string>>().notNull(),
  paidAt: integer('paid_at').notNull(),
}, t => [
  uniqueIndex('oob_order_no_uq').on(t.orderNo),
  uniqueIndex('oob_money_uq').on(t.moneyId),
  uniqueIndex('oob_integral_uq').on(t.integralBillId),
  uniqueIndex('oob_savings_uq').on(t.savingsId),
  foreignKey({ name: 'offline_order_balance_order_id_fkey', columns: [t.orderId], foreignColumns: [offlineOrderPaymentSelection.orderId] }).onDelete('restrict'),
  foreignKey({ name: 'offline_order_balance_money_id_fkey', columns: [t.moneyId], foreignColumns: [userMoney.id] }).onDelete('restrict'),
  foreignKey({ name: 'offline_order_balance_integral_bill_id_fkey', columns: [t.integralBillId], foreignColumns: [userBill.id] }).onDelete('restrict'),
  foreignKey({ name: 'offline_order_balance_savings_id_fkey', columns: [t.savingsId], foreignColumns: [storeOrderEconomize.id] }).onDelete('restrict'),
  check('oob_identity_ck', sql`uid>0 AND order_id>0 AND order_no ~ '^xx[0-9a-f]{30}$'
    AND version='offline-balance-v1' AND paid_at>0 AND money_id>0
    AND (integral_bill_id IS NULL OR integral_bill_id>0) AND (savings_id IS NULL OR savings_id>0)
    AND jsonb_typeof(policy)='object' AND octet_length(policy::text)<=4096`),
  check('oob_money_ck', sql`pay_price>0 AND pay_price<>'NaN'::numeric
    AND balance_before>=0 AND balance_before<>'NaN'::numeric AND balance_after>=0 AND balance_after<>'NaN'::numeric
    AND balance_before=balance_after+pay_price`),
  check('oob_integral_ck', sql`integral_before>=0 AND integral_after>=0 AND integral_reward>=0
    AND integral_after::bigint=integral_before::bigint+integral_reward::bigint
    AND integral_rate>=0 AND member_bonus>=0 AND (member_active OR member_bonus=0)
    AND integral_reward=trunc(integral_rate*pay_price)+member_bonus
    AND ((integral_reward=0 AND integral_bill_id IS NULL) OR (integral_reward>0 AND integral_bill_id IS NOT NULL))`)
]);
