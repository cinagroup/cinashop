import { and, asc, eq, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { memberRight, otherOrder, storeOrderEconomize, systemConfig, user, userBill } from '@/models/schema';
import { normalizeConfigScalar } from '@/utils/config';
import { ValidateException } from '@/utils/errors';
import { offlineAmountCents, offlineMoney } from './OfflineOrderQuoteService';
import type { OfflineOrderPaymentContext } from './OfflineOrderPaymentContext';

export const OFFLINE_MAX_INTEGRAL = 2_147_483_647n;
export function offlineAccountCents(value: string): bigint {
  if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(value)) throw new ValidateException('账户余额数据无效');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}
function flag(value: string): boolean {
  if (value !== '0' && value !== '1') throw new ValidateException('线下消费支付开关配置无效');
  return value === '1';
}

/** Called under order/account locks. External collection must not depend on
 * today's wallet switch; both paths share the same exact reward semantics.
 */
export async function readOfflinePaymentPolicy(tx: DbClient, uid: number, payCents: bigint, wasPromoter: number, wallet: boolean) {
  await tx.execute(sql`SELECT public.ooa_lock_pricing()`);
  const rows = await tx.execute<{ menu_name: string; value: string }>(sql`
    SELECT DISTINCT ON (menu_name) menu_name,
      CASE WHEN octet_length(value)<=128 THEN value ELSE '[oversized-policy]' END AS value
    FROM ${systemConfig} WHERE is_store=0 AND
      (menu_name IN ('member_card_status','order_give_integral','brokerage_func_status','store_brokerage_statu','store_brokerage_price')
        OR (${wallet} AND menu_name IN ('balance_func_status','yue_pay_status')))
    ORDER BY menu_name,sort DESC,id DESC`);
  const values = new Map(rows.map(row => [row.menu_name, normalizeConfigScalar(row.value)]));
  if (rows.some(row => row.value === '[oversized-policy]')) throw new ValidateException('线下消费支付配置过长');
  const config = (key: string, fallback = '0') => values.get(key) || fallback;
  if (wallet && (!flag(config('balance_func_status')) || !flag(config('yue_pay_status')))) throw new ValidateException('余额支付未开启');
  const membership = config('member_card_status', '1');
  if (!/^-?\d+$/.test(membership) || !Number.isSafeInteger(Number(membership))) throw new ValidateException('会员配置无效');
  const [source] = await tx.select({
    now: sql<number>`floor(extract(epoch FROM statement_timestamp()))::integer`,
    eligible: sql<boolean>`(${user.isEverLevel}=1 OR (${user.isMoneyLevel}>0
      AND ${user.overdueTime}>floor(extract(epoch FROM statement_timestamp()))))`,
  }).from(user).where(eq(user.uid, uid));
  const memberActive = source.eligible && Number(membership) === 1;
  const [right] = await tx.select({ status: memberRight.status, number: memberRight.number }).from(memberRight)
    .where(eq(memberRight.rightType, 'integral')).orderBy(asc(memberRight.id)).limit(1);
  const bonus = memberActive && right?.status === 1 ? right.number : 0;
  if (!Number.isSafeInteger(bonus) || bonus < 0 || BigInt(bonus) > OFFLINE_MAX_INTEGRAL) throw new ValidateException('会员赠分配置无效');
  const rate = config('order_give_integral');
  if (!/^(?:0|[1-9]\d{0,7})(?:\.\d{1,6})?$/.test(rate)) throw new ValidateException('消费赠分比例配置无效');
  const [whole, fraction = ''] = rate.split('.');
  const rateUnits = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  // Preserve PHP's actual addition, not its misleading "double reward" comment.
  const reward = payCents * rateUnits / 100_000_000n + BigInt(bonus);
  if (reward > OFFLINE_MAX_INTEGRAL) throw new ValidateException('消费赠分超出积分范围');
  let promoted = false;
  const evidence: Record<string, string> = { ...(wallet ? { balance: '1', yue: '1' } : { collection: 'external' }), member: membership, rate,
    brokerage: config('brokerage_func_status'), mode: config('store_brokerage_statu', '1'),
    threshold: config('store_brokerage_price'), priorPromoter: String(wasPromoter) };
  if (wasPromoter === 0 && flag(evidence.brokerage)) {
    if (!['1', '2', '3'].includes(evidence.mode)) throw new ValidateException('推广资格配置无效');
    if (evidence.mode === '3') {
      const threshold = offlineAccountCents(evidence.threshold);
      const [paid] = await tx.select({ cents: sql<string>`(COALESCE(sum(${otherOrder.payPrice}),0)*100)::text` })
        .from(otherOrder).where(and(eq(otherOrder.uid, uid), eq(otherOrder.paid, 1)));
      if (!/^\d+(?:\.0+)?$/.test(paid.cents)) throw new ValidateException('历史消费金额无效');
      const total = BigInt(paid.cents.split('.')[0]) + payCents;
      evidence.paidTotal = offlineMoney(total); promoted = total >= threshold;
    }
  }
  return { now: source.now, memberActive, bonus, rate, reward: Number(reward), promoted, evidence };
}

export async function writeOfflineRewardEffectsTx(tx: DbClient, context: OfflineOrderPaymentContext,
  policy: Awaited<ReturnType<typeof readOfflinePaymentPolicy>>, integralAfter: number) {
  const { order, admission } = context;
  let integralBillId: number | null = null, savingsId: number | null = null;
  if (policy.reward > 0) {
    const [bill] = await tx.insert(userBill).values({ uid: order.uid, linkId: order.orderId, pm: 1, category: 'integral',
      type: 'gain', eventKey: 'offline_order_give_integral', title: '下单赠送积分', number: String(policy.reward),
      balance: String(integralAfter), mark: `下单赠送${policy.reward}积分`, status: 1, addTime: policy.now }).returning({ id: userBill.id });
    integralBillId = bill.id;
  }
  if (admission.discountPercent > 0) {
    const [saving] = await tx.insert(storeOrderEconomize).values({ uid: order.uid, orderId: order.orderId, orderType: 2,
      payPrice: order.payPrice, offlinePrice: offlineMoney(offlineAmountCents(admission.rawPrice) - offlineAmountCents(order.payPrice)),
      addTime: policy.now }).returning({ id: storeOrderEconomize.id });
    savingsId = saving.id;
  }
  return { integralBillId, savingsId };
}
