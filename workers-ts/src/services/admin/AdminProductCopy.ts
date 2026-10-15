import { and, asc, eq } from 'drizzle-orm';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { DbClient } from '@/lib/di';
import { storeProduct, storeProductAttr, storeProductAttrValue, storeProductDescription,
  storeProductCoupon, storeProductRelation, systemStore, systemSupplier } from '@/models/schema';
import { ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { budgetLegacyProductRead } from './AdminLegacyProductReadBudget';
import { productSaveCanonical, productSaveConflict } from './AdminLegacyProductSaveState';

export interface ProductCopyContext { sourceId: number; token: string }
export interface ProductCopyDescriptor {
  source_id: number; token: string; destination: { type: number; relation_id: number };
}
type Product = typeof storeProduct.$inferSelect;
/** Only metadata/SKU configuration is fingerprinted. Card credentials are never
 * selected or returned by the copy protocol. The opaque MAC also covers fixed
 * delivery content without disclosing it to a copy client. */
export function productCopyDescriptor(product: Product, attrs: unknown[], skus: unknown[], descriptions: unknown[],
  coupons: unknown[], labels: unknown[], appKey: string | undefined): ProductCopyDescriptor {
  if (!appKey) throw new ServiceUnavailableException('商品复制签名尚未就绪');
  if (![0, 1, 2].includes(product.type) || !Number.isSafeInteger(product.relationId)
    || (product.type === 0 ? product.relationId !== 0 : product.relationId <= 0 || product.relationId > 2147483647)
    || ![0, 1, 3, 4].includes(product.productType)) throw new ValidateException('来源商品归属或履约类型无效');
  return { source_id: product.id, destination: { type: product.type, relation_id: product.relationId },
    token: createHmac('sha256', appKey).update('cinashop.product-copy.snapshot.v1\0')
      .update(productSaveCanonical({ product, attrs, skus, descriptions, coupons, labels })).digest('hex') };
}
export async function assertProductCopyDestination(tx: DbClient, product: Product): Promise<void> {
  if (product.type === 2) {
    const [supplier] = await tx.select({ id: systemSupplier.id }).from(systemSupplier)
      .where(and(eq(systemSupplier.id, product.relationId), eq(systemSupplier.isDel, 0))).limit(1);
    if (!supplier) throw new ValidateException('复制目标供应商不存在或已删除');
  } else if (product.type === 1) {
    const [store] = await tx.select({ id: systemStore.id }).from(systemStore)
      .where(and(eq(systemStore.id, product.relationId), eq(systemStore.isDel, 0))).limit(1);
    if (!store) throw new ValidateException('复制目标门店不存在或已删除');
  }
}
/** The caller holds the full product-table barrier and supplier/store barriers.
 * Re-read the exact seed inputs inside the actual save transaction; never trust
 * the prior GET, client owner or a client copy-mode flag. */
export async function admitProductCopy(tx: DbClient, context: ProductCopyContext, appKey: string | undefined) {
  const id = context.sourceId;
  await budgetLegacyProductRead(tx, [
    { table: storeProduct, where: eq(storeProduct.id, id) },
    { table: storeProductAttr, where: and(eq(storeProductAttr.productId, id), eq(storeProductAttr.type, 0))! },
    { table: storeProductAttrValue, where: and(eq(storeProductAttrValue.productId, id), eq(storeProductAttrValue.type, 0))! },
    { table: storeProductDescription, where: and(eq(storeProductDescription.productId, id), eq(storeProductDescription.type, 0))! },
    { table: storeProductCoupon, where: eq(storeProductCoupon.productId, id) },
    { table: storeProductRelation, where: and(eq(storeProductRelation.productId, id), eq(storeProductRelation.type, 4))! },
  ]);
  const [product] = await tx.select().from(storeProduct).where(eq(storeProduct.id, id)).limit(1);
  if (!product) throw productSaveConflict('来源商品已删除，请重新选择复制来源');
  const [attrs, skus, descriptions, coupons, labels] = await Promise.all([
    tx.select().from(storeProductAttr).where(and(eq(storeProductAttr.productId, id), eq(storeProductAttr.type, 0))).orderBy(asc(storeProductAttr.id)),
    tx.select().from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId, id), eq(storeProductAttrValue.type, 0))).orderBy(asc(storeProductAttrValue.id)),
    tx.select().from(storeProductDescription).where(and(eq(storeProductDescription.productId, id), eq(storeProductDescription.type, 0))),
    tx.select().from(storeProductCoupon).where(eq(storeProductCoupon.productId, id)).orderBy(asc(storeProductCoupon.id)),
    tx.select().from(storeProductRelation).where(and(eq(storeProductRelation.productId, id), eq(storeProductRelation.type, 4))).orderBy(asc(storeProductRelation.id)),
  ]);
  const descriptor = productCopyDescriptor(product, attrs, skus, descriptions, coupons, labels, appKey);
  if (!/^[a-f0-9]{64}$/.test(context.token)
    || !timingSafeEqual(new TextEncoder().encode(context.token), new TextEncoder().encode(descriptor.token)))
    throw productSaveConflict('来源商品已变化，请保留草稿并重新载入复制来源');
  await assertProductCopyDestination(tx, product);
  return product;
}
