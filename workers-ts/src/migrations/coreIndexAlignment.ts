export const CORE_INDEX_ALIGNMENT_SQL = String.raw`
-- DB-009D2: restore exact initial-PHP/external index contracts omitted by Worker DDL.
-- The five already-covered aliases are deliberately excluded; nothing is dropped.
-- Apply only in a transaction. Existing duplicate recharge order IDs abort the
-- entire migration; never repair rows or silently accept a wrong-name index.
DO $core_index_alignment$
DECLARE
  target_schema text := current_schema();
  item record;
  table_oid oid;
  index_oid oid;
  expected_definition text;
  index_ready boolean;
BEGIN
  IF target_schema IS NULL THEN
    RAISE EXCEPTION '0135 target schema is missing';
  END IF;
  PERFORM set_config('lock_timeout', '2s', true);
  FOR item IN SELECT * FROM (VALUES
    ('store_cart', 'sc_product_id_idx', ARRAY['product_id']::text[], false),
    ('store_cart', 'sc_type_idx', ARRAY['type']::text[], false),
    ('store_cart', 'sc_uid_del_idx', ARRAY['uid', 'is_del']::text[], false),
    ('store_cart', 'sc_uid_pay_idx', ARRAY['uid', 'is_pay']::text[], false),
    ('store_coupon_issue', 'sci_status_idx', ARRAY['status']::text[], false),
    ('store_coupon_user', 'scu_uid_status_idx', ARRAY['uid', 'status']::text[], false),
    ('store_order', 'so_paid_idx', ARRAY['paid']::text[], false),
    ('store_order', 'so_status_idx', ARRAY['status']::text[], false),
    ('store_order', 'so_uid_idx', ARRAY['uid']::text[], false),
    ('store_order_cart_info', 'soci_oid_idx', ARRAY['oid']::text[], false),
    ('store_order_cart_info', 'soci_uid_idx', ARRAY['uid']::text[], false),
    ('store_order_refund', 'sor_cancel_oid_idx', ARRAY['is_cancel', 'store_order_id']::text[], false),
    ('store_order_refund', 'sor_uid_idx', ARRAY['uid']::text[], false),
    ('store_order_status', 'sos_change_time_idx', ARRAY['change_time']::text[], false),
    ('store_order_status', 'sos_oid_idx', ARRAY['oid']::text[], false),
    ('store_pink', 'sp_combination_idx', ARRAY['combination_id']::text[], false),
    ('store_product', 'sp_add_time_idx', ARRAY['add_time']::text[], false),
    ('store_product', 'sp_cate_id_idx', ARRAY['cate_id']::text[], false),
    ('store_product', 'sp_is_del_idx', ARRAY['is_del']::text[], false),
    ('store_product', 'sp_is_show_idx', ARRAY['is_show']::text[], false),
    ('store_product', 'sp_price_idx', ARRAY['price']::text[], false),
    ('store_product', 'sp_sales_idx', ARRAY['sales']::text[], false),
    ('store_product', 'sp_sort_idx', ARRAY['sort']::text[], false),
    ('store_product_attr', 'spa_product_id_idx', ARRAY['product_id']::text[], false),
    ('store_product_attr_result', 'spar_product_id_idx', ARRAY['product_id']::text[], false),
    ('store_product_attr_value', 'spav_product_suk_idx', ARRAY['product_id', 'suk']::text[], false),
    ('store_product_attr_value', 'spav_unique_suk_idx', ARRAY['unique', 'suk']::text[], false),
    ('store_product_category', 'spc_is_show_idx', ARRAY['is_show']::text[], false),
    ('store_product_category', 'spc_pid_idx', ARRAY['pid']::text[], false),
    ('store_product_label', 'spl_label_cate_idx', ARRAY['label_cate']::text[], false),
    ('store_product_relation', 'spr_product_id_idx', ARRAY['product_id']::text[], false),
    ('store_product_relation', 'spr_relation_id_idx', ARRAY['relation_id']::text[], false),
    ('store_product_relation', 'spr_type_idx', ARRAY['type']::text[], false),
    ('store_seckill', 'ss_time_idx', ARRAY['time_id']::text[], false),
    ('store_service_log', 'ssl_uid_toUid_idx', ARRAY['uid', 'to_uid']::text[], false),
    ('system_admin', 'sa_account_idx', ARRAY['account']::text[], false),
    ('system_config', 'system_config_is_store_idx', ARRAY['is_store']::text[], false),
    ('system_config', 'system_config_menu_name_idx', ARRAY['menu_name']::text[], false),
    ('user', 'user_account_idx', ARRAY['account']::text[], false),
    ('user', 'user_delete_time_idx', ARRAY['delete_time']::text[], false),
    ('user', 'user_phone_idx', ARRAY['phone']::text[], false),
    ('user', 'user_status_idx', ARRAY['status']::text[], false),
    ('user_bill', 'ub_cat_type_link_idx', ARRAY['category', 'type', 'link_id']::text[], false),
    ('user_bill', 'ub_uid_idx', ARRAY['uid']::text[], false),
    ('user_invoice', 'ui_uid_idx', ARRAY['uid']::text[], false),
    ('user_money', 'um_uid_idx', ARRAY['uid']::text[], false),
    ('user_recharge', 'ur_order_id_idx', ARRAY['order_id']::text[], true)
  ) AS expected(table_name, index_name, column_names, is_unique)
  LOOP
    SELECT c.oid INTO table_oid
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=target_schema AND c.relname=item.table_name
        AND c.relkind='r' AND c.relpersistence='p';
    IF table_oid IS NULL THEN
      RAISE EXCEPTION '0135 expected permanent table % is missing', item.table_name;
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
      RAISE EXCEPTION '0135 index definition drift: %.%', item.table_name, item.index_name;
    END IF;
  END LOOP;
END
$core_index_alignment$;
`;
