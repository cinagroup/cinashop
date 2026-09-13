import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';

/** One bounded, read-only snapshot of stored shipping references. This is an
 * installation prerequisite, NOT a migration installer or proof that triggers,
 * ACLs or future writes are protected. No business identifiers leave this audit.
 * A future installer must repeat validation behind its own write barrier.
 */
export async function auditShippingLifecycleBaseline(
  db: Pick<DbClient, 'transaction'> & Partial<Pick<DbClient, '$client'>>,
) {
  if (!db.$client) throw new Error('Shipping baseline requires a root database');
  return db.transaction(async tx => {
    await tx.execute(sql.raw(`SET LOCAL search_path=pg_catalog,pg_temp; SET LOCAL row_security=off;
      SELECT pg_catalog.set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
      pg_catalog.set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text || 'ms',true),
      pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true)`));
    const [identity] = await tx.select({ version: sql<number>`current_setting('server_version_num')::int`,
      readOnly: sql<boolean>`current_setting('transaction_read_only')='on'`,
      repeatableRead: sql<boolean>`current_setting('transaction_isolation')='repeatable read'` }).from(sql`(VALUES(1)) identity(n)`);
    if (!identity || Math.floor(identity.version / 10000) !== 16 || !identity.readOnly || !identity.repeatableRead) {
      throw new Error('Shipping baseline requires a PostgreSQL 16 read-only repeatable-read snapshot');
    }
    const catalog = await tx.select({ table: sql<string>`table_name`, compatible: sql<boolean>`compatible` }).from(sql`(
      WITH wanted(table_name,columns,types) AS (VALUES
        ('shipping_templates',ARRAY['id','owner_type','relation_id','is_del','status'],ARRAY[23,21,23,21,21]),
        ('store_product',ARRAY['id','type','relation_id','temp_id','freight'],ARRAY[23,21,23,23,21]),
        ('store_seckill',ARRAY['id','product_id','temp_id','freight'],ARRAY[23,23,23,21]),
        ('store_bargain',ARRAY['id','product_id','temp_id','freight'],ARRAY[23,23,23,21]),
        ('store_combination',ARRAY['id','product_id','temp_id','freight'],ARRAY[23,23,23,21]),
        ('store_integral',ARRAY['id','product_id','temp_id','freight'],ARRAY[23,23,23,21]),
        ('store_discounts_products',ARRAY['id','product_id','temp_id'],ARRAY[23,23,23])
      ) SELECT w.table_name, COALESCE(c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
        AND NOT EXISTS(SELECT 1 FROM unnest(w.columns,w.types) required(name,type_oid)
          LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attname=required.name AND a.attnum>0 AND NOT a.attisdropped
          WHERE a.attnum IS NULL OR a.atttypid<>required.type_oid OR NOT a.attnotnull OR a.attgenerated<>'')
        AND EXISTS(SELECT 1 FROM pg_catalog.pg_constraint pk JOIN pg_catalog.pg_attribute id ON id.attrelid=c.oid AND id.attname='id'
          WHERE pk.conrelid=c.oid AND pk.contype='p' AND pk.convalidated AND NOT pk.condeferrable AND pk.conkey=ARRAY[id.attnum]),false) AS compatible
      FROM wanted w LEFT JOIN pg_catalog.pg_namespace n ON n.nspname='public'
      LEFT JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid AND c.relname=w.table_name
    ) shape`).orderBy(sql`table_name`);
    const base = { scope: 'shipping-lifecycle-stored-reference-baseline' as const,
      protocolCatalogVerified: false as const, installationAuthorized: false as const,
      futureWritesProtected: false as const, readOnly: true as const, catalog };
    if (catalog.length !== 7 || catalog.some(row => !row.compatible)) {
      return { ...base, baselineReady: false, dataChecked: false, tables: [] };
    }
    // Explicit schema qualification prevents a temporary table/search-path
    // shadow from supplying apparently healthy rows. Include every retained row.
    const tables = await tx.select({ table: sql<string>`table_name`, rows: sql<number>`rows`,
      references: sql<number>`reference_count`, implicitDefault: sql<number>`implicit_default`,
      invalidReferences: sql<number>`invalid_references`, negativeTemplateId: sql<number>`negative_template_id`,
      missingSource: sql<number>`missing_source`, invalidSourceOwner: sql<number>`invalid_source_owner`,
      missingTemplate: sql<number>`missing_template`, unavailableTemplate: sql<number>`unavailable_template`,
      ownerMismatch: sql<number>`owner_mismatch` }).from(sql`(
      WITH stored AS MATERIALIZED (
        SELECT 'store_product'::text AS table_name,p.temp_id,p.freight,p.type AS owner_type,p.relation_id AS owner_id,true AS source_present FROM public.store_product p
        UNION ALL SELECT 'store_seckill',c.temp_id,c.freight,p.type,p.relation_id,p.id IS NOT NULL FROM public.store_seckill c LEFT JOIN public.store_product p ON p.id=c.product_id
        UNION ALL SELECT 'store_bargain',c.temp_id,c.freight,p.type,p.relation_id,p.id IS NOT NULL FROM public.store_bargain c LEFT JOIN public.store_product p ON p.id=c.product_id
        UNION ALL SELECT 'store_combination',c.temp_id,c.freight,p.type,p.relation_id,p.id IS NOT NULL FROM public.store_combination c LEFT JOIN public.store_product p ON p.id=c.product_id
        UNION ALL SELECT 'store_integral',c.temp_id,c.freight,p.type,p.relation_id,p.id IS NOT NULL FROM public.store_integral c LEFT JOIN public.store_product p ON p.id=c.product_id
        UNION ALL SELECT 'store_discounts_products',c.temp_id,2,p.type,p.relation_id,p.id IS NOT NULL FROM public.store_discounts_products c LEFT JOIN public.store_product p ON p.id=c.product_id
      ), refs AS (SELECT *,CASE WHEN temp_id>0 THEN temp_id WHEN freight NOT IN (1,2) THEN 1 ELSE 0 END AS ref FROM stored),
      checks AS (SELECT r.*,temp_id<0 AS bad_id,ref>0 AND NOT source_present AS bad_source,
        ref>0 AND source_present AND NOT COALESCE(r.owner_type IN (0,1,2) AND (CASE WHEN r.owner_type=0 THEN owner_id=0 ELSE owner_id>0 END),false) AS bad_owner,
        ref>0 AND t.id IS NULL AS missing_parent,
        ref>0 AND t.id IS NOT NULL AND (t.is_del<>0 OR t.status<>1) AS unavailable_parent,
        ref>0 AND source_present AND t.id IS NOT NULL AND (t.owner_type IS DISTINCT FROM r.owner_type OR t.relation_id IS DISTINCT FROM r.owner_id) AS wrong_owner
        FROM refs r LEFT JOIN public.shipping_templates t ON t.id=r.ref),
      names(table_name) AS (VALUES('store_product'),('store_seckill'),('store_bargain'),('store_combination'),('store_integral'),('store_discounts_products'))
      SELECT names.table_name,count(c.table_name)::int AS rows,count(*) FILTER(WHERE ref>0)::int AS reference_count,
        count(*) FILTER(WHERE ref=1 AND temp_id<=0)::int AS implicit_default,
        count(*) FILTER(WHERE bad_id OR bad_source OR bad_owner OR missing_parent OR unavailable_parent OR wrong_owner)::int AS invalid_references,
        count(*) FILTER(WHERE bad_id)::int AS negative_template_id,count(*) FILTER(WHERE bad_source)::int AS missing_source,
        count(*) FILTER(WHERE bad_owner)::int AS invalid_source_owner,count(*) FILTER(WHERE missing_parent)::int AS missing_template,
        count(*) FILTER(WHERE unavailable_parent)::int AS unavailable_template,count(*) FILTER(WHERE wrong_owner)::int AS owner_mismatch
      FROM names LEFT JOIN checks c ON c.table_name=names.table_name GROUP BY names.table_name
    ) baseline`).orderBy(sql`table_name`);
    return { ...base, baselineReady: tables.length === 6 && tables.every(row => row.invalidReferences === 0), dataChecked: true, tables };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
