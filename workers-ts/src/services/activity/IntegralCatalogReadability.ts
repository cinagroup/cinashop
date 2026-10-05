import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { sanitizePublishedArticleHtml } from '@/services/content/ArticleContentPolicy';
import { ValidateException } from '@/utils/errors';
import { INTEGRAL_DETAIL_LIMITS, INTEGRAL_DETAIL_CONFIG_KEYS, integralDetailId } from './IntegralProductDetailData';

export const INTEGRAL_CATALOG_DESCRIPTION_BUDGET = 2 * 1024 * 1024;
/** Normalize every R2 namespace spelling before the existing persisted-owner
 * asset policy sees it. Old signatures never confer detail ownership. The
 * result is either a stable local reference for fresh validation/signing, an
 * ordinary legacy address, or an absent attribute. No address is fetched. */
function integralBodyAddress(value: string): string | null {
  let layer = value.replace(/&amp;/g, '&'), asset: string | null = null;
  for (let depth = 0; depth <= 3; depth++) {
    if (layer.startsWith('//') || /[\\\u0000-\u001f\u007f]/u.test(layer) || (depth === 0 && /\s/u.test(layer))) return null;
    try {
      const parsed = new URL(layer, 'https://integral-description.invalid');
      if (parsed.username || parsed.password || parsed.pathname.startsWith('//')) return null;
      if (parsed.pathname === '/api/assets' || parsed.pathname.startsWith('/api/assets/')) {
        const match = /^\/api\/assets\/([1-9]\d{0,9})$/.exec(parsed.pathname);
        if (!match || Number(match[1]) > 2147483647) return null;
        asset = `/api/assets/${match[1]}`;
      }
    } catch { return null; }
    if (!/%[a-f0-9]{2}/iu.test(layer)) break;
    if (depth === 3) return null;
    try { layer = decodeURIComponent(layer); } catch { return null; }
  }
  return asset ?? value;
}
/** The article boundary rebuilds safe markup. Integral DTOs additionally
 * remove text controls that a storefront cannot render; TAB/LF/CR remain. */
export function integralDescriptionHtml(value: string): string {
  return sanitizePublishedArticleHtml(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .replace(/\b(href|src)="([^"]*)"/g, (_attribute, key: string, reference: string) => {
      const normalized = integralBodyAddress(reference); return normalized === null ? '' : `${key}="${normalized}"`;
    });
}
export function integralDescriptionAssetReferences(description: string): string[] {
  return [...new Set([...description.matchAll(/\b(?:href|src)="(\/api\/assets\/[1-9]\d*)"/g)].map(match => match[1]))];
}
type ReadabilityRow = { id: number; activity_count: number; base_count: number; attribute_count: number;
  description_count: number; descriptions: Array<string | null> | null; batch_bytes: string | number; config_count: number };

/** Caller-owned RR READ ONLY snapshot. Four bounded lateral reads per selected
 * identity in one SQL statement; no full-detail N+1 or positive-stock filter.
 * Counts use limit+1 sentinels. PostgreSQL checks the aggregate UTF8 budget
 * before returning any bodies, so an oversized page cannot allocate them in
 * the Worker. SQL/timeout failures deliberately propagate. */
export async function readIntegralCatalogReadability(tx: DbClient, items: readonly { id: number; productId: number }[]): Promise<Map<number, string[]>> {
  if (items.length > 100) throw new ValidateException('积分目录本地可读性批次超过100项');
  const identities = new Map<number, number>();
  for (const item of items) {
    const id = integralDetailId(item.id), productId = integralDetailId(item.productId);
    if (identities.has(id)) throw new ValidateException('积分目录本地可读性身份重复');
    identities.set(id, productId);
  }
  if (!items.length) return new Map();
  const input = sql.join([...identities].map(([id, productId]) => sql`(${id}::integer,${productId}::integer)`), sql`,`);
  const rows = await tx.execute<ReadabilityRow>(sql`WITH local_readability AS (
    SELECT requested.id, activity_skus.total AS activity_count, base_skus.total AS base_count,
      attributes.total AS attribute_count, bodies.total AS description_count, bodies.descriptions, bodies.bytes
    FROM (VALUES ${input}) AS requested(id,product_id)
    CROSS JOIN LATERAL (SELECT count(*)::integer AS total FROM (SELECT 1 FROM public.store_product_attr_value
      WHERE product_id=requested.id AND type=4 AND is_retired=0 LIMIT ${INTEGRAL_DETAIL_LIMITS.skus + 1}) limited) activity_skus
    CROSS JOIN LATERAL (SELECT count(*)::integer AS total FROM (SELECT 1 FROM public.store_product_attr_value
      WHERE product_id=requested.product_id AND type=0 AND is_retired=0 LIMIT ${INTEGRAL_DETAIL_LIMITS.skus + 1}) limited) base_skus
    CROSS JOIN LATERAL (SELECT count(*)::integer AS total FROM (SELECT 1 FROM public.store_product_attr
      WHERE product_id=requested.id AND type=4 LIMIT ${INTEGRAL_DETAIL_LIMITS.attributes + 1}) limited) attributes
    CROSS JOIN LATERAL (SELECT count(*)::integer AS total, COALESCE(sum(octet_length(description)),0)::bigint AS bytes,
      array_agg(description) AS descriptions FROM (SELECT left(description,${INTEGRAL_DETAIL_LIMITS.description + 1}) AS description
        FROM public.store_product_description WHERE product_id=requested.id AND type=4 LIMIT 2) limited) bodies
  ), global_config AS (SELECT count(*)::integer AS total FROM (SELECT 1 FROM public.system_config
    WHERE is_store=0 AND menu_name IN (${sql.join(INTEGRAL_DETAIL_CONFIG_KEYS.map(key => sql`${key}`), sql`,`)}) LIMIT 1001) limited)
  SELECT id, activity_count, base_count, attribute_count, description_count, global_config.total AS config_count,
    CASE WHEN sum(bytes) OVER()<=${INTEGRAL_CATALOG_DESCRIPTION_BUDGET} THEN descriptions ELSE NULL END AS descriptions,
    sum(bytes) OVER() AS batch_bytes FROM local_readability CROSS JOIN global_config ORDER BY id`);
  if (rows.some(row => row.config_count > 1000)) throw new ValidateException('积分详情展示配置超过完整容量');
  if (rows.some(row => Number(row.batch_bytes) > INTEGRAL_CATALOG_DESCRIPTION_BUDGET)) throw new ValidateException('积分目录正文批次超过2MiB UTF8预算');
  const result = new Map<number, string[]>();
  for (const row of rows) {
    const issues: string[] = [];
    if (row.activity_count > INTEGRAL_DETAIL_LIMITS.skus) issues.push('activity_sku_capacity');
    if (row.base_count > INTEGRAL_DETAIL_LIMITS.skus) issues.push('base_sku_capacity');
    if (row.attribute_count > INTEGRAL_DETAIL_LIMITS.attributes) issues.push('attribute_capacity');
    if (row.description_count > 1) issues.push('description_ambiguous');
    if (row.descriptions?.some(body => (body?.length ?? 0) > INTEGRAL_DETAIL_LIMITS.description)) issues.push('description_capacity');
    if (row.description_count === 1 && !issues.includes('description_capacity') && integralDescriptionAssetReferences(integralDescriptionHtml(row.descriptions?.[0] ?? '')).length > INTEGRAL_DETAIL_LIMITS.bodyAssets) issues.push('body_asset_capacity');
    result.set(row.id, issues);
  }
  return result;
}
