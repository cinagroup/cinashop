import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import type { Env } from '@/env';
import { storeBrand, storeCart, storeProduct } from '@/models/schema';
import { integralDetailText } from '@/services/activity/IntegralProductDetailData';
import { publicProductPictures, renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { ValidateException } from '@/utils/errors';
/** One batch for the current product page. Cart quantity is actor-scoped;
 * cards are descriptive, never a substitute for a selected real SKU quote. */
export async function decoratePublicProductCards(tx: DbClient, list: Record<string, unknown>[], uid: number, env: Env) {
  if (!list.length) return list; if (list.length > 100) throw new ValidateException('商品页超过完整读取容量');
  const ids = list.map(row => Number(row.id)), brandIds = [...new Set(list.map(row => Number(row.brand_id)).filter(id => id > 0))];
  const metadata = await tx.select({ id: storeProduct.id, customFormPresent: sql<boolean>`COALESCE(btrim(${storeProduct.customForm}) NOT IN ('','[]','null','{}'),false)` })
    .from(storeProduct).where(inArray(storeProduct.id, ids));
  const blocked = new Set(metadata.filter(row => row.customFormPresent).map(row => row.id));
  const brands = brandIds.length ? await tx.select({ id: storeBrand.id, name: storeBrand.brandName }).from(storeBrand)
    .where(and(inArray(storeBrand.id, brandIds), eq(storeBrand.isShow, 1), eq(storeBrand.isDel, 0))) : [];
  const cart = uid > 0 ? await tx.select({ id: storeCart.productId, quantity: sql<string>`SUM(${storeCart.cartNum})::text` }).from(storeCart)
    .where(and(eq(storeCart.uid, uid), inArray(storeCart.productId, ids), eq(storeCart.type, 0), eq(storeCart.activityId, 0), eq(storeCart.isPay, 0),
      eq(storeCart.isDel, 0), eq(storeCart.isNew, 0), eq(storeCart.status, 1))).groupBy(storeCart.productId) : [];
  if (cart.some(row => !Number.isSafeInteger(Number(row.quantity)) || Number(row.quantity) < 0 || Number(row.quantity) > 2147483647)) throw new ValidateException('购物车数量无效');
  const byBrand = new Map(brands.map(row => [row.id, integralDetailText(row.name, 100)])), quantities = new Map(cart.map(row => [row.id, Number(row.quantity)]));
  const references = await publicProductPictures(tx, list.flatMap(row => {
    const type = Number(row.type) === 1 ? 0 : Number(row.type), relationId = Number(row.type) === 1 ? 0 : Number(row.relation_id);
    return [{ image: row.image, type, relationId }, { image: row.recommend_image, type, relationId }];
  }));
  const images = await renderProductPictures(env?.APP_KEY, references);
  return list.map((row,index) => ({ ...row, image: images[index * 2], recommend_image: images[index * 2 + 1],
    brand_name: byBrand.get(Number(row.brand_id)) ?? '', cart_num: quantities.get(Number(row.id)) ?? 0,
    cart_button: blocked.has(Number(row.id)) ? 0 : row.cart_button }));
}
