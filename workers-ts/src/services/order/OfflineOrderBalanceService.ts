import { and, eq, gte, sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { otherOrder, otherOrderStatus, storeOrderEconomize, user, userBill, userMoney } from '@/models/schema';
import { offlineOrderAdmission } from '@/models/candidates/offline_order_admission';
import { offlineOrderBalance } from '@/models/candidates/offline_order_balance';
import { ApiException, ValidateException } from '@/utils/errors';
import { offlineMoney, offlinePayableCents } from './OfflineOrderQuoteService';
import { assertUnpaidOfflineOrder, lockOfflineOrderPayment } from './OfflineOrderPaymentContext';
import { insertOfflineWalletSelectionTx, readOfflinePaymentSelectionTx } from './OfflineOrderPaymentSelectionService';
import { OFFLINE_MAX_INTEGRAL as MAX_INTEGRAL, offlineAccountCents as balanceCents,
  readOfflinePaymentPolicy, writeOfflineRewardEffectsTx } from './OfflineOrderPaymentPolicy';
export async function verifyOfflineBalanceReceipt(tx: DbClient, receipt: typeof offlineOrderBalance.$inferSelect) {
  // Never compare historical balances to today's user balance, nor recalculate
  // old gifts from today's configuration. Missing/corrupt effects fail closed.
  const [proof] = await tx.execute<{ valid: boolean }>(sql`SELECT
    (r.version='offline-balance-v1' AND r.pay_price>0 AND r.balance_before=r.balance_after+r.pay_price
      AND r.integral_after::bigint=r.integral_before::bigint+r.integral_reward::bigint
      AND r.integral_reward=trunc(r.integral_rate*r.pay_price)+r.member_bonus
      AND m.uid=r.uid AND m.link_id=r.order_no AND m.type='offline_scan' AND m.pm=0 AND m.status=1
      AND m.number=r.pay_price AND m.balance=r.balance_after AND m.add_time=r.paid_at
      AND ((r.integral_reward=0 AND r.integral_bill_id IS NULL) OR
        (r.integral_reward>0 AND b.id IS NOT NULL AND b.uid=r.uid AND b.link_id=r.order_no AND b.category='integral'
          AND b.type='gain' AND b.event_key='offline_order_give_integral' AND b.pm=1 AND b.status=1 AND b.take=0
          AND b.frozen_time=0 AND b.number=r.integral_reward AND b.balance=r.integral_after AND b.add_time=r.paid_at))
      AND ((a.discount_percent=0 AND r.savings_id IS NULL) OR
        (a.discount_percent>0 AND s.id IS NOT NULL AND s.uid=r.uid AND s.order_id=r.order_no AND s.order_type=2
          AND s.pay_price=r.pay_price AND s.offline_price=a.raw_price-a.pay_price AND s.postage_price=0
          AND s.member_price=0 AND s.coupon_price=0 AND s.status=0 AND s.add_time=r.paid_at))) AS valid
    FROM ${offlineOrderBalance} r JOIN ${offlineOrderAdmission} a ON a.order_id=r.order_id
      JOIN ${userMoney} m ON m.id=r.money_id LEFT JOIN ${userBill} b ON b.id=r.integral_bill_id
      LEFT JOIN ${storeOrderEconomize} s ON s.id=r.savings_id WHERE r.order_id=${receipt.orderId}`);
  if (proof?.valid !== true) throw new ValidateException('线下消费支付凭据不完整');
}

/** Unreleased positive-price wallet settlement used by the offline pay route.
 * Order -> user -> fixed config locks; all monetary effects commit together.
 * Zero-price settlement is prohibited by the explicit minimum-payable policy.
 */
export async function payOfflineOrderBalance(container: Container, input: { uid: number; orderNo: string }) {
  return withTx(container, async tx => {
    const context = await lockOfflineOrderPayment(tx, input);
    const { order, admission, account } = context;
    const selection = await readOfflinePaymentSelectionTx(tx, context);
    const [receipt] = await tx.select().from(offlineOrderBalance).where(eq(offlineOrderBalance.orderId, order.id));
    const result = (row: typeof offlineOrderBalance.$inferSelect, replayed: boolean) => ({
      order_id: order.orderId, paid: true as const, pay_type: 'yue' as const, pay_price: row.payPrice,
      balance_after: row.balanceAfter, integral_reward: row.integralReward, replayed, cancelled: order.isDel !== 0,
    });
    if (receipt) {
      if (!selection || selection.rail !== 'yue' || selection.createdAt !== receipt.paidAt
        || receipt.uid !== input.uid || receipt.orderNo !== order.orderId || receipt.payPrice !== order.payPrice
        || order.paid !== 1 || order.payType !== 'yue' || order.tradeNo !== '' || order.payTime !== receipt.paidAt) {
        throw new ValidateException('线下消费支付状态与凭据不一致');
      }
      await verifyOfflineBalanceReceipt(tx, receipt);
      return result(receipt, true);
    }
    if (selection) {
      throw new ApiException('线下消费已选定支付路径，请先核对原支付结果', 409);
    }
    assertUnpaidOfflineOrder(order);
    const amount = offlinePayableCents(admission.payPrice);
    const before = balanceCents(account.nowMoney);
    if (before < amount) throw new ValidateException('余额不足');
    if (!Number.isInteger(account.integral) || account.integral < 0 || ![0, 1].includes(account.isPromoter)) {
      throw new ValidateException('账户积分或推广状态无效');
    }
    const policy = await readOfflinePaymentPolicy(tx, input.uid, amount, account.isPromoter, true);
    const integralAfter = BigInt(account.integral) + BigInt(policy.reward);
    if (integralAfter > MAX_INTEGRAL) throw new ValidateException('账户积分超出范围');
    if (policy.now < admission.createdAt) throw new ValidateException('线下消费支付时间异常');
    const [existing] = await tx.execute<{ present: boolean }>(sql`SELECT
      (EXISTS(SELECT 1 FROM ${userMoney} WHERE uid=${input.uid} AND link_id=${order.orderId} AND type='offline_scan')
        OR EXISTS(SELECT 1 FROM ${userBill} WHERE uid=${input.uid} AND link_id=${order.orderId} AND event_key='offline_order_give_integral')
        OR EXISTS(SELECT 1 FROM ${storeOrderEconomize} WHERE uid=${input.uid} AND order_id=${order.orderId})) AS present`);
    if (existing.present) throw new ValidateException('线下消费存在未绑定的历史账单');
    await insertOfflineWalletSelectionTx(tx, context, policy.now);
    const after = offlineMoney(before - amount);
    const updated = await tx.update(user).set({ nowMoney: after, integral: Number(integralAfter),
      isPromoter: policy.promoted ? 1 : account.isPromoter }).where(and(eq(user.uid, input.uid), gte(user.nowMoney, order.payPrice)))
      .returning({ uid: user.uid });
    if (updated.length !== 1) throw new ValidateException('余额扣款失败');
    // user_money is the existing cash-history authority. Do not duplicate this
    // expense in user_bill or label it pay_product (that joins store-order refunds).
    const [money] = await tx.insert(userMoney).values({ uid: input.uid, linkId: order.orderId, type: 'offline_scan',
      title: '线下消费', number: order.payPrice, balance: after, pm: 0, status: 1,
      mark: `线下消费余额支付${order.payPrice}元`, addTime: policy.now }).returning({ id: userMoney.id });
    const { integralBillId, savingsId } = await writeOfflineRewardEffectsTx(tx, context, policy, Number(integralAfter));
    await tx.update(otherOrder).set({ paid: 1, payType: 'yue', payTime: policy.now }).where(eq(otherOrder.id, order.id));
    const [paid] = await tx.insert(offlineOrderBalance).values({ orderId: order.id, uid: input.uid, orderNo: order.orderId,
      payPrice: order.payPrice, balanceBefore: account.nowMoney, balanceAfter: after, moneyId: money.id,
      integralBefore: account.integral, integralAfter: Number(integralAfter), integralReward: policy.reward,
      integralRate: policy.rate, memberBonus: policy.bonus, memberActive: policy.memberActive,
      integralBillId, savingsId, promoted: policy.promoted, policy: policy.evidence, paidAt: policy.now }).returning();
    await tx.insert(otherOrderStatus).values({ oid: order.id, changeType: 'pay_success', changeMessage: '线下消费余额支付成功',
      shopType: 3, changeTime: policy.now });
    return result(paid, false);
  });
}
