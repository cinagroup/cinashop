import { and, asc, eq } from "drizzle-orm";
import type { DbClient } from "@/lib/di";
import { storeProductAttrValue } from "@/models/schema";
import { ValidateException } from "@/utils/errors";

export type LegacyActivitySkuType = 1 | 2 | 3;

export interface LegacyActivitySkuPair {
  activitySku: typeof storeProductAttrValue.$inferSelect;
  baseSku: typeof storeProductAttrValue.$inferSelect;
}

/**
 * Resolve the PHP activity-SKU identity to the Worker-owned base-SKU identity.
 *
 * Old clients submit store_product_attr_value(type=1/2/3).unique while newer
 * Worker carts persist the corresponding type=0 unique.  The stable bridge is
 * (activity id, type, suk) -> (base product id, type=0, suk).  Ambiguous legacy
 * rows fail closed instead of silently charging or restoring the wrong SKU.
 */
export async function resolveLegacyActivitySkuPair(
  db: DbClient,
  params: {
    activityId: number;
    productId: number;
    type: LegacyActivitySkuType;
    unique?: string;
    suk?: string;
  },
): Promise<LegacyActivitySkuPair> {
  const unique = String(params.unique ?? "").trim();
  const requestedSuk = String(params.suk ?? "").trim();
  let activityRows: Array<typeof storeProductAttrValue.$inferSelect> = [];
  let baseRows: Array<typeof storeProductAttrValue.$inferSelect> = [];

  if (unique) {
    [activityRows, baseRows] = await Promise.all([
      db
        .select()
        .from(storeProductAttrValue)
        .where(and(
          eq(storeProductAttrValue.productId, params.activityId),
          eq(storeProductAttrValue.type, params.type),
          eq(storeProductAttrValue.unique, unique),
        ))
        .limit(2),
      db
        .select()
        .from(storeProductAttrValue)
        .where(and(
          eq(storeProductAttrValue.productId, params.productId),
          eq(storeProductAttrValue.type, 0),
          eq(storeProductAttrValue.unique, unique),
        ))
        .limit(2),
    ]);
    if (activityRows.length > 1 || baseRows.length > 1) {
      throw new ValidateException("商品规格标识不唯一");
    }
    if (!activityRows[0] && !baseRows[0] && !requestedSuk) {
      throw new ValidateException("商品规格标识无效");
    }
  }

  if (!activityRows[0]) {
    const suk = requestedSuk || baseRows[0]?.suk || "";
    activityRows = await db
      .select()
      .from(storeProductAttrValue)
      .where(and(
        eq(storeProductAttrValue.productId, params.activityId),
        eq(storeProductAttrValue.type, params.type),
        ...(suk ? [eq(storeProductAttrValue.suk, suk)] : []),
      ))
      .orderBy(asc(storeProductAttrValue.id))
      .limit(2);
  }
  if (activityRows.length !== 1) {
    throw new ValidateException(activityRows.length ? "活动商品规格不唯一" : "活动商品规格不存在或已失效");
  }
  const activitySku = activityRows[0];

  if (!baseRows[0] || baseRows[0].suk !== activitySku.suk) {
    baseRows = await db
      .select()
      .from(storeProductAttrValue)
      .where(and(
        eq(storeProductAttrValue.productId, params.productId),
        eq(storeProductAttrValue.type, 0),
        eq(storeProductAttrValue.suk, activitySku.suk),
      ))
      .orderBy(asc(storeProductAttrValue.id))
      .limit(2);
  }
  if (baseRows.length !== 1) {
    throw new ValidateException(baseRows.length ? "基础商品规格不唯一" : "基础商品规格不存在或已失效");
  }

  return { activitySku, baseSku: baseRows[0] };
}
