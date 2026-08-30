/** Forward-only STORE-A delivery-list index used by the Worker migration runner. */
export const STORE_MOBILE_DELIVERY_INDEX_SQL = `
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '45s';

CREATE INDEX IF NOT EXISTS "so_delivery_mobile_active"
  ON "store_order" ("delivery_uid", "status", "add_time" DESC, "id" DESC)
  WHERE "delivery_uid" > 0
    AND "paid" = 1
    AND "is_del" = 0
    AND "is_system_del" = 0
    AND "refund_status" IN (0, 3);

DO $store_mobile_delivery_index_verification$
DECLARE
  actual RECORD;
BEGIN
  SELECT
    index_relation.relkind = 'i' AS is_index,
    indexed.indisunique AS is_unique,
    indexed.indisprimary AS is_primary,
    indexed.indisexclusion AS is_exclusion,
    indexed.indimmediate AS is_immediate,
    indexed.indisclustered AS is_clustered,
    indexed.indisreplident AS is_replica_identity,
    indexed.indisvalid AS is_valid,
    indexed.indisready AS is_ready,
    indexed.indislive AS is_live,
    indexed.indcheckxmin AS must_check_xmin,
    indexed.indnullsnotdistinct AS nulls_not_distinct,
    access_method.amname AS access_method,
    indexed.indnatts = indexed.indnkeyatts AS has_only_key_columns,
    indexed.indexprs IS NULL AS has_no_expressions,
    index_relation.reloptions IS NULL AS has_default_options,
    NOT EXISTS (
      SELECT 1 FROM pg_constraint attached
      WHERE attached.conindid = indexed.indexrelid
    ) AS is_unconstrained,
    ARRAY(
      SELECT pg_get_indexdef(indexed.indexrelid, position, true)
      FROM generate_series(1, indexed.indnkeyatts) AS position
      ORDER BY position
    ) AS key_columns,
    ARRAY(
      SELECT indexed.indoption[position]
      FROM generate_series(0, indexed.indnkeyatts - 1) AS position
      ORDER BY position
    )::smallint[] AS key_options,
    replace(replace(replace(replace(
      COALESCE(pg_get_expr(indexed.indpred, indexed.indrelid, true), ''),
      '(', ''), ')', ''), ' ', ''), '"', '') AS predicate_sql
  INTO actual
  FROM pg_index indexed
  JOIN pg_class index_relation ON index_relation.oid = indexed.indexrelid
  JOIN pg_class table_relation ON table_relation.oid = indexed.indrelid
  JOIN pg_namespace index_namespace ON index_namespace.oid = index_relation.relnamespace
  JOIN pg_namespace table_namespace ON table_namespace.oid = table_relation.relnamespace
  JOIN pg_am access_method ON access_method.oid = index_relation.relam
  WHERE index_namespace.nspname = current_schema()
    AND table_namespace.nspname = current_schema()
    AND index_relation.relname = 'so_delivery_mobile_active'
    AND table_relation.relname = 'store_order'
  LIMIT 1;

  IF NOT FOUND
    OR actual.is_index IS DISTINCT FROM true
    OR actual.is_unique IS DISTINCT FROM false
    OR actual.is_primary IS DISTINCT FROM false
    OR actual.is_exclusion IS DISTINCT FROM false
    OR actual.is_immediate IS DISTINCT FROM true
    OR actual.is_clustered IS DISTINCT FROM false
    OR actual.is_replica_identity IS DISTINCT FROM false
    OR actual.is_valid IS DISTINCT FROM true
    OR actual.is_ready IS DISTINCT FROM true
    OR actual.is_live IS DISTINCT FROM true
    OR actual.must_check_xmin IS DISTINCT FROM false
    OR actual.nulls_not_distinct IS DISTINCT FROM false
    OR actual.access_method IS DISTINCT FROM 'btree'
    OR actual.has_only_key_columns IS DISTINCT FROM true
    OR actual.has_no_expressions IS DISTINCT FROM true
    OR actual.has_default_options IS DISTINCT FROM true
    OR actual.is_unconstrained IS DISTINCT FROM true
    OR actual.key_columns IS DISTINCT FROM ARRAY['delivery_uid', 'status', 'add_time', 'id']::text[]
    OR actual.key_options IS DISTINCT FROM ARRAY[0, 0, 3, 3]::smallint[]
    OR actual.predicate_sql IS DISTINCT FROM 'delivery_uid>0ANDpaid=1ANDis_del=0ANDis_system_del=0ANDrefund_status=ANYARRAY[0,3]'
  THEN
    RAISE EXCEPTION 'Unexpected definition for store mobile delivery index so_delivery_mobile_active';
  END IF;
END
$store_mobile_delivery_index_verification$;
`.trim();

/** Forward-only STORE-B refund lookup index used by the Worker migration runner. */
export const STORE_MOBILE_ORDER_REFUND_INDEX_SQL = `
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '45s';

CREATE INDEX IF NOT EXISTS "sor_store_order_id"
  ON "store_order_refund" ("store_order_id");

DO $store_order_refund_lookup_index_verification$
DECLARE
  actual RECORD;
BEGIN
  SELECT
    index_relation.relkind = 'i' AS is_index,
    indexed.indisunique AS is_unique,
    indexed.indisprimary AS is_primary,
    indexed.indisexclusion AS is_exclusion,
    indexed.indimmediate AS is_immediate,
    indexed.indisclustered AS is_clustered,
    indexed.indisreplident AS is_replica_identity,
    indexed.indisvalid AS is_valid,
    indexed.indisready AS is_ready,
    indexed.indislive AS is_live,
    indexed.indcheckxmin AS must_check_xmin,
    indexed.indnullsnotdistinct AS nulls_not_distinct,
    access_method.amname AS access_method,
    indexed.indnatts = indexed.indnkeyatts AS has_only_key_columns,
    indexed.indexprs IS NULL AS has_no_expressions,
    indexed.indpred IS NULL AS has_no_predicate,
    index_relation.reloptions IS NULL AS has_default_options,
    NOT EXISTS (
      SELECT 1 FROM pg_constraint attached
      WHERE attached.conindid = indexed.indexrelid
    ) AS is_unconstrained,
    ARRAY(
      SELECT pg_get_indexdef(indexed.indexrelid, position, true)
      FROM generate_series(1, indexed.indnkeyatts) AS position
      ORDER BY position
    ) AS key_columns,
    ARRAY(
      SELECT indexed.indoption[position]
      FROM generate_series(0, indexed.indnkeyatts - 1) AS position
      ORDER BY position
    )::smallint[] AS key_options
  INTO actual
  FROM pg_index indexed
  JOIN pg_class index_relation ON index_relation.oid = indexed.indexrelid
  JOIN pg_class table_relation ON table_relation.oid = indexed.indrelid
  JOIN pg_namespace index_namespace ON index_namespace.oid = index_relation.relnamespace
  JOIN pg_namespace table_namespace ON table_namespace.oid = table_relation.relnamespace
  JOIN pg_am access_method ON access_method.oid = index_relation.relam
  WHERE index_namespace.nspname = current_schema()
    AND table_namespace.nspname = current_schema()
    AND index_relation.relname = 'sor_store_order_id'
    AND table_relation.relname = 'store_order_refund'
  LIMIT 1;

  IF NOT FOUND
    OR actual.is_index IS DISTINCT FROM true
    OR actual.is_unique IS DISTINCT FROM false
    OR actual.is_primary IS DISTINCT FROM false
    OR actual.is_exclusion IS DISTINCT FROM false
    OR actual.is_immediate IS DISTINCT FROM true
    OR actual.is_clustered IS DISTINCT FROM false
    OR actual.is_replica_identity IS DISTINCT FROM false
    OR actual.is_valid IS DISTINCT FROM true
    OR actual.is_ready IS DISTINCT FROM true
    OR actual.is_live IS DISTINCT FROM true
    OR actual.must_check_xmin IS DISTINCT FROM false
    OR actual.nulls_not_distinct IS DISTINCT FROM false
    OR actual.access_method IS DISTINCT FROM 'btree'
    OR actual.has_only_key_columns IS DISTINCT FROM true
    OR actual.has_no_expressions IS DISTINCT FROM true
    OR actual.has_no_predicate IS DISTINCT FROM true
    OR actual.has_default_options IS DISTINCT FROM true
    OR actual.is_unconstrained IS DISTINCT FROM true
    OR actual.key_columns IS DISTINCT FROM ARRAY['store_order_id']::text[]
    OR actual.key_options IS DISTINCT FROM ARRAY[0]::smallint[]
  THEN
    RAISE EXCEPTION 'Unexpected definition for refund lookup index sor_store_order_id';
  END IF;
END
$store_order_refund_lookup_index_verification$;
`.trim();
