-- DB-009D2b3c: align 44 reviewed ordinary index names without rebuilding them.
-- Apply after preceding migrations, inside a transaction; no business-row changes.
-- Exactly one reviewed old/new name must exist. Ambiguous or unknown shapes abort.
DO $ordinary_index_name_alignment$
DECLARE
  target_schema text := current_schema();
  item record;
  table_oid oid;
  old_oid oid;
  target_oid oid;
  selected_oid oid;
  selected_name text;
  expected_definition text;
  aligned boolean;
BEGIN
  IF target_schema IS NULL THEN
    RAISE EXCEPTION '0138 target schema is missing';
  END IF;
  PERFORM set_config('lock_timeout', '2s', true);
  FOR item IN SELECT * FROM (VALUES
    ('store_cart', 'sc_product_id', 'sc_product_id_idx', ARRAY['product_id']::text[]),
    ('store_cart', 'sc_type', 'sc_type_idx', ARRAY['type']::text[]),
    ('store_cart', 'sc_uid_del', 'sc_uid_del_idx', ARRAY['uid', 'is_del']::text[]),
    ('store_cart', 'sc_uid_pay', 'sc_uid_pay_idx', ARRAY['uid', 'is_pay']::text[]),
    ('store_coupon_issue', 'sci_status', 'sci_status_idx', ARRAY['status']::text[]),
    ('store_coupon_user', 'scu_uid_status', 'scu_uid_status_idx', ARRAY['uid', 'status']::text[]),
    ('store_order', 'so_paid', 'so_paid_idx', ARRAY['paid']::text[]),
    ('store_order', 'so_status', 'so_status_idx', ARRAY['status']::text[]),
    ('store_order', 'so_uid', 'so_uid_idx', ARRAY['uid']::text[]),
    ('store_order_cart_info', 'soci_oid', 'soci_oid_idx', ARRAY['oid']::text[]),
    ('store_order_cart_info', 'soci_uid', 'soci_uid_idx', ARRAY['uid']::text[]),
    ('store_order_refund', 'sor_cancel_oid', 'sor_cancel_oid_idx', ARRAY['is_cancel', 'store_order_id']::text[]),
    ('store_order_refund', 'sor_uid', 'sor_uid_idx', ARRAY['uid']::text[]),
    ('store_order_status', 'sos_change_time', 'sos_change_time_idx', ARRAY['change_time']::text[]),
    ('store_order_status', 'sos_oid', 'sos_oid_idx', ARRAY['oid']::text[]),
    ('store_pink', 'sp_combination', 'sp_combination_idx', ARRAY['combination_id']::text[]),
    ('store_product', 'cate_id', 'sp_cate_id_idx', ARRAY['cate_id']::text[]),
    ('store_product', 'is_del', 'sp_is_del_idx', ARRAY['is_del']::text[]),
    ('store_product', 'price', 'sp_price_idx', ARRAY['price']::text[]),
    ('store_product', 'sales', 'sp_sales_idx', ARRAY['sales']::text[]),
    ('store_product_attr', 'store_id_attr', 'spa_product_id_idx', ARRAY['product_id']::text[]),
    ('store_product_attr_result', 'store_id_result', 'spar_product_id_idx', ARRAY['product_id']::text[]),
    ('store_product_attr_value', 'store_id_value', 'spav_product_suk_idx', ARRAY['product_id', 'suk']::text[]),
    ('store_product_attr_value', 'unique_suk', 'spav_unique_suk_idx', ARRAY['unique', 'suk']::text[]),
    ('store_product_category', 'is_show', 'spc_is_show_idx', ARRAY['is_show']::text[]),
    ('store_product_category', 'pid', 'spc_pid_idx', ARRAY['pid']::text[]),
    ('store_product_label', 'label_cate', 'spl_label_cate_idx', ARRAY['label_cate']::text[]),
    ('store_product_relation', 'product_id', 'spr_product_id_idx', ARRAY['product_id']::text[]),
    ('store_product_relation', 'relation_id', 'spr_relation_id_idx', ARRAY['relation_id']::text[]),
    ('store_product_relation', 'type', 'spr_type_idx', ARRAY['type']::text[]),
    ('store_seckill', 'ss_time', 'ss_time_idx', ARRAY['time_id']::text[]),
    ('store_service_log', 'ssl_uid_toUid', 'ssl_uid_toUid_idx', ARRAY['uid', 'to_uid']::text[]),
    ('store_service_record', 'ssr_to_uid', 'ssr_to_uid_idx', ARRAY['to_uid']::text[]),
    ('system_admin', 'sa_account', 'sa_account_idx', ARRAY['account']::text[]),
    ('system_config', 'is_store', 'system_config_is_store_idx', ARRAY['is_store']::text[]),
    ('system_config', 'menu_name', 'system_config_menu_name_idx', ARRAY['menu_name']::text[]),
    ('system_supplier', 'supplier_status', 'supplier_status_idx', ARRAY['is_show', 'is_del']::text[]),
    ('user', 'account', 'user_account_idx', ARRAY['account']::text[]),
    ('user', 'index_0', 'user_delete_time_idx', ARRAY['delete_time']::text[]),
    ('user', 'phone', 'user_phone_idx', ARRAY['phone']::text[]),
    ('user', 'status', 'user_status_idx', ARRAY['status']::text[]),
    ('user_bill', 'ub_cat_type_link', 'ub_cat_type_link_idx', ARRAY['category', 'type', 'link_id']::text[]),
    ('user_invoice', 'ui_uid', 'ui_uid_idx', ARRAY['uid']::text[]),
    ('user_money', 'um_uid', 'um_uid_idx', ARRAY['uid']::text[])
  ) AS expected(table_name, old_name, target_name, column_names)
  LOOP
    SELECT c.oid INTO table_oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=target_schema AND c.relname=item.table_name
        AND c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition;
    IF table_oid IS NULL THEN
      RAISE EXCEPTION '0138 expected permanent ordinary table % is missing', item.table_name;
    END IF;
    -- Serialize conflicting schema work; lock_timeout bounds waiting, not total execution.
    EXECUTE format('LOCK TABLE %I.%I IN SHARE UPDATE EXCLUSIVE MODE', target_schema, item.table_name);
    SELECT c.oid INTO old_oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=target_schema AND c.relname=item.old_name;
    SELECT c.oid INTO target_oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=target_schema AND c.relname=item.target_name;
    IF old_oid IS NOT NULL AND target_oid IS NOT NULL THEN
      RAISE EXCEPTION '0138 ambiguous index names: %.% / %', item.table_name, item.old_name, item.target_name;
    END IF;
    IF old_oid IS NULL AND target_oid IS NULL THEN
      RAISE EXCEPTION '0138 reviewed index is missing: %.%', item.table_name, item.target_name;
    END IF;
    selected_oid := COALESCE(old_oid, target_oid);
    selected_name := CASE WHEN old_oid IS NULL THEN item.target_name ELSE item.old_name END;
    expected_definition := format('CREATE INDEX %I ON %I.%I USING btree (%s)', selected_name, target_schema, item.table_name,
      (SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal)
        FROM unnest(item.column_names) WITH ORDINALITY AS columns(column_name, ordinal)));
    SELECT c.relkind='i' AND c.relpersistence='p' AND NOT c.relispartition AND i.indrelid=table_oid
      AND NOT i.indisunique AND NOT i.indisprimary AND NOT i.indisexclusion
      AND i.indisvalid AND i.indisready AND i.indislive AND i.indimmediate
      AND NOT i.indnullsnotdistinct AND NOT i.indisreplident
      AND i.indnkeyatts=cardinality(item.column_names) AND i.indnatts=i.indnkeyatts
      AND i.indexprs IS NULL AND i.indpred IS NULL
      AND pg_get_indexdef(i.indexrelid)=expected_definition
      AND NOT EXISTS(SELECT 1 FROM pg_constraint owner
        WHERE owner.conindid=i.indexrelid AND owner.contype IN ('p','u','x'))
      INTO aligned FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indexrelid=selected_oid;
    IF aligned IS DISTINCT FROM true THEN
      RAISE EXCEPTION '0138 index definition drift: %.%', item.table_name, selected_name;
    END IF;
    IF old_oid IS NOT NULL THEN
      EXECUTE format('ALTER INDEX %I.%I RENAME TO %I', target_schema, item.old_name, item.target_name);
      SELECT c.oid INTO target_oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=target_schema AND c.relname=item.target_name;
      IF target_oid IS DISTINCT FROM old_oid
        OR pg_get_indexdef(target_oid) IS DISTINCT FROM format('CREATE INDEX %I ON %I.%I USING btree (%s)',
          item.target_name, target_schema, item.table_name,
          (SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal)
            FROM unnest(item.column_names) WITH ORDINALITY AS columns(column_name, ordinal))) THEN
        RAISE EXCEPTION '0138 rename identity or definition changed: %.%', item.table_name, item.target_name;
      END IF;
    END IF;
  END LOOP;
END
$ordinary_index_name_alignment$;
