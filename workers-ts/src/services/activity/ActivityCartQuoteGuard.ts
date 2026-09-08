import { and, sql, type SQL } from "drizzle-orm";
import { storeCart } from "@/models/schema";

/** For single-cart activity checkout: compare the quoted cart at its atomic claim.
 * Ownership/payment/visibility predicates remain in the caller. Metadata such as
 * addTime is not a quote input. Bargain claims also compare durable participation.
 */
export function activityCartQuoteGuard(row: typeof storeCart.$inferSelect): SQL {
  const keys = ["id", "cartNum", "productId", "productAttrUnique", "productType", "activityId", "type", "isNew"] as const;
  return and(...keys.map(key => sql`${storeCart[key]} IS NOT DISTINCT FROM ${row[key]}`),
    row.type === 2 ? sql`${storeCart.bargainUserId} IS NOT DISTINCT FROM ${row.bargainUserId}` : undefined)!;
}
