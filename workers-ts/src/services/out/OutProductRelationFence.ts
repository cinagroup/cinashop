import { and, asc, eq, getTableColumns, notInArray, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeProduct, storeProductRelation } from '@/models/schema';
import { ServiceUnavailableException, ValidateException } from '@/utils/errors';

const columns = { ...getTableColumns(storeProductRelation), rowVersion: sql<string>`xmin::text` };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
type Product = typeof storeProduct.$inferSelect;
type PreservedProduct = Partial<Pick<Product, 'brandId' | 'brandCom' | 'ensureId' | 'storeLabelId' | 'labelId' | 'specsId' | 'specs'>>;
export interface OutProductRelationFence {
  productId: number;
  productType: 0 | 1 | 3 | 4;
  ownedTypes: readonly number[];
  rows: Awaited<ReturnType<typeof protectedRows>>;
  preservedProduct: PreservedProduct;
}
async function protectedRows(tx: DbClient, productId: number, ownedTypes: readonly number[]) {
  const rows = await tx.select(columns).from(storeProductRelation).where(and(
    eq(storeProductRelation.productId, productId), notInArray(storeProductRelation.type, [...ownedTypes]),
  )).orderBy(asc(storeProductRelation.id)).limit(2001).for('share', { noWait: true });
  if (rows.length > 2000) throw new ServiceUnavailableException('商品历史关联过多，请先核对');
  return rows;
}
/** ownedTypes comes only from the coordinator's explicit field presence. */
export async function captureOutProductRelationFence(tx: DbClient, product: Product | undefined,
  ownedTypes: readonly number[], productType: 0 | 1 | 3 | 4): Promise<OutProductRelationFence> {
  return { productId: product?.id ?? 0, productType, ownedTypes: [...ownedTypes],
    rows: product ? await protectedRows(tx, product.id, ownedTypes) : [],
    preservedProduct: product ? {
      ...(ownedTypes.includes(2) ? {} : { brandId: product.brandId, brandCom: product.brandCom }),
      ...(ownedTypes.includes(5) ? {} : { ensureId: product.ensureId }),
      ...(ownedTypes.includes(3) ? {} : { storeLabelId: product.storeLabelId }),
      ...(ownedTypes.includes(4) ? {} : { labelId: product.labelId }),
      ...(ownedTypes.includes(6) ? {} : { specsId: product.specsId, specs: product.specs }),
    } : {},
  };
}
export async function assertOutProductRelationFence(tx: DbClient, fence: OutProductRelationFence) {
  const [product] = await tx.select({ productType: storeProduct.productType, brandId: storeProduct.brandId, brandCom: storeProduct.brandCom,
    ensureId: storeProduct.ensureId, storeLabelId: storeProduct.storeLabelId, labelId: storeProduct.labelId,
    specsId: storeProduct.specsId, specs: storeProduct.specs })
    .from(storeProduct).where(eq(storeProduct.id, fence.productId)).limit(1);
  if (!product || product.productType !== fence.productType || Object.entries(fence.preservedProduct).some(([key, value]) => product[key as keyof typeof product] !== value)
    || !same(await protectedRows(tx, fence.productId, fence.ownedTypes), fence.rows)) {
    throw new ValidateException('平台商品历史关联已变化');
  }
}
