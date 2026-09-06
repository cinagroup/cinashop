-- DB-009D2b3e: remove only five reviewed, unreferenced external duplicates.
-- Preserve the existing canonical index; any drift/dependency aborts the transaction.
DO $external_duplicate_index_retirement$
DECLARE
  target_schema text := current_schema();
  item record;
  table_oid oid;
  column_number smallint;
  old_index oid;
  retained_index oid;
  selected_index oid;
  selected_name text;
  retained_file oid;
  aligned boolean;
BEGIN
  IF target_schema IS NULL THEN RAISE EXCEPTION '0140 target schema is missing'; END IF;
  PERFORM set_config('lock_timeout', '2s', true);
  FOR item IN SELECT * FROM (VALUES
    ('store_order_refund', 'sor_store_order_id_idx', 'sor_store_order_id', 'store_order_id', false),
    ('user_recharge', 'ur_uid_idx', 'ur_uid', 'uid', false),
    ('wechat_user', 'wu_openid_uq_idx', 'wu_openid_uq', 'openid', true),
    ('wechat_user', 'wu_uid_idx', 'wu_uid', 'uid', false),
    ('wechat_user', 'wu_unionid_idx', 'wu_unionid', 'unionid', false)
  ) AS expected(table_name,old_name,retained_name,column_name,is_unique)
  LOOP
    SELECT c.oid INTO table_oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=target_schema AND c.relname=item.table_name AND c.relkind='r'
        AND c.relpersistence='p' AND NOT c.relispartition;
    IF table_oid IS NULL THEN RAISE EXCEPTION '0140 expected permanent ordinary table % is missing',item.table_name; END IF;
    EXECUTE format('LOCK TABLE %I.%I IN ACCESS EXCLUSIVE MODE',target_schema,item.table_name);
    IF to_regclass(format('%I.%I',target_schema,item.table_name))::oid IS DISTINCT FROM table_oid THEN
      RAISE EXCEPTION '0140 table identity changed: %',item.table_name;
    END IF;
    SELECT attnum INTO column_number FROM pg_attribute
      WHERE attrelid=table_oid AND attname=item.column_name AND attnum>0 AND NOT attisdropped;
    SELECT c.oid INTO old_index FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=target_schema AND c.relname=item.old_name;
    SELECT c.oid,c.relfilenode INTO retained_index,retained_file FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=target_schema AND c.relname=item.retained_name;
    IF retained_index IS NULL OR column_number IS NULL THEN
      RAISE EXCEPTION '0140 retained index/column missing: %.%',item.table_name,item.retained_name;
    END IF;
    -- Validate the retained object even when the old name is already absent.
    FOREACH selected_index IN ARRAY ARRAY[retained_index,old_index] LOOP
      CONTINUE WHEN selected_index IS NULL;
      selected_name := CASE WHEN selected_index=retained_index THEN item.retained_name ELSE item.old_name END;
      SELECT c.relkind='i' AND c.relpersistence='p' AND NOT c.relispartition
        AND c.reloptions IS NULL AND c.reltablespace=0 AND am.amname='btree'
        AND i.indrelid=table_oid AND i.indisunique=item.is_unique AND NOT i.indisprimary
        AND NOT i.indisexclusion AND i.indisvalid AND i.indisready AND i.indislive AND i.indimmediate
        AND NOT i.indnullsnotdistinct AND NOT i.indisreplident AND NOT i.indisclustered AND NOT i.indcheckxmin
        AND i.indnkeyatts=1 AND i.indnatts=1 AND i.indkey[0]=column_number
        AND i.indexprs IS NULL AND i.indpred IS NULL
        AND pg_get_indexdef(i.indexrelid)=format('CREATE %sINDEX %I ON %I.%I USING btree (%I)',
          CASE WHEN item.is_unique THEN 'UNIQUE ' ELSE '' END,selected_name,target_schema,item.table_name,item.column_name)
        AND NOT EXISTS(SELECT 1 FROM pg_constraint owner WHERE owner.conindid=selected_index AND owner.contype IN ('p','u','x'))
        INTO aligned FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam
        WHERE i.indexrelid=selected_index;
      IF aligned IS DISTINCT FROM true THEN RAISE EXCEPTION '0140 index definition drift: %.%',item.table_name,selected_name; END IF;
    END LOOP;
    IF old_index IS NOT NULL THEN
      SELECT a.indkey=b.indkey AND a.indclass=b.indclass AND a.indcollation=b.indcollation AND a.indoption=b.indoption
        INTO aligned FROM pg_index a JOIN pg_index b ON b.indexrelid=retained_index WHERE a.indexrelid=old_index;
      IF aligned IS DISTINCT FROM true THEN RAISE EXCEPTION '0140 physical index semantics differ: %',item.old_name; END IF;
      -- RESTRICT alone can still remove AUTO/INTERNAL dependents. Reject every incoming dependency,
      -- including FK conindid, and unknown ownership/extension/partition/shared dependencies.
      IF EXISTS(SELECT 1 FROM pg_constraint WHERE conindid=old_index)
        OR EXISTS(SELECT 1 FROM pg_depend WHERE refclassid='pg_class'::regclass AND refobjid=old_index)
        OR EXISTS(SELECT 1 FROM pg_depend WHERE classid='pg_class'::regclass AND objid=old_index
          AND NOT (objsubid=0 AND deptype='a' AND refclassid='pg_class'::regclass AND refobjid=table_oid AND refobjsubid=column_number))
        OR EXISTS(SELECT 1 FROM pg_shdepend WHERE classid='pg_class'::regclass AND objid=old_index
          AND dbid=(SELECT oid FROM pg_database WHERE datname=current_database())) THEN
        RAISE EXCEPTION '0140 index has unreviewed dependencies: %',item.old_name;
      END IF;
      EXECUTE format('DROP INDEX %I.%I RESTRICT',target_schema,item.old_name);
      IF to_regclass(format('%I.%I',target_schema,item.old_name)) IS NOT NULL
        OR to_regclass(format('%I.%I',target_schema,item.retained_name))::oid IS DISTINCT FROM retained_index
        OR (SELECT relfilenode FROM pg_class WHERE oid=retained_index) IS DISTINCT FROM retained_file THEN
        RAISE EXCEPTION '0140 retained index identity changed: %',item.retained_name;
      END IF;
    END IF;
  END LOOP;
END
$external_duplicate_index_retirement$;
