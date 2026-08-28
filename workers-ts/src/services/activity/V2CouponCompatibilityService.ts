import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Container } from "@/lib/di";
import {
  storeBrand,
  storeCouponIssue,
  storeCouponProduct,
  storeCouponUser,
  storeProduct,
  storeProductCategory,
  user as userTable,
} from "@/models/schema";
import {
  parseCouponScopeIds,
  reconcileCouponProductScopeIds,
} from "@/services/activity/ProductCouponService";
import { isPaidMembershipActive } from "@/services/order/StoreOrderCreateService";
import { ValidateException } from "@/utils/errors";

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1_000;
const MAX_PAGE_SIZE = 100;
const MAX_UNPAGED_COUPONS = 1_000;

type CouponIssue = typeof storeCouponIssue.$inferSelect;
type CouponUser = typeof storeCouponUser.$inferSelect;

export interface LegacyCouponQuery {
  page: number;
  limit: number;
  type?: -1 | 0 | 1 | 2 | 3;
  productId: number;
  brandId: number;
  defaultOrder: string;
  timeOrder: string;
  priceOrder: string;
}

interface ProductContext {
  productId: number;
  categoryIds: number[];
  brandIds: number[];
}

interface CouponProductRow {
  coupon_id: number;
  id: number;
  image: string;
  store_name: string;
  price: number | string;
  sales: number;
}

type LegacyCouponProduct = Omit<CouponProductRow, "coupon_id">;

function phpInteger(value: unknown, fallback = 0): number {
  if (value === undefined || value === null || value === "") return fallback;
  const match = String(value).trim().match(/^[+-]?\d+/);
  if (!match) return 0;
  const parsed = Number(match[0]);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function boundedPositiveInteger(value: unknown, fallback: number, maximum: number): number {
  const parsed = phpInteger(value, fallback);
  if (parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

/** Parse the old ThinkPHP `getMore` query contract without accepting unbounded pages. */
export function parseLegacyCouponQuery(query: Record<string, unknown>): LegacyCouponQuery {
  const rawType = query.type === undefined || query.type === ""
    ? undefined
    : phpInteger(query.type);
  const type = rawType !== undefined && [-1, 0, 1, 2, 3].includes(rawType)
    ? rawType as LegacyCouponQuery["type"]
    : undefined;
  return {
    page: boundedPositiveInteger(query.page, 1, 1_000_000),
    limit: boundedPositiveInteger(query.limit, 10, MAX_PAGE_SIZE),
    type,
    productId: Math.max(0, phpInteger(query.product_id)),
    brandId: Math.max(0, phpInteger(query.brand_id)),
    defaultOrder: String(query.defaultOrder ?? ""),
    timeOrder: String(query.timeOrder ?? ""),
    priceOrder: String(query.priceOrder ?? ""),
  };
}

/** ThinkPHP/PHP ran these routes in China Standard Time. */
export function formatLegacyCouponDate(
  value: Date | null | undefined,
  separator: "-" | "/" = "-",
): string {
  if (!value || !Number.isFinite(value.getTime())) return "";
  const shifted = new Date(value.getTime() + SHANGHAI_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${year}${separator}${month}${separator}${day}`;
}

/** UTC instants bracketing the current Asia/Shanghai calendar day. */
export function legacyShanghaiDayRange(now: Date): { start: Date; end: Date } {
  const shifted = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const localMidnightAsUtc = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  );
  return {
    start: new Date(localMidnightAsUtc - SHANGHAI_OFFSET_MS),
    end: new Date(localMidnightAsUtc + 24 * 60 * 60 * 1_000 - SHANGHAI_OFFSET_MS),
  };
}

function unixSeconds(value: Date | null | undefined): number {
  return value ? Math.floor(value.getTime() / 1_000) : 0;
}

function firstScopeId(...values: unknown[]): number {
  return parseCouponScopeIds(...values)[0] ?? 0;
}

function money(value: string | number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function usedProjection(row: CouponUser) {
  return {
    id: row.id,
    cid: row.issueCouponId,
    uid: row.uid,
    start_time: unixSeconds(row.startTime),
    end_time: unixSeconds(row.endTime),
    use_time: unixSeconds(row.useTime),
    status: row.status,
    is_fail: row.isFail,
  };
}

/** Restore the source CRMEB field names after the target schema's type-column swap. */
export function legacyCouponProjection(
  issue: CouponIssue,
  options: {
    variant: "list" | "new" | "today";
    used?: CouponUser;
    relatedProductIds?: readonly number[];
    products?: readonly LegacyCouponProduct[];
  },
): Record<string, unknown> {
  const productIds = reconcileCouponProductScopeIds(
    [issue.legacyProductIds, issue.productId],
    options.relatedProductIds ?? [],
  );
  const legacyProductId = productIds.length
    ? productIds.join(",")
    : issue.legacyProductIds ?? issue.productId;
  const result: Record<string, unknown> = {
    id: issue.id,
    cid: issue.cid,
    category: issue.category,
    // Source `type` was the scope. The target intentionally stores it in coupon_type.
    type: issue.couponType,
    // Source `coupon_type` was the discount mode. The target stores it in type.
    coupon_type: issue.type,
    coupon_title: issue.couponTitle,
    coupon_price: money(issue.couponPrice),
    use_min_price: money(issue.useMinPrice),
    product_id: legacyProductId,
    category_id: issue.legacyCategoryId > 0
      ? issue.legacyCategoryId
      : firstScopeId(issue.category_id),
    brand_id: issue.legacyBrandId > 0 ? issue.legacyBrandId : firstScopeId(issue.brandId),
    total_count: issue.totalCount,
    remain_count: issue.remainCount,
    receive_limit: issue.receiveLimit,
    receive_type: issue.receiveType,
    start_time: unixSeconds(issue.startTime),
    end_time: unixSeconds(issue.endTime),
    coupon_time: issue.day,
    is_permanent: issue.isPermanent,
    is_give_subscribe: issue.isGiveSubscribe,
    is_full_give: issue.isFullGive,
    // PHP only float-casts coupon_price/use_min_price in these three handlers.
    full_reduction: issue.fullReduction,
    is_del: issue.isDel,
    title: issue.title,
    integral: issue.integral,
    start_use_time: unixSeconds(issue.useStartTime),
    end_use_time: unixSeconds(issue.useEndTime),
    rule: issue.rule,
    status: issue.status,
    app_type: issue.appType,
    sort: issue.sort,
    add_time: issue.addTime,
  };

  if (options.variant === "list") {
    const used = options.used;
    if (used) result.used = usedProjection(used);
    result.is_use = !!used;
    result.start_time = issue.day > 0 && used
      ? formatLegacyCouponDate(used.startTime, "/")
      : issue.day === 0
        ? formatLegacyCouponDate(issue.useStartTime, "/")
        : "";
    result.end_time = issue.day > 0 && used
      ? formatLegacyCouponDate(used.endTime, "/")
      : issue.day === 0
        ? formatLegacyCouponDate(issue.useEndTime, "/")
        : "";
    result.products = options.products ?? [];
  } else {
    result.start_time = issue.startTime ? formatLegacyCouponDate(issue.startTime) : 0;
    result.end_time = issue.endTime ? formatLegacyCouponDate(issue.endTime) : 0;
  }
  return result;
}

function csvContains(column: SQL, id: number): SQL {
  return sql`(',' || regexp_replace(COALESCE(${column}::text, ''), '[^0-9]+', ',', 'g') || ',') LIKE ${`%,${id},%`}`;
}

function anyCsvContains(column: SQL, ids: readonly number[]): SQL {
  if (!ids.length) return sql`FALSE`;
  return or(...ids.map((id) => csvContains(column, id))) ?? sql`FALSE`;
}

function productScopeMatches(productId: number): SQL {
  if (!productId) return sql`FALSE`;
  return or(
    csvContains(sql`${storeCouponIssue.legacyProductIds}`, productId),
    csvContains(sql`${storeCouponIssue.productId}`, productId),
    sql`EXISTS (
      SELECT 1 FROM ${storeCouponProduct}
      WHERE ${storeCouponProduct.couponId} = ${storeCouponIssue.id}
        AND ${storeCouponProduct.productId} = ${productId}
    )`,
  ) ?? sql`FALSE`;
}

function categoryScopeMatches(categoryIds: readonly number[]): SQL {
  if (!categoryIds.length) return sql`FALSE`;
  return or(
    inArray(storeCouponIssue.legacyCategoryId, [...categoryIds]),
    anyCsvContains(sql`${storeCouponIssue.category_id}`, categoryIds),
  ) ?? sql`FALSE`;
}

function brandScopeMatches(brandIds: readonly number[]): SQL {
  if (!brandIds.length) return sql`FALSE`;
  return or(
    inArray(storeCouponIssue.legacyBrandId, [...brandIds]),
    anyCsvContains(sql`${storeCouponIssue.brandId}`, brandIds),
  ) ?? sql`FALSE`;
}

function validCouponCondition(now: Date): SQL {
  return and(
    eq(storeCouponIssue.status, 1),
    eq(storeCouponIssue.isDel, 0),
    or(gt(storeCouponIssue.remainCount, 0), eq(storeCouponIssue.isPermanent, 1)),
    or(
      and(lte(storeCouponIssue.startTime, now), gte(storeCouponIssue.endTime, now)),
      and(isNull(storeCouponIssue.startTime), isNull(storeCouponIssue.endTime)),
    ),
    or(
      and(eq(storeCouponIssue.day, 0), gte(storeCouponIssue.useEndTime, now)),
      gt(storeCouponIssue.day, 0),
    ),
  ) ?? sql`FALSE`;
}

function listScopeCondition(query: LegacyCouponQuery, context: ProductContext, now: Date): SQL {
  if (query.type === -1) {
    return and(
      gt(storeCouponIssue.endTime, now),
      lte(storeCouponIssue.endTime, new Date(now.getTime() + 24 * 60 * 60 * 1_000)),
    ) ?? sql`FALSE`;
  }
  if (query.type === 0) return eq(storeCouponIssue.couponType, 0);
  if (query.type === 1) {
    return and(
      eq(storeCouponIssue.couponType, 1),
      context.categoryIds.length ? categoryScopeMatches(context.categoryIds) : undefined,
    ) ?? sql`FALSE`;
  }
  if (query.type === 2) {
    return and(
      eq(storeCouponIssue.couponType, 2),
      context.productId ? productScopeMatches(context.productId) : undefined,
    ) ?? sql`FALSE`;
  }
  if (query.type === 3) {
    // PHP accidentally discarded the brand derived from product_id in this branch,
    // making the old UniApp's brand tab empty. Prefer an explicit brand_id, then
    // use the already-authoritative product brand and its immediate parent.
    const brandIds = query.brandId ? [query.brandId] : context.brandIds;
    return and(
      eq(storeCouponIssue.couponType, 3),
      brandIds.length ? brandScopeMatches(brandIds) : undefined,
    ) ?? sql`FALSE`;
  }
  if (!context.productId) return sql`TRUE`;
  return or(
    eq(storeCouponIssue.couponType, 0),
    and(eq(storeCouponIssue.couponType, 2), productScopeMatches(context.productId)),
    and(eq(storeCouponIssue.couponType, 1), categoryScopeMatches(context.categoryIds)),
    and(eq(storeCouponIssue.couponType, 3), brandScopeMatches(context.brandIds)),
  ) ?? sql`FALSE`;
}

function rawRows<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  const rows = (value as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(rows) ? rows as T[] : [];
}

export class V2CouponCompatibilityService {
  constructor(private readonly container: Container) {}

  async available(uid: number, rawQuery: Record<string, unknown>, now = new Date()) {
    const query = parseLegacyCouponQuery(rawQuery);
    const context = await this.productContext(query.productId);
    const base = validCouponCondition(now);
    const scope = listScopeCondition(query, context, now);
    const orders: SQL[] = [];
    if (query.priceOrder !== "" && query.priceOrder !== "0") {
      const price = sql`CASE WHEN ${storeCouponIssue.type} <= 1
        THEN ${storeCouponIssue.couponPrice}::numeric
        ELSE 100 - ${storeCouponIssue.couponPrice}::numeric END`;
      orders.push(query.priceOrder === "desc" ? desc(price) : asc(price));
    }
    if (query.timeOrder !== "" && query.timeOrder !== "0") {
      orders.push(query.timeOrder === "desc"
        ? desc(storeCouponIssue.addTime)
        : asc(storeCouponIssue.addTime));
    }
    if (query.defaultOrder !== "" && query.defaultOrder !== "0") {
      orders.push(desc(storeCouponIssue.sort), desc(storeCouponIssue.id));
    }
    orders.push(desc(storeCouponIssue.sort), desc(storeCouponIssue.id));

    const issues = await this.container.db
      .select()
      .from(storeCouponIssue)
      .where(and(base, eq(storeCouponIssue.receiveType, 1), scope))
      .orderBy(...orders)
      .limit(query.limit)
      .offset((query.page - 1) * query.limit);

    const issueIds = issues.map((issue) => issue.id);
    const [usedByIssue, relatedByIssue, productsByIssue, count] = await Promise.all([
      this.usedByIssue(uid, issueIds),
      this.relatedProductsByIssue(issueIds),
      this.sampleProducts(issueIds),
      this.issueCounts(base, context),
    ]);
    return {
      list: issues.map((issue) => legacyCouponProjection(issue, {
        variant: "list",
        used: usedByIssue.get(issue.id),
        relatedProductIds: relatedByIssue.get(issue.id),
        products: productsByIssue.get(issue.id),
      })),
      count,
    };
  }

  async newCoupons(uid: number, now = new Date()) {
    const [issues, users] = await Promise.all([
      this.boundedUnpaged(
        and(validCouponCondition(now), eq(storeCouponIssue.receiveType, 2)) ?? sql`FALSE`,
      ),
      this.container.db
        .select({ addTime: userTable.addTime, lastTime: userTable.lastTime })
        .from(userTable)
        .where(eq(userTable.uid, uid))
        .limit(1),
    ]);
    const related = await this.relatedProductsByIssue(issues.map((issue) => issue.id));
    return {
      list: issues.map((issue) => legacyCouponProjection(issue, {
        variant: "new",
        relatedProductIds: related.get(issue.id),
      })),
      image: "",
      show: users[0] && users[0].addTime === users[0].lastTime ? 1 : 0,
    };
  }

  async today(uid: number, now = new Date()) {
    let receiveTypes = [1, 4];
    if (uid > 0) {
      const [users, memberCardStatus] = await Promise.all([
        this.container.db
          .select({
            isMoneyLevel: userTable.isMoneyLevel,
            isEverLevel: userTable.isEverLevel,
            overdueTime: userTable.overdueTime,
          })
          .from(userTable)
          .where(eq(userTable.uid, uid))
          .limit(1),
        this.container.systemConfigDao.getValue("member_card_status"),
      ]);
      const user = users[0];
      const membershipEnabled = String(memberCardStatus || "1") === "1";
      const isSvip = !!user && membershipEnabled
        && isPaidMembershipActive(user, Math.floor(now.getTime() / 1_000));
      if (!isSvip) receiveTypes = [1];
    }
    const range = legacyShanghaiDayRange(now);
    const startSeconds = Math.floor(range.start.getTime() / 1_000);
    const endSeconds = Math.floor(range.end.getTime() / 1_000);
    const issues = await this.container.db
      .select()
      .from(storeCouponIssue)
      .where(and(
        eq(storeCouponIssue.status, 1),
        eq(storeCouponIssue.isDel, 0),
        inArray(storeCouponIssue.receiveType, receiveTypes),
        gte(storeCouponIssue.addTime, startSeconds),
        lt(storeCouponIssue.addTime, endSeconds),
      ))
      .orderBy(desc(storeCouponIssue.sort), desc(storeCouponIssue.id))
      .limit(10);
    const related = await this.relatedProductsByIssue(issues.map((issue) => issue.id));
    return {
      list: issues.map((issue) => legacyCouponProjection(issue, {
        variant: "today",
        relatedProductIds: related.get(issue.id),
      })),
      image: "",
    };
  }

  private async productContext(productId: number): Promise<ProductContext> {
    if (!productId) return { productId: 0, categoryIds: [], brandIds: [] };
    const products = await this.container.db
      .select({ id: storeProduct.id, cateId: storeProduct.cateId, brandId: storeProduct.brandId })
      .from(storeProduct)
      .where(eq(storeProduct.id, productId))
      .limit(1);
    const product = products[0];
    if (!product) return { productId, categoryIds: [], brandIds: [] };
    const directCategoryIds = parseCouponScopeIds(product.cateId);
    const [categories, brands] = await Promise.all([
      directCategoryIds.length
        ? this.container.db
            .select({ id: storeProductCategory.id, pid: storeProductCategory.pid })
            .from(storeProductCategory)
            .where(inArray(storeProductCategory.id, directCategoryIds))
        : Promise.resolve([]),
      product.brandId > 0
        ? this.container.db
            .select({ id: storeBrand.id, pid: storeBrand.pid })
            .from(storeBrand)
            .where(eq(storeBrand.id, product.brandId))
            .limit(1)
        : Promise.resolve([]),
    ]);
    return {
      productId,
      categoryIds: parseCouponScopeIds(directCategoryIds, categories.map((category) => category.pid)),
      brandIds: parseCouponScopeIds(brands[0]?.id, brands[0]?.pid),
    };
  }

  private async boundedUnpaged(condition: SQL): Promise<CouponIssue[]> {
    const rows = await this.container.db
      .select()
      .from(storeCouponIssue)
      .where(condition)
      .orderBy(desc(storeCouponIssue.id))
      .limit(MAX_UNPAGED_COUPONS + 1);
    if (rows.length > MAX_UNPAGED_COUPONS) {
      throw new ValidateException("优惠券数量超过兼容接口安全上限");
    }
    return rows;
  }

  private async usedByIssue(uid: number, issueIds: readonly number[]): Promise<Map<number, CouponUser>> {
    const result = new Map<number, CouponUser>();
    if (!uid || !issueIds.length) return result;
    const rows = await this.container.db
      .select()
      .from(storeCouponUser)
      .where(and(eq(storeCouponUser.uid, uid), inArray(storeCouponUser.issueCouponId, [...issueIds])))
      .orderBy(desc(storeCouponUser.id));
    for (const row of rows) if (!result.has(row.issueCouponId)) result.set(row.issueCouponId, row);
    return result;
  }

  private async relatedProductsByIssue(issueIds: readonly number[]): Promise<Map<number, number[]>> {
    const result = new Map<number, number[]>();
    if (!issueIds.length) return result;
    const rows = await this.container.db
      .select({ couponId: storeCouponProduct.couponId, productId: storeCouponProduct.productId })
      .from(storeCouponProduct)
      .where(inArray(storeCouponProduct.couponId, [...issueIds]));
    for (const row of rows) {
      const ids = result.get(row.couponId) ?? [];
      ids.push(row.productId);
      result.set(row.couponId, ids);
    }
    return result;
  }

  private async issueCounts(base: SQL, context: ProductContext): Promise<number[]> {
    const category = context.categoryIds.length ? categoryScopeMatches(context.categoryIds) : sql`TRUE`;
    const product = context.productId ? productScopeMatches(context.productId) : sql`TRUE`;
    const brand = context.brandIds.length ? brandScopeMatches(context.brandIds) : sql`TRUE`;
    const rows = await this.container.db
      .select({
        general: sql<number>`COUNT(*) FILTER (WHERE ${storeCouponIssue.couponType} = 0)::int`,
        category: sql<number>`COUNT(*) FILTER (WHERE ${storeCouponIssue.couponType} = 1 AND ${category})::int`,
        product: sql<number>`COUNT(*) FILTER (WHERE ${storeCouponIssue.couponType} = 2 AND ${product})::int`,
        brand: sql<number>`COUNT(*) FILTER (WHERE ${storeCouponIssue.couponType} = 3 AND ${brand})::int`,
      })
      .from(storeCouponIssue)
      .where(and(base, eq(storeCouponIssue.receiveType, 1)));
    const row = rows[0];
    return [row?.general ?? 0, row?.category ?? 0, row?.product ?? 0, row?.brand ?? 0]
      .map(Number);
  }

  private async sampleProducts(issueIds: readonly number[]): Promise<Map<number, LegacyCouponProduct[]>> {
    const result = new Map<number, LegacyCouponProduct[]>();
    if (!issueIds.length) return result;
    // postgres.js sends standalone VALUES parameters as text unless the SQL supplies a type.
    // Cast here so the CTE joins the integer primary key without an integer=text ambiguity.
    const values = sql.join(issueIds.map((id) => sql`(${id}::integer)`), sql`, `);
    const raw = await this.container.db.execute(sql`
      WITH requested(coupon_id) AS (VALUES ${values})
      SELECT
        requested.coupon_id::int,
        sample.id::int,
        sample.image,
        sample.store_name,
        sample.price::double precision AS price,
        sample.sales::int
      FROM requested
      INNER JOIN store_coupon_issue issue ON issue.id = requested.coupon_id
      INNER JOIN LATERAL (
        SELECT
          product.id,
          product.image,
          product.store_name,
          product.price,
          COALESCE(product.sales, 0) + COALESCE(product.ficti, 0) AS sales
        FROM store_product product
        LEFT JOIN store_brand brand ON brand.id = product.brand_id
        WHERE product.is_show = 1
          AND product.is_del = 0
          AND product.is_verify = 1
          AND product.price >= issue.use_min_price
          AND (
            issue.coupon_type = 0
            OR (
              issue.coupon_type = 2
              AND (
                (',' || regexp_replace(COALESCE(issue.legacy_product_ids, ''), '[^0-9]+', ',', 'g') || ',')
                  LIKE '%,' || product.id::text || ',%'
                OR (',' || regexp_replace(COALESCE(issue.product_id, ''), '[^0-9]+', ',', 'g') || ',')
                  LIKE '%,' || product.id::text || ',%'
                OR EXISTS (
                  SELECT 1 FROM store_coupon_product relation
                  WHERE relation.coupon_id = issue.id AND relation.product_id = product.id
                )
              )
            )
            OR (
              issue.coupon_type = 1
              AND EXISTS (
                SELECT 1 FROM store_product_category category
                WHERE (',' || regexp_replace(COALESCE(product.cate_id, ''), '[^0-9]+', ',', 'g') || ',')
                    LIKE '%,' || category.id::text || ',%'
                  AND (
                    issue.legacy_category_id IN (category.id, category.pid)
                    OR (',' || regexp_replace(COALESCE(issue.category_id, ''), '[^0-9]+', ',', 'g') || ',')
                      LIKE '%,' || category.id::text || ',%'
                    OR (',' || regexp_replace(COALESCE(issue.category_id, ''), '[^0-9]+', ',', 'g') || ',')
                      LIKE '%,' || category.pid::text || ',%'
                  )
              )
            )
            OR (
              issue.coupon_type = 3
              AND (
                issue.legacy_brand_id IN (brand.id, brand.pid)
                OR (',' || regexp_replace(COALESCE(issue.brand_id, ''), '[^0-9]+', ',', 'g') || ',')
                  LIKE '%,' || brand.id::text || ',%'
                OR (',' || regexp_replace(COALESCE(issue.brand_id, ''), '[^0-9]+', ',', 'g') || ',')
                  LIKE '%,' || brand.pid::text || ',%'
              )
            )
          )
        ORDER BY
          CASE WHEN issue.coupon_type = 0 THEN md5(product.id::text || ':' || issue.id::text) END,
          (COALESCE(product.sales, 0) + COALESCE(product.ficti, 0)) DESC,
          product.id DESC
        LIMIT 1
      ) sample ON TRUE
    `);
    for (const row of rawRows<CouponProductRow>(raw)) {
      result.set(Number(row.coupon_id), [{
        id: Number(row.id),
        image: row.image,
        store_name: row.store_name,
        price: money(row.price),
        sales: Number(row.sales),
      }]);
    }
    return result;
  }
}
