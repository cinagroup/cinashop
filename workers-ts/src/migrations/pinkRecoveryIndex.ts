export const PINK_RECOVERY_INDEX_SQL = String.raw`
-- B1: additive recovery-scan index; no business-row or sequence changes.
-- Apply after existing migrations, in a caller-owned bounded transaction.
-- A regular index build blocks writes, not reads. Schedule a maintenance window.
-- For existing databases use runPinkRecoveryIndex(), never MigrationService.runAll().
DO $pink_recovery_index$
DECLARE
  target_schema text := pg_catalog.current_schema();
  original_path text := pg_catalog.current_setting('search_path');
  table_oid oid;
  table_owner oid;
  index_oid oid;
  index_ready boolean;
  expected_definition text;
  expected_predicate text := $predicate$((is_cancel = 0) AND (is_del = 0) AND (apply_type = 1) AND (refund_type = ANY (ARRAY[0, 1, 2, 4, 5])) AND ((refund_reason)::text = '用户手动取消拼团'::text) AND ((refund_explain)::text = '用户手动取消未成团的拼团订单'::text) AND ("left"((order_id)::text, 12) = 'pink_cancel_'::text))$predicate$;
BEGIN
  IF target_schema IS NULL OR pg_catalog.left(target_schema, 3) = 'pg_' OR target_schema = 'information_schema' THEN
    RAISE EXCEPTION '0146 expected application schema';
  END IF;
  -- Do not resolve functions/operators/catalogs through a pooled application path.
  PERFORM set_config('search_path', 'pg_catalog, pg_temp', true);
  PERFORM set_config('lock_timeout',
    LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000)::text || 'ms', true);
  IF EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtenabled <> 'D') THEN
    RAISE EXCEPTION '0146 enabled DDL event triggers require explicit review';
  END IF;
  SELECT c.oid, c.relowner INTO table_oid, table_owner
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=target_schema AND c.relname='store_order_refund'
      AND c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition;
  IF table_oid IS NULL THEN
    RAISE EXCEPTION '0146 expected permanent store_order_refund table';
  END IF;
  EXECUTE format('LOCK TABLE ONLY %I.store_order_refund IN SHARE MODE', target_schema);
  IF EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid=table_oid OR inhparent=table_oid) THEN
    RAISE EXCEPTION '0146 inherited refund tables require explicit review';
  END IF;
  -- The canonical predicate below is specific to these built-in operand types.
  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('id','integer'::regtype,-1), ('add_time','integer'::regtype,-1),
      ('is_cancel','smallint'::regtype,-1), ('is_del','smallint'::regtype,-1),
      ('apply_type','smallint'::regtype,-1), ('refund_type','smallint'::regtype,-1),
      ('refund_reason','character varying'::regtype,259),
      ('refund_explain','character varying'::regtype,259),
      ('order_id','character varying'::regtype,54)
    ) AS expected(name,type_oid,type_modifier)
    LEFT JOIN pg_attribute a ON a.attrelid=table_oid AND a.attname=expected.name AND NOT a.attisdropped
    LEFT JOIN pg_type t ON t.oid=a.atttypid
    WHERE a.attnum IS NULL OR a.attnum <= 0 OR a.atttypid <> expected.type_oid
      OR a.atttypmod <> expected.type_modifier OR NOT a.attnotnull
      OR a.attgenerated <> '' OR a.attcollation <> t.typcollation
  ) THEN
    RAISE EXCEPTION '0146 recovery operand column drift';
  END IF;
  expected_definition := format(
    'CREATE INDEX sor_pink_recovery_scan ON %I.store_order_refund USING btree (id, add_time) WHERE %s',
    target_schema, expected_predicate);
  SELECT c.oid INTO index_oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=target_schema AND c.relname='sor_pink_recovery_scan';
  IF index_oid IS NULL THEN
    EXECUTE expected_definition;
    SELECT c.oid INTO index_oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=target_schema AND c.relname='sor_pink_recovery_scan';
  END IF;
  SELECT c.relkind='i' AND c.relpersistence='p' AND c.relowner=table_owner
    AND c.reloptions IS NULL AND i.indrelid=table_oid
    AND NOT i.indisunique AND NOT i.indisprimary AND NOT i.indisexclusion
    AND i.indisvalid AND i.indisready AND i.indislive AND i.indimmediate
    AND NOT i.indnullsnotdistinct AND NOT i.indisreplident
    AND i.indnkeyatts=2 AND i.indnatts=i.indnkeyatts AND i.indexprs IS NULL
    AND pg_get_indexdef(i.indexrelid)=expected_definition
    AND NOT EXISTS (SELECT 1 FROM pg_constraint owner WHERE owner.conindid=i.indexrelid)
    INTO index_ready FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
    WHERE i.indexrelid=index_oid;
  IF index_ready IS DISTINCT FROM true THEN
    RAISE EXCEPTION '0146 index definition drift: store_order_refund.sor_pink_recovery_scan';
  END IF;
  PERFORM set_config('search_path', original_path, true);
END
$pink_recovery_index$;
`;
