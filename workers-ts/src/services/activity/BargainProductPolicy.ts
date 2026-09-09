import { eq } from "drizzle-orm";
import type { DbClient } from "@/lib/di";
import { storeBargain, storeProduct } from "@/models/schema";
import { ValidateException } from "@/utils/errors";

/** PHP's save-time product eligibility and derived metadata, not public catalog
 * visibility. Acquire after the activity inventory boundary; never lock a SKU
 * or participant here. SHARE holds the source snapshot through the save, while
 * allowing another activity editor to read the same product concurrently.
 */
export async function lockBargainProductPolicy(tx: DbClient, productId: number): Promise<Partial<typeof storeBargain.$inferInsert>> {
  const [product] = await tx.select({
    isDel: storeProduct.isDel, isVerify: storeProduct.isVerify,
    isVipProduct: storeProduct.isVipProduct, isPresaleProduct: storeProduct.isPresaleProduct,
    type: storeProduct.type, productType: storeProduct.productType, relationId: storeProduct.relationId,
    customForm: storeProduct.customForm, systemFormId: storeProduct.systemFormId,
    storeLabelId: storeProduct.storeLabelId, ensureId: storeProduct.ensureId, specs: storeProduct.specs,
  }).from(storeProduct).where(eq(storeProduct.id, productId)).limit(1).for("share");
  if (!product || product.isDel !== 0 || product.isVerify !== 1) throw new ValidateException("关联商品不存在或不可用");
  if (product.isVipProduct !== 0) throw new ValidateException("SVIP专享商品不能设置砍价活动");
  if (product.isPresaleProduct !== 0) throw new ValidateException("预售商品不能设置砍价活动");
  return {
    type: product.type, productType: product.productType, relationId: product.relationId,
    customForm: product.customForm, systemFormId: product.systemFormId,
    storeLabelId: product.storeLabelId, ensureId: product.ensureId, specs: product.specs,
    ...(product.productType !== 0 ? { deliveryType: "2" } : {}),
    ...([1, 2, 3].includes(product.productType) ? { freight: 2, tempId: 0, postage: "0.00" } : {}),
  };
}
