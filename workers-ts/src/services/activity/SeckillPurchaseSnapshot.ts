import { and, eq, sql, type SQL } from "drizzle-orm";
import { storeCart, storeProduct, storeProductAttrValue, storeSeckill } from "@/models/schema";

/** Compare pricing inputs at the existing write/lock boundary, not in another unlocked read.
 * A mismatch rolls back the caller's entire transaction and requires a fresh confirmation.
 * Stock/quota/sales are deliberately excluded: existing atomic inventory predicates govern them.
 * These guards do not freeze shared shipping/configuration tables or solve cross-path lock order.
 */
export function seckillRuleQuoteGuard(row: typeof storeSeckill.$inferSelect): SQL {
  const keys = ["activityId", "productId", "onceNum", "num", "freight", "postage", "tempId",
    "giveIntegral", "systemFormId", "storeName", "image"] as const;
  return and(...keys.map(key => sql`${storeSeckill[key]} IS NOT DISTINCT FROM ${row[key]}`))!;
}

export function seckillSkuQuoteGuard(row: typeof storeProductAttrValue.$inferSelect, base = false): SQL {
  const keys = ["productId", "type", "unique", "suk", "price", "cost", "settlePrice", "integral", "image"] as const;
  const baseKeys = ["weight", "volume", "writeTimes", "writeValid", "writeDays", "writeStart", "writeEnd", "diskInfo"] as const;
  return and(eq(storeProductAttrValue.isRetired, 0),
    ...keys.map(key => sql`${storeProductAttrValue[key]} IS NOT DISTINCT FROM ${row[key]}`),
    ...(base ? baseKeys.map(key => sql`${storeProductAttrValue[key]} IS NOT DISTINCT FROM ${row[key]}`) : []))!;
}

export function seckillCartQuoteGuard(row: typeof storeCart.$inferSelect): SQL {
  const keys = ["id", "cartNum", "productId", "productAttrUnique", "productType", "activityId", "type", "isNew"] as const;
  return and(...keys.map(key => sql`${storeCart[key]} IS NOT DISTINCT FROM ${row[key]}`))!;
}

export function seckillProductQuoteGuard(row: typeof storeProduct.$inferSelect): SQL {
  const keys = ["type", "relationId", "merId", "productType", "isVipProduct", "isSupportRefund", "settlePrice"] as const;
  return and(eq(storeProduct.isShow, 1), eq(storeProduct.isDel, 0), eq(storeProduct.isVerify, 1),
    ...keys.map(key => sql`${storeProduct[key]} IS NOT DISTINCT FROM ${row[key]}`))!;
}
