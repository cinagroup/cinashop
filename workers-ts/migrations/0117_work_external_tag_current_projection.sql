-- Expand-only canonical Enterprise WeChat customer-tag catalog projection.
-- Legacy work_label/user_label rows remain immutable import evidence.
DO $work_external_tag_current_projection$
DECLARE
  target_schema text := current_schema();
  callback_oid oid;
  qualified_oid oid;
  table_name text;
  constraint_name text;
BEGIN
  IF target_schema IS NULL OR target_schema = '' OR left(target_schema, 3) = 'pg_' THEN
    RAISE EXCEPTION '0117 requires a non-system current schema';
  END IF;
  callback_oid := to_regclass('work_callback_event');
  qualified_oid := to_regclass(format('%I.%I', target_schema, 'work_callback_event'));
  IF callback_oid IS NULL OR callback_oid IS DISTINCT FROM qualified_oid THEN
    RAISE EXCEPTION '0117 search_path resolves work_callback_event outside current schema %', target_schema;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = callback_oid AND relkind = 'r' AND relpersistence = 'p'
      AND NOT relispartition
  ) THEN RAISE EXCEPTION 'work_callback_event must be a permanent ordinary table'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = callback_oid AND conname = 'wce_department_ref_uq'
      AND contype = 'u' AND convalidated
  ) THEN RAISE EXCEPTION '0117 requires the canonical work_callback_event event-reference key'; END IF;
  FOREACH table_name IN ARRAY ARRAY[
    'work_external_tag_group_current',
    'work_external_tag_current',
    'work_external_tag_projection_fence'
  ] LOOP
    qualified_oid := to_regclass(format('%I.%I', target_schema, table_name));
    IF to_regclass(table_name) IS NOT NULL
      AND to_regclass(table_name) IS DISTINCT FROM qualified_oid THEN
      RAISE EXCEPTION '0117 search_path misbinds % outside current schema %', table_name, target_schema;
    END IF;
  END LOOP;

  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %I.work_external_tag_group_current (
      corp_id varchar(18) NOT NULL,
      strategy_id integer NOT NULL DEFAULT 0,
      group_id varchar(128) NOT NULL,
      lifecycle_state varchar(16) NOT NULL,
      snapshot_complete boolean NOT NULL DEFAULT false,
      group_name varchar(256),
      sort_order integer,
      provider_create_time integer,
      last_event_id integer NOT NULL,
      last_event_key varchar(64) NOT NULL,
      last_event_subject_key_hash varchar(64) NOT NULL,
      last_event_time integer NOT NULL,
      last_sequence_rank integer NOT NULL,
      create_time integer NOT NULL DEFAULT 0,
      update_time integer NOT NULL DEFAULT 0,
      deleted_time integer
    )
  $ddl$, target_schema);
  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %I.work_external_tag_current (
      corp_id varchar(18) NOT NULL,
      strategy_id integer NOT NULL DEFAULT 0,
      tag_id varchar(128) NOT NULL,
      group_id varchar(128),
      lifecycle_state varchar(16) NOT NULL,
      snapshot_complete boolean NOT NULL DEFAULT false,
      name varchar(256),
      sort_order integer,
      provider_create_time integer,
      last_event_id integer NOT NULL,
      last_event_key varchar(64) NOT NULL,
      last_event_subject_key_hash varchar(64) NOT NULL,
      last_event_time integer NOT NULL,
      last_sequence_rank integer NOT NULL,
      create_time integer NOT NULL DEFAULT 0,
      update_time integer NOT NULL DEFAULT 0,
      deleted_time integer
    )
  $ddl$, target_schema);
  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %I.work_external_tag_projection_fence (
      corp_id varchar(18) NOT NULL,
      strategy_id integer NOT NULL DEFAULT 0,
      subject_type varchar(16) NOT NULL,
      remote_id varchar(128) NOT NULL,
      last_event_id integer NOT NULL,
      last_event_key varchar(64) NOT NULL,
      last_event_subject_key_hash varchar(64) NOT NULL,
      last_event_time integer NOT NULL,
      last_sequence_rank integer NOT NULL,
      create_time integer NOT NULL DEFAULT 0,
      update_time integer NOT NULL DEFAULT 0
    )
  $ddl$, target_schema);

  FOR table_name, constraint_name IN SELECT * FROM (VALUES
    ('work_external_tag_group_current','wetgc_pk'),
    ('work_external_tag_group_current','wetgc_last_event_fk'),
    ('work_external_tag_group_current','wetgc_corp_id_ck'),
    ('work_external_tag_group_current','wetgc_identity_ck'),
    ('work_external_tag_group_current','wetgc_lifecycle_state_ck'),
    ('work_external_tag_group_current','wetgc_values_ck'),
    ('work_external_tag_group_current','wetgc_event_fence_ck'),
    ('work_external_tag_group_current','wetgc_snapshot_ck'),
    ('work_external_tag_group_current','wetgc_time_ck'),
    ('work_external_tag_current','wetc_pk'),
    ('work_external_tag_current','wetc_group_fk'),
    ('work_external_tag_current','wetc_last_event_fk'),
    ('work_external_tag_current','wetc_corp_id_ck'),
    ('work_external_tag_current','wetc_identity_ck'),
    ('work_external_tag_current','wetc_lifecycle_state_ck'),
    ('work_external_tag_current','wetc_values_ck'),
    ('work_external_tag_current','wetc_event_fence_ck'),
    ('work_external_tag_current','wetc_snapshot_ck'),
    ('work_external_tag_current','wetc_time_ck'),
    ('work_external_tag_projection_fence','wetpf_pk'),
    ('work_external_tag_projection_fence','wetpf_last_event_fk'),
    ('work_external_tag_projection_fence','wetpf_corp_id_ck'),
    ('work_external_tag_projection_fence','wetpf_identity_ck'),
    ('work_external_tag_projection_fence','wetpf_event_fence_ck'),
    ('work_external_tag_projection_fence','wetpf_time_ck')
  ) AS expected(table_name, constraint_name)
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass(format('%I.%I', target_schema, table_name))
        AND conname = constraint_name
    ) THEN CONTINUE; END IF;
    CASE constraint_name
      WHEN 'wetgc_pk' THEN EXECUTE format('ALTER TABLE %I.work_external_tag_group_current ADD CONSTRAINT wetgc_pk PRIMARY KEY (corp_id,strategy_id,group_id)', target_schema);
      WHEN 'wetgc_last_event_fk' THEN EXECUTE format('ALTER TABLE %I.work_external_tag_group_current ADD CONSTRAINT wetgc_last_event_fk FOREIGN KEY (last_event_id,corp_id,last_event_key,last_event_subject_key_hash,last_event_time,last_sequence_rank) REFERENCES %I.work_callback_event (id,corp_id,event_key,subject_key_hash,event_time,sequence_rank) ON DELETE RESTRICT', target_schema, target_schema);
      WHEN 'wetgc_corp_id_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_external_tag_group_current ADD CONSTRAINT wetgc_corp_id_ck CHECK (corp_id ~ '^[A-Za-z0-9_-]{1,18}$')$q$, target_schema);
      WHEN 'wetgc_identity_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_external_tag_group_current ADD CONSTRAINT wetgc_identity_ck CHECK (strategy_id BETWEEN 0 AND 2147483647 AND group_id <> '' AND group_id = btrim(group_id) AND octet_length(group_id) <= 128 AND group_id !~ '[[:cntrl:]]')$q$, target_schema);
      WHEN 'wetgc_lifecycle_state_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_external_tag_group_current ADD CONSTRAINT wetgc_lifecycle_state_ck CHECK (lifecycle_state IN ('ACTIVE','DELETED'))$q$, target_schema);
      WHEN 'wetgc_values_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_external_tag_group_current ADD CONSTRAINT wetgc_values_ck CHECK ((group_name IS NULL OR (group_name <> '' AND group_name = btrim(group_name) AND group_name !~ '[[:cntrl:]]')) AND (sort_order IS NULL OR sort_order BETWEEN 0 AND 2147483647) AND (provider_create_time IS NULL OR provider_create_time >= 0))$q$, target_schema);
      WHEN 'wetgc_event_fence_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_external_tag_group_current ADD CONSTRAINT wetgc_event_fence_ck CHECK (last_event_id > 0 AND last_event_key ~ '^[0-9a-f]{64}$' AND last_event_subject_key_hash ~ '^[0-9a-f]{64}$' AND last_event_time > 0 AND last_sequence_rank >= 0)$q$, target_schema);
      WHEN 'wetgc_snapshot_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_external_tag_group_current ADD CONSTRAINT wetgc_snapshot_ck CHECK ((lifecycle_state = 'ACTIVE' AND snapshot_complete = true AND group_name IS NOT NULL AND sort_order IS NOT NULL AND provider_create_time IS NOT NULL AND deleted_time IS NULL) OR (lifecycle_state = 'DELETED' AND snapshot_complete = false AND deleted_time IS NOT NULL))$q$, target_schema);
      WHEN 'wetgc_time_ck' THEN EXECUTE format('ALTER TABLE %I.work_external_tag_group_current ADD CONSTRAINT wetgc_time_ck CHECK (create_time >= 0 AND update_time >= 0 AND (deleted_time IS NULL OR deleted_time > 0))', target_schema);

      WHEN 'wetc_pk' THEN EXECUTE format('ALTER TABLE %I.work_external_tag_current ADD CONSTRAINT wetc_pk PRIMARY KEY (corp_id,strategy_id,tag_id)', target_schema);
      WHEN 'wetc_group_fk' THEN EXECUTE format('ALTER TABLE %I.work_external_tag_current ADD CONSTRAINT wetc_group_fk FOREIGN KEY (corp_id,strategy_id,group_id) REFERENCES %I.work_external_tag_group_current (corp_id,strategy_id,group_id) ON DELETE RESTRICT', target_schema, target_schema);
      WHEN 'wetc_last_event_fk' THEN EXECUTE format('ALTER TABLE %I.work_external_tag_current ADD CONSTRAINT wetc_last_event_fk FOREIGN KEY (last_event_id,corp_id,last_event_key,last_event_subject_key_hash,last_event_time,last_sequence_rank) REFERENCES %I.work_callback_event (id,corp_id,event_key,subject_key_hash,event_time,sequence_rank) ON DELETE RESTRICT', target_schema, target_schema);
      WHEN 'wetc_corp_id_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_external_tag_current ADD CONSTRAINT wetc_corp_id_ck CHECK (corp_id ~ '^[A-Za-z0-9_-]{1,18}$')$q$, target_schema);
      WHEN 'wetc_identity_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_external_tag_current ADD CONSTRAINT wetc_identity_ck CHECK (strategy_id BETWEEN 0 AND 2147483647 AND tag_id <> '' AND tag_id = btrim(tag_id) AND octet_length(tag_id) <= 128 AND tag_id !~ '[[:cntrl:]]' AND (group_id IS NULL OR (group_id <> '' AND group_id = btrim(group_id) AND octet_length(group_id) <= 128 AND group_id !~ '[[:cntrl:]]')))$q$, target_schema);
      WHEN 'wetc_lifecycle_state_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_external_tag_current ADD CONSTRAINT wetc_lifecycle_state_ck CHECK (lifecycle_state IN ('ACTIVE','DELETED'))$q$, target_schema);
      WHEN 'wetc_values_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_external_tag_current ADD CONSTRAINT wetc_values_ck CHECK ((name IS NULL OR (name <> '' AND name = btrim(name) AND name !~ '[[:cntrl:]]')) AND (sort_order IS NULL OR sort_order BETWEEN 0 AND 2147483647) AND (provider_create_time IS NULL OR provider_create_time >= 0))$q$, target_schema);
      WHEN 'wetc_event_fence_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_external_tag_current ADD CONSTRAINT wetc_event_fence_ck CHECK (last_event_id > 0 AND last_event_key ~ '^[0-9a-f]{64}$' AND last_event_subject_key_hash ~ '^[0-9a-f]{64}$' AND last_event_time > 0 AND last_sequence_rank >= 0)$q$, target_schema);
      WHEN 'wetc_snapshot_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_external_tag_current ADD CONSTRAINT wetc_snapshot_ck CHECK ((lifecycle_state = 'ACTIVE' AND snapshot_complete = true AND group_id IS NOT NULL AND name IS NOT NULL AND sort_order IS NOT NULL AND provider_create_time IS NOT NULL AND deleted_time IS NULL) OR (lifecycle_state = 'DELETED' AND snapshot_complete = false AND deleted_time IS NOT NULL))$q$, target_schema);
      WHEN 'wetc_time_ck' THEN EXECUTE format('ALTER TABLE %I.work_external_tag_current ADD CONSTRAINT wetc_time_ck CHECK (create_time >= 0 AND update_time >= 0 AND (deleted_time IS NULL OR deleted_time > 0))', target_schema);

      WHEN 'wetpf_pk' THEN EXECUTE format('ALTER TABLE %I.work_external_tag_projection_fence ADD CONSTRAINT wetpf_pk PRIMARY KEY (corp_id,strategy_id,subject_type,remote_id)', target_schema);
      WHEN 'wetpf_last_event_fk' THEN EXECUTE format('ALTER TABLE %I.work_external_tag_projection_fence ADD CONSTRAINT wetpf_last_event_fk FOREIGN KEY (last_event_id,corp_id,last_event_key,last_event_subject_key_hash,last_event_time,last_sequence_rank) REFERENCES %I.work_callback_event (id,corp_id,event_key,subject_key_hash,event_time,sequence_rank) ON DELETE RESTRICT', target_schema, target_schema);
      WHEN 'wetpf_corp_id_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_external_tag_projection_fence ADD CONSTRAINT wetpf_corp_id_ck CHECK (corp_id ~ '^[A-Za-z0-9_-]{1,18}$')$q$, target_schema);
      WHEN 'wetpf_identity_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_external_tag_projection_fence ADD CONSTRAINT wetpf_identity_ck CHECK (strategy_id BETWEEN 0 AND 2147483647 AND subject_type IN ('tag','tag_group','catalog') AND remote_id <> '' AND remote_id = btrim(remote_id) AND octet_length(remote_id) <= 128 AND remote_id !~ '[[:cntrl:]]')$q$, target_schema);
      WHEN 'wetpf_event_fence_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_external_tag_projection_fence ADD CONSTRAINT wetpf_event_fence_ck CHECK (last_event_id > 0 AND last_event_key ~ '^[0-9a-f]{64}$' AND last_event_subject_key_hash ~ '^[0-9a-f]{64}$' AND last_event_time > 0 AND last_sequence_rank >= 0)$q$, target_schema);
      WHEN 'wetpf_time_ck' THEN EXECUTE format('ALTER TABLE %I.work_external_tag_projection_fence ADD CONSTRAINT wetpf_time_ck CHECK (create_time >= 0 AND update_time >= 0)', target_schema);
      ELSE RAISE EXCEPTION '0117 internal unknown constraint %', constraint_name;
    END CASE;
  END LOOP;

  EXECUTE format('CREATE INDEX IF NOT EXISTS wetgc_catalog_idx ON %I.work_external_tag_group_current (corp_id,strategy_id,lifecycle_state,sort_order,group_id)', target_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS wetgc_last_event_idx ON %I.work_external_tag_group_current (last_event_id)', target_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS wetc_group_state_idx ON %I.work_external_tag_current (corp_id,strategy_id,group_id,lifecycle_state,sort_order,tag_id)', target_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS wetc_last_event_idx ON %I.work_external_tag_current (last_event_id)', target_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS wetpf_last_event_idx ON %I.work_external_tag_projection_fence (last_event_id)', target_schema);
END
$work_external_tag_current_projection$;

-- Reject CREATE TABLE IF NOT EXISTS drift, including defaults and collation.
DO $work_external_tag_column_verification$
DECLARE
  target_schema text := current_schema();
  expected_record record;
  actual_shape text[];
BEGIN
  FOR expected_record IN SELECT * FROM (VALUES
    ('work_external_tag_group_current',ARRAY[
      'corp_id|character varying(18)|N||','strategy_id|integer|N||0','group_id|character varying(128)|N||',
      'lifecycle_state|character varying(16)|N||','snapshot_complete|boolean|N||false','group_name|character varying(256)|Y||',
      'sort_order|integer|Y||','provider_create_time|integer|Y||','last_event_id|integer|N||','last_event_key|character varying(64)|N||',
      'last_event_subject_key_hash|character varying(64)|N||','last_event_time|integer|N||','last_sequence_rank|integer|N||',
      'create_time|integer|N||0','update_time|integer|N||0','deleted_time|integer|Y||'
    ]::text[]),
    ('work_external_tag_current',ARRAY[
      'corp_id|character varying(18)|N||','strategy_id|integer|N||0','tag_id|character varying(128)|N||','group_id|character varying(128)|Y||',
      'lifecycle_state|character varying(16)|N||','snapshot_complete|boolean|N||false','name|character varying(256)|Y||',
      'sort_order|integer|Y||','provider_create_time|integer|Y||','last_event_id|integer|N||','last_event_key|character varying(64)|N||',
      'last_event_subject_key_hash|character varying(64)|N||','last_event_time|integer|N||','last_sequence_rank|integer|N||',
      'create_time|integer|N||0','update_time|integer|N||0','deleted_time|integer|Y||'
    ]::text[]),
    ('work_external_tag_projection_fence',ARRAY[
      'corp_id|character varying(18)|N||','strategy_id|integer|N||0','subject_type|character varying(16)|N||','remote_id|character varying(128)|N||',
      'last_event_id|integer|N||','last_event_key|character varying(64)|N||','last_event_subject_key_hash|character varying(64)|N||',
      'last_event_time|integer|N||','last_sequence_rank|integer|N||','create_time|integer|N||0','update_time|integer|N||0'
    ]::text[])
  ) AS expected(table_name,expected_shape)
  LOOP
    IF to_regclass(expected_record.table_name) IS DISTINCT FROM to_regclass(format('%I.%I',target_schema,expected_record.table_name)) THEN
      RAISE EXCEPTION '0117 search_path misbinds % during verification',expected_record.table_name;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=target_schema AND c.relname=expected_record.table_name
        AND c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition
    ) THEN RAISE EXCEPTION '% is not a permanent ordinary table',expected_record.table_name; END IF;
    SELECT array_agg(a.attname||'|'||format_type(a.atttypid,a.atttypmod)||'|'||CASE WHEN a.attnotnull THEN 'N' ELSE 'Y' END||'|'||a.attidentity::text||'|'||COALESCE(pg_get_expr(d.adbin,d.adrelid),'') ORDER BY a.attnum)
      INTO actual_shape
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=to_regclass(format('%I.%I',target_schema,expected_record.table_name))
      AND a.attnum>0 AND NOT a.attisdropped;
    IF actual_shape IS DISTINCT FROM expected_record.expected_shape THEN
      RAISE EXCEPTION '% has an incompatible column shape: %',expected_record.table_name,actual_shape;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid
      WHERE a.attrelid=to_regclass(format('%I.%I',target_schema,expected_record.table_name))
        AND a.attnum>0 AND NOT a.attisdropped
        AND (a.attidentity<>'' OR a.attgenerated<>'' OR a.attcollation<>t.typcollation)
    ) THEN RAISE EXCEPTION '% has incompatible identity/generated/collation metadata',expected_record.table_name; END IF;
  END LOOP;
END
$work_external_tag_column_verification$;

DO $work_external_tag_constraint_verification$
DECLARE
  target_schema text := current_schema();
  expected_record record;
  compatible boolean;
BEGIN
  FOR expected_record IN SELECT * FROM (VALUES
    ('work_callback_event','wce_department_ref_uq','u',ARRAY['id','corp_id','event_key','subject_key_hash','event_time','sequence_rank']::text[]),
    ('work_external_tag_group_current','wetgc_pk','p',ARRAY['corp_id','strategy_id','group_id']::text[]),
    ('work_external_tag_current','wetc_pk','p',ARRAY['corp_id','strategy_id','tag_id']::text[]),
    ('work_external_tag_projection_fence','wetpf_pk','p',ARRAY['corp_id','strategy_id','subject_type','remote_id']::text[])
  ) AS expected(table_name,constraint_name,constraint_type,key_columns)
  LOOP
    SELECT count(*)=1 AND COALESCE(bool_and(
      c.convalidated AND c.conislocal AND c.coninhcount=0 AND c.conparentid=0
      AND NOT c.condeferrable AND NOT c.condeferred
      AND ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(attnum,pos)
        JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum ORDER BY k.pos)=expected_record.key_columns
    ),false) INTO compatible
    FROM pg_constraint c
    WHERE c.conrelid=to_regclass(format('%I.%I',target_schema,expected_record.table_name))
      AND c.conname=expected_record.constraint_name AND c.contype=expected_record.constraint_type::"char";
    IF NOT compatible THEN RAISE EXCEPTION 'constraint %.% has incompatible key metadata',expected_record.table_name,expected_record.constraint_name; END IF;
  END LOOP;

  FOR expected_record IN SELECT * FROM (VALUES
    ('work_external_tag_group_current','wetgc_last_event_fk',ARRAY['last_event_id','corp_id','last_event_key','last_event_subject_key_hash','last_event_time','last_sequence_rank']::text[],'work_callback_event',ARRAY['id','corp_id','event_key','subject_key_hash','event_time','sequence_rank']::text[]),
    ('work_external_tag_current','wetc_group_fk',ARRAY['corp_id','strategy_id','group_id']::text[],'work_external_tag_group_current',ARRAY['corp_id','strategy_id','group_id']::text[]),
    ('work_external_tag_current','wetc_last_event_fk',ARRAY['last_event_id','corp_id','last_event_key','last_event_subject_key_hash','last_event_time','last_sequence_rank']::text[],'work_callback_event',ARRAY['id','corp_id','event_key','subject_key_hash','event_time','sequence_rank']::text[]),
    ('work_external_tag_projection_fence','wetpf_last_event_fk',ARRAY['last_event_id','corp_id','last_event_key','last_event_subject_key_hash','last_event_time','last_sequence_rank']::text[],'work_callback_event',ARRAY['id','corp_id','event_key','subject_key_hash','event_time','sequence_rank']::text[])
  ) AS expected(table_name,constraint_name,key_columns,foreign_table,foreign_columns)
  LOOP
    SELECT count(*)=1 AND COALESCE(bool_and(
      c.convalidated AND c.conislocal AND c.coninhcount=0 AND c.conparentid=0
      AND NOT c.condeferrable AND NOT c.condeferred AND c.confdeltype='r'
      AND c.confupdtype='a' AND c.confmatchtype='s'
      AND c.confrelid=to_regclass(format('%I.%I',target_schema,expected_record.foreign_table))
      AND ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(attnum,pos)
        JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum ORDER BY k.pos)=expected_record.key_columns
      AND ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(attnum,pos)
        JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.attnum ORDER BY k.pos)=expected_record.foreign_columns
    ),false) INTO compatible
    FROM pg_constraint c
    WHERE c.conrelid=to_regclass(format('%I.%I',target_schema,expected_record.table_name))
      AND c.conname=expected_record.constraint_name AND c.contype='f';
    IF NOT compatible THEN RAISE EXCEPTION 'constraint %.% has incompatible FK metadata',expected_record.table_name,expected_record.constraint_name; END IF;
  END LOOP;

  IF EXISTS (
    SELECT expected.table_name,expected.constraint_name FROM (VALUES
      ('work_external_tag_group_current','wetgc_corp_id_ck'),('work_external_tag_group_current','wetgc_identity_ck'),
      ('work_external_tag_group_current','wetgc_lifecycle_state_ck'),('work_external_tag_group_current','wetgc_values_ck'),
      ('work_external_tag_group_current','wetgc_event_fence_ck'),('work_external_tag_group_current','wetgc_snapshot_ck'),('work_external_tag_group_current','wetgc_time_ck'),
      ('work_external_tag_current','wetc_corp_id_ck'),('work_external_tag_current','wetc_identity_ck'),
      ('work_external_tag_current','wetc_lifecycle_state_ck'),('work_external_tag_current','wetc_values_ck'),
      ('work_external_tag_current','wetc_event_fence_ck'),('work_external_tag_current','wetc_snapshot_ck'),('work_external_tag_current','wetc_time_ck'),
      ('work_external_tag_projection_fence','wetpf_corp_id_ck'),('work_external_tag_projection_fence','wetpf_identity_ck'),
      ('work_external_tag_projection_fence','wetpf_event_fence_ck'),('work_external_tag_projection_fence','wetpf_time_ck')
    ) AS expected(table_name,constraint_name)
    LEFT JOIN pg_constraint c ON c.conrelid=to_regclass(format('%I.%I',target_schema,expected.table_name))
      AND c.conname=expected.constraint_name AND c.contype='c' AND c.convalidated
      AND c.conislocal AND c.coninhcount=0 AND c.conparentid=0
      AND NOT c.condeferrable AND NOT c.condeferred
    WHERE c.oid IS NULL
  ) THEN RAISE EXCEPTION '0117 has missing or incompatible CHECK metadata'; END IF;
  IF (
    SELECT count(*) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
      JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname=target_schema AND t.relname IN (
      'work_external_tag_group_current','work_external_tag_current','work_external_tag_projection_fence'
    )
  )<>25 THEN RAISE EXCEPTION '0117 projection constraint count drift'; END IF;
END
$work_external_tag_constraint_verification$;

-- Closed authority surface: reject extra constraints/indexes/RLS/rules/policies/triggers.
DO $work_external_tag_closed_surface_verification$
DECLARE
  target_schema text := current_schema();
  expected_record record;
  table_oid oid;
  actual_names text[];
BEGIN
  FOR expected_record IN SELECT * FROM (VALUES
    ('work_external_tag_group_current',ARRAY['wetgc_corp_id_ck','wetgc_event_fence_ck','wetgc_identity_ck','wetgc_last_event_fk','wetgc_lifecycle_state_ck','wetgc_pk','wetgc_snapshot_ck','wetgc_time_ck','wetgc_values_ck']::text[],ARRAY['wetgc_catalog_idx','wetgc_last_event_idx','wetgc_pk']::text[]),
    ('work_external_tag_current',ARRAY['wetc_corp_id_ck','wetc_event_fence_ck','wetc_group_fk','wetc_identity_ck','wetc_last_event_fk','wetc_lifecycle_state_ck','wetc_pk','wetc_snapshot_ck','wetc_time_ck','wetc_values_ck']::text[],ARRAY['wetc_group_state_idx','wetc_last_event_idx','wetc_pk']::text[]),
    ('work_external_tag_projection_fence',ARRAY['wetpf_corp_id_ck','wetpf_event_fence_ck','wetpf_identity_ck','wetpf_last_event_fk','wetpf_pk','wetpf_time_ck']::text[],ARRAY['wetpf_last_event_idx','wetpf_pk']::text[])
  ) AS expected(table_name,constraint_names,index_names)
  LOOP
    table_oid:=to_regclass(format('%I.%I',target_schema,expected_record.table_name));
    SELECT array_agg(conname ORDER BY conname) INTO actual_names
      FROM pg_constraint WHERE conrelid=table_oid AND contype<>'n';
    IF actual_names IS DISTINCT FROM expected_record.constraint_names THEN
      RAISE EXCEPTION '% has an unexpected constraint set: %',expected_record.table_name,actual_names;
    END IF;
    SELECT array_agg(i.relname ORDER BY i.relname) INTO actual_names
      FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid WHERE x.indrelid=table_oid;
    IF actual_names IS DISTINCT FROM expected_record.index_names THEN
      RAISE EXCEPTION '% has an unexpected index set: %',expected_record.table_name,actual_names;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_index WHERE indrelid=table_oid AND (NOT indisvalid OR NOT indisready OR NOT indislive))
      OR EXISTS (SELECT 1 FROM pg_class WHERE oid=table_oid AND (relrowsecurity OR relforcerowsecurity OR relhasrules))
      OR EXISTS (SELECT 1 FROM pg_policy WHERE polrelid=table_oid)
      OR EXISTS (SELECT 1 FROM pg_rewrite WHERE ev_class=table_oid)
      OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=table_oid AND NOT tgisinternal) THEN
      RAISE EXCEPTION '% has invalid indexes or unexpected authority metadata',expected_record.table_name;
    END IF;
  END LOOP;
END
$work_external_tag_closed_surface_verification$;

-- Exact index definitions, access methods, ownership and uniqueness.
DO $work_external_tag_index_verification$
DECLARE
  target_schema text := current_schema();
  expected_record record;
  actual_definition text;
  compatible boolean;
BEGIN
  FOR expected_record IN SELECT * FROM (VALUES
    ('work_external_tag_group_current','wetgc_pk','btree',true,'CREATE UNIQUE INDEX wetgc_pk ON %I.work_external_tag_group_current USING btree (corp_id, strategy_id, group_id)'),
    ('work_external_tag_group_current','wetgc_catalog_idx','btree',false,'CREATE INDEX wetgc_catalog_idx ON %I.work_external_tag_group_current USING btree (corp_id, strategy_id, lifecycle_state, sort_order, group_id)'),
    ('work_external_tag_group_current','wetgc_last_event_idx','btree',false,'CREATE INDEX wetgc_last_event_idx ON %I.work_external_tag_group_current USING btree (last_event_id)'),
    ('work_external_tag_current','wetc_pk','btree',true,'CREATE UNIQUE INDEX wetc_pk ON %I.work_external_tag_current USING btree (corp_id, strategy_id, tag_id)'),
    ('work_external_tag_current','wetc_group_state_idx','btree',false,'CREATE INDEX wetc_group_state_idx ON %I.work_external_tag_current USING btree (corp_id, strategy_id, group_id, lifecycle_state, sort_order, tag_id)'),
    ('work_external_tag_current','wetc_last_event_idx','btree',false,'CREATE INDEX wetc_last_event_idx ON %I.work_external_tag_current USING btree (last_event_id)'),
    ('work_external_tag_projection_fence','wetpf_pk','btree',true,'CREATE UNIQUE INDEX wetpf_pk ON %I.work_external_tag_projection_fence USING btree (corp_id, strategy_id, subject_type, remote_id)'),
    ('work_external_tag_projection_fence','wetpf_last_event_idx','btree',false,'CREATE INDEX wetpf_last_event_idx ON %I.work_external_tag_projection_fence USING btree (last_event_id)')
  ) AS expected(table_name,index_name,access_method,is_unique,index_definition)
  LOOP
    SELECT count(*)=1 AND COALESCE(bool_and(
      x.indisvalid AND x.indisready AND x.indislive AND x.indisunique=expected_record.is_unique
      AND NOT x.indisexclusion AND x.indpred IS NULL AND x.indexprs IS NULL
      AND am.amname=expected_record.access_method
      AND i.relnamespace=(SELECT oid FROM pg_namespace WHERE nspname=target_schema)
      AND i.relpersistence='p'
    ),false),max(pg_get_indexdef(i.oid)) INTO compatible,actual_definition
    FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_am am ON am.oid=i.relam
    WHERE x.indrelid=to_regclass(format('%I.%I',target_schema,expected_record.table_name))
      AND i.relname=expected_record.index_name;
    IF NOT compatible OR actual_definition IS DISTINCT FROM format(expected_record.index_definition,target_schema) THEN
      RAISE EXCEPTION 'index %.% has incompatible metadata: %',expected_record.table_name,expected_record.index_name,actual_definition;
    END IF;
  END LOOP;
END
$work_external_tag_index_verification$;
