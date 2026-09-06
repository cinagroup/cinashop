-- DB-009D2b3a: restore 28 PHP-backed query indexes already declared by ORM.
-- Exact ordered nonunique/non-prefix source keys are pinned in the audit manifest.
-- Apply in a transaction after all preceding migrations; no business-row changes.
-- Unknown same-name shapes abort; existing aliases and constraints remain intact.
DO $legacy_query_index_alignment$
DECLARE
  target_schema text := current_schema();
  item record;
  table_oid oid;
  index_oid oid;
  expected_definition text;
  index_ready boolean;
BEGIN
  IF target_schema IS NULL THEN
    RAISE EXCEPTION '0136 target schema is missing';
  END IF;
  PERFORM set_config('lock_timeout', '2s', true);
  FOR item IN SELECT * FROM (VALUES
    ('community', 'c_type', ARRAY['type']::text[], false),
    ('community_comment', 'cc_community', ARRAY['community_id']::text[], false),
    ('store_cart', 'sc_uid_new', ARRAY['uid', 'is_new']::text[], false),
    ('store_order', 'so_add_time', ARRAY['add_time']::text[], false),
    ('store_order_refund', 'sor_order_id', ARRAY['order_id']::text[], false),
    ('store_order_status', 'sos_change_type', ARRAY['change_type']::text[], false),
    ('store_product', 'is_benefit', ARRAY['is_benefit']::text[], false),
    ('store_product', 'is_best', ARRAY['is_best']::text[], false),
    ('store_product', 'is_hot', ARRAY['is_hot']::text[], false),
    ('store_product', 'is_new', ARRAY['is_new']::text[], false),
    ('store_product', 'is_postage', ARRAY['is_postage']::text[], false),
    ('store_product_category', 'add_time', ARRAY['add_time']::text[], false),
    ('store_product_category', 'sort', ARRAY['sort']::text[], false),
    ('store_product_label', 'type_label', ARRAY['type']::text[], false),
    ('store_seckill', 'ss_status', ARRAY['status']::text[], false),
    ('system_admin', 'sa_status', ARRAY['status']::text[], false),
    ('system_config', 'config_tab_id', ARRAY['config_tab_id']::text[], false),
    ('user', 'add_time_delete_sex', ARRAY['add_time', 'delete_time', 'sex']::text[], false),
    ('user', 'is_promoter', ARRAY['is_promoter', 'phone']::text[], false),
    ('user', 'level', ARRAY['level']::text[], false),
    ('user', 'spreaduid', ARRAY['spread_uid']::text[], false),
    ('user', 'work_uid', ARRAY['work_uid']::text[], false),
    ('user_bill', 'ub_add_time', ARRAY['add_time']::text[], false),
    ('user_bill', 'ub_pm', ARRAY['pm']::text[], false),
    ('user_bill', 'ub_status', ARRAY['status']::text[], false),
    ('user_brokerage', 'ub_uid', ARRAY['uid']::text[], false),
    ('user_extract', 'ue_uid', ARRAY['uid']::text[], false),
    ('user_money', 'um_type_link', ARRAY['type', 'link_id']::text[], false)
  ) AS expected(table_name, index_name, column_names, is_unique)
  LOOP
    SELECT c.oid INTO table_oid
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=target_schema AND c.relname=item.table_name
        AND c.relkind='r' AND c.relpersistence='p';
    IF table_oid IS NULL THEN
      RAISE EXCEPTION '0136 expected permanent table % is missing', item.table_name;
    END IF;
    -- Pin table/index shape while validating or building; 2s bounds lock waits.
    EXECUTE format('LOCK TABLE %I.%I IN SHARE MODE', target_schema, item.table_name);
    expected_definition := format('CREATE %sINDEX %I ON %I.%I USING btree (%s)',
      CASE WHEN item.is_unique THEN 'UNIQUE ' ELSE '' END,
      item.index_name, target_schema, item.table_name,
      (SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal)
        FROM unnest(item.column_names) WITH ORDINALITY AS columns(column_name, ordinal)));
    SELECT c.oid INTO index_oid
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=target_schema AND c.relname=item.index_name;
    IF index_oid IS NULL THEN
      EXECUTE expected_definition;
      SELECT c.oid INTO index_oid
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=target_schema AND c.relname=item.index_name;
    END IF;
    SELECT c.relkind='i' AND c.relpersistence='p' AND i.indrelid=table_oid
      AND i.indisunique=item.is_unique AND NOT i.indisprimary AND NOT i.indisexclusion
      AND i.indisvalid AND i.indisready AND i.indislive AND i.indimmediate
      AND NOT i.indnullsnotdistinct AND NOT i.indisreplident
      AND i.indnkeyatts=cardinality(item.column_names) AND i.indnatts=i.indnkeyatts
      AND i.indexprs IS NULL AND i.indpred IS NULL
      AND pg_get_indexdef(i.indexrelid)=expected_definition
      AND NOT EXISTS(SELECT 1 FROM pg_constraint owner
        WHERE owner.conindid=i.indexrelid AND owner.contype IN ('p','u','x'))
      INTO index_ready
      FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
      WHERE i.indexrelid=index_oid;
    IF index_ready IS DISTINCT FROM true THEN
      RAISE EXCEPTION '0136 index definition drift: %.%', item.table_name, item.index_name;
    END IF;
  END LOOP;
END
$legacy_query_index_alignment$;
