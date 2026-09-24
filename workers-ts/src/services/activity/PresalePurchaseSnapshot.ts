import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeCart, storeProduct, storeProductAttrValue, user } from '@/models/schema';
import { ValidateException } from '@/utils/errors';
import { presaleSchedule } from './PresaleScheduleService';
import { assertPresalePurchaseLimit, presalePurchaseLimits } from './PresalePurchaseLimits';

type Product = typeof storeProduct.$inferSelect;
type Cart = typeof storeCart.$inferSelect;
type Sku = typeof storeProductAttrValue.$inferSelect;
type Account = Pick<typeof user.$inferSelect, 'uid' | 'status' | 'isDel' | 'isEverLevel' | 'isMoneyLevel' | 'overdueTime'>;

/** Immutable terms, not a reservation, client input, or current product lookup.
 * Purchase includes the entire end second. PHP manual delivery permits dispatch
 * from the start of that second; shippingDaysAfterEnd is a promise, not a delay gate.
 */
export interface PresalePurchaseSnapshot {
  version: 'presale-full-payment-v1';
  productId: number;
  startsAt: number;
  endsAt: number;
  shippingDaysAfterEnd: number;
  paidMemberOnly: boolean;
  perOrderLimit: number | null;
}

export function preparePresalePurchase(cart: Cart, product: Product, sku: Sku, account: Account | null,
  now = new Date()): PresalePurchaseSnapshot {
  if (!account || account.uid !== cart.uid || account.uid <= 0 || account.status !== 1 || account.isDel !== 0) {
    throw new ValidateException('用户状态已变化，请重新登录');
  }
  if (cart.type !== 6 || cart.isNew !== 1 || cart.activityId !== 0 || cart.bargainUserId !== 0 || cart.staffId !== 0 ||
    cart.touristUid !== '' || cart.storeId !== 0 || cart.productId !== product.id || cart.productType !== product.productType ||
    !Number.isSafeInteger(cart.cartNum) || cart.cartNum < 1 || cart.cartNum > 32767) {
    throw new ValidateException('预售商品请重新选择立即购买');
  }
  if (product.isShow !== 1 || product.isDel !== 0 || product.isVerify !== 1 ||
    sku.productId !== product.id || sku.type !== 0 || sku.isRetired !== 0 || sku.unique !== cart.productAttrUnique ||
    !sku.unique || sku.unique.length > 8 || /[\s\x00-\x1f\x7f]/.test(sku.unique)) {
    throw new ValidateException('预售商品或规格已失效');
  }
  const schedule = presaleSchedule(product, now);
  if (schedule.state !== 'active') throw new ValidateException(schedule.state === 'future' ? '预售活动未开始' : '预售活动已结束');
  if (cart.cartNum > product.stock || cart.cartNum > sku.stock) throw new ValidateException('预售商品库存不足');
  if (![0, 1].includes(product.isVipProduct) || (product.isVipProduct === 1 &&
    !(account.isEverLevel === 1 || (account.isMoneyLevel > 0 && now.getTime() < account.overdueTime * 1000)))) {
    throw new ValidateException('该预售商品仅限有效付费会员购买');
  }
  const limits = presalePurchaseLimits(product);
  assertPresalePurchaseLimit(limits, cart.cartNum);
  const perOrderLimit = limits.mode === 'per_order' ? limits.quantity : null;
  return { version: 'presale-full-payment-v1', productId: product.id, startsAt: schedule.start_time,
    endsAt: schedule.stop_time, shippingDaysAfterEnd: schedule.shipping_days_after_end,
    paidMemberOnly: product.isVipProduct === 1, perOrderLimit };
}

/** Compare the quoted terms in the inventory UPDATE itself (also after a wait).
 * That row lock protects them through commit. Stock remains an atomic predicate.
 */
export function presaleProductQuoteGuard(product: Product): SQL {
  const keys = ['type', 'relationId', 'merId', 'productType', 'isVipProduct', 'isSupportRefund', 'settlePrice',
    'systemFormId', 'deliveryType', 'presaleStartTime', 'presaleEndTime', 'presaleDay', 'isLimit'] as const;
  return and(eq(storeProduct.isPresaleProduct, 1), eq(storeProduct.isShow, 1), eq(storeProduct.isDel, 0), eq(storeProduct.isVerify, 1),
    ...keys.map(key => sql`${storeProduct[key]} IS NOT DISTINCT FROM ${product[key]}`),
    product.isLimit === 1 ? and(eq(storeProduct.limitType, product.limitType), eq(storeProduct.limitNum, product.limitNum)) : undefined)!;
}

export function presaleSkuQuoteGuard(sku: Sku, productType: number): SQL | undefined {
  if (productType === 1) return sql`${storeProductAttrValue.diskInfo} IS NOT DISTINCT FROM ${sku.diskInfo}`;
  if (productType !== 4) return undefined;
  const keys = ['writeTimes', 'writeValid', 'writeDays', 'writeStart', 'writeEnd'] as const;
  return and(...keys.map(key => sql`${storeProductAttrValue[key]} IS NOT DISTINCT FROM ${sku[key]}`));
}

/** Final principal check after writes. NOWAIT avoids a reverse user->SKU lock
 * edge. Return only protected bounds for the caller's LAST database clock check.
 * Product membership gating is independent of global membership pricing switches.
 */
export async function protectPresalePrincipal(tx: DbClient, uid: number, snapshot: PresalePurchaseSnapshot): Promise<SQL> {
  try {
    const [account] = await tx.select({ isEverLevel: user.isEverLevel, isMoneyLevel: user.isMoneyLevel, overdueTime: user.overdueTime })
      .from(user).where(and(eq(user.uid, uid), eq(user.status, 1), eq(user.isDel, 0))).limit(1).for('share', { noWait: true });
    if (!account) throw new ValidateException('用户状态已变化，请重新登录');
    return and(sql`clock_timestamp() >= to_timestamp(${snapshot.startsAt})`,
      sql`clock_timestamp() < to_timestamp(${snapshot.endsAt + 1})`,
      snapshot.paidMemberOnly ? sql`(${account.isEverLevel} = 1 OR (${account.isMoneyLevel} > 0 AND clock_timestamp() < to_timestamp(${account.overdueTime})))` : undefined)!;
  } catch (error) {
    let cause: unknown = error;
    for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
      if ('code' in cause && cause.code === '55P03') throw new ValidateException('预售购买资格正在更新，请稍后重试');
      if (!('cause' in cause) || cause.cause === cause) break;
      cause = cause.cause;
    }
    throw error;
  }
}
