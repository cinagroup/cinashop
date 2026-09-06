export const WORKER_QUERY_INDEX_ALIGNMENT_SQL = String.raw`
-- DB-009D2b3b: restore 20 query indexes with existing Worker code consumers.
-- Full query/canonical catalog evidence is pinned in the audit manifest.
-- Apply in a transaction after preceding migrations; no business-row changes.
-- Keep aliases and existing unique indexes. No production execution implied.
DO $worker_query_index_alignment$
DECLARE
  target_schema text := current_schema();
  item record;
  table_oid oid;
  index_oid oid;
  expected_definition text;
  index_ready boolean;
BEGIN
  IF target_schema IS NULL THEN
    RAISE EXCEPTION '0137 target schema is missing';
  END IF;
  PERFORM set_config('lock_timeout', '2s', true);
  FOR item IN SELECT * FROM (VALUES
    ('community', 'c_add_time', ARRAY['add_time']::text[], false),
    ('community', 'c_status', ARRAY['status']::text[], false),
    ('community_comment', 'cc_add_time', ARRAY['add_time']::text[], false),
    ('community_comment', 'cc_uid', ARRAY['uid']::text[], false),
    ('express_company', 'ec_status', ARRAY['status']::text[], false),
    ('shipping_templates', 'st_status', ARRAY['status']::text[], false),
    ('store_bargain', 'sbarg_status', ARRAY['status']::text[], false),
    ('store_bargain_user', 'sbu_bargain', ARRAY['bargain_id']::text[], false),
    ('store_bargain_user', 'sbu_uid', ARRAY['uid']::text[], false),
    ('store_combination', 'scomb_status', ARRAY['status']::text[], false),
    ('store_coupon_issue', 'sci_type', ARRAY['coupon_type']::text[], false),
    ('store_integral', 'sint_status', ARRAY['status']::text[], false),
    ('store_pink', 'sp_kid', ARRAY['k_id']::text[], false),
    ('store_service', 'ss_account', ARRAY['account']::text[], false),
    ('store_service_log', 'ssl_add_time', ARRAY['add_time']::text[], false),
    ('system_message', 'sm_add_time', ARRAY['add_time']::text[], false),
    ('system_message', 'sm_user', ARRAY['user_id']::text[], false),
    ('user_brokerage', 'ub_cat_type', ARRAY['category', 'type']::text[], false),
    ('user_brokerage', 'ub_link', ARRAY['link_id']::text[], false),
    ('user_message', 'um_uid_msg', ARRAY['uid', 'message_id']::text[], false)
  ) AS expected(table_name, index_name, column_names, is_unique)
  LOOP
    SELECT c.oid INTO table_oid
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=target_schema AND c.relname=item.table_name
        AND c.relkind='r' AND c.relpersistence='p';
    IF table_oid IS NULL THEN
      RAISE EXCEPTION '0137 expected permanent table % is missing', item.table_name;
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
      RAISE EXCEPTION '0137 index definition drift: %.%', item.table_name, item.index_name;
    END IF;
  END LOOP;
END
$worker_query_index_alignment$;
`;
