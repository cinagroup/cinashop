// SQL is mirrored in migrations/0150_brokerage_paid_order_fence.sql.
// MigrationService registers it as embedded step 0156; existing DBs use the standalone runner.
export const BROKERAGE_PAID_ORDER_FENCE_SQL = String.raw`
-- 0150: paid-order aggregate write fence. Install before enabling mode=3 read guards.
-- No balances, historical orders, schema columns or pricing formulas are rewritten.
-- AFTER transition tables include final row values and lock net-changed positive uids.
DO $brokerage_paid_fence$
DECLARE
  target_schema text := pg_catalog.current_schema();
  original_path text := pg_catalog.current_setting('search_path');
  orders_oid oid;
  users_oid oid;
  function_oid oid;
  expected_body text := $fence_source$
DECLARE
  changes_sql text;
  affected_uids integer[];
  locked_uid integer;
  locked_count integer := 0;
BEGIN
  IF TG_OP = 'INSERT' THEN
    changes_sql := 'SELECT uid, pay_price AS amount FROM brokerage_new WHERE pid <> -1 AND paid = 1 AND is_del = 0 AND refund_status IN (0,3)';
  ELSIF TG_OP = 'DELETE' THEN
    changes_sql := 'SELECT uid, -pay_price AS amount FROM brokerage_old WHERE pid <> -1 AND paid = 1 AND is_del = 0 AND refund_status IN (0,3)';
  ELSIF TG_OP = 'UPDATE' THEN
    changes_sql := 'SELECT uid, -pay_price AS amount FROM brokerage_old WHERE pid <> -1 AND paid = 1 AND is_del = 0 AND refund_status IN (0,3) UNION ALL SELECT uid, pay_price AS amount FROM brokerage_new WHERE pid <> -1 AND paid = 1 AND is_del = 0 AND refund_status IN (0,3)';
  ELSE
    RAISE EXCEPTION 'Unexpected brokerage fence operation %', TG_OP;
  END IF;
  EXECUTE 'SELECT COALESCE(array_agg(uid ORDER BY uid), ARRAY[]::integer[]) FROM (SELECT uid FROM (' ||
    changes_sql || ') AS changes WHERE uid > 0 GROUP BY uid HAVING SUM(amount) <> 0) AS affected'
    INTO affected_uids;
  IF cardinality(affected_uids) = 0 THEN RETURN NULL; END IF;
  FOR locked_uid IN EXECUTE format(
    'SELECT uid FROM %I."user" WHERE uid = ANY($1) ORDER BY uid FOR NO KEY UPDATE', TG_TABLE_SCHEMA
  ) USING affected_uids LOOP
    locked_count := locked_count + 1;
  END LOOP;
  IF locked_count <> cardinality(affected_uids) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Paid order eligibility references a missing positive user';
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
    RAISE EXCEPTION '0150 expected application schema';
  END IF;
  PERFORM set_config('search_path', 'pg_catalog, pg_temp', true);
  PERFORM set_config('lock_timeout',
    LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000)::text || 'ms', true);
  IF EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtenabled <> 'D') THEN
    RAISE EXCEPTION '0150 enabled DDL event triggers require explicit review';
  END IF;
  SELECT c.oid INTO orders_oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=target_schema AND c.relname='store_order' AND c.relkind='r'
      AND c.relpersistence='p' AND NOT c.relispartition AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity;
  SELECT c.oid INTO users_oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=target_schema AND c.relname='user' AND c.relkind='r'
      AND c.relpersistence='p' AND NOT c.relispartition AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity;
  IF orders_oid IS NULL OR users_oid IS NULL THEN
    RAISE EXCEPTION '0150 expected permanent non-RLS order and user tables';
  END IF;
  EXECUTE format('LOCK TABLE ONLY %I.store_order, ONLY %I."user" IN SHARE ROW EXCLUSIVE MODE', target_schema, target_schema);
  IF orders_oid <> to_regclass(format('%I.store_order',target_schema))
    OR users_oid <> to_regclass(format('%I."user"',target_schema))
    OR EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid IN (orders_oid,users_oid) OR inhparent IN (orders_oid,users_oid))
    OR EXISTS (SELECT 1 FROM pg_class WHERE oid IN (orders_oid,users_oid)
      AND (relkind <> 'r' OR relpersistence <> 'p' OR relispartition OR relrowsecurity OR relforcerowsecurity)) THEN
    RAISE EXCEPTION '0150 changed, inherited or RLS tables require explicit review';
  END IF;
  FOR item IN SELECT * FROM (VALUES
    (orders_oid,'uid','integer'::regtype,-1),
    (orders_oid,'pid','integer'::regtype,-1),
    (orders_oid,'paid','smallint'::regtype,-1),
    (orders_oid,'is_del','smallint'::regtype,-1),
    (orders_oid,'refund_status','smallint'::regtype,-1),
    (orders_oid,'pay_price','numeric'::regtype,((12 << 16) | 2) + 4),
    (users_oid,'uid','integer'::regtype,-1)
  ) AS expected(table_oid,column_name,type_oid,type_mod) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=item.table_oid AND attname=item.column_name
      AND attnum > 0 AND NOT attisdropped AND atttypid=item.type_oid AND atttypmod=item.type_mod
      AND attnotnull AND attgenerated='' AND attidentity='') THEN
      RAISE EXCEPTION '0150 column drift: %', item.column_name;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_attribute a
      ON a.attrelid=c.conrelid AND a.attname='uid'
    WHERE c.conrelid=users_oid AND c.contype='p' AND c.convalidated AND NOT c.condeferrable
      AND c.conkey=ARRAY[a.attnum]::smallint[]) THEN
    RAISE EXCEPTION '0150 expected nondeferrable user uid primary key';
  END IF;
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.store_order o LEFT JOIN %I."user" u ON u.uid=o.uid
    WHERE o.uid>0 AND o.pid<>-1 AND o.paid=1 AND o.is_del=0 AND o.refund_status IN (0,3)
      AND o.pay_price<>0 AND u.uid IS NULL)', target_schema, target_schema) INTO dangling;
  IF dangling THEN RAISE EXCEPTION '0150 dangling paid-order users require explicit repair'; END IF;

  SELECT p.oid, p.prosrc INTO function_oid, existing_body FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname=target_schema AND p.proname='brokerage_paid_order_fence_0150' AND p.pronargs=0;
  IF function_oid IS NOT NULL THEN
    IF existing_body IS DISTINCT FROM expected_body OR NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=function_oid
        AND l.lanname='plpgsql' AND p.prorettype='trigger'::regtype AND p.prokind='f'
        AND NOT p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof
        AND p.provolatile='v' AND p.proparallel='u' AND p.proconfig=ARRAY['search_path=pg_catalog']
    ) THEN RAISE EXCEPTION '0150 existing fence function drift'; END IF;
  ELSE
    EXECUTE format('CREATE FUNCTION %I.brokerage_paid_order_fence_0150() RETURNS trigger LANGUAGE plpgsql
      VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS %L', target_schema, expected_body);
    function_oid := to_regprocedure(format('%I.brokerage_paid_order_fence_0150()',target_schema));
  END IF;
  FOR item IN SELECT * FROM (VALUES
    ('brokerage_paid_insert_0150','INSERT',4,NULL::name,'brokerage_new'::name,'NEW TABLE AS brokerage_new'),
    ('brokerage_paid_update_0150','UPDATE',16,'brokerage_old'::name,'brokerage_new'::name,'OLD TABLE AS brokerage_old NEW TABLE AS brokerage_new'),
    ('brokerage_paid_delete_0150','DELETE',8,'brokerage_old'::name,NULL::name,'OLD TABLE AS brokerage_old')
  ) AS expected(trigger_name,event_name,type_bits,old_name,new_name,reference_sql) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=orders_oid AND tgname=item.trigger_name) THEN
      EXECUTE format('CREATE TRIGGER %I AFTER %s ON %I.store_order REFERENCING %s
        FOR EACH STATEMENT EXECUTE FUNCTION %I.brokerage_paid_order_fence_0150()',
        item.trigger_name,item.event_name,target_schema,item.reference_sql,target_schema);
    END IF;
    SELECT tgfoid=function_oid AND tgtype=item.type_bits AND tgenabled='O'
      AND NOT tgisinternal AND NOT tgdeferrable AND NOT tginitdeferred AND tgconstraint=0
      AND tgconstrrelid=0 AND tgparentid=0 AND tgnargs=0 AND tgargs=''::bytea
      AND tgqual IS NULL AND tgattr=''::int2vector
      AND tgoldtable IS NOT DISTINCT FROM item.old_name AND tgnewtable IS NOT DISTINCT FROM item.new_name
      INTO trigger_ok FROM pg_trigger WHERE tgrelid=orders_oid AND tgname=item.trigger_name;
    IF trigger_ok IS DISTINCT FROM true THEN RAISE EXCEPTION '0150 existing fence trigger drift: %',item.trigger_name; END IF;
  END LOOP;
  PERFORM set_config('search_path',original_path,true);
END
$brokerage_paid_fence$;
`;

// Exact installed function body, shared with the fail-closed checkout catalog check.
// Reject a malformed source instead of accepting a name-only or stale version marker.
const fenceSourceParts = BROKERAGE_PAID_ORDER_FENCE_SQL.split('$fence_source$');
if (fenceSourceParts.length !== 3 || !fenceSourceParts[1]) throw new Error('Invalid paid-order fence source');
export const BROKERAGE_PAID_ORDER_FENCE_BODY = fenceSourceParts[1];
