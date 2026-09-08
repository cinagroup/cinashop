-- DB-009G2: all-state customer-reference index; statistics policy is unchanged.
-- Caller must provide a bounded transaction and a maintenance window.
-- Existing databases use runWorkContactClientIndex(), not historical runAll().
DO $work_contact_client_index$
DECLARE
  target_schema text := pg_catalog.current_schema();
  original_path text := pg_catalog.current_setting('search_path');
  table_oid oid;
  table_owner oid;
  index_oid oid;
  index_ready boolean;
  expected_definition text;
BEGIN
  IF target_schema IS NULL OR pg_catalog.left(target_schema,3)='pg_' OR target_schema='information_schema' THEN
    RAISE EXCEPTION '0148 expected application schema';
  END IF;
  PERFORM set_config('search_path','pg_catalog, pg_temp',true);
  PERFORM set_config('lock_timeout',
    LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000)::text || 'ms',true);
  IF EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtenabled <> 'D') THEN
    RAISE EXCEPTION '0148 enabled DDL event triggers require explicit review';
  END IF;
  SELECT c.oid,c.relowner INTO table_oid,table_owner
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=target_schema AND c.relname='work_contact_action_outbox'
      AND c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition;
  IF table_oid IS NULL THEN
    RAISE EXCEPTION '0148 expected permanent work_contact_action_outbox';
  END IF;
  EXECUTE format('LOCK TABLE ONLY %I.work_contact_action_outbox IN SHARE MODE',target_schema);
  IF EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid=table_oid OR inhparent=table_oid) THEN
    RAISE EXCEPTION '0148 inherited tables require explicit review';
  END IF;
  IF (SELECT count(*) FROM pg_attribute a WHERE a.attrelid=table_oid AND NOT a.attisdropped
      AND a.attnum>0 AND a.attnotnull AND a.attgenerated='' AND a.attidentity=''
      AND ((a.attname='corp_id' AND a.atttypid='varchar'::regtype AND a.atttypmod=22
            AND a.attcollation='pg_catalog."default"'::regcollation)
        OR (a.attname='client_id' AND a.atttypid='integer'::regtype AND a.atttypmod=-1 AND a.attcollation=0))) <> 2 THEN
    RAISE EXCEPTION '0148 customer reference column drift';
  END IF;
  expected_definition := format('CREATE INDEX wcao_client_ref ON %I.work_contact_action_outbox USING btree (corp_id, client_id)',target_schema);
  SELECT c.oid INTO index_oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=target_schema AND c.relname='wcao_client_ref';
  IF index_oid IS NULL THEN
    EXECUTE expected_definition;
    SELECT c.oid INTO index_oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=target_schema AND c.relname='wcao_client_ref';
  END IF;
  SELECT c.relkind='i' AND c.relpersistence='p' AND c.relowner=table_owner
    AND c.reloptions IS NULL AND c.reltablespace=0 AND i.indrelid=table_oid
    AND NOT i.indisunique AND NOT i.indisprimary AND NOT i.indisexclusion
    AND i.indisvalid AND i.indisready AND i.indislive AND i.indimmediate
    AND NOT i.indnullsnotdistinct AND NOT i.indisreplident
    AND i.indnkeyatts=2 AND i.indnatts=2 AND i.indexprs IS NULL AND i.indpred IS NULL
    AND pg_get_indexdef(i.indexrelid)=expected_definition
    AND NOT EXISTS (SELECT 1 FROM pg_constraint owner WHERE owner.conindid=i.indexrelid)
    INTO index_ready FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indexrelid=index_oid;
  IF index_ready IS DISTINCT FROM true THEN
    RAISE EXCEPTION '0148 customer reference index definition drift';
  END IF;
  PERFORM set_config('search_path',original_path,true);
END
$work_contact_client_index$;
