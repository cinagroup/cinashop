import { SHIPPING_REFERENCE_EXPRESSION_SQL, SHIPPING_PACKAGE_REFERENCE_EXPRESSION_SQL } from '../lib/shippingReferenceExpression';

const referenceKey = '(\nCASE\n    WHEN (temp_id > 0) THEN temp_id\n    WHEN (freight <> ALL (ARRAY[1, 2])) THEN 1\n    ELSE 0\nEND)';
const packageKey = '(\nCASE\n    WHEN (temp_id > 0) THEN temp_id\n    ELSE 0\nEND)';
const reference = (table: string, name: string, packageTable = false) => ({ table, name,
  ddl: `CREATE INDEX ${name} ON public.${table} ((${packageTable ? SHIPPING_PACKAGE_REFERENCE_EXPRESSION_SQL : SHIPPING_REFERENCE_EXPRESSION_SQL}))`,
  definition: `CREATE INDEX ${name} ON public.${table} USING btree (${packageTable ? packageKey : referenceKey})`,
});
const source = (table: string, name: string) => ({ table, name,
  ddl: `CREATE INDEX ${name} ON public.${table} (product_id)`,
  definition: `CREATE INDEX ${name} ON public.${table} USING btree (product_id)`,
});

// Fixed application contract, not a manifest derived from the target catalog.
// All retained rows matter; no lifecycle predicate, INCLUDE, uniqueness or grants.
export const SHIPPING_LIFECYCLE_INDEXES = [
  reference('store_product', 'sp_shipping_ref'),
  reference('store_seckill', 'sseckill_shipping_ref'),
  reference('store_bargain', 'sbarg_shipping_ref'),
  reference('store_combination', 'scomb_shipping_ref'),
  reference('store_integral', 'sint_shipping_ref'),
  reference('store_discounts_products', 'sdp_shipping_ref', true),
  source('store_seckill', 'sseckill_shipping_source'),
  source('store_bargain', 'sbarg_shipping_source'),
  source('store_combination', 'scomb_shipping_source'),
  source('store_integral', 'sint_shipping_source'),
] as const;

export const SHIPPING_LIFECYCLE_INDEX_CATALOG_SQL = String.raw`
WITH wanted AS (SELECT * FROM jsonb_to_recordset($shipping_index_manifest$${JSON.stringify(SHIPPING_LIFECYCLE_INDEXES)}$shipping_index_manifest$::jsonb)
  AS w(name text,"table" text,definition text,ddl text))
SELECT w.name,w."table",w.ddl,c.oid IS NOT NULL AS present,
  COALESCE(c.relkind='i' AND c.relpersistence='p' AND NOT c.relispartition AND c.relowner=t.relowner
    AND c.reloptions IS NULL AND c.reltablespace=0 AND i.indrelid=t.oid
    AND NOT i.indisunique AND NOT i.indisprimary AND NOT i.indisexclusion
    AND i.indisvalid AND i.indisready AND i.indislive AND i.indimmediate
    AND NOT i.indnullsnotdistinct AND NOT i.indisreplident
    AND i.indnkeyatts=1 AND i.indnatts=1 AND i.indpred IS NULL
    AND pg_catalog.pg_get_indexdef(i.indexrelid)=w.definition
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conindid=i.indexrelid),false) AS compatible
FROM wanted w LEFT JOIN pg_catalog.pg_namespace n ON n.nspname='public'
LEFT JOIN pg_catalog.pg_class t ON t.relnamespace=n.oid AND t.relname=w."table"
LEFT JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid AND c.relname=w.name
LEFT JOIN pg_catalog.pg_index i ON i.indexrelid=c.oid
`;

// The package source lookup already has this all-state leading product_id index.
// It is a prerequisite, never recreated or replaced by the ten-index migration.
export const SHIPPING_LIFECYCLE_REUSED_INDEX_SQL = String.raw`
SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_index i
 JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid JOIN pg_catalog.pg_class t ON t.oid=i.indrelid
 JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname='sdp_product_discount' AND c.relkind='i' AND c.relpersistence='p'
 AND c.relowner=t.relowner AND c.reloptions IS NULL AND c.reltablespace=0
 AND i.indisvalid AND i.indisready AND i.indislive AND i.indimmediate
 AND NOT i.indisunique AND NOT i.indisprimary AND NOT i.indisexclusion AND NOT i.indisreplident AND NOT i.indnullsnotdistinct
 AND i.indnkeyatts=2 AND i.indnatts=2 AND i.indexprs IS NULL AND i.indpred IS NULL
 AND pg_catalog.pg_get_indexdef(i.indexrelid)='CREATE INDEX sdp_product_discount ON public.store_discounts_products USING btree (product_id, discount_id)'
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conindid=i.indexrelid)) AS compatible
`;
