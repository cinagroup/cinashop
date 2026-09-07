import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import type { Container } from "@/lib/di";
import { storeCouponIssue, storeProduct } from "@/models/schema";
import { ValidateException } from "@/utils/errors";
import { prepareCouponScope } from "./OrderCouponService";
import { calculateCouponEligibleSubtotalCents, parseCouponScopeIds, reconcileCouponProductScopeIds } from "./ProductCouponService";

export const couponScopeSorts = ["recommended", "rating", "newest", "price_asc", "price_desc", "sales_asc", "sales_desc"] as const;
type Sort = typeof couponScopeSorts[number];
type Position = { primary: string; secondary: string; id: number };
type Cursor = Position & { context: string };

function invalid(): never { throw new ValidateException("优惠券搜索参数或游标无效，请刷新"); }
function encodeCursor(value: Cursor) {
  return btoa(JSON.stringify([1, value.context, value.primary, value.secondary, value.id]))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decodeCursor(value: string): Cursor {
  if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) return invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(atob(value.replace(/-/g, "+").replace(/_/g, "/"))); } catch { return invalid(); }
  if (!Array.isArray(parsed) || parsed.length !== 5 || parsed[0] !== 1
    || typeof parsed[1] !== "string" || !/^[a-f0-9]{64}$/.test(parsed[1])
    || typeof parsed[2] !== "string" || !/^-?\d{1,13}(?:\.\d{1,2})?$/.test(parsed[2])
    || typeof parsed[3] !== "string" || !/^-?\d{1,10}$/.test(parsed[3])
    || Number(parsed[3]) < -2147483648 || Number(parsed[3]) > 2147483647
    || !Number.isInteger(parsed[4]) || parsed[4] < 1 || parsed[4] > 2147483647) return invalid();
  const result = { context: parsed[1], primary: parsed[2], secondary: parsed[3], id: parsed[4] as number };
  if (encodeCursor(result) !== value) return invalid();
  return result;
}

export function couponScopeSearchQuery(id: string | undefined, query: Record<string, string | undefined>) {
  if (query.view !== "search" || query.before !== undefined || query.page !== undefined) return invalid();
  if (!id || !/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) < 1 || Number(id) > 2147483647) return invalid();
  const rawLimit = query.limit ?? "20", keyword = (query.keyword ?? "").trim();
  if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 100
    || (query.keyword?.length ?? 0) > 100 || /[\u0000-\u001f\u007f]/.test(query.keyword ?? "")) return invalid();
  const sort = query.sort ?? "recommended";
  if (!couponScopeSorts.some(item => item === sort)) return invalid();
  return { couponId: Number(id), limit: Number(rawLimit), before: 0, keyword, sort: sort as Sort,
    cursor: query.cursor === undefined ? null : decodeCursor(query.cursor) };
}

export type CouponScopeSearchQuery = ReturnType<typeof couponScopeSearchQuery>;

/** Called only after the owner/availability guard. Cursor positions are not authorization tokens. */
export async function searchCouponScope(container: Container, uid: number, vip: boolean,
  issue: typeof storeCouponIssue.$inferSelect, title: string, query: CouponScopeSearchQuery) {
  const prepared = await prepareCouponScope(container, [], [issue]);
  const definition = { scopeType: issue.couponType,
    productIds: reconcileCouponProductScopeIds([issue.legacyProductIds, issue.productId], prepared.related.get(issue.id) ?? []),
    categoryIds: parseCouponScopeIds(issue.legacyCategoryId, issue.category_id), brandIds: parseCouponScopeIds(issue.legacyBrandId, issue.brandId) };
  const ids = (issue.couponType === 1 ? definition.categoryIds : issue.couponType === 2 ? definition.productIds : issue.couponType === 3 ? definition.brandIds : []).slice().sort((a, b) => a - b);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([
    uid, query.couponId, issue.id, title, vip, query.keyword, query.sort, issue.couponType, ids,
  ])));
  const context = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  if (query.cursor && query.cursor.context !== context) throw new ValidateException("优惠券范围或搜索条件已变化，请刷新");

  const primary: SQL = query.sort.startsWith("price_") ? sql`${storeProduct.price}`
    : query.sort.startsWith("sales_") ? sql`(COALESCE(${storeProduct.sales}, 0)::bigint + COALESCE(${storeProduct.ficti}, 0)::bigint)`
    : query.sort === "rating" ? sql`${storeProduct.star}`
    : query.sort === "newest" ? sql`${storeProduct.id}` : sql`${storeProduct.sort}`;
  const secondary = query.sort === "rating" ? sql`${storeProduct.sort}` : sql`0::integer`;
  const ascending = query.sort.endsWith("_asc");
  const visible = [eq(storeProduct.isShow, 1), eq(storeProduct.isDel, 0), eq(storeProduct.isVerify, 1)];
  if (!vip) visible.push(eq(storeProduct.isVipProduct, 0));
  // Literal substring search: user %/_/backslash must not turn into LIKE operators.
  if (query.keyword) visible.push(sql`${storeProduct.storeName} ILIKE ${`%${query.keyword.replace(/[\\%_]/g, "\\$&")}%`} ESCAPE ${"\\"}`);
  const list: Array<{ id: number; store_name: string; image: string; catalog_price: string }> = [];
  let position: Position | null = query.cursor, scanned = 0, hasMore = false;
  // Bound materialized candidates to 500 (+ one lookahead per batch), not the whole catalogue.
  // SQL still orders globally; this cap is not a claim that PostgreSQL scans at most 500 rows.
  while ((issue.couponType === 0 || ids.length > 0) && scanned < 500 && list.length < query.limit) {
    const where = [...visible];
    if (position) {
      const first = ascending ? sql`${primary} > ${position.primary}::numeric` : sql`${primary} < ${position.primary}::numeric`;
      where.push(sql`(${first} OR (${primary} = ${position.primary}::numeric AND
        (${secondary} < ${position.secondary}::integer OR (${secondary} = ${position.secondary}::integer AND ${storeProduct.id} < ${position.id}))))`);
    }
    const rows = await container.db.select({ id: storeProduct.id, pid: storeProduct.pid, cateId: storeProduct.cateId,
      brandId: storeProduct.brandId, store_name: storeProduct.storeName, image: storeProduct.image, price: storeProduct.price,
      primary: sql<string>`(${primary})::text`, secondary: sql<string>`(${secondary})::text` })
      .from(storeProduct).where(and(...where)).orderBy(ascending ? asc(primary) : desc(primary), desc(secondary), desc(storeProduct.id)).limit(101);
    if (!rows.length) { hasMore = false; break; }
    const candidates = rows.slice(0, 100);
    // Product relations were resolved once above; only category/brand metadata needs per-batch loading.
    const scope = await prepareCouponScope(container, candidates.map(product => ({ product, cart: { cartNum: 1 }, unitPriceCents: 1 })),
      issue.couponType === 2 ? [] : [issue]);
    // Avoid rebuilding a possible 20,000-ID product set for every individual candidate.
    // Intersect only with checkout's already-normalized item keys; membership still uses its shared evaluator.
    const batchProductIds = new Set(scope.items.flatMap(item => [item.productId, item.parentProductId]));
    const batchDefinition = { ...definition, productIds: definition.productIds.filter(id => batchProductIds.has(id)) };
    for (const [index, product] of candidates.entries()) {
      scanned++; position = { primary: product.primary, secondary: product.secondary, id: product.id };
      hasMore = index + 1 < rows.length;
      if (calculateCouponEligibleSubtotalCents({ ...batchDefinition, items: [scope.items[index]!] }) > 0) {
        list.push({ id: product.id, store_name: product.store_name, image: product.image, catalog_price: product.price });
      }
      if (list.length === query.limit) break;
    }
    if (!hasMore) break;
  }
  return { coupon_id: query.couponId, coupon_title: title, scope_type: issue.couponType, scope_only: true as const,
    keyword: query.keyword, sort: query.sort, list, scanned_count: scanned,
    scan_limit_reached: scanned === 500 && hasMore && list.length < query.limit,
    // Includes all ordering keys of the last EXAMINED row; never skip an unexamined batch tail.
    next_cursor: hasMore && position ? encodeCursor({ ...position, context }) : null };
}
