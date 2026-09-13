import { getTableColumns, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { withTx, type Container } from '@/lib/di';
import { shippingTemplates, shippingTemplatesRegion } from '@/models/schema';
import { ValidateException } from '@/utils/errors';

const MAX_REGIONS = 1000;
function integer(value: string, min: number, max: number) {
  if (!/^-?\d+$/.test(value)) throw new ValidateException('运费列表分页参数无效');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new ValidateException('运费列表分页参数越界');
  return parsed;
}
function input(query: Record<string, string>) {
  if (Object.keys(query).some(key => !['limit', 'cursor', 'name'].includes(key))) throw new ValidateException('运费列表查询参数无效');
  const limit = integer(query.limit ?? '20', 1, 50);
  const name = (query.name ?? '').trim();
  if (name.length > 255 || name.includes('\0')) throw new ValidateException('模板搜索名称无效');
  let cursor: { sort: number; id: number } | undefined;
  if (query.cursor !== undefined) {
    if (!/^-?\d{1,10}:[1-9]\d{0,9}$/.test(query.cursor)) throw new ValidateException('运费列表游标无效');
    const [sort, id] = query.cursor.split(':');
    cursor = { sort: integer(sort, -2_147_483_648, 2_147_483_647), id: integer(id, 1, 2_147_483_647) };
  }
  return { limit, name, cursor };
}

// Keep Drizzle's camelCase keys and decimal string contract inside PostgreSQL JSON.
function rowJson(table: PgTable) {
  return sql`jsonb_build_object(${sql.join(Object.entries(getTableColumns(table)).flatMap(([key, column]) => [
    sql`${key}::text`, column.dataType === 'string' ? sql`${column}::text` : sql`${column}`,
  ]), sql`, `)})`;
}
interface Snapshot {
  list: Array<typeof shippingTemplates.$inferSelect>;
  regions: Array<typeof shippingTemplatesRegion.$inferSelect>;
  count: number;
  hasMore: boolean;
}

/** One data statement = one READ COMMITTED snapshot for parent, children and count.
 * No parent row locks and no cursor promise across separate HTTP requests.
 * Global-admin ownership visibility remains unchanged; only deleted parents are excluded.
 */
export async function listAdminShippingTemplates(container: Container, query: Record<string, string>) {
  const { limit, name, cursor } = input(query);
  const active = sql`${shippingTemplates.isDel}=0 ${name ? sql`AND strpos(lower(${shippingTemplates.name}),lower(${name}))>0` : sql``}`;
  return withTx(container, async tx => {
    await tx.execute(sql.raw(`SELECT
      set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
      set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000)::text || 'ms',true),
      set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true)`));
    const result = await tx.execute(sql`WITH candidates AS MATERIALIZED (
      SELECT * FROM ${shippingTemplates} WHERE ${active}
      ${cursor ? sql`AND (${shippingTemplates.sort},${shippingTemplates.id}) < (${cursor.sort},${cursor.id})` : sql``}
      ORDER BY ${shippingTemplates.sort} DESC,${shippingTemplates.id} DESC LIMIT ${limit + 1}
    ), selected AS MATERIALIZED (
      SELECT * FROM candidates ORDER BY sort DESC,id DESC LIMIT ${limit}
    ), selected_regions AS MATERIALIZED (
      SELECT * FROM ${shippingTemplatesRegion}
      WHERE ${shippingTemplatesRegion.templateId} IN (SELECT id FROM selected)
      ORDER BY ${shippingTemplatesRegion.id} LIMIT ${MAX_REGIONS + 1}
    ) SELECT jsonb_build_object(
      'list',COALESCE((SELECT jsonb_agg(${rowJson(shippingTemplates)} ORDER BY sort DESC,id DESC)
        FROM selected AS shipping_templates),'[]'::jsonb),
      'regions',COALESCE((SELECT jsonb_agg(${rowJson(shippingTemplatesRegion)} ORDER BY id)
        FROM selected_regions AS shipping_templates_region),'[]'::jsonb),
      'count',(SELECT count(*)::int FROM ${shippingTemplates} WHERE ${active}),
      'hasMore',(SELECT count(*)>${limit} FROM candidates)
    ) AS snapshot`);
    const snapshot = Array.from(result)[0]?.snapshot as Snapshot | undefined;
    if (!snapshot || !Array.isArray(snapshot.list) || !Array.isArray(snapshot.regions)) throw new Error('Missing shipping list snapshot');
    if (snapshot.regions.length > MAX_REGIONS) throw new ValidateException('当前页区域规则超过1000条，请减少每页模板数量');
    const last = snapshot.list.at(-1);
    return { list: snapshot.list, regions: snapshot.regions, count: snapshot.count, limit,
      nextCursor: snapshot.hasMore && last ? `${last.sort}:${last.id}` : null };
  });
}
