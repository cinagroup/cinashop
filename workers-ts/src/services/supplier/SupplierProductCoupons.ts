import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { storeCouponIssue, storeProductCoupon } from '@/models/schema';
import { outProductCouponInput } from '@/services/out/OutProductCouponBindings';
import { assertSupplierProductLabelAuthority, type SupplierProductLabelActor } from './SupplierProductLabelService';
import { ServiceUnavailableException, ValidateException } from '@/utils/errors';

export function supplierProductCouponInput(raw: Record<string, unknown>): number[] | undefined {
  return Object.hasOwn(raw, 'coupon_ids') ? outProductCouponInput(raw) : undefined;
}

/** Read legacy links without converting missing/deleted records into clear intent. */
export async function readSupplierProductCoupons(db: DbClient, productId: number) {
  const links = await db.select({ linkId: storeProductCoupon.id, id: storeProductCoupon.issueCouponId,
    storedTitle: storeProductCoupon.title, issueId: storeCouponIssue.id,
    title: storeCouponIssue.couponTitle, fallbackTitle: storeCouponIssue.title, deleted: storeCouponIssue.isDel })
    .from(storeProductCoupon).leftJoin(storeCouponIssue, eq(storeCouponIssue.id, storeProductCoupon.issueCouponId))
    .where(eq(storeProductCoupon.productId, productId)).orderBy(asc(storeProductCoupon.id)).limit(101);
  const truncated = links.length > 100, seen = new Set<number>();
  let consistent = !truncated;
  const entries: Array<{ id: number; title: string; available: boolean }> = [];
  for (const row of links.slice(0, 100)) {
    if (row.id <= 0 || row.id > 2147483647 || seen.has(row.id)) { consistent = false; continue; }
    seen.add(row.id);
    entries.push({ id: row.id, title: row.title || row.fallbackTitle || row.storedTitle || `发行实例 #${row.id}`,
      available: row.issueId !== null && row.deleted === 0 });
  }
  entries.sort((a, b) => a.id - b.id);
  return { version: 1 as const, ids: entries.map(row => row.id), entries, truncated, consistent };
}

export function supplierCouponCatalogQuery(query: URLSearchParams) {
  if ([...query.keys()].some(key => !['page', 'limit', 'keyword'].includes(key))
    || ['page', 'limit', 'keyword'].some(key => query.getAll(key).length > 1)) throw new ValidateException('赠券目录查询参数错误');
  const integer = (name: string, fallback: number, maximum: number) => {
    const raw = query.get(name); if (raw === null) return fallback;
    if (!/^[1-9]\d{0,6}$/.test(raw) || Number(raw) > maximum) throw new ValidateException('赠券目录分页参数错误');
    return Number(raw);
  };
  const keyword = (query.get('keyword') ?? '').trim();
  if (keyword.length > 128 || /[\u0000-\u001f]/.test(keyword)) throw new ValidateException('赠券目录搜索词错误');
  return { page: integer('page', 1, 1_000_000), limit: integer('limit', 20, 50), keyword };
}

/** Issuance has no merchant-owner column. Reuse the actual undeleted admission;
 * paid processing separately decides status, windows and remaining stock. */
export async function supplierProductCouponCatalog(container: Container, supplierId: number,
  query: URLSearchParams, actor: SupplierProductLabelActor) {
  const input = supplierCouponCatalogQuery(query);
  const path = '/supplierapi/product/coupon/catalog';
  return withTx(container, async db => {
    await db.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ ONLY`);
    await db.execute(sql`SET LOCAL statement_timeout='5s'`);
    await assertSupplierProductLabelAuthority(db, supplierId, actor, 'GET', path);
    const pattern = `%${input.keyword.replace(/[\\%_]/g, value => '\\' + value)}%`;
    const where = and(eq(storeCouponIssue.isDel, 0), input.keyword ? or(ilike(storeCouponIssue.couponTitle, pattern),
      ilike(storeCouponIssue.title, pattern), /^\d{1,10}$/.test(input.keyword) && Number(input.keyword) <= 2147483647
        ? eq(storeCouponIssue.id, Number(input.keyword)) : undefined) : undefined);
    const [count] = await db.select({ total: sql<number>`count(*)::integer` }).from(storeCouponIssue).where(where);
    const list = await db.select({ id: storeCouponIssue.id, title: storeCouponIssue.couponTitle, fallback_title: storeCouponIssue.title,
      status: storeCouponIssue.status, coupon_price: storeCouponIssue.couponPrice, discount_type: storeCouponIssue.type,
      use_min_price: storeCouponIssue.useMinPrice }).from(storeCouponIssue).where(where).orderBy(desc(storeCouponIssue.id))
      .limit(input.limit).offset((input.page - 1) * input.limit);
    await assertSupplierProductLabelAuthority(db, supplierId, actor, 'GET', path);
    const result = { version: 1 as const, list: list.map(({ fallback_title, ...row }) => ({ ...row, title: row.title || fallback_title || `发行实例 #${row.id}` })),
      count: count?.total ?? 0, page: input.page, limit: input.limit };
    if (new TextEncoder().encode(JSON.stringify(result)).length > 128 * 1024) throw new ServiceUnavailableException('赠券目录响应过大');
    return result;
  });
}
