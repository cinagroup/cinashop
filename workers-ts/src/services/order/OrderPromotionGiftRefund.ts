import { and, asc, eq } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeCouponUser, storeOrder, storeOrderCartInfo, storeOrderOutbox, storeOrderPromotionGiftCouponReward,
  user, userBill } from '@/models/schema';
import { readOrderPromotionGiftIntent } from '@/services/activity/OrderPromotionGiftSnapshot';
import { ValidateException } from '@/utils/errors';
import { amountToCents } from '@/services/payment/RefundGateway';

type Order = typeof storeOrder.$inferSelect;
type Cart = typeof storeOrderCartInfo.$inferSelect;
const invalid = () => new ValidateException('满送退款权益与原订单证据不一致，请先核对订单');
const partial = () => new ValidateException('满送订单的部分退款、拆单或已发货权益归属尚未完成适配');
const grantEvent = 'order_promotions_give_integral';
const reversalEvent = 'order_promotions_integral_refund';

/** Owning transaction already holds the source order and all cart rows. This
 * adapter admits one exact undelivered original order only. Paid coupons and
 * purchase labels remain granted, as in PHP; no pool is returned after payment.
 * Whole physical gift quantities must be part of the immutable refund claim. */
export async function assertFullGiftRefundAdmission(tx: DbClient, order: Order,
  rows: readonly Cart[], selections: ReadonlyMap<string, number>, refundAmount: string,
  atomic: boolean): Promise<boolean> {
  const intent = readOrderPromotionGiftIntent(order.promotionsGive);
  if (!intent) return false;
  if (!atomic) throw new ValidateException('满送订单暂不支持从当前售后入口退款，请联系商家处理');
  if (order.pid !== 0 || order.type !== 0 || order.status !== 0 || order.paid !== 1
    || order.uid <= 0 || order.refundPrice !== '0.00' || order.backIntegral !== '0.00'
    || rows.length === 0 || rows.length > 100 || selections.size !== rows.length
    || rows.some(row => selections.get(row.cartId) !== row.cartNum)
    || amountToCents(refundAmount) !== amountToCents(order.payPrice)
    || (amountToCents(refundAmount) ?? 0) <= 0) throw partial();
  if (rows.some(row => row.oid !== order.id || row.uid !== order.uid
    || ![0, 1].includes(row.isGift) || row.cartNum <= 0)
    || rows.reduce((sum, row) => sum + row.cartNum, 0) !== order.totalNum) throw invalid();
  const byCart = new Map(rows.map(row => [row.cartId, row]));
  if (byCart.size !== rows.length) throw invalid();
  const expectedGifts = new Map<string, { productId: number; skuId: number; unique: string; quantity: number }>();
  const expectedCoupons = new Map<number, { rootId: number; tierId: number; issueId: number }>();
  let integral = 0;
  for (const promotion of intent.promotions) {
    integral += promotion.give_integral;
    if (!Number.isSafeInteger(integral) || promotion.eligible_cart_ids.some(id => !byCart.has(id) || byCart.get(id)!.isGift !== 0)) throw invalid();
    for (const gift of promotion.products) {
      const previous = expectedGifts.get(gift.cart_id);
      if (previous && (previous.productId !== gift.product_id || previous.skuId !== gift.sku_id || previous.unique !== gift.unique)) throw invalid();
      expectedGifts.set(gift.cart_id, { productId: gift.product_id, skuId: gift.sku_id,
        unique: gift.unique, quantity: (previous?.quantity ?? 0) + gift.quantity });
    }
    for (const coupon of promotion.coupons) {
      if (expectedCoupons.has(coupon.aux_id)) throw invalid();
      expectedCoupons.set(coupon.aux_id, { rootId: promotion.id, tierId: promotion.tier_id, issueId: coupon.issue_id });
    }
  }
  if (integral !== order.giveIntegral || rows.filter(row => row.isGift === 1).length !== expectedGifts.size) throw invalid();
  const issueIds=[...new Set([...expectedCoupons.values()].map(coupon=>coupon.issueId))].sort((a,b)=>a-b);
  const stored=order.giveCoupon??'';
  if ((issueIds.length===0 && stored!=='') || (issueIds.length>0 && !/^[1-9]\d*(?:,[1-9]\d*)*$/.test(stored))) throw invalid();
  const storedIds=stored===''?[]:stored.split(',').map(Number);
  if(storedIds.some(id=>!Number.isSafeInteger(id) || id>2_147_483_647)
    || new Set(storedIds).size!==storedIds.length
    || JSON.stringify([...storedIds].sort((a,b)=>a-b))!==JSON.stringify(issueIds))throw invalid();
  for (const [cartId, expected] of expectedGifts) {
    const row = byCart.get(cartId);
    if (!row || row.isGift !== 1 || row.productId !== expected.productId
      || row.skuUnique !== expected.unique || row.cartNum !== expected.quantity || !row.cartInfo) throw invalid();
    let snapshot: unknown;
    try { snapshot = JSON.parse(row.cartInfo); } catch { throw invalid(); }
    const sku = (snapshot as { sku?: { id?: unknown } })?.sku;
    if (sku?.id !== expected.skuId) throw invalid();
  }
  const receipts = await tx.select().from(storeOrderPromotionGiftCouponReward)
    .where(eq(storeOrderPromotionGiftCouponReward.orderId, order.id))
    .orderBy(asc(storeOrderPromotionGiftCouponReward.id)).limit(601);
  if (receipts.length !== expectedCoupons.size) {
    throw new ValidateException('满送付款赠券尚未完成或归属不一致，请先核对付款后置任务');
  }
  const seen = new Set<number>();
  for (const receipt of receipts) {
    const expected = expectedCoupons.get(receipt.auxiliaryId);
    if (!expected || seen.has(receipt.auxiliaryId) || receipt.uid !== order.uid
      || receipt.rootId !== expected.rootId || receipt.tierId !== expected.tierId
      || receipt.issueCouponId !== expected.issueId) throw invalid();
    seen.add(receipt.auxiliaryId);
    const [coupon] = await tx.select({ uid: storeCouponUser.uid, issueId: storeCouponUser.issueCouponId })
      .from(storeCouponUser).where(eq(storeCouponUser.id, receipt.couponUserId)).limit(1);
    if (!coupon || coupon.uid !== order.uid || coupon.issueId !== expected.issueId) throw invalid();
  }
  const grants = await tx.select({ number: userBill.number }).from(userBill).where(and(
    eq(userBill.uid, order.uid), eq(userBill.linkId, String(order.id)), eq(userBill.category, 'integral'),
    eq(userBill.eventKey, grantEvent), eq(userBill.pm, 1), eq(userBill.status, 1),
  )).limit(2);
  if ((integral > 0 && (grants.length !== 1 || !/^(?:0|[1-9]\d*)(?:\.00)?$/.test(grants[0].number)
      || Number(grants[0].number) !== integral))
    || (integral === 0 && grants.length)) {
    throw new ValidateException('满送付款赠积分尚未完成或归属不一致，请先核对付款后置任务');
  }
  // The paid worker locks outbox -> order. Read its monotone terminal state
  // without a late outbox row lock while this transaction owns the order.
  // Empty coupon/point sets are not proof that physical-only paid effects ran.
  const events = await tx.select({ aggregateType: storeOrderOutbox.aggregateType,
    aggregateId: storeOrderOutbox.aggregateId, eventType: storeOrderOutbox.eventType,
    payload: storeOrderOutbox.payload, status: storeOrderOutbox.status })
    .from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey, `order.paid:${order.id}`)).limit(2);
  const event = events[0], payload = event?.payload;
  if (events.length !== 1 || event.aggregateType !== 'order' || event.aggregateId !== order.id
    || event.eventType !== 'order.paid' || event.status !== 'COMPLETED'
    || !payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).length !== 2 || !('orderId' in payload) || !('orderNo' in payload)
    || payload.orderId !== order.id || payload.orderNo !== order.orderId) {
    throw new ValidateException('满送付款后置任务尚未完成或订单归属不一致，请稍后重试');
  }
  return true;
}

/** Called after whole-refund admission and before committing refund money.
 * The refund/order transition owns replay; one independent source event keeps
 * receipt rewards and their line-compensation fractions unchanged. */
export async function reverseWholeOrderPromotionGiftPoints(tx: DbClient, order: Order, now: number): Promise<void> {
  const intent = readOrderPromotionGiftIntent(order.promotionsGive);
  if (!intent) return;
  const points = intent.promotions.reduce((sum, promotion) => sum + promotion.give_integral, 0);
  if (!points) return;
  if (order.pid !== 0 || order.status !== 0 || points !== order.giveIntegral) throw invalid();
  const previous = await tx.select({ id: userBill.id }).from(userBill).where(and(
    eq(userBill.uid, order.uid), eq(userBill.linkId, String(order.id)), eq(userBill.category, 'integral'),
    eq(userBill.eventKey, reversalEvent), eq(userBill.pm, 0), eq(userBill.status, 1),
  )).limit(1);
  if (previous.length) throw invalid();
  const [account] = await tx.select({ uid: user.uid, integral: user.integral }).from(user)
    .where(eq(user.uid, order.uid)).limit(1).for('update');
  if (!account || !Number.isSafeInteger(account.integral) || account.integral < 0) throw invalid();
  const recovered = Math.min(points, account.integral);
  await tx.update(user).set({ integral: account.integral - recovered }).where(eq(user.uid, order.uid));
  await tx.insert(userBill).values({ uid: order.uid, linkId: String(order.id), pm: 0,
    title: '满送赠积分回退', category: 'integral', type: 'deduction', eventKey: reversalEvent,
    number: String(recovered), balance: String(account.integral - recovered), status: 1, addTime: now,
    mark: `订单 ${order.orderId} 整单退款，满送原赠 ${points} 积分，实际收回 ${recovered} 积分` });
}
