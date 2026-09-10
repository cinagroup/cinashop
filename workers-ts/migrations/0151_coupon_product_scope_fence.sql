-- 0151: coupon/product relation multiset write fence. No business rows are rewritten.
-- AFTER transition tables include final values, including changes from BEFORE triggers.
-- Reader must hold a relation lock, then parent SHARE, then read the set in a new RC statement.
-- DML triggers do not cover TRUNCATE or privileged DDL/replica bypass.
DO $coupon_product_scope_fence$
DECLARE
  target_schema text := pg_catalog.current_schema();
  original_path text := pg_catalog.current_setting('search_path');
  relations_oid oid;
  templates_oid oid;
  function_oid oid;
  expected_body text := $fence_source$
DECLARE
  changes_sql text;
  affected_ids integer[];
  locked_id integer;
  locked_count integer := 0;
BEGIN
  IF TG_OP = 'INSERT' THEN
    changes_sql := 'SELECT coupon_id, product_id, 1 AS delta FROM coupon_scope_new';
  ELSIF TG_OP = 'DELETE' THEN
    changes_sql := 'SELECT coupon_id, product_id, -1 AS delta FROM coupon_scope_old';
  ELSIF TG_OP = 'UPDATE' THEN
    changes_sql := 'SELECT coupon_id, product_id, -1 AS delta FROM coupon_scope_old UNION ALL SELECT coupon_id, product_id, 1 AS delta FROM coupon_scope_new';
  ELSE
    RAISE EXCEPTION 'Unexpected coupon scope fence operation %', TG_OP;
  END IF;
  EXECUTE 'SELECT COALESCE(array_agg(coupon_id ORDER BY coupon_id), ARRAY[]::integer[]) FROM (SELECT DISTINCT coupon_id FROM (SELECT coupon_id, product_id FROM (' ||
    changes_sql || ') AS changes GROUP BY coupon_id, product_id HAVING SUM(delta) <> 0) AS changed_pairs) AS affected'
    INTO affected_ids;
  IF cardinality(affected_ids) = 0 THEN RETURN NULL; END IF;
  FOR locked_id IN EXECUTE format(
    'SELECT id FROM %I.store_coupon_issue WHERE id = ANY($1) ORDER BY id FOR NO KEY UPDATE', TG_TABLE_SCHEMA
  ) USING affected_ids LOOP
    locked_count := locked_count + 1;
  END LOOP;
  IF locked_count <> cardinality(affected_ids) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Coupon scope change references a missing template';
  END IF;
  RETURN NULL;
END
$fence_source$;
  existing_body text;
  item record;
  trigger_ok boolean;
  dangling boolean;
BEGIN
  IF target_schema IS NULL OR left(target_schema,3) = 'pg_' OR target_schema = 'information_schema' THEN
    RAISE EXCEPTION '0151 expected application schema';
  END IF;
  PERFORM set_config('search_path', 'pg_catalog, pg_temp', true);
  PERFORM set_config('lock_timeout',
    LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000)::text || 'ms', true);
  IF EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtenabled <> 'D') THEN
    RAISE EXCEPTION '0151 enabled DDL event triggers require explicit review';
  END IF;
  SELECT c.oid INTO relations_oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=target_schema AND c.relname='store_coupon_product' AND c.relkind='r'
      AND c.relpersistence='p' AND NOT c.relispartition AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity;
  SELECT c.oid INTO templates_oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=target_schema AND c.relname='store_coupon_issue' AND c.relkind='r'
      AND c.relpersistence='p' AND NOT c.relispartition AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity;
  IF relations_oid IS NULL OR templates_oid IS NULL THEN
    RAISE EXCEPTION '0151 expected permanent non-RLS coupon relation and template tables';
  END IF;
  EXECUTE format('LOCK TABLE ONLY %I.store_coupon_product, ONLY %I.store_coupon_issue IN SHARE ROW EXCLUSIVE MODE', target_schema, target_schema);
  IF relations_oid <> to_regclass(format('%I.store_coupon_product',target_schema))
    OR templates_oid <> to_regclass(format('%I.store_coupon_issue',target_schema))
    OR EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid IN (relations_oid,templates_oid) OR inhparent IN (relations_oid,templates_oid))
    OR EXISTS (SELECT 1 FROM pg_class WHERE oid IN (relations_oid,templates_oid)
      AND (relkind <> 'r' OR relpersistence <> 'p' OR relispartition OR relrowsecurity OR relforcerowsecurity)) THEN
    RAISE EXCEPTION '0151 changed, inherited or RLS tables require explicit review';
  END IF;
  FOR item IN SELECT * FROM (VALUES
    (relations_oid,'coupon_id','integer'::regtype,-1),
    (relations_oid,'product_id','integer'::regtype,-1),
    (templates_oid,'id','integer'::regtype,-1)
  ) AS expected(table_oid,column_name,type_oid,type_mod) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=item.table_oid AND attname=item.column_name
      AND attnum > 0 AND NOT attisdropped AND atttypid=item.type_oid AND atttypmod=item.type_mod
      AND attnotnull AND attgenerated='' AND attidentity='') THEN
      RAISE EXCEPTION '0151 column drift: %', item.column_name;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_attribute a
      ON a.attrelid=c.conrelid AND a.attname='id'
    WHERE c.conrelid=templates_oid AND c.contype='p' AND c.convalidated AND NOT c.condeferrable
      AND c.conkey=ARRAY[a.attnum]::smallint[]) THEN
    RAISE EXCEPTION '0151 expected nondeferrable coupon template id primary key';
  END IF;
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.store_coupon_product r LEFT JOIN %I.store_coupon_issue t ON t.id=r.coupon_id
    WHERE t.id IS NULL)', target_schema, target_schema) INTO dangling;
  IF dangling THEN RAISE EXCEPTION '0151 dangling coupon relations require explicit repair'; END IF;

  SELECT p.oid, p.prosrc INTO function_oid, existing_body FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname=target_schema AND p.proname='coupon_product_scope_fence_0151' AND p.pronargs=0;
  IF function_oid IS NOT NULL THEN
    IF existing_body IS DISTINCT FROM expected_body OR NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=function_oid
        AND l.lanname='plpgsql' AND p.prorettype='trigger'::regtype AND p.prokind='f'
        AND NOT p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof
        AND p.provolatile='v' AND p.proparallel='u' AND p.proconfig=ARRAY['search_path=pg_catalog']
    ) THEN RAISE EXCEPTION '0151 existing fence function drift'; END IF;
  ELSE
    EXECUTE format('CREATE FUNCTION %I.coupon_product_scope_fence_0151() RETURNS trigger LANGUAGE plpgsql
      VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS %L', target_schema, expected_body);
    function_oid := to_regprocedure(format('%I.coupon_product_scope_fence_0151()',target_schema));
  END IF;
  FOR item IN SELECT * FROM (VALUES
    ('coupon_product_insert_0151','INSERT',4,NULL::name,'coupon_scope_new'::name,'NEW TABLE AS coupon_scope_new'),
    ('coupon_product_update_0151','UPDATE',16,'coupon_scope_old'::name,'coupon_scope_new'::name,'OLD TABLE AS coupon_scope_old NEW TABLE AS coupon_scope_new'),
    ('coupon_product_delete_0151','DELETE',8,'coupon_scope_old'::name,NULL::name,'OLD TABLE AS coupon_scope_old')
  ) AS expected(trigger_name,event_name,type_bits,old_name,new_name,reference_sql) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=relations_oid AND tgname=item.trigger_name) THEN
      EXECUTE format('CREATE TRIGGER %I AFTER %s ON %I.store_coupon_product REFERENCING %s
        FOR EACH STATEMENT EXECUTE FUNCTION %I.coupon_product_scope_fence_0151()',
        item.trigger_name,item.event_name,target_schema,item.reference_sql,target_schema);
    END IF;
    SELECT tgfoid=function_oid AND tgtype=item.type_bits AND tgenabled='O'
      AND NOT tgisinternal AND NOT tgdeferrable AND NOT tginitdeferred AND tgconstraint=0
      AND tgconstrrelid=0 AND tgparentid=0 AND tgnargs=0 AND tgargs=''::bytea
      AND tgqual IS NULL AND tgattr=''::int2vector
      AND tgoldtable IS NOT DISTINCT FROM item.old_name AND tgnewtable IS NOT DISTINCT FROM item.new_name
      INTO trigger_ok FROM pg_trigger WHERE tgrelid=relations_oid AND tgname=item.trigger_name;
    IF trigger_ok IS DISTINCT FROM true THEN RAISE EXCEPTION '0151 existing fence trigger drift: %',item.trigger_name; END IF;
  END LOOP;
  PERFORM set_config('search_path',original_path,true);
END
$coupon_product_scope_fence$;
