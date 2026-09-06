-- DB-009E1: align four known defaults without rewriting rows or changing column types.
DO $column_default_alignment$
DECLARE
  target_schema text := current_schema();
  item record;
  table_oid oid;
  column_number smallint;
  previous_default text;
  resulting_default text;
  aligned boolean;
BEGIN
  IF target_schema IS NULL THEN RAISE EXCEPTION '0141 target schema is missing'; END IF;
  PERFORM set_config('lock_timeout', '2s', true);
  FOR item IN SELECT * FROM (VALUES
    ('store_order_outbox', 'payload', 'jsonb', NULL::text, $value$'{}'::jsonb$value$),
    ('store_seckill', 'time_id', 'text', $value$''::text$value$, $value$''::character varying$value$),
    ('system_queue_dead_letter', 'body', 'jsonb', NULL::text, $value$'{}'::jsonb$value$),
    ('user_brokerage_frozen', 'price', 'numeric(12,2)', $value$'0'::numeric$value$, $value$0$value$)
  ) AS expected(table_name,column_name,type_name,old_default,target_default)
  LOOP
    SELECT c.oid INTO table_oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=target_schema AND c.relname=item.table_name AND c.relkind='r'
        AND c.relpersistence='p' AND NOT c.relispartition;
    IF table_oid IS NULL THEN RAISE EXCEPTION '0141 expected permanent ordinary table % is missing',item.table_name; END IF;
    EXECUTE format('LOCK TABLE ONLY %I.%I IN ACCESS EXCLUSIVE MODE',target_schema,item.table_name);
    IF to_regclass(format('%I.%I',target_schema,item.table_name))::oid IS DISTINCT FROM table_oid
      OR EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid=table_oid OR inhparent=table_oid) THEN
      RAISE EXCEPTION '0141 table identity or inheritance drift: %',item.table_name;
    END IF;
    SELECT a.attnum,pg_get_expr(d.adbin,d.adrelid),
      format_type(a.atttypid,a.atttypmod)=item.type_name AND a.attnotnull
      AND a.attidentity='' AND a.attgenerated='' AND a.attislocal AND a.attinhcount=0
      AND a.attcollation=CASE WHEN item.type_name='text' THEN 'pg_catalog."default"'::regcollation::oid ELSE 0 END
      INTO column_number,previous_default,aligned
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=table_oid AND a.attname=item.column_name AND a.attnum>0 AND NOT a.attisdropped;
    IF aligned IS DISTINCT FROM true OR column_number IS NULL THEN
      RAISE EXCEPTION '0141 column shape drift or missing: %.%',item.table_name,item.column_name;
    END IF;
    -- Compare stored expressions, never execute an unknown default to classify it.
    IF previous_default IS DISTINCT FROM item.old_default AND previous_default IS DISTINCT FROM item.target_default THEN
      RAISE EXCEPTION '0141 unreviewed default: %.%',item.table_name,item.column_name;
    END IF;
    IF previous_default IS DISTINCT FROM item.target_default THEN
      EXECUTE format('ALTER TABLE ONLY %I.%I ALTER COLUMN %I SET DEFAULT %s',target_schema,item.table_name,item.column_name,item.target_default);
      SELECT pg_get_expr(d.adbin,d.adrelid) INTO resulting_default FROM pg_attrdef d
        WHERE d.adrelid=table_oid AND d.adnum=column_number;
      IF resulting_default IS DISTINCT FROM item.target_default THEN
        RAISE EXCEPTION '0141 default did not align: %.%',item.table_name,item.column_name;
      END IF;
    END IF;
  END LOOP;
END
$column_default_alignment$;
