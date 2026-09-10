import { eq } from 'drizzle-orm';
import { storeCouponIssue, storeCouponProduct } from '@/models/schema';
import { ValidateException } from '@/utils/errors';
import { parseCouponScopeIds, reconcileCouponProductScopeIds, type CouponScopeItem } from '@/services/activity/ProductCouponService';
import { lockCheckoutCouponRelationProtocol, type CouponAuthorityTransaction } from './CheckoutCouponRelationsAuthority';
import { assertCheckoutCouponItems } from './CheckoutCouponItemAuthority';

type Template = Pick<typeof storeCouponIssue.$inferSelect,
  'id' | 'type' | 'couponType' | 'legacyProductIds' | 'productId' | 'legacyCategoryId' | 'category_id' | 'legacyBrandId' | 'brandId'>;

/** Internal creation dependency, not a new customer receipt field. Product-coupon
 * relations are re-read under the validated writer protocol and parent lock.
 * Actual coupon resolution also supplies the original item/reference dependencies.
 */
export function couponTemplateSnapshot(template: Template, relatedProducts: readonly number[], items: readonly CouponScopeItem[] | null = null) {
  const ids = template.couponType === 2
    ? reconcileCouponProductScopeIds([template.legacyProductIds, template.productId], relatedProducts)
    : template.couponType === 1 ? parseCouponScopeIds(template.legacyCategoryId, template.category_id)
    : template.couponType === 3 ? parseCouponScopeIds(template.legacyBrandId, template.brandId) : [];
  return { id: template.id, discountType: template.type, scopeType: template.couponType,
    scopeIds: [...new Set(ids)].sort((a, b) => a - b), relatedProducts: [...relatedProducts],
    items: items?.map(item => ({ ...item, categoryIds: [...item.categoryIds], categoryAncestorIds: [...item.categoryAncestorIds],
      brandAncestorIds: [...item.brandAncestorIds] })) ?? null };
}
export type CouponTemplateSnapshot = ReturnType<typeof couponTemplateSnapshot>;

/** One SHARE NOWAIT row lock after reservation, held through commit. Never wait
 * in reverse order behind a template editor that might need our inventory/user.
 * Only fields used by owned-coupon evaluation count; claim windows/counters,
 * display metadata and unused scope aliases are deliberately not frozen facts.
 */
export async function assertCheckoutCouponTemplate(
  tx: CouponAuthorityTransaction, expected: CouponTemplateSnapshot,
) {
  if (tx.$client) throw new Error('Coupon template authority requires the owning transaction');
  try {
    if (expected.scopeType === 2) await lockCheckoutCouponRelationProtocol(tx);
    const [row] = await tx.select({ id: storeCouponIssue.id, type: storeCouponIssue.type, couponType: storeCouponIssue.couponType,
      legacyProductIds: storeCouponIssue.legacyProductIds, productId: storeCouponIssue.productId,
      legacyCategoryId: storeCouponIssue.legacyCategoryId, category_id: storeCouponIssue.category_id,
      legacyBrandId: storeCouponIssue.legacyBrandId, brandId: storeCouponIssue.brandId })
      .from(storeCouponIssue).where(eq(storeCouponIssue.id, expected.id)).limit(1).for('share', { noWait: true });
    if (!row) throw new ValidateException('优惠券模板已删除，请重新确认');
    // Do not combine this SELECT with the parent lock: READ COMMITTED must take
    // a fresh statement snapshot after the parent is held. Later relation writers
    // cannot commit until this transaction releases that parent SHARE lock.
    let related = expected.relatedProducts;
    if (expected.scopeType === 2) {
      const relations = await tx.select({ productId: storeCouponProduct.productId }).from(storeCouponProduct)
        .where(eq(storeCouponProduct.couponId, expected.id)).orderBy(storeCouponProduct.productId).limit(20001);
      if (relations.length > 20000) throw new ValidateException('优惠券商品范围过大，请重新确认');
      related = relations.map(relation => relation.productId);
    }
    const current = couponTemplateSnapshot(row, related);
    if (current.discountType !== expected.discountType || current.scopeType !== expected.scopeType
      || current.scopeIds.length !== expected.scopeIds.length
      || current.scopeIds.some((id, index) => id !== expected.scopeIds[index])) {
      throw new ValidateException('优惠券模板规则已变化，请重新确认');
    }
    if (expected.items) await assertCheckoutCouponItems(tx, expected.items, expected.scopeType);
  } catch (error) {
    let cause: unknown = error;
    for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
      if ('code' in cause && cause.code === '55P03') throw new ValidateException('优惠券模板正在更新，请稍后重新确认');
      if (!('cause' in cause) || cause.cause === cause) break;
      cause = cause.cause;
    }
    throw error;
  }
}
