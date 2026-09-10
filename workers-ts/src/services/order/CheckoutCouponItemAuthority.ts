import { inArray, sql } from 'drizzle-orm';
import { storeProduct, storeProductCategory, storeBrand } from '@/models/schema';
import { parseCouponScopeIds, type CouponScopeItem } from '@/services/activity/ProductCouponService';
import { ValidateException } from '@/utils/errors';
import type { CouponAuthorityTransaction } from './CheckoutCouponRelationsAuthority';

/** The existing customer receipt's item projection, not a new pricing rule. */
function facts(items: readonly CouponScopeItem[], scopeType: number) {
  const ordered = (ids: readonly number[]) => [...new Set(ids)].sort((a, b) => a - b);
  return items.map(item => ({ productId: item.productId, parentProductId: item.parentProductId,
    categoryIds: scopeType === 1 ? ordered([...item.categoryIds, ...item.categoryAncestorIds]) : [],
    brandIds: scopeType === 3 ? ordered([item.brandId, ...item.brandAncestorIds]) : [],
    subtotalCents: item.subtotalCents,
  })).sort((a, b) => a.productId - b.productId || a.subtotalCents - b.subtotalCents);
}

/** Called after the original inventory writes and coupon-template guard. Lock
 * current products first, then referenced categories/brands in stable ID order.
 * Missing positive direct references cannot be row-locked: fail closed instead
 * of treating absence as protected against a later INSERT. Ancestor strings are
 * the calculator's authority; it does not recursively read ancestor rows.
 */
export async function assertCheckoutCouponItems(
  tx: CouponAuthorityTransaction, expected: readonly CouponScopeItem[], scopeType: number,
): Promise<void> {
  if (tx.$client || !tx.execute) throw new ValidateException('优惠券商品复核必须位于建单事务内');
  const [settings] = await tx.select({ timeout: sql<string>`pg_catalog.current_setting('lock_timeout')`,
    isolation: sql<string>`pg_catalog.current_setting('transaction_isolation')` })
    .from(sql`(VALUES (1)) AS coupon_item_settings(n)`);
  if (!settings || settings.isolation !== 'read committed') throw new ValidateException('优惠券商品复核需要READ COMMITTED事务');
  // NOWAIT bounds tuple locks, not implicit relation locks. Bound acquisition of
  // ROW SHARE modes too; this uses SELECT plus column UPDATE privileges, without
  // table-wide write grants. Restore on success only; failure aborts the owner.
  await tx.execute(sql`SELECT pg_catalog.set_config('lock_timeout','1ms',true)`);
  const ids = [...new Set(expected.map(item => item.productId))].sort((a, b) => a - b);
  const products = ids.length ? await tx.select({ id: storeProduct.id, pid: storeProduct.pid,
    cateId: storeProduct.cateId, brandId: storeProduct.brandId }).from(storeProduct)
    .where(inArray(storeProduct.id, ids)).orderBy(storeProduct.id).for('share', { noWait: true }) : [];
  if (products.length !== ids.length) throw new ValidateException('优惠券商品已删除，请重新确认');
  const categoryIds = scopeType === 1 ? [...new Set(products.flatMap(row => parseCouponScopeIds(row.cateId)))].sort((a, b) => a - b) : [];
  const brandIds = scopeType === 3 ? [...new Set(products.map(row => row.brandId).filter(id => id > 0))].sort((a, b) => a - b) : [];
  if (categoryIds.length > 10000) throw new ValidateException('商品分类范围过大');
  const categories = categoryIds.length ? await tx.select({ id: storeProductCategory.id,
    pid: storeProductCategory.pid, path: storeProductCategory.path }).from(storeProductCategory)
    .where(inArray(storeProductCategory.id, categoryIds)).orderBy(storeProductCategory.id).for('share', { noWait: true }) : [];
  const brands = brandIds.length ? await tx.select({ id: storeBrand.id, pid: storeBrand.pid, fid: storeBrand.fid })
    .from(storeBrand).where(inArray(storeBrand.id, brandIds)).orderBy(storeBrand.id).for('share', { noWait: true }) : [];
  if (categories.length !== categoryIds.length || brands.length !== brandIds.length) {
    throw new ValidateException('商品分类或品牌引用缺失，请修复后重新确认');
  }
  await tx.execute(sql`SELECT pg_catalog.set_config('lock_timeout',${settings.timeout},true)`);
  const productById = new Map(products.map(row => [row.id, row]));
  const categoryById = new Map(categories.map(row => [row.id, row]));
  const brandById = new Map(brands.map(row => [row.id, row]));
  const current = expected.map(item => {
    const product = productById.get(item.productId)!;
    const direct = parseCouponScopeIds(product.cateId), brand = brandById.get(product.brandId);
    return { ...item, parentProductId: product.pid || product.id, categoryIds: direct,
      categoryAncestorIds: direct.flatMap(id => { const row = categoryById.get(id); return row ? parseCouponScopeIds(row.pid, row.path) : []; }),
      brandId: product.brandId, brandAncestorIds: brand ? parseCouponScopeIds(brand.pid, brand.fid) : [],
    };
  });
  if (JSON.stringify(facts(current, scopeType)) !== JSON.stringify(facts(expected, scopeType))) {
    throw new ValidateException('商品优惠券适用范围已变化，请重新确认');
  }
}
