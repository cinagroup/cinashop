import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeProduct } from '@/models/schema';
import { publicProductPictures, renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { publicOrdinaryProductIdentitySql } from '@/services/product/OrdinaryProductReadData';
import { productRecommendationInput } from '@/services/product/ProductRecommendationInput';
import { HttpApiException } from '@/utils/errors';

/** An editing echo never grants access to a hidden foreign product's media.
 * Keep the source's reference order, duplicates and missing IDs. Public cards
 * independently apply their current visibility, member and sorting policy. */
export async function readSupplierProductRecommendations(tx: DbClient, supplierId: number, stored: string, appKey?: string) {
  let ids: number[] = [], consistent = true;
  try {
    const canonical = productRecommendationInput({ recommend_list: stored ? stored.split(',') : [] })!;
    consistent = canonical === stored;
    if (consistent) ids = canonical ? canonical.split(',').map(Number) : [];
  } catch { consistent = false; }
  const rows = ids.length ? await tx.select({ id: storeProduct.id, image: storeProduct.image,
    type: storeProduct.type, relationId: storeProduct.relationId }).from(storeProduct).where(and(inArray(storeProduct.id, [...new Set(ids)]),
    or(and(eq(storeProduct.type, 2), eq(storeProduct.relationId, supplierId), eq(storeProduct.isDel, 0)), and(publicOrdinaryProductIdentitySql(), eq(storeProduct.isVipProduct, 0))))) : [];
  const pictures = await publicProductPictures(tx, rows.map(row => ({ image: row.image,
    ...(row.type === 1 ? { type: 0, relationId: 0 } : { type: row.type, relationId: row.relationId }) })));
  const signed = await renderProductPictures(appKey, pictures), images = new Map(rows.map((row, index) => [row.id, signed[index]]));
  return { recommendation_selection: { version: 1 as const, ids, consistent },
    recommend_list: ids.map(id => ({ product_id: String(id), image: images.get(id) ?? '' })) };
}

export async function assertSupplierProductRecommendations(tx: DbClient, supplierId: number,
  expected: typeof storeProduct.$inferSelect, recommendList: string) {
  await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
  const [actual] = await tx.select().from(storeProduct).where(eq(storeProduct.id, expected.id));
  if (!actual || actual.type !== 2 || actual.relationId !== supplierId || ![0, 1, 3].includes(actual.productType)
    || actual.isDel !== 0 || actual.isShow !== 0 || actual.isVerify !== 0 || actual.recommendList !== recommendList
    || JSON.stringify(actual) !== JSON.stringify(expected))
    throw new HttpApiException('推荐商品保存核对失败，请刷新后重试', 409, 409);
}
