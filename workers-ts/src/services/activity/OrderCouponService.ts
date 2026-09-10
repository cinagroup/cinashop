import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { Container } from "@/lib/di";
import { storeBrand, storeCouponIssue, storeCouponProduct, storeCouponUser, storeProductCategory } from "@/models/schema";
import { ValidateException } from "@/utils/errors";
import { decimalToCents } from "@/services/order/OrderBrokerageService";
import { calculateCouponDiscountCents, calculateCouponEligibleSubtotalCents, parseCouponScopeIds, reconcileCouponProductScopeIds, type CouponScopeItem } from "./ProductCouponService";
import { projectOwnedCoupon } from "./UserCouponWalletService";
import { couponTemplateSnapshot } from '@/services/order/CheckoutCouponTemplateAuthority';

type Coupon = typeof storeCouponUser.$inferSelect;
type Issue = typeof storeCouponIssue.$inferSelect;
export interface PricedCouponItem {
  cart: { cartNum: number };
  product: { id: number; pid: number; cateId: string; brandId: number };
  unitPriceCents: number;
}
export interface OrderCouponQuery { limit: number; before: number; unpaged: boolean }
export type OrderCouponPage = Awaited<ReturnType<typeof eligibleOrderCoupons>>;

/** One batch of scope metadata, reused by every coupon. No per-coupon pricing or global request state. */
export async function prepareCouponScope(container: Container, orderItems: readonly PricedCouponItem[], issues: readonly Issue[]) {
  const productIssueIds = [...new Set(issues.filter((issue) => issue.couponType === 2).map((issue) => issue.id))];
  const categoryIds = issues.some((issue) => issue.couponType === 1)
    ? [...new Set(orderItems.flatMap(({ product }) => parseCouponScopeIds(product.cateId)))] : [];
  const brandIds = issues.some((issue) => issue.couponType === 3)
    ? [...new Set(orderItems.map(({ product }) => product.brandId).filter((id) => id > 0))] : [];
  if (categoryIds.length > 10000) throw new ValidateException("商品分类范围过大");
  const [relations, categories, brands] = await Promise.all([
    productIssueIds.length ? container.db.select({ couponId: storeCouponProduct.couponId, productId: storeCouponProduct.productId })
      .from(storeCouponProduct).where(inArray(storeCouponProduct.couponId, productIssueIds))
      .orderBy(storeCouponProduct.couponId, storeCouponProduct.productId).limit(20001) : [],
    categoryIds.length ? container.db.select({ id: storeProductCategory.id, pid: storeProductCategory.pid, path: storeProductCategory.path })
      .from(storeProductCategory).where(inArray(storeProductCategory.id, categoryIds)) : [],
    brandIds.length ? container.db.select({ id: storeBrand.id, pid: storeBrand.pid, fid: storeBrand.fid })
      .from(storeBrand).where(inArray(storeBrand.id, brandIds)) : [],
  ]);
  if (relations.length > 20000) throw new ValidateException("优惠券商品范围过大，请缩小分页范围");
  const related = new Map<number, number[]>();
  for (const relation of relations) {
    const ids = related.get(relation.couponId) ?? [];
    ids.push(relation.productId); related.set(relation.couponId, ids);
  }
  const categoryById = new Map(categories.map((row) => [row.id, row]));
  const brandById = new Map(brands.map((row) => [row.id, row]));
  const items: CouponScopeItem[] = orderItems.map(({ cart, product, unitPriceCents }) => {
    const direct = parseCouponScopeIds(product.cateId);
    const brand = brandById.get(product.brandId);
    return { productId: product.id, parentProductId: product.pid || product.id, categoryIds: direct,
      categoryAncestorIds: direct.flatMap((id) => { const row = categoryById.get(id); return row ? parseCouponScopeIds(row.pid, row.path) : []; }),
      brandId: product.brandId, brandAncestorIds: brand ? parseCouponScopeIds(brand.pid, brand.fid) : [],
      subtotalCents: unitPriceCents * cart.cartNum };
  });
  return { related, items };
}

function evaluateCoupon(coupon: Coupon, issue: Issue | null, scope: Awaited<ReturnType<typeof prepareCouponScope>>, now: number) {
  if (!issue) throw new ValidateException("优惠券模板不存在，无法校验适用范围");
  if (coupon.status !== 0 || coupon.isFail !== 0) throw new ValidateException("优惠券已使用或已失效");
  if (coupon.startTime && coupon.startTime.getTime() > now) throw new ValidateException("优惠券尚未到可用时间");
  if (coupon.endTime && coupon.endTime.getTime() < now) throw new ValidateException("优惠券已过期");
  if (![0, 1, 2, 3].includes(issue.couponType) || ![1, 2].includes(issue.type)) throw new ValidateException("优惠券类型配置无效");
  const eligibleSubtotalCents = calculateCouponEligibleSubtotalCents({ scopeType: issue.couponType,
    productIds: reconcileCouponProductScopeIds([issue.legacyProductIds, issue.productId], scope.related.get(issue.id) ?? []),
    categoryIds: parseCouponScopeIds(issue.legacyCategoryId, issue.category_id),
    brandIds: parseCouponScopeIds(issue.legacyBrandId, issue.brandId), items: scope.items });
  if (eligibleSubtotalCents <= 0) throw new ValidateException("优惠券不适用于当前商品");
  let minimum: number;
  try { minimum = decimalToCents(coupon.useMinPrice); } catch { throw new ValidateException("优惠券使用门槛配置无效"); }
  if (eligibleSubtotalCents < minimum) throw new ValidateException(`适用商品满 ¥${coupon.useMinPrice} 才能使用该券`);
  return { eligibleSubtotalCents, priceCents: calculateCouponDiscountCents({ discountType: issue.type, couponPrice: coupon.couponPrice, eligibleSubtotalCents }) };
}

/** Authoritative single-coupon resolution shared by quote, create and the order picker. */
export async function resolveOrderCoupon(container: Container, uid: number, couponId: number | undefined, items: readonly PricedCouponItem[]) {
  if (!couponId) return { priceCents: 0, row: null, quoteFacts: null, template: null };
  const rows = await container.db.select({ coupon: storeCouponUser, issue: storeCouponIssue }).from(storeCouponUser)
    .leftJoin(storeCouponIssue, eq(storeCouponIssue.id, storeCouponUser.issueCouponId))
    .where(and(eq(storeCouponUser.id, couponId), eq(storeCouponUser.uid, uid))).limit(1);
  const row = rows[0];
  if (!row) throw new ValidateException("优惠券不存在");
  const scope = await prepareCouponScope(container, items, row.issue ? [row.issue] : []);
  const evaluated = evaluateCoupon(row.coupon, row.issue, scope, Date.now());
  // Bind the rules actually used by evaluateCoupon, not mutable titles/claim counters.
  // Canonical sets avoid invalidation from equivalent legacy scope ordering.
  const issue = row.issue!, coupon = row.coupon;
  const ordered = (ids: number[]) => [...new Set(ids)].sort((a, b) => a - b);
  const quoteFacts = {
    id: coupon.id, uid: coupon.uid, issueId: issue.id, discountType: issue.type, scopeType: issue.couponType,
    valueHundredths: decimalToCents(coupon.couponPrice), minimumCents: decimalToCents(coupon.useMinPrice),
    startsAt: coupon.startTime?.getTime() ?? null, endsAt: coupon.endTime?.getTime() ?? null,
    productIds: issue.couponType === 2 ? ordered(reconcileCouponProductScopeIds([issue.legacyProductIds, issue.productId], scope.related.get(issue.id) ?? [])) : [],
    categoryIds: issue.couponType === 1 ? ordered(parseCouponScopeIds(issue.legacyCategoryId, issue.category_id)) : [],
    brandIds: issue.couponType === 3 ? ordered(parseCouponScopeIds(issue.legacyBrandId, issue.brandId)) : [],
    eligibleSubtotalCents: evaluated.eligibleSubtotalCents,
    items: scope.items.map(item => ({ productId: item.productId, parentProductId: item.parentProductId,
      categoryIds: issue.couponType === 1 ? ordered([...(item.categoryIds ?? []), ...(item.categoryAncestorIds ?? [])]) : [],
      brandIds: issue.couponType === 3 ? ordered([item.brandId ?? 0, ...(item.brandAncestorIds ?? [])]) : [],
      subtotalCents: item.subtotalCents,
    })).sort((a, b) => a.productId - b.productId || a.subtotalCents - b.subtotalCents),
  };
  return { priceCents: evaluated.priceCents, row: coupon, quoteFacts,
    template: couponTemplateSnapshot(issue, scope.related.get(issue.id) ?? [], scope.items) };
}

/** Read-only snapshot, not a reservation. Legacy unpaged callers fail explicitly above 1000 candidates. */
export async function eligibleOrderCoupons(container: Container, uid: number, items: readonly PricedCouponItem[], query: OrderCouponQuery) {
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new ValidateException("请先登录");
  if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > (query.unpaged ? 1000 : 100)
    || !Number.isSafeInteger(query.before) || query.before < 0 || (query.unpaged && query.before !== 0)) throw new ValidateException("优惠券分页参数无效");
  const now = new Date();
  const where = [eq(storeCouponUser.uid, uid), eq(storeCouponUser.status, 0), eq(storeCouponUser.isFail, 0),
    sql`(${storeCouponUser.startTime} IS NULL OR ${storeCouponUser.startTime} <= ${now.toISOString()})`,
    sql`(${storeCouponUser.endTime} IS NULL OR ${storeCouponUser.endTime} >= ${now.toISOString()})`];
  if (query.before) where.push(lt(storeCouponUser.id, query.before));
  const rows = await container.db.select({ coupon: storeCouponUser, issue: storeCouponIssue }).from(storeCouponUser)
    .leftJoin(storeCouponIssue, eq(storeCouponIssue.id, storeCouponUser.issueCouponId))
    .where(and(...where)).orderBy(desc(storeCouponUser.id)).limit(query.limit + 1);
  if (query.unpaged && rows.length > query.limit) throw new ValidateException("优惠券数量超过单次上限，请使用limit/before分页");
  const candidates = rows.slice(0, query.limit);
  const scope = await prepareCouponScope(container, items, candidates.flatMap(({ issue }) => issue ? [issue] : []));
  const list = candidates.flatMap(({ coupon, issue }) => {
    try {
      const value = evaluateCoupon(coupon, issue, scope, now.getTime());
      return [{ ...projectOwnedCoupon(coupon, issue, now), cid: coupon.issueCouponId, title: coupon.couponTitle,
        type: issue!.couponType, estimated_discount: (value.priceCents / 100).toFixed(2),
        eligible_subtotal: (value.eligibleSubtotalCents / 100).toFixed(2) }];
    } catch (error) {
      if (error instanceof ValidateException) return []; // Invalid/inapplicable coupon only; DB/runtime failures still reject the whole request.
      throw error;
    }
  });
  // Cursor tracks the last SCANNED candidate: a page may contain zero eligible coupons and still have a next page.
  return { list, nextCursor: rows.length > query.limit ? candidates[candidates.length - 1]!.coupon.id : null };
}
