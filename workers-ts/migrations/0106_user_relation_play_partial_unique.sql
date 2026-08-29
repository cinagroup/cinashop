-- Forward-only USER-CENTER upgrade: keep play events append-only while all
-- other relationship kinds remain idempotent.
-- Run through the transactional migration runner; SET LOCAL is not a
-- standalone psql transaction boundary.
-- The partial unique relation index is required by the explicit four-column
-- ON CONFLICT target used for idempotent non-play writes. Play rows are events.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE INDEX IF NOT EXISTS "ua_uid_idx"
  ON "user_address" ("uid");

-- 0004 created this name as a full unique index. Replace only that exact,
-- ordinary legacy definition; an unexpected namesake is left intact so the
-- strict verification below fails closed instead of dropping unknown DDL.
DO $user_relation_unique_upgrade$
DECLARE
  legacy RECORD;
BEGIN
  SELECT
    table_namespace.nspname AS table_schema,
    table_relation.relname AS table_name,
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
    replace(replace(replace(replace(
      COALESCE(pg_get_expr(indexed.indpred, indexed.indrelid, true), ''),
      '(', ''), ')', ''), ' ', ''), '"', '') AS predicate_sql
  INTO legacy
  FROM pg_index indexed
  JOIN pg_class index_relation ON index_relation.oid = indexed.indexrelid
  JOIN pg_class table_relation ON table_relation.oid = indexed.indrelid
  JOIN pg_namespace index_namespace ON index_namespace.oid = index_relation.relnamespace
  JOIN pg_namespace table_namespace ON table_namespace.oid = table_relation.relnamespace
  JOIN pg_am access_method ON access_method.oid = index_relation.relam
  WHERE index_namespace.nspname = current_schema()
    AND index_relation.relname = 'ur_uid_rel_type_cat_idx'
  LIMIT 1;

  IF FOUND
    AND legacy.table_schema IS NOT DISTINCT FROM current_schema()
    AND legacy.table_name IS NOT DISTINCT FROM 'user_relation'
    AND legacy.is_index IS NOT DISTINCT FROM true
    AND legacy.is_unique IS NOT DISTINCT FROM true
    AND legacy.is_primary IS NOT DISTINCT FROM false
    AND legacy.is_exclusion IS NOT DISTINCT FROM false
    AND legacy.is_immediate IS NOT DISTINCT FROM true
    AND legacy.is_clustered IS NOT DISTINCT FROM false
    AND legacy.is_replica_identity IS NOT DISTINCT FROM false
    AND legacy.is_valid IS NOT DISTINCT FROM true
    AND legacy.is_ready IS NOT DISTINCT FROM true
    AND legacy.is_live IS NOT DISTINCT FROM true
    AND legacy.must_check_xmin IS NOT DISTINCT FROM false
    AND legacy.nulls_not_distinct IS NOT DISTINCT FROM false
    AND legacy.access_method IS NOT DISTINCT FROM 'btree'
    AND legacy.has_only_key_columns IS NOT DISTINCT FROM true
    AND legacy.has_no_expressions IS NOT DISTINCT FROM true
    AND legacy.has_default_options IS NOT DISTINCT FROM true
    AND legacy.is_unconstrained IS NOT DISTINCT FROM true
    AND legacy.key_columns IS NOT DISTINCT FROM ARRAY['uid', 'relation_id', 'type', 'category']::text[]
    AND legacy.predicate_sql IS NOT DISTINCT FROM ''
  THEN
    EXECUTE format('DROP INDEX %I.%I', current_schema(), 'ur_uid_rel_type_cat_idx');
  END IF;
END
$user_relation_unique_upgrade$;

CREATE UNIQUE INDEX IF NOT EXISTS "ur_uid_rel_type_cat_idx"
  ON "user_relation" ("uid", "relation_id", "type", "category")
  WHERE "type" <> 'play';

CREATE INDEX IF NOT EXISTS "ur_uid_type_idx"
  ON "user_relation" ("uid", "type");

CREATE INDEX IF NOT EXISTS "ur_collect_category_relation_idx"
  ON "user_relation" ("category", "relation_id")
  WHERE "type" = 'collect';

CREATE INDEX IF NOT EXISTS "us_uid_time_idx"
  ON "user_sign" ("uid", "add_time");

-- Advisory locks only serialize Worker requests. This database invariant also
-- rejects a concurrent legacy-PHP write in the same Asia/Shanghai business day.
CREATE UNIQUE INDEX IF NOT EXISTS "us_uid_shanghai_day_uq"
  ON "user_sign" ("uid", ((("add_time"::bigint + 28800) / 86400)));

-- CREATE INDEX IF NOT EXISTS only compares names. Fail closed when a
-- pre-existing name points at the wrong table, key order, uniqueness, access
-- method, INCLUDE list, or partial predicate.
DO $user_center_index_verification$
DECLARE
  expected RECORD;
  actual RECORD;
BEGIN
  FOR expected IN
    SELECT * FROM (VALUES
      ('ua_uid_idx'::text, 'user_address'::text, false, ARRAY['uid']::text[], ''::text, true),
      ('ur_uid_rel_type_cat_idx', 'user_relation', true,
        ARRAY['uid', 'relation_id', 'type', 'category']::text[], 'type::text<>''play''::text', true),
      ('ur_uid_type_idx', 'user_relation', false, ARRAY['uid', 'type']::text[], '', true),
      ('ur_collect_category_relation_idx', 'user_relation', false,
        ARRAY['category', 'relation_id']::text[], 'type::text=''collect''::text', true),
      ('us_uid_time_idx', 'user_sign', false, ARRAY['uid', 'add_time']::text[], '', true),
      ('us_uid_shanghai_day_uq', 'user_sign', true,
        ARRAY['uid', '((add_time::bigint + 28800) / 86400)']::text[], '', false)
    ) AS specification(index_name, table_name, is_unique, key_columns, predicate_sql, has_no_expressions)
  LOOP
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
      AND index_relation.relname = expected.index_name
      AND table_relation.relname = expected.table_name
      AND indexed.indisvalid
      AND indexed.indisready
    LIMIT 1;

    IF NOT FOUND
      OR actual.is_index IS DISTINCT FROM true
      OR actual.is_unique IS DISTINCT FROM expected.is_unique
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
      OR actual.has_no_expressions IS DISTINCT FROM expected.has_no_expressions
      OR actual.has_default_options IS DISTINCT FROM true
      OR actual.is_unconstrained IS DISTINCT FROM true
      OR actual.key_columns IS DISTINCT FROM expected.key_columns
      OR actual.predicate_sql IS DISTINCT FROM expected.predicate_sql
    THEN
      RAISE EXCEPTION 'Unexpected definition for user-center index %', expected.index_name;
    END IF;
  END LOOP;
END
$user_center_index_verification$;
