// Pure SQL mirror for the separately reviewed embedded migration registration.
// Importing this module never connects to a database or executes the migration.
export const KEFU_SEQUENCE_ALIGNMENT_SQL = String.raw`
-- DB-009E5B: only the exact old bigint/unowned or canonical integer/owned state.
-- No number allocation, restart, setval, DROP, row write or automatic production use.
-- AS INTEGER rewrites this sequence's storage, preserving its OID and current number.
-- Run in a separately approved READ COMMITTED maintenance transaction with a bounded
-- statement_timeout. ACCESS EXCLUSIVE locks block readers/writers until transaction end.
DO $kefu_sequence_alignment$
DECLARE
  target_schema text := pg_catalog.current_schema();
  old_search_path text := pg_catalog.current_setting('search_path');
  old_lock_timeout text := pg_catalog.current_setting('lock_timeout');
  namespace_oid oid;
  table_oid oid;
  sequence_oid oid;
  column_number smallint;
  default_oid oid;
  owning_count integer;
  phase integer;
  was_aligned boolean;
  actual_table record;
  actual_sequence record;
  actual_column record;
  options record;
  counter record;
  maximum_visitor bigint;
  before_number bigint;
  before_called boolean;
  before_log_count bigint;
  before_table jsonb;
  before_sequence jsonb;
  before_options jsonb;
  before_column jsonb;
  before_default jsonb;
  before_dependencies jsonb;
  before_shared_dependencies jsonb;
  before_comments jsonb;
  actual_dependencies jsonb;
  actual_shared_dependencies jsonb;
  actual_comments jsonb;
BEGIN
  IF target_schema IS NULL OR target_schema = 'information_schema' OR target_schema LIKE 'pg_%'
     OR pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION '0145 requires an explicit application schema and READ COMMITTED transaction';
  END IF;
  SELECT oid INTO namespace_oid FROM pg_catalog.pg_namespace WHERE nspname = target_schema;
  IF namespace_oid IS NULL THEN RAISE EXCEPTION '0145 target schema missing'; END IF;
  -- Same-schema ALTER is used only to acquire a supported sequence lock without
  -- overwriting unknown options. Do not invoke user-defined DDL event hooks.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled <> 'D') THEN
    RAISE EXCEPTION '0145 enabled DDL event triggers require separate review';
  END IF;
  PERFORM pg_catalog.set_config('search_path',pg_catalog.format('pg_catalog,%I,pg_temp',target_schema),true);
  PERFORM pg_catalog.set_config('lock_timeout','2s',true);
  SELECT oid INTO table_oid FROM pg_catalog.pg_class WHERE relnamespace=namespace_oid AND relname='kefu_visitor_session' AND relkind='r';
  SELECT oid INTO sequence_oid FROM pg_catalog.pg_class WHERE relnamespace=namespace_oid AND relname='kefu_visitor_uid_seq' AND relkind='S';
  IF table_oid IS NULL OR sequence_oid IS NULL THEN RAISE EXCEPTION '0145 required table/sequence missing or wrong kind'; END IF;
  EXECUTE pg_catalog.format('LOCK TABLE ONLY %I.kefu_visitor_session IN ACCESS EXCLUSIVE MODE',target_schema);
  SELECT * INTO actual_table FROM pg_catalog.pg_class WHERE oid=table_oid;
  IF actual_table.relnamespace<>namespace_oid OR actual_table.relname<>'kefu_visitor_session'
     OR actual_table.relkind<>'r' OR actual_table.relpersistence<>'p' OR actual_table.relispartition
     OR actual_table.relrowsecurity OR actual_table.relforcerowsecurity
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=table_oid OR inhparent=table_oid) THEN
    RAISE EXCEPTION '0145 unsupported owning table state';
  END IF;
  -- PostgreSQL locks already-owned sequences through their table even when the
  -- requested namespace equals the existing namespace; catalog entries stay put.
  EXECUTE pg_catalog.format('ALTER TABLE %I.kefu_visitor_session SET SCHEMA %I',target_schema,target_schema);
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_locks WHERE pid=pg_catalog.pg_backend_pid()
      AND locktype='relation' AND relation=sequence_oid AND mode='AccessExclusiveLock' AND granted) THEN
    -- An unowned sequence supports this same-schema operation. A differently
    -- owned sequence is rejected by PostgreSQL before it changes any metadata.
    EXECUTE pg_catalog.format('ALTER SEQUENCE %I.kefu_visitor_uid_seq SET SCHEMA %I',target_schema,target_schema);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_locks WHERE pid=pg_catalog.pg_backend_pid()
      AND locktype='relation' AND relation=sequence_oid AND mode='AccessExclusiveLock' AND granted) THEN
    RAISE EXCEPTION '0145 sequence identity changed before lock acquisition';
  END IF;

  FOR phase IN 1..2 LOOP
    SELECT * INTO actual_table FROM pg_catalog.pg_class WHERE oid=table_oid;
    SELECT * INTO actual_sequence FROM pg_catalog.pg_class WHERE oid=sequence_oid;
    SELECT * INTO options FROM pg_catalog.pg_sequence WHERE seqrelid=sequence_oid;
    IF actual_sequence.oid IS NULL OR actual_sequence.relnamespace<>namespace_oid
       OR actual_sequence.relname<>'kefu_visitor_uid_seq' OR actual_sequence.relkind<>'S'
       OR actual_sequence.relpersistence<>'p' OR actual_sequence.relowner<>actual_table.relowner
       OR options.seqtypid NOT IN ('pg_catalog.int4'::pg_catalog.regtype,'pg_catalog.int8'::pg_catalog.regtype)
       OR options.seqstart<>1000000000 OR options.seqmin<>1 OR options.seqmax<>2147483647
       OR options.seqincrement<>1 OR options.seqcache<>1 OR options.seqcycle THEN
      RAISE EXCEPTION '0145 sequence definition or owner role drift';
    END IF;
    SELECT * INTO actual_column FROM pg_catalog.pg_attribute
      WHERE attrelid=table_oid AND attname='visitor_uid' AND attnum>0 AND NOT attisdropped;
    IF actual_column.attnum IS NULL OR actual_column.atttypid<>'pg_catalog.int4'::pg_catalog.regtype
       OR actual_column.atttypmod<>-1 OR NOT actual_column.attnotnull OR actual_column.attidentity<>''
       OR actual_column.attgenerated<>'' OR actual_column.attcollation<>0
       OR actual_column.attinhcount<>0 OR NOT actual_column.attislocal THEN
      RAISE EXCEPTION '0145 owning column drift';
    END IF;
    column_number := actual_column.attnum;
    SELECT oid INTO default_oid FROM pg_catalog.pg_attrdef WHERE adrelid=table_oid AND adnum=column_number
      AND pg_catalog.pg_get_expr(adbin,adrelid,false)='nextval(''kefu_visitor_uid_seq''::regclass)';
    IF default_oid IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_index i ON i.indexrelid=c.conindid
      WHERE c.conrelid=table_oid AND c.conname='kefu_visitor_session_visitor_uid_key' AND c.contype='u'
        AND c.conkey=ARRAY[column_number] AND NOT c.condeferrable AND NOT c.condeferred AND c.convalidated
        AND i.indisunique AND i.indisvalid AND i.indisready AND i.indpred IS NULL AND i.indexprs IS NULL
        AND i.indnkeyatts=1 AND i.indnatts=1) THEN
      RAISE EXCEPTION '0145 visitor default or unique constraint drift';
    END IF;
    SELECT count(*) INTO owning_count FROM pg_catalog.pg_depend
      WHERE classid='pg_catalog.pg_class'::pg_catalog.regclass AND objid=sequence_oid AND objsubid=0
        AND refclassid='pg_catalog.pg_class'::pg_catalog.regclass AND refobjid=table_oid
        AND refobjsubid=column_number AND deptype='a';
    IF NOT ((options.seqtypid='pg_catalog.int8'::pg_catalog.regtype AND owning_count=0)
         OR (options.seqtypid='pg_catalog.int4'::pg_catalog.regtype AND owning_count=1)) THEN
      RAISE EXCEPTION '0145 unknown partial sequence alignment';
    END IF;
    -- Only the original namespace, exact default reference and optional target
    -- AUTO ownership are understood. Views/functions/extensions/other consumers
    -- referencing this sequence require explicit review instead of blind ALTER.
    IF (SELECT count(*) FROM pg_catalog.pg_depend WHERE
        (classid='pg_catalog.pg_class'::pg_catalog.regclass AND objid=sequence_oid)
        OR (refclassid='pg_catalog.pg_class'::pg_catalog.regclass AND refobjid=sequence_oid)) <> 2+owning_count
       OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend WHERE classid='pg_catalog.pg_class'::pg_catalog.regclass
         AND objid=sequence_oid AND objsubid=0 AND refclassid='pg_catalog.pg_namespace'::pg_catalog.regclass
         AND refobjid=namespace_oid AND refobjsubid=0 AND deptype='n')
       OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend WHERE classid='pg_catalog.pg_attrdef'::pg_catalog.regclass
         AND objid=default_oid AND objsubid=0 AND refclassid='pg_catalog.pg_class'::pg_catalog.regclass
         AND refobjid=sequence_oid AND refobjsubid=0 AND deptype='n')
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_seclabel WHERE classoid='pg_catalog.pg_class'::pg_catalog.regclass
         AND objoid IN (table_oid,sequence_oid)) THEN
      RAISE EXCEPTION '0145 unsupported sequence dependencies or security labels';
    END IF;
    EXECUTE pg_catalog.format('SELECT last_value,is_called,log_cnt FROM %I.kefu_visitor_uid_seq',target_schema) INTO counter;
    EXECUTE pg_catalog.format('SELECT max(visitor_uid)::bigint FROM ONLY %I.kefu_visitor_session',target_schema) INTO maximum_visitor;
    IF counter.last_value<1000000000 OR counter.last_value>2147483647
       OR (maximum_visitor IS NOT NULL AND (counter.last_value<maximum_visitor
         OR (NOT counter.is_called AND counter.last_value=maximum_visitor))) THEN
      RAISE EXCEPTION '0145 current sequence counter is unsafe; manual review required, never reset automatically';
    END IF;
    SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(d) ORDER BY classid,objid,objsubid,refclassid,refobjid,refobjsubid,deptype),'[]'::jsonb)
      INTO actual_dependencies FROM pg_catalog.pg_depend d WHERE
      ((classid='pg_catalog.pg_class'::pg_catalog.regclass AND objid=sequence_oid)
        OR (refclassid='pg_catalog.pg_class'::pg_catalog.regclass AND refobjid=sequence_oid))
      AND NOT (classid='pg_catalog.pg_class'::pg_catalog.regclass AND objid=sequence_oid
        AND refclassid='pg_catalog.pg_class'::pg_catalog.regclass AND refobjid=table_oid
        AND refobjsubid=column_number AND deptype='a');
    SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(d) ORDER BY dbid,classid,objid,objsubid,refclassid,refobjid,deptype),'[]'::jsonb)
      INTO actual_shared_dependencies FROM pg_catalog.pg_shdepend d
      WHERE classid='pg_catalog.pg_class'::pg_catalog.regclass AND objid IN (table_oid,sequence_oid)
        AND dbid=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database());
    SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(d) ORDER BY objoid,objsubid),'[]'::jsonb)
      INTO actual_comments FROM pg_catalog.pg_description d
      WHERE classoid='pg_catalog.pg_class'::pg_catalog.regclass AND objoid IN (table_oid,sequence_oid);
    IF phase=1 THEN
      was_aligned := options.seqtypid='pg_catalog.int4'::pg_catalog.regtype;
      before_number := counter.last_value; before_called := counter.is_called; before_log_count := counter.log_cnt;
      before_table := pg_catalog.to_jsonb(actual_table); before_sequence := pg_catalog.to_jsonb(actual_sequence);
      before_options := pg_catalog.to_jsonb(options); before_column := pg_catalog.to_jsonb(actual_column);
      SELECT pg_catalog.to_jsonb(d) INTO before_default FROM pg_catalog.pg_attrdef d WHERE oid=default_oid;
      before_dependencies := actual_dependencies; before_shared_dependencies := actual_shared_dependencies; before_comments := actual_comments;
      IF NOT was_aligned THEN
        EXECUTE pg_catalog.format('ALTER SEQUENCE %I.kefu_visitor_uid_seq AS INTEGER OWNED BY %I.kefu_visitor_session.visitor_uid',target_schema,target_schema);
      END IF;
    ELSE
      IF options.seqtypid<>'pg_catalog.int4'::pg_catalog.regtype OR owning_count<>1
         OR counter.last_value IS DISTINCT FROM before_number OR counter.is_called IS DISTINCT FROM before_called
         OR counter.log_cnt IS DISTINCT FROM before_log_count
         OR pg_catalog.to_jsonb(actual_table) IS DISTINCT FROM before_table
         OR (pg_catalog.to_jsonb(actual_sequence)-'relfilenode') IS DISTINCT FROM (before_sequence-'relfilenode')
         OR (was_aligned AND pg_catalog.to_jsonb(actual_sequence) IS DISTINCT FROM before_sequence)
         OR (pg_catalog.to_jsonb(options)-'seqtypid') IS DISTINCT FROM (before_options-'seqtypid')
         OR pg_catalog.to_jsonb(actual_column) IS DISTINCT FROM before_column
         OR (SELECT pg_catalog.to_jsonb(d) FROM pg_catalog.pg_attrdef d WHERE oid=default_oid) IS DISTINCT FROM before_default
         OR actual_dependencies IS DISTINCT FROM before_dependencies
         OR actual_shared_dependencies IS DISTINCT FROM before_shared_dependencies OR actual_comments IS DISTINCT FROM before_comments THEN
        RAISE EXCEPTION '0145 sequence alignment postcondition failed';
      END IF;
    END IF;
  END LOOP;
  PERFORM pg_catalog.set_config('search_path',old_search_path,true);
  PERFORM pg_catalog.set_config('lock_timeout',old_lock_timeout,true);
END $kefu_sequence_alignment$;
`;
