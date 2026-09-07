import { and, desc, eq, lt } from "drizzle-orm";
import type { Container } from "@/lib/di";
import { storeCouponIssue, storeCouponUser, storeProduct } from "@/models/schema";
import { ValidateException } from "@/utils/errors";
import { prepareCouponScope } from "./OrderCouponService";
import { calculateCouponEligibleSubtotalCents, parseCouponScopeIds, reconcileCouponProductScopeIds } from "./ProductCouponService";
import { projectOwnedCoupon } from "./UserCouponWalletService";

export function couponScopeProductsQuery(id: string | undefined, query: Record<string, string | undefined>) {
  const integer = (value: string | undefined, fallback: number, min: number, max: number) => {
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(value)) throw new ValidateException("优惠券商品查询参数无效");
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < min || result > max) throw new ValidateException("优惠券商品查询参数无效");
    return result;
  };
  const couponId = integer(id, 0, 1, Number.MAX_SAFE_INTEGER);
  if (!couponId || query.page !== undefined) throw new ValidateException("优惠券商品请使用券ID及limit/before分页");
  return { couponId, limit: integer(query.limit, 20, 1, 100), before: integer(query.before, 0, 0, Number.MAX_SAFE_INTEGER) };
}

/** Scope membership only: never a spendable quote, reservation or auto-applied coupon. */
export class CouponScopeProductsService {
  constructor(private readonly container: Container) {}

  async list(uid: number, query: ReturnType<typeof couponScopeProductsQuery>) {
    if (!Number.isSafeInteger(uid) || uid <= 0) throw new ValidateException("请先登录");
    // Validate internal callers too, before constructing a query or reading private state.
    const input = couponScopeProductsQuery(String(query.couponId), { limit: String(query.limit), before: String(query.before) });
    const [owned] = await this.container.db.select({ coupon: storeCouponUser, issue: storeCouponIssue })
      .from(storeCouponUser).leftJoin(storeCouponIssue, eq(storeCouponIssue.id, storeCouponUser.issueCouponId))
      .where(and(eq(storeCouponUser.uid, uid), eq(storeCouponUser.id, input.couponId))).limit(1);
    if (!owned) throw new ValidateException("优惠券不存在");
    if (!owned.issue || projectOwnedCoupon(owned.coupon, owned.issue).availability !== "available") {
      throw new ValidateException("优惠券当前不可用，请刷新钱包");
    }
    const current = await this.container.userDao.findForAuth(uid);
    if (!current) throw new ValidateException("请先登录");
    const where = [eq(storeProduct.isShow, 1), eq(storeProduct.isDel, 0), eq(storeProduct.isVerify, 1)];
    // Match the existing public catalogue's membership visibility, including sold-out products.
    if (!current.isMoneyLevel) where.push(eq(storeProduct.isVipProduct, 0));
    if (input.before) where.push(lt(storeProduct.id, input.before));
    const rows = await this.container.db.select({ id: storeProduct.id, pid: storeProduct.pid, cateId: storeProduct.cateId,
      brandId: storeProduct.brandId, store_name: storeProduct.storeName, image: storeProduct.image, price: storeProduct.price })
      .from(storeProduct).where(and(...where)).orderBy(desc(storeProduct.id)).limit(input.limit + 1);
    const candidates = rows.slice(0, input.limit), issue = owned.issue;
    // Reuse precisely the checkout hierarchy and conflicting-representation rules, not a second SQL parser.
    const scope = await prepareCouponScope(this.container, candidates.map(product => ({ product,
      cart: { cartNum: 1 }, unitPriceCents: 1 })), [issue]);
    const definition = { scopeType: issue.couponType,
      productIds: reconcileCouponProductScopeIds([issue.legacyProductIds, issue.productId], scope.related.get(issue.id) ?? []),
      categoryIds: parseCouponScopeIds(issue.legacyCategoryId, issue.category_id),
      brandIds: parseCouponScopeIds(issue.legacyBrandId, issue.brandId) };
    const list = candidates.flatMap((product, index) => calculateCouponEligibleSubtotalCents({ ...definition, items: [scope.items[index]!] }) > 0
      ? [{ id: product.id, store_name: product.store_name, image: product.image, catalog_price: product.price }] : []);
    return { coupon_id: owned.coupon.id, coupon_title: owned.coupon.couponTitle, scope_type: issue.couponType,
      scope_only: true as const, list,
      // Empty filtered pages can still continue. The cursor is the last SCANNED visible catalogue row.
      next_cursor: rows.length > input.limit ? candidates[candidates.length - 1]!.id : null };
  }
}
