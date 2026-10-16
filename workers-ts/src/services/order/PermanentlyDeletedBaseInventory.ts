import { eq, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeProduct } from '@/models/schema';
import { readSupplierPermanentDeletionFact, type PermanentProductDeletionExpected,
  type PermanentProductDeletionFact } from '@/services/product/PermanentProductDeletionEvidence';
import { HttpApiException, ServiceUnavailableException } from '@/utils/errors';

/** Deliberate physical deletion is different from missing/corrupt inventory.
 * Existing inventory continues through the original compensation path. Only
 * a commissioned immutable Supplier deletion fact can exempt absent base stock;
 * the caller must still restore every retained activity and monetary fact.
 */
export async function readPermanentlyDeletedBaseInventory(tx: DbClient,
  expected: PermanentProductDeletionExpected): Promise<PermanentProductDeletionFact | null> {
  if ((await tx.select({ id: storeProduct.id }).from(storeProduct)
    .where(eq(storeProduct.id, expected.productId)).limit(1)).length) return null;
  // Historical/memory fixtures without this independently commissioned addon
  // retain their original missing-inventory failure. Never install it at runtime.
  const [relations] = await tx.execute(sql`SELECT
    to_regclass('store_product')=to_regclass('public.store_product')
      AND to_regclass('store_product_attr_value')=to_regclass('public.store_product_attr_value')
      AND to_regclass('store_product_sku_retirement_log')=to_regclass('public.store_product_sku_retirement_log')
      AND to_regprocedure('public.guard_product_permanent_delete_log()') IS NOT NULL AS public_targets`);
  if (relations?.public_targets !== true) return null;
  try {
    // Both absence checks and any following stock writes share this physical
    // fence. NOWAIT avoids reversing an already-held order/activity lock chain.
    // The immutable log only needs SELECT; its trigger forbids fact mutation.
    await tx.execute(sql`LOCK TABLE ONLY public.store_product, ONLY public.store_product_attr_value IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
    const [state] = await tx.execute(sql`SELECT
      NOT EXISTS(SELECT 1 FROM ONLY public.store_product WHERE id=${expected.productId})
      AND NOT EXISTS(SELECT 1 FROM ONLY public.store_product_attr_value WHERE product_id=${expected.productId} AND type=0)
      AND (${expected.skuId ?? null}::integer IS NULL OR NOT EXISTS(
        SELECT 1 FROM ONLY public.store_product_attr_value WHERE id=${expected.skuId ?? null}::integer)) AS absent`);
    if (state?.absent !== true) return null;
    return readSupplierPermanentDeletionFact(tx, expected);
  } catch (cause) {
    let error: unknown = cause;
    for (let depth = 0; depth < 8 && error && typeof error === 'object'; depth++) {
      if ('code' in error && String(error.code) === '42501')
        throw Object.assign(new ServiceUnavailableException('商品彻删库存核对权限尚未就绪'), { cause });
      if ('code' in error && ['55P03', '40P01', '40001'].includes(String(error.code)))
        throw Object.assign(new HttpApiException('商品库存正在变化，请稍后核对原订单', 409, 409), { cause });
      error = 'cause' in error ? error.cause : undefined;
    }
    throw cause;
  }
}
