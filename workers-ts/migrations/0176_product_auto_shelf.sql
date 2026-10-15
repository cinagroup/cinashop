SET LOCAL search_path TO pg_catalog, public, pg_temp;
SELECT
  pg_catalog.set_config('statement_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
  pg_catalog.set_config('lock_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text || 'ms',true),
  pg_catalog.set_config('idle_in_transaction_session_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true);
DO $product_auto_shelf$
DECLARE
  spec record;
  actual text;
  expected text;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass('public.store_product')
      AND relkind='r' AND relpersistence='p' AND NOT relrowsecurity AND NOT relforcerowsecurity)
    OR EXISTS(SELECT 1 FROM pg_inherits WHERE inhparent=to_regclass('public.store_product') OR inhrelid=to_regclass('public.store_product'))
    OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN
    RAISE EXCEPTION 'Product auto shelf table prerequisite drift';
  END IF;
  LOCK TABLE ONLY public.store_product IN SHARE MODE NOWAIT;
  FOR spec IN SELECT * FROM (VALUES ('sp_auto_on_due_idx','auto_on_time',0),('sp_auto_off_due_idx','auto_off_time',1)) AS v(name,column_name,show_state) LOOP
    IF to_regclass('public.'||spec.name) IS NULL THEN
      EXECUTE format('CREATE INDEX %I ON public.store_product (%I,id) WHERE is_del=0 AND is_show=%s AND %I>0',spec.name,spec.column_name,spec.show_state,spec.column_name);
    END IF;
    SELECT pg_get_indexdef(i.indexrelid) INTO actual FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
      WHERE i.indexrelid=to_regclass('public.'||spec.name) AND i.indrelid='public.store_product'::regclass
        AND i.indisvalid AND i.indisready AND i.indislive AND NOT i.indisunique AND NOT i.indisprimary AND NOT i.indisexclusion
        AND i.indnkeyatts=2 AND i.indnatts=2 AND c.relkind='i' AND c.relpersistence='p' AND c.reloptions IS NULL;
    expected := format('CREATE INDEX %s ON public.store_product USING btree (%s, id) WHERE ((is_del = 0) AND (is_show = %s) AND (%s > 0))',spec.name,spec.column_name,spec.show_state,spec.column_name);
    IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Product auto shelf index drift: %',spec.name; END IF;
  END LOOP;
END
$product_auto_shelf$;
