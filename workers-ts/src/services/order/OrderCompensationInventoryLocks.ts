import { and, eq } from "drizzle-orm";
import { storeProduct, storeProductAttrValue } from "@/models/schema";
import type { DbClient } from "@/lib/di";
import { HttpApiException } from "@/utils/errors";

export interface CompensationInventoryTarget {
  baseSkuId: number;
  productId: number;
}

function hasPostgresCode(error: unknown, code: string): boolean {
  let cause = error;
  for (let depth = 0; depth < 8 && cause && typeof cause === "object"; depth++) {
    if ("code" in cause && cause.code === code) return true;
    cause = "cause" in cause ? cause.cause : null;
  }
  return false;
}

/**
 * Freeze the complete SKU/product target list before calling this function.
 * Lock in the original line order, matching checkout's SKU -> product order.
 * NOWAIT prevents a historical reverse line order from joining a wait cycle
 * with checkout or another compensation. The caller's transaction must roll
 * back in full on 409 and may then retry the same operation key.
 */
export async function lockOrderCompensationInventory(
  tx: DbClient,
  targets: readonly CompensationInventoryTarget[],
  missing: () => Error,
): Promise<void> {
  const lockedSkus = new Map<number, number>();
  const lockedProducts = new Set<number>();
  try {
    for (const { baseSkuId, productId } of targets) {
      const priorProduct = lockedSkus.get(baseSkuId);
      if (priorProduct !== undefined && priorProduct !== productId) throw missing();
      if (priorProduct === undefined) {
        const [sku] = await tx.select({ id: storeProductAttrValue.id })
          .from(storeProductAttrValue)
          .where(and(eq(storeProductAttrValue.id, baseSkuId),
            eq(storeProductAttrValue.productId, productId), eq(storeProductAttrValue.type, 0)))
          .limit(1).for("update", { noWait: true });
        if (!sku) throw missing();
        lockedSkus.set(baseSkuId, productId);
      }
      if (!lockedProducts.has(productId)) {
        const [product] = await tx.select({ id: storeProduct.id }).from(storeProduct)
          .where(eq(storeProduct.id, productId)).limit(1).for("update", { noWait: true });
        if (!product) throw missing();
        lockedProducts.add(productId);
      }
    }
  } catch (error) {
    if (hasPostgresCode(error, "55P03")) {
      throw new HttpApiException("库存正在变化，请稍后重试", 409, 409);
    }
    throw error;
  }
}