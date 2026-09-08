-- DB-009G1: indexes for all states of two child references, including soft-deleted rows.
-- Apply after existing migrations, in a caller-owned bounded transaction.
-- Regular index builds block writes, not reads. Use a maintenance window.
-- Existing databases use runForeignKeyChildIndexes(), never MigrationService.runAll().
DO $foreign_key_child_indexes$
DECLARE
  target_schema text := pg_catalog.current_schema();
  original_path text := pg_catalog.current_setting('search_path');
  target record;
  table_oid oid;
  table_owner oid;
  index_oid oid;
  index_ready boolean;
  expected_definition text;
BEGIN
  IF target_schema IS NULL OR pg_catalog.left(target_schema, 3) = 'pg_' OR target_schema = 'information_schema' THEN
    RAISE EXCEPTION '0147 expected application schema';
  END IF;
  PERFORM set_config('search_path', 'pg_catalog, pg_temp', true);
  PERFORM set_config('lock_timeout',
    LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000)::text || 'ms', true);
  IF EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtenabled <> 'D') THEN
    RAISE EXCEPTION '0147 enabled DDL event triggers require explicit review';
  END IF;
  -- Stable lock/build order. A later failure rolls back both additions.
  FOR target IN SELECT * FROM (VALUES
    ('payment_reconciliation_case', 'callback_event_id', 'bigint'::regtype, 'prc_callback_event'),
    ('store_product_reply', 'order_cart_info_id', 'integer'::regtype, 'spr_order_cart_info')
  ) AS targets(table_name, column_name, type_oid, index_name) ORDER BY table_name
  LOOP
    SELECT c.oid, c.relowner INTO table_oid, table_owner
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=target_schema AND c.relname=target.table_name
        AND c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition;
    IF table_oid IS NULL THEN
      RAISE EXCEPTION '0147 expected permanent table: %', target.table_name;
    END IF;
    EXECUTE format('LOCK TABLE ONLY %I.%I IN SHARE MODE', target_schema, target.table_name);
    IF EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid=table_oid OR inhparent=table_oid) THEN
      RAISE EXCEPTION '0147 inherited tables require explicit review: %', target.table_name;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid=table_oid AND a.attname=target.column_name AND NOT a.attisdropped
        AND a.attnum>0 AND a.atttypid=target.type_oid AND a.atttypmod=-1
        AND NOT a.attnotnull AND a.attgenerated='' AND a.attidentity='' AND a.attcollation=0
    ) THEN
      RAISE EXCEPTION '0147 reference column drift: %.%', target.table_name, target.column_name;
    END IF;
    expected_definition := format('CREATE INDEX %I ON %I.%I USING btree (%I)',
      target.index_name, target_schema, target.table_name, target.column_name);
    SELECT c.oid INTO index_oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=target_schema AND c.relname=target.index_name;
    IF index_oid IS NULL THEN
      EXECUTE expected_definition;
      SELECT c.oid INTO index_oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=target_schema AND c.relname=target.index_name;
    END IF;
    SELECT c.relkind='i' AND c.relpersistence='p' AND c.relowner=table_owner
      AND c.reloptions IS NULL AND c.reltablespace=0 AND i.indrelid=table_oid
      AND NOT i.indisunique AND NOT i.indisprimary AND NOT i.indisexclusion
      AND i.indisvalid AND i.indisready AND i.indislive AND i.indimmediate
      AND NOT i.indnullsnotdistinct AND NOT i.indisreplident
      AND i.indnkeyatts=1 AND i.indnatts=1 AND i.indexprs IS NULL AND i.indpred IS NULL
      AND pg_get_indexdef(i.indexrelid)=expected_definition
      AND NOT EXISTS (SELECT 1 FROM pg_constraint owner WHERE owner.conindid=i.indexrelid)
      INTO index_ready FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
      WHERE i.indexrelid=index_oid;
    IF index_ready IS DISTINCT FROM true THEN
      RAISE EXCEPTION '0147 index definition drift: %.%', target.table_name, target.index_name;
    END IF;
  END LOOP;
  PERFORM set_config('search_path', original_path, true);
END
$foreign_key_child_indexes$;
