/** Idempotent USER-CENTER-COMPAT indexes shared by migration and audit code. */
export const USER_CENTER_COMPATIBILITY_INDEX_SQL = `
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE INDEX IF NOT EXISTS "ua_uid_idx"
  ON "user_address" ("uid");

CREATE UNIQUE INDEX IF NOT EXISTS "ur_uid_rel_type_cat_idx"
  ON "user_relation" ("uid", "relation_id", "type", "category");

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
      ('ua_uid_idx'::text, 'user_address'::text, false, ARRAY['uid']::text[], ''::text),
      ('ur_uid_rel_type_cat_idx', 'user_relation', true,
        ARRAY['uid', 'relation_id', 'type', 'category']::text[], ''),
      ('ur_uid_type_idx', 'user_relation', false, ARRAY['uid', 'type']::text[], ''),
      ('ur_collect_category_relation_idx', 'user_relation', false,
        ARRAY['category', 'relation_id']::text[], 'type::text=''collect''::text'),
      ('us_uid_time_idx', 'user_sign', false, ARRAY['uid', 'add_time']::text[], ''),
      ('us_uid_shanghai_day_uq', 'user_sign', true,
        ARRAY['uid', '((add_time::bigint + 28800) / 86400)']::text[], '')
    ) AS specification(index_name, table_name, is_unique, key_columns, predicate_sql)
  LOOP
    SELECT
      indexed.indisunique AS is_unique,
      access_method.amname AS access_method,
      indexed.indnatts = indexed.indnkeyatts AS has_only_key_columns,
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
      OR actual.is_unique IS DISTINCT FROM expected.is_unique
      OR actual.access_method IS DISTINCT FROM 'btree'
      OR actual.has_only_key_columns IS DISTINCT FROM true
      OR actual.key_columns IS DISTINCT FROM expected.key_columns
      OR actual.predicate_sql IS DISTINCT FROM expected.predicate_sql
    THEN
      RAISE EXCEPTION 'Unexpected definition for user-center index %', expected.index_name;
    END IF;
  END LOOP;
END
$user_center_index_verification$;
`.trim();
