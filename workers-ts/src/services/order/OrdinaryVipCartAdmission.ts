import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeProduct, user } from '@/models/schema';
import { ValidateException } from '@/utils/errors';
import { readMembershipPricingPolicy } from '@/services/user/MembershipPricingPolicy';
import { assertCheckoutMembershipSnapshot } from './CheckoutMembershipSnapshot';
import { protectCheckoutPricingSources } from './CheckoutPricingSources';

type Product = Pick<typeof storeProduct.$inferSelect, 'id' | 'isVipProduct' | 'isPresaleProduct' | 'isShow' | 'isDel' | 'isVerify'>;

/** Read-only admission before allocating or updating a cart row. The later
 * transaction fence is still authoritative if membership changes afterward. */
export async function assertOrdinaryVipCandidate(db: DbClient, uid: number, product: Product): Promise<void> {
  if (product.isVipProduct !== 0 && product.isVipProduct !== 1) throw new ValidateException('商品付费会员资格配置无效');
  if (product.isVipProduct === 0) return;
  if (!Number.isSafeInteger(uid) || uid <= 0 || uid > 2_147_483_647) throw new ValidateException('该商品仅限有效付费会员购买');
  if (!(await readMembershipPricingPolicy(db)).paidMemberEnabled) throw new ValidateException('付费会员功能未开放，无法选择专享商品');
  const [account] = await db.select({ eligible: sql<boolean>`${user.isEverLevel} = 1 OR
    (${user.isMoneyLevel} > 0 AND clock_timestamp() < to_timestamp(${user.overdueTime}))` }).from(user)
    .where(and(eq(user.uid, uid), eq(user.status, 1), eq(user.isDel, 0), isNull(user.deleteTime))).limit(1);
  if (!account?.eligible) throw new ValidateException('该商品仅限有效付费会员购买');
}

/** Called after the cart write in its transaction. A NOWAIT product fence
 * avoids the cart->product / product->cart deadlock edge with product editors.
 * The membership and pricing-source fences protect the actual account and
 * global switch through commit; a DB-clock predicate handles expiry after waits. */
export async function protectOrdinaryVipCart(tx: DbClient, uid: number, expected: Product): Promise<void> {
  await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
  try {
    const [current] = await tx.select({ id: storeProduct.id, isVipProduct: storeProduct.isVipProduct,
      isPresaleProduct: storeProduct.isPresaleProduct, isShow: storeProduct.isShow,
      isDel: storeProduct.isDel, isVerify: storeProduct.isVerify }).from(storeProduct)
      .where(eq(storeProduct.id, expected.id)).limit(1).for('share', { noWait: true });
    if (!current || current.isVipProduct !== expected.isVipProduct || current.isPresaleProduct !== 0 ||
        current.isShow !== expected.isShow || current.isDel !== expected.isDel || current.isVerify !== expected.isVerify) {
      throw new ValidateException('商品或会员专属状态已变化，请重新选择');
    }
    if (current.isVipProduct !== 0 && current.isVipProduct !== 1) throw new ValidateException('商品付费会员资格配置无效');
    if (current.isVipProduct === 0) return;
    if (!Number.isSafeInteger(uid) || uid <= 0 || uid > 2_147_483_647) throw new ValidateException('该商品仅限有效付费会员购买');
    const membership = await assertCheckoutMembershipSnapshot(tx, { uid, paidActive: true, levelActive: null, levelId: null, level: null });
    const [account] = await tx.select({ uid: user.uid }).from(user)
      .where(and(eq(user.uid, uid), eq(user.status, 1), eq(user.isDel, 0), isNull(user.deleteTime))).limit(1);
    if (!account || !membership) throw new ValidateException('该商品仅限有效付费会员购买');
    await protectCheckoutPricingSources(tx, '会员资格配置正在更新，请稍后重试');
    if (!(await readMembershipPricingPolicy(tx)).paidMemberEnabled) throw new ValidateException('付费会员功能未开放，无法选择专享商品');
    const [currentMember] = await tx.select({ valid: sql<boolean>`${membership}` }).from(sql`(VALUES (1)) AS vip_cart_clock(n)`);
    if (!currentMember?.valid) throw new ValidateException('该商品仅限有效付费会员购买');
  } catch (error) {
    let cause: unknown = error;
    for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
      if ('code' in cause && cause.code === '55P03') throw new ValidateException('商品或会员资格正在变化，请稍后重试');
      if (!('cause' in cause) || cause.cause === cause) break;
      cause = cause.cause;
    }
    throw error;
  }
}
