/** Exact bundled copy of migrations/0114_work_department_current_projection.sql. */
export const WORK_DEPARTMENT_CURRENT_PROJECTION_SQL = `-- Expand-only canonical Enterprise WeChat department projection. The legacy
-- work_department table remains untouched as import evidence.
DO $work_department_current_projection$
DECLARE
  target_schema text := current_schema();
  callback_oid oid;
  qualified_oid oid;
  table_name text;
  constraint_name text;
BEGIN
  IF target_schema IS NULL OR target_schema = '' OR left(target_schema, 3) = 'pg_' THEN
    RAISE EXCEPTION '0114 requires a non-system current schema';
  END IF;

  callback_oid := to_regclass('work_callback_event');
  qualified_oid := to_regclass(format('%I.%I', target_schema, 'work_callback_event'));
  IF callback_oid IS NULL OR callback_oid IS DISTINCT FROM qualified_oid THEN
    RAISE EXCEPTION '0114 search_path resolves work_callback_event outside current schema %', target_schema;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = callback_oid AND relkind = 'r' AND relpersistence = 'p'
      AND NOT relispartition
  ) THEN
    RAISE EXCEPTION 'work_callback_event must be a permanent ordinary table';
  END IF;

  -- A temp or earlier search_path relation must never capture an unqualified
  -- reference on a repeated run.
  FOREACH table_name IN ARRAY ARRAY[
    'work_department_current',
    'work_department_projection_fence',
    'work_department_leader_current'
  ]
  LOOP
    qualified_oid := to_regclass(format('%I.%I', target_schema, table_name));
    IF to_regclass(table_name) IS NOT NULL
      AND to_regclass(table_name) IS DISTINCT FROM qualified_oid THEN
      RAISE EXCEPTION '0114 search_path misbinds % outside current schema %', table_name, target_schema;
    END IF;
  END LOOP;

  -- The composite callback reference is intentionally redundant with id's PK:
  -- it fences every projected value to the exact immutable callback tuple.
  EXECUTE format('LOCK TABLE %I.%I IN ACCESS EXCLUSIVE MODE', target_schema, 'work_callback_event');
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = callback_oid AND conname = 'wce_department_ref_uq'
  ) THEN
    EXECUTE format(
      'ALTER TABLE %I.%I ADD CONSTRAINT wce_department_ref_uq UNIQUE '
      || '(id, corp_id, event_key, subject_key_hash, event_time, sequence_rank)',
      target_schema, 'work_callback_event'
    );
  END IF;

  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %I.work_department_current (
      corp_id varchar(18) NOT NULL,
      department_id integer NOT NULL,
      lifecycle_state varchar(16) NOT NULL DEFAULT 'UNRESOLVED',
      profile_complete boolean NOT NULL DEFAULT false,
      name varchar(128),
      name_en varchar(128),
      parent_department_id integer,
      sort_order bigint,
      last_event_id integer,
      last_event_key varchar(64),
      last_event_subject_key_hash varchar(64),
      last_event_time integer NOT NULL DEFAULT 0,
      last_sequence_rank integer NOT NULL DEFAULT 0,
      create_time integer NOT NULL DEFAULT 0,
      update_time integer NOT NULL DEFAULT 0,
      deleted_time integer
    )
  $ddl$, target_schema);
  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %I.work_department_projection_fence (
      corp_id varchar(18) NOT NULL,
      department_id integer NOT NULL,
      last_event_id integer NOT NULL,
      last_event_key varchar(64) NOT NULL,
      last_event_subject_key_hash varchar(64) NOT NULL,
      last_event_time integer NOT NULL,
      last_sequence_rank integer NOT NULL,
      create_time integer NOT NULL DEFAULT 0,
      update_time integer NOT NULL DEFAULT 0
    )
  $ddl$, target_schema);
  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %I.work_department_leader_current (
      corp_id varchar(18) NOT NULL,
      department_id integer NOT NULL,
      userid varchar(64) NOT NULL,
      sort_order integer NOT NULL,
      create_time integer NOT NULL DEFAULT 0,
      update_time integer NOT NULL DEFAULT 0
    )
  $ddl$, target_schema);

  -- Add only absent named constraints. The verification blocks below reject
  -- any same-named object whose metadata, keys, action, or expression drifts.
  FOR table_name, constraint_name IN
    SELECT * FROM (VALUES
      ('work_department_current', 'wdc_pk'),
      ('work_department_current', 'wdc_parent_fk'),
      ('work_department_current', 'wdc_last_event_fk'),
      ('work_department_current', 'wdc_corp_id_ck'),
      ('work_department_current', 'wdc_identity_ck'),
      ('work_department_current', 'wdc_lifecycle_state_ck'),
      ('work_department_current', 'wdc_name_ck'),
      ('work_department_current', 'wdc_sort_ck'),
      ('work_department_current', 'wdc_event_fence_ck'),
      ('work_department_current', 'wdc_lifecycle_snapshot_ck'),
      ('work_department_current', 'wdc_time_ck'),
      ('work_department_projection_fence', 'wdpf_pk'),
      ('work_department_projection_fence', 'wdpf_department_fk'),
      ('work_department_projection_fence', 'wdpf_last_event_fk'),
      ('work_department_projection_fence', 'wdpf_corp_id_ck'),
      ('work_department_projection_fence', 'wdpf_identity_ck'),
      ('work_department_projection_fence', 'wdpf_event_fence_ck'),
      ('work_department_projection_fence', 'wdpf_time_ck'),
      ('work_department_leader_current', 'wdlc_pk'),
      ('work_department_leader_current', 'wdlc_department_fk'),
      ('work_department_leader_current', 'wdlc_corp_id_ck'),
      ('work_department_leader_current', 'wdlc_identity_ck'),
      ('work_department_leader_current', 'wdlc_userid_ck'),
      ('work_department_leader_current', 'wdlc_values_ck')
    ) AS expected(table_name, constraint_name)
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass(format('%I.%I', target_schema, table_name))
        AND conname = constraint_name
    ) THEN
      CONTINUE;
    END IF;
    CASE constraint_name
      WHEN 'wdc_pk' THEN EXECUTE format('ALTER TABLE %I.work_department_current ADD CONSTRAINT wdc_pk PRIMARY KEY (corp_id, department_id)', target_schema);
      WHEN 'wdc_parent_fk' THEN EXECUTE format('ALTER TABLE %I.work_department_current ADD CONSTRAINT wdc_parent_fk FOREIGN KEY (corp_id, parent_department_id) REFERENCES %I.work_department_current (corp_id, department_id) ON DELETE RESTRICT', target_schema, target_schema);
      WHEN 'wdc_last_event_fk' THEN EXECUTE format('ALTER TABLE %I.work_department_current ADD CONSTRAINT wdc_last_event_fk FOREIGN KEY (last_event_id, corp_id, last_event_key, last_event_subject_key_hash, last_event_time, last_sequence_rank) REFERENCES %I.work_callback_event (id, corp_id, event_key, subject_key_hash, event_time, sequence_rank) ON DELETE RESTRICT', target_schema, target_schema);
      WHEN 'wdc_corp_id_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_department_current ADD CONSTRAINT wdc_corp_id_ck CHECK (corp_id ~ '^[A-Za-z0-9_-]{1,18}$')$q$, target_schema);
      WHEN 'wdc_identity_ck' THEN EXECUTE format('ALTER TABLE %I.work_department_current ADD CONSTRAINT wdc_identity_ck CHECK (department_id > 0 AND (parent_department_id IS NULL OR (parent_department_id > 0 AND parent_department_id <> department_id)))', target_schema);
      WHEN 'wdc_lifecycle_state_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_department_current ADD CONSTRAINT wdc_lifecycle_state_ck CHECK (lifecycle_state IN ('UNRESOLVED', 'ACTIVE', 'DELETED'))$q$, target_schema);
      WHEN 'wdc_name_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_department_current ADD CONSTRAINT wdc_name_ck CHECK ((name IS NULL OR (name <> '' AND name = btrim(name) AND name !~ '[[:cntrl:]]')) AND (name_en IS NULL OR (name_en = btrim(name_en) AND name_en !~ '[[:cntrl:]]')))$q$, target_schema);
      WHEN 'wdc_sort_ck' THEN EXECUTE format('ALTER TABLE %I.work_department_current ADD CONSTRAINT wdc_sort_ck CHECK (sort_order IS NULL OR (sort_order >= 0 AND sort_order <= 4294967295))', target_schema);
      WHEN 'wdc_event_fence_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_department_current ADD CONSTRAINT wdc_event_fence_ck CHECK ((last_event_id IS NULL AND last_event_key IS NULL AND last_event_subject_key_hash IS NULL AND last_event_time = 0 AND last_sequence_rank = 0) OR (last_event_id > 0 AND last_event_key ~ '^[0-9a-f]{64}$' AND last_event_subject_key_hash ~ '^[0-9a-f]{64}$' AND last_event_time > 0 AND last_sequence_rank >= 0))$q$, target_schema);
      WHEN 'wdc_lifecycle_snapshot_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_department_current ADD CONSTRAINT wdc_lifecycle_snapshot_ck CHECK ((lifecycle_state = 'UNRESOLVED' AND profile_complete = false AND name IS NULL AND name_en IS NULL AND parent_department_id IS NULL AND sort_order IS NULL AND last_event_id IS NULL AND deleted_time IS NULL) OR (lifecycle_state = 'ACTIVE' AND profile_complete = true AND name IS NOT NULL AND name_en IS NOT NULL AND sort_order IS NOT NULL AND last_event_id IS NOT NULL AND deleted_time IS NULL) OR (lifecycle_state = 'DELETED' AND profile_complete = false AND last_event_id IS NOT NULL AND deleted_time IS NOT NULL))$q$, target_schema);
      WHEN 'wdc_time_ck' THEN EXECUTE format('ALTER TABLE %I.work_department_current ADD CONSTRAINT wdc_time_ck CHECK (create_time >= 0 AND update_time >= 0 AND (deleted_time IS NULL OR deleted_time > 0))', target_schema);
      WHEN 'wdpf_pk' THEN EXECUTE format('ALTER TABLE %I.work_department_projection_fence ADD CONSTRAINT wdpf_pk PRIMARY KEY (corp_id, department_id)', target_schema);
      WHEN 'wdpf_department_fk' THEN EXECUTE format('ALTER TABLE %I.work_department_projection_fence ADD CONSTRAINT wdpf_department_fk FOREIGN KEY (corp_id, department_id) REFERENCES %I.work_department_current (corp_id, department_id) ON DELETE RESTRICT', target_schema, target_schema);
      WHEN 'wdpf_last_event_fk' THEN EXECUTE format('ALTER TABLE %I.work_department_projection_fence ADD CONSTRAINT wdpf_last_event_fk FOREIGN KEY (last_event_id, corp_id, last_event_key, last_event_subject_key_hash, last_event_time, last_sequence_rank) REFERENCES %I.work_callback_event (id, corp_id, event_key, subject_key_hash, event_time, sequence_rank) ON DELETE RESTRICT', target_schema, target_schema);
      WHEN 'wdpf_corp_id_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_department_projection_fence ADD CONSTRAINT wdpf_corp_id_ck CHECK (corp_id ~ '^[A-Za-z0-9_-]{1,18}$')$q$, target_schema);
      WHEN 'wdpf_identity_ck' THEN EXECUTE format('ALTER TABLE %I.work_department_projection_fence ADD CONSTRAINT wdpf_identity_ck CHECK (department_id > 0)', target_schema);
      WHEN 'wdpf_event_fence_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_department_projection_fence ADD CONSTRAINT wdpf_event_fence_ck CHECK (last_event_id > 0 AND last_event_key ~ '^[0-9a-f]{64}$' AND last_event_subject_key_hash ~ '^[0-9a-f]{64}$' AND last_event_time > 0 AND last_sequence_rank >= 0)$q$, target_schema);
      WHEN 'wdpf_time_ck' THEN EXECUTE format('ALTER TABLE %I.work_department_projection_fence ADD CONSTRAINT wdpf_time_ck CHECK (create_time >= 0 AND update_time >= 0)', target_schema);
      WHEN 'wdlc_pk' THEN EXECUTE format('ALTER TABLE %I.work_department_leader_current ADD CONSTRAINT wdlc_pk PRIMARY KEY (corp_id, department_id, userid)', target_schema);
      WHEN 'wdlc_department_fk' THEN EXECUTE format('ALTER TABLE %I.work_department_leader_current ADD CONSTRAINT wdlc_department_fk FOREIGN KEY (corp_id, department_id) REFERENCES %I.work_department_current (corp_id, department_id) ON DELETE RESTRICT', target_schema, target_schema);
      WHEN 'wdlc_corp_id_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_department_leader_current ADD CONSTRAINT wdlc_corp_id_ck CHECK (corp_id ~ '^[A-Za-z0-9_-]{1,18}$')$q$, target_schema);
      WHEN 'wdlc_identity_ck' THEN EXECUTE format('ALTER TABLE %I.work_department_leader_current ADD CONSTRAINT wdlc_identity_ck CHECK (department_id > 0)', target_schema);
      WHEN 'wdlc_userid_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_department_leader_current ADD CONSTRAINT wdlc_userid_ck CHECK (userid <> '' AND userid = btrim(userid) AND userid = lower(userid) AND userid ~ '^[a-z0-9][a-z0-9_@.-]{0,63}$' AND userid !~ '[[:cntrl:]]')$q$, target_schema);
      WHEN 'wdlc_values_ck' THEN EXECUTE format('ALTER TABLE %I.work_department_leader_current ADD CONSTRAINT wdlc_values_ck CHECK (sort_order BETWEEN 0 AND 9 AND create_time >= 0 AND update_time >= 0)', target_schema);
      ELSE RAISE EXCEPTION '0114 internal unknown constraint %', constraint_name;
    END CASE;
  END LOOP;

  EXECUTE format('CREATE INDEX IF NOT EXISTS wdc_active_tree_idx ON %I.work_department_current (corp_id, parent_department_id, sort_order DESC, department_id) WHERE lifecycle_state = ''ACTIVE''', target_schema);
  EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS wdc_active_root_uidx ON %I.work_department_current (corp_id) WHERE lifecycle_state = ''ACTIVE'' AND parent_department_id IS NULL', target_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS wdc_parent_idx ON %I.work_department_current (corp_id, parent_department_id, department_id)', target_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS wdc_last_event_idx ON %I.work_department_current (last_event_id) WHERE last_event_id IS NOT NULL', target_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS wdpf_last_event_idx ON %I.work_department_projection_fence (last_event_id)', target_schema);
  EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS wdlc_position_uidx ON %I.work_department_leader_current (corp_id, department_id, sort_order)', target_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS wdlc_userid_idx ON %I.work_department_leader_current (corp_id, userid, department_id)', target_schema);
END
$work_department_current_projection$;

-- CREATE TABLE IF NOT EXISTS must never mask a wider or subtly incompatible
-- pre-existing table. Column order is part of the contract.
DO $work_department_column_verification$
DECLARE
  target_schema text := current_schema();
  expected_record record;
  actual_shape text[];
BEGIN
  FOR expected_record IN
    SELECT * FROM (VALUES
      ('work_department_current', ARRAY[
        'corp_id|character varying(18)|N||','department_id|integer|N||',
        'lifecycle_state|character varying(16)|N||''UNRESOLVED''::character varying',
        'profile_complete|boolean|N||false','name|character varying(128)|Y||',
        'name_en|character varying(128)|Y||','parent_department_id|integer|Y||',
        'sort_order|bigint|Y||','last_event_id|integer|Y||',
        'last_event_key|character varying(64)|Y||',
        'last_event_subject_key_hash|character varying(64)|Y||',
        'last_event_time|integer|N||0','last_sequence_rank|integer|N||0',
        'create_time|integer|N||0','update_time|integer|N||0','deleted_time|integer|Y||'
      ]::text[]),
      ('work_department_projection_fence', ARRAY[
        'corp_id|character varying(18)|N||','department_id|integer|N||',
        'last_event_id|integer|N||','last_event_key|character varying(64)|N||',
        'last_event_subject_key_hash|character varying(64)|N||',
        'last_event_time|integer|N||','last_sequence_rank|integer|N||',
        'create_time|integer|N||0','update_time|integer|N||0'
      ]::text[]),
      ('work_department_leader_current', ARRAY[
        'corp_id|character varying(18)|N||','department_id|integer|N||',
        'userid|character varying(64)|N||','sort_order|integer|N||',
        'create_time|integer|N||0','update_time|integer|N||0'
      ]::text[])
    ) AS expected(table_name, expected_shape)
  LOOP
    IF to_regclass(expected_record.table_name) IS DISTINCT FROM
       to_regclass(format('%I.%I', target_schema, expected_record.table_name)) THEN
      RAISE EXCEPTION '0114 search_path misbinds % during verification', expected_record.table_name;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname = target_schema AND c.relname = expected_record.table_name
        AND c.relkind = 'r' AND c.relpersistence = 'p' AND NOT c.relispartition
    ) THEN RAISE EXCEPTION '% is not a permanent ordinary table', expected_record.table_name; END IF;
    SELECT array_agg(a.attname || '|' || format_type(a.atttypid,a.atttypmod) || '|'
      || CASE WHEN a.attnotnull THEN 'N' ELSE 'Y' END || '|' || a.attidentity::text || '|'
      || COALESCE(pg_get_expr(d.adbin,d.adrelid),'') ORDER BY a.attnum)
      INTO actual_shape
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=to_regclass(format('%I.%I',target_schema,expected_record.table_name))
      AND a.attnum>0 AND NOT a.attisdropped;
    IF actual_shape IS DISTINCT FROM expected_record.expected_shape THEN
      RAISE EXCEPTION '% has an incompatible column shape', expected_record.table_name;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid
      WHERE a.attrelid=to_regclass(format('%I.%I',target_schema,expected_record.table_name))
        AND a.attnum>0 AND NOT a.attisdropped
        AND (a.attgenerated<>'' OR a.attcollation<>t.typcollation)
    ) THEN RAISE EXCEPTION '% has an incompatible generated column or collation', expected_record.table_name; END IF;
  END LOOP;
END
$work_department_column_verification$;

-- Verify exact key metadata, six-column callback fences, and delete actions.
DO $work_department_key_verification$
DECLARE
  target_schema text := current_schema();
  expected_record record;
  compatible boolean;
BEGIN
  FOR expected_record IN
    SELECT * FROM (VALUES
      ('work_callback_event','wce_department_ref_uq','u',ARRAY['id','corp_id','event_key','subject_key_hash','event_time','sequence_rank']::text[]),
      ('work_department_current','wdc_pk','p',ARRAY['corp_id','department_id']::text[]),
      ('work_department_projection_fence','wdpf_pk','p',ARRAY['corp_id','department_id']::text[]),
      ('work_department_leader_current','wdlc_pk','p',ARRAY['corp_id','department_id','userid']::text[])
    ) AS expected(table_name,constraint_name,constraint_type,key_columns)
  LOOP
    SELECT count(*)=1 AND COALESCE(bool_and(c.convalidated AND c.conislocal
      AND c.coninhcount=0 AND c.conparentid=0 AND NOT c.condeferrable AND NOT c.condeferred
      AND ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(attnum,pos)
        JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum ORDER BY k.pos)=expected_record.key_columns),false)
      INTO compatible
    FROM pg_constraint c
    WHERE c.conrelid=to_regclass(format('%I.%I',target_schema,expected_record.table_name))
      AND c.conname=expected_record.constraint_name AND c.contype=expected_record.constraint_type::"char";
    IF NOT compatible THEN RAISE EXCEPTION 'constraint %.% has incompatible key metadata', expected_record.table_name,expected_record.constraint_name; END IF;
  END LOOP;

  FOR expected_record IN
    SELECT * FROM (VALUES
      ('work_department_current','wdc_parent_fk',ARRAY['corp_id','parent_department_id']::text[],'work_department_current',ARRAY['corp_id','department_id']::text[]),
      ('work_department_current','wdc_last_event_fk',ARRAY['last_event_id','corp_id','last_event_key','last_event_subject_key_hash','last_event_time','last_sequence_rank']::text[],'work_callback_event',ARRAY['id','corp_id','event_key','subject_key_hash','event_time','sequence_rank']::text[]),
      ('work_department_projection_fence','wdpf_department_fk',ARRAY['corp_id','department_id']::text[],'work_department_current',ARRAY['corp_id','department_id']::text[]),
      ('work_department_projection_fence','wdpf_last_event_fk',ARRAY['last_event_id','corp_id','last_event_key','last_event_subject_key_hash','last_event_time','last_sequence_rank']::text[],'work_callback_event',ARRAY['id','corp_id','event_key','subject_key_hash','event_time','sequence_rank']::text[]),
      ('work_department_leader_current','wdlc_department_fk',ARRAY['corp_id','department_id']::text[],'work_department_current',ARRAY['corp_id','department_id']::text[])
    ) AS expected(table_name,constraint_name,key_columns,reference_table,reference_columns)
  LOOP
    SELECT count(*)=1 AND COALESCE(bool_and(c.convalidated AND c.conislocal AND c.coninhcount=0
      AND c.conparentid=0 AND NOT c.condeferrable AND NOT c.condeferred
      AND c.confrelid=to_regclass(format('%I.%I',target_schema,expected_record.reference_table))
      AND c.confupdtype='a' AND c.confdeltype='r' AND c.confmatchtype='s'
      AND ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(attnum,pos)
        JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum ORDER BY k.pos)=expected_record.key_columns
      AND ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(attnum,pos)
        JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.attnum ORDER BY k.pos)=expected_record.reference_columns),false)
      INTO compatible
    FROM pg_constraint c
    WHERE c.conrelid=to_regclass(format('%I.%I',target_schema,expected_record.table_name))
      AND c.conname=expected_record.constraint_name AND c.contype='f';
    IF NOT compatible THEN RAISE EXCEPTION 'foreign key %.% has an incompatible definition', expected_record.table_name,expected_record.constraint_name; END IF;
  END LOOP;

  -- Every expected CHECK must exist once with strict local/non-inherited metadata.
  FOR expected_record IN SELECT * FROM (VALUES
    ('work_department_current','wdc_corp_id_ck'),('work_department_current','wdc_identity_ck'),
    ('work_department_current','wdc_lifecycle_state_ck'),('work_department_current','wdc_name_ck'),
    ('work_department_current','wdc_sort_ck'),('work_department_current','wdc_event_fence_ck'),
    ('work_department_current','wdc_lifecycle_snapshot_ck'),('work_department_current','wdc_time_ck'),
    ('work_department_projection_fence','wdpf_corp_id_ck'),('work_department_projection_fence','wdpf_identity_ck'),
    ('work_department_projection_fence','wdpf_event_fence_ck'),('work_department_projection_fence','wdpf_time_ck'),
    ('work_department_leader_current','wdlc_corp_id_ck'),('work_department_leader_current','wdlc_identity_ck'),
    ('work_department_leader_current','wdlc_userid_ck'),('work_department_leader_current','wdlc_values_ck')
  ) AS expected(table_name,constraint_name)
  LOOP
    SELECT count(*)=1 AND COALESCE(bool_and(c.convalidated AND c.conislocal AND c.coninhcount=0
      AND c.conparentid=0 AND NOT c.connoinherit AND NOT c.condeferrable AND NOT c.condeferred),false)
      INTO compatible FROM pg_constraint c
    WHERE c.conrelid=to_regclass(format('%I.%I',target_schema,expected_record.table_name))
      AND c.conname=expected_record.constraint_name AND c.contype='c';
    IF NOT compatible THEN RAISE EXCEPTION 'check %.% has incompatible metadata',expected_record.table_name,expected_record.constraint_name; END IF;
  END LOOP;
END
$work_department_key_verification$;

-- Compare installed CHECK parse trees to same-server references. This rejects
-- weakened boolean grouping and literal drift without relying on raw SQL text.
DO $work_department_check_verification$
DECLARE
  target_schema text := current_schema();
  suffix text := substr(md5(pg_backend_pid()::text || clock_timestamp()::text),1,12);
  current_ref text; fence_ref text; leader_ref text;
  current_oid oid; fence_oid oid; leader_oid oid;
  expected_record record; actual_definition text; expected_definition text;
BEGIN
  current_ref := '__wdc_ck_'||suffix; fence_ref := '__wdpf_ck_'||suffix; leader_ref := '__wdlc_ck_'||suffix;
  EXECUTE format('CREATE TEMP TABLE %I (LIKE %I.work_department_current) ON COMMIT DROP',current_ref,target_schema);
  EXECUTE format('CREATE TEMP TABLE %I (LIKE %I.work_department_projection_fence) ON COMMIT DROP',fence_ref,target_schema);
  EXECUTE format('CREATE TEMP TABLE %I (LIKE %I.work_department_leader_current) ON COMMIT DROP',leader_ref,target_schema);
  current_oid:=to_regclass(format('pg_temp.%I',current_ref)); fence_oid:=to_regclass(format('pg_temp.%I',fence_ref)); leader_oid:=to_regclass(format('pg_temp.%I',leader_ref));
  EXECUTE format($q$ALTER TABLE pg_temp.%I
    ADD CONSTRAINT e_wdc_corp_id_ck CHECK (corp_id ~ '^[A-Za-z0-9_-]{1,18}$'),
    ADD CONSTRAINT e_wdc_identity_ck CHECK (department_id > 0 AND (parent_department_id IS NULL OR (parent_department_id > 0 AND parent_department_id <> department_id))),
    ADD CONSTRAINT e_wdc_lifecycle_state_ck CHECK (lifecycle_state IN ('UNRESOLVED','ACTIVE','DELETED')),
    ADD CONSTRAINT e_wdc_name_ck CHECK ((name IS NULL OR (name <> '' AND name=btrim(name) AND name !~ '[[:cntrl:]]')) AND (name_en IS NULL OR (name_en=btrim(name_en) AND name_en !~ '[[:cntrl:]]'))),
    ADD CONSTRAINT e_wdc_sort_ck CHECK (sort_order IS NULL OR (sort_order>=0 AND sort_order<=4294967295)),
    ADD CONSTRAINT e_wdc_event_fence_ck CHECK ((last_event_id IS NULL AND last_event_key IS NULL AND last_event_subject_key_hash IS NULL AND last_event_time=0 AND last_sequence_rank=0) OR (last_event_id>0 AND last_event_key ~ '^[0-9a-f]{64}$' AND last_event_subject_key_hash ~ '^[0-9a-f]{64}$' AND last_event_time>0 AND last_sequence_rank>=0)),
    ADD CONSTRAINT e_wdc_lifecycle_snapshot_ck CHECK ((lifecycle_state='UNRESOLVED' AND profile_complete=false AND name IS NULL AND name_en IS NULL AND parent_department_id IS NULL AND sort_order IS NULL AND last_event_id IS NULL AND deleted_time IS NULL) OR (lifecycle_state='ACTIVE' AND profile_complete=true AND name IS NOT NULL AND name_en IS NOT NULL AND sort_order IS NOT NULL AND last_event_id IS NOT NULL AND deleted_time IS NULL) OR (lifecycle_state='DELETED' AND profile_complete=false AND last_event_id IS NOT NULL AND deleted_time IS NOT NULL)),
    ADD CONSTRAINT e_wdc_time_ck CHECK (create_time>=0 AND update_time>=0 AND (deleted_time IS NULL OR deleted_time>0))$q$,current_ref);
  EXECUTE format($q$ALTER TABLE pg_temp.%I
    ADD CONSTRAINT e_wdpf_corp_id_ck CHECK (corp_id ~ '^[A-Za-z0-9_-]{1,18}$'),
    ADD CONSTRAINT e_wdpf_identity_ck CHECK (department_id>0),
    ADD CONSTRAINT e_wdpf_event_fence_ck CHECK (last_event_id>0 AND last_event_key ~ '^[0-9a-f]{64}$' AND last_event_subject_key_hash ~ '^[0-9a-f]{64}$' AND last_event_time>0 AND last_sequence_rank>=0),
    ADD CONSTRAINT e_wdpf_time_ck CHECK (create_time>=0 AND update_time>=0)$q$,fence_ref);
  EXECUTE format($q$ALTER TABLE pg_temp.%I
    ADD CONSTRAINT e_wdlc_corp_id_ck CHECK (corp_id ~ '^[A-Za-z0-9_-]{1,18}$'),
    ADD CONSTRAINT e_wdlc_identity_ck CHECK (department_id>0),
    ADD CONSTRAINT e_wdlc_userid_ck CHECK (userid<>'' AND userid=btrim(userid) AND userid=lower(userid) AND userid ~ '^[a-z0-9][a-z0-9_@.-]{0,63}$' AND userid !~ '[[:cntrl:]]'),
    ADD CONSTRAINT e_wdlc_values_ck CHECK (sort_order BETWEEN 0 AND 9 AND create_time>=0 AND update_time>=0)$q$,leader_ref);
  FOR expected_record IN SELECT * FROM (VALUES
    ('work_department_current','wdc_corp_id_ck',current_oid,'e_wdc_corp_id_ck'),('work_department_current','wdc_identity_ck',current_oid,'e_wdc_identity_ck'),('work_department_current','wdc_lifecycle_state_ck',current_oid,'e_wdc_lifecycle_state_ck'),('work_department_current','wdc_name_ck',current_oid,'e_wdc_name_ck'),('work_department_current','wdc_sort_ck',current_oid,'e_wdc_sort_ck'),('work_department_current','wdc_event_fence_ck',current_oid,'e_wdc_event_fence_ck'),('work_department_current','wdc_lifecycle_snapshot_ck',current_oid,'e_wdc_lifecycle_snapshot_ck'),('work_department_current','wdc_time_ck',current_oid,'e_wdc_time_ck'),
    ('work_department_projection_fence','wdpf_corp_id_ck',fence_oid,'e_wdpf_corp_id_ck'),('work_department_projection_fence','wdpf_identity_ck',fence_oid,'e_wdpf_identity_ck'),('work_department_projection_fence','wdpf_event_fence_ck',fence_oid,'e_wdpf_event_fence_ck'),('work_department_projection_fence','wdpf_time_ck',fence_oid,'e_wdpf_time_ck'),
    ('work_department_leader_current','wdlc_corp_id_ck',leader_oid,'e_wdlc_corp_id_ck'),('work_department_leader_current','wdlc_identity_ck',leader_oid,'e_wdlc_identity_ck'),('work_department_leader_current','wdlc_userid_ck',leader_oid,'e_wdlc_userid_ck'),('work_department_leader_current','wdlc_values_ck',leader_oid,'e_wdlc_values_ck')
  ) AS expected(table_name,constraint_name,reference_oid,reference_name)
  LOOP
    SELECT pg_get_expr(conbin,conrelid) INTO actual_definition FROM pg_constraint WHERE conrelid=to_regclass(format('%I.%I',target_schema,expected_record.table_name)) AND conname=expected_record.constraint_name AND contype='c';
    SELECT pg_get_expr(conbin,conrelid) INTO expected_definition FROM pg_constraint WHERE conrelid=expected_record.reference_oid AND conname=expected_record.reference_name AND contype='c';
    IF actual_definition IS DISTINCT FROM expected_definition THEN RAISE EXCEPTION 'check %.% has an incompatible expression',expected_record.table_name,expected_record.constraint_name; END IF;
  END LOOP;
END
$work_department_check_verification$;

-- The three new projection tables have a closed authority surface. Extra
-- constraints, indexes, policies, rules, or user triggers are drift, even when
-- all expected named objects also exist. work_callback_event is deliberately
-- excluded because 0114 owns only its new composite UNIQUE constraint.
DO $work_department_closed_surface_verification$
DECLARE
  target_schema text := current_schema();
  expected_record record;
  table_oid oid;
  actual_names text[];
BEGIN
  FOR expected_record IN SELECT * FROM (VALUES
    ('work_department_current', ARRAY[
      'wdc_corp_id_ck','wdc_event_fence_ck','wdc_identity_ck','wdc_last_event_fk',
      'wdc_lifecycle_snapshot_ck','wdc_lifecycle_state_ck','wdc_name_ck','wdc_parent_fk',
      'wdc_pk','wdc_sort_ck','wdc_time_ck'
    ]::text[], ARRAY['wdc_active_root_uidx','wdc_active_tree_idx','wdc_last_event_idx','wdc_parent_idx','wdc_pk']::text[]),
    ('work_department_projection_fence', ARRAY[
      'wdpf_corp_id_ck','wdpf_department_fk','wdpf_event_fence_ck','wdpf_identity_ck',
      'wdpf_last_event_fk','wdpf_pk','wdpf_time_ck'
    ]::text[], ARRAY['wdpf_last_event_idx','wdpf_pk']::text[]),
    ('work_department_leader_current', ARRAY[
      'wdlc_corp_id_ck','wdlc_department_fk','wdlc_identity_ck','wdlc_pk','wdlc_userid_ck','wdlc_values_ck'
    ]::text[], ARRAY['wdlc_pk','wdlc_position_uidx','wdlc_userid_idx']::text[])
  ) AS expected(table_name,constraint_names,index_names)
  LOOP
    table_oid := to_regclass(format('%I.%I',target_schema,expected_record.table_name));
    SELECT array_agg(conname ORDER BY conname) INTO actual_names
    FROM pg_constraint WHERE conrelid=table_oid AND contype <> 'n';
    IF actual_names IS DISTINCT FROM expected_record.constraint_names THEN
      RAISE EXCEPTION '% has an unexpected constraint set',expected_record.table_name;
    END IF;
    SELECT array_agg(i.relname ORDER BY i.relname) INTO actual_names
    FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid WHERE x.indrelid=table_oid;
    IF actual_names IS DISTINCT FROM expected_record.index_names THEN
      RAISE EXCEPTION '% has an unexpected index set',expected_record.table_name;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_class c WHERE c.oid=table_oid
      AND (c.relrowsecurity OR c.relforcerowsecurity OR c.relhasrules))
      OR EXISTS (SELECT 1 FROM pg_policy WHERE polrelid=table_oid)
      OR EXISTS (SELECT 1 FROM pg_rewrite WHERE ev_class=table_oid)
      OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=table_oid AND NOT tgisinternal) THEN
      RAISE EXCEPTION '% has unexpected RLS, rules, policies, or user triggers',expected_record.table_name;
    END IF;
  END LOOP;
END
$work_department_closed_surface_verification$;

-- Exact btree/index verification catches name collisions, wrong predicates,
-- sort direction, expression/include columns, and invalid indexes.
DO $work_department_index_verification$
DECLARE
  target_schema text := current_schema();
  expected_record record; compatible boolean;
  suffix text := substr(md5(pg_backend_pid()::text || clock_timestamp()::text),1,12);
  current_ref text; current_oid oid;
  actual_keys text[]; actual_options text; actual_predicate text; expected_predicate text;
BEGIN
  current_ref := '__wdc_ix_'||suffix;
  EXECUTE format('CREATE TEMP TABLE %I (LIKE %I.work_department_current) ON COMMIT DROP',current_ref,target_schema);
  current_oid := to_regclass(format('pg_temp.%I',current_ref));
  EXECUTE format($q$ALTER TABLE pg_temp.%I
    ADD CONSTRAINT e_active CHECK (lifecycle_state = 'ACTIVE'),
    ADD CONSTRAINT e_active_root CHECK (lifecycle_state = 'ACTIVE' AND parent_department_id IS NULL),
    ADD CONSTRAINT e_last_event CHECK (last_event_id IS NOT NULL)$q$,current_ref);
  FOR expected_record IN SELECT * FROM (VALUES
    ('work_callback_event','wce_department_ref_uq',true,false,ARRAY['id','corp_id','event_key','subject_key_hash','event_time','sequence_rank']::text[],'0 0 0 0 0 0',NULL::oid,NULL::text),
    ('work_department_current','wdc_pk',true,true,ARRAY['corp_id','department_id']::text[],'0 0',NULL::oid,NULL::text),
    ('work_department_current','wdc_active_tree_idx',false,false,ARRAY['corp_id','parent_department_id','sort_order','department_id']::text[],'0 0 3 0',current_oid,'e_active'),
    ('work_department_current','wdc_active_root_uidx',true,false,ARRAY['corp_id']::text[],'0',current_oid,'e_active_root'),
    ('work_department_current','wdc_parent_idx',false,false,ARRAY['corp_id','parent_department_id','department_id']::text[],'0 0 0',NULL::oid,NULL::text),
    ('work_department_current','wdc_last_event_idx',false,false,ARRAY['last_event_id']::text[],'0',current_oid,'e_last_event'),
    ('work_department_projection_fence','wdpf_pk',true,true,ARRAY['corp_id','department_id']::text[],'0 0',NULL::oid,NULL::text),
    ('work_department_projection_fence','wdpf_last_event_idx',false,false,ARRAY['last_event_id']::text[],'0',NULL::oid,NULL::text),
    ('work_department_leader_current','wdlc_pk',true,true,ARRAY['corp_id','department_id','userid']::text[],'0 0 0',NULL::oid,NULL::text),
    ('work_department_leader_current','wdlc_position_uidx',true,false,ARRAY['corp_id','department_id','sort_order']::text[],'0 0 0',NULL::oid,NULL::text),
    ('work_department_leader_current','wdlc_userid_idx',false,false,ARRAY['corp_id','userid','department_id']::text[],'0 0 0',NULL::oid,NULL::text)
  ) AS expected(table_name,index_name,is_unique,is_primary,key_columns,key_options,reference_oid,reference_name)
  LOOP
    SELECT EXISTS(SELECT 1 FROM pg_class i JOIN pg_namespace ins ON ins.oid=i.relnamespace
      JOIN pg_index x ON x.indexrelid=i.oid JOIN pg_class t ON t.oid=x.indrelid
      JOIN pg_namespace tns ON tns.oid=t.relnamespace JOIN pg_am am ON am.oid=i.relam
      WHERE ins.nspname=target_schema AND i.relname=expected_record.index_name
        AND tns.nspname=target_schema AND t.relname=expected_record.table_name AND am.amname='btree'
        AND x.indisvalid AND x.indisready AND x.indislive AND x.indisunique=expected_record.is_unique
        AND x.indisprimary=expected_record.is_primary AND NOT x.indisexclusion
        AND NOT x.indnullsnotdistinct AND NOT x.indcheckxmin
        AND x.indnkeyatts=cardinality(expected_record.key_columns) AND x.indnatts=cardinality(expected_record.key_columns)
        AND x.indexprs IS NULL
        AND ARRAY(SELECT replace(pg_get_indexdef(i.oid,pos,true),'"','') FROM generate_series(1,x.indnkeyatts) pos ORDER BY pos)=expected_record.key_columns
        AND x.indoption::text=expected_record.key_options
        AND ((expected_record.reference_oid IS NULL AND x.indpred IS NULL) OR
          (expected_record.reference_oid IS NOT NULL AND x.indpred IS NOT NULL
            AND pg_get_expr(x.indpred,x.indrelid)=(SELECT pg_get_expr(c.conbin,c.conrelid)
              FROM pg_constraint c WHERE c.conrelid=expected_record.reference_oid
                AND c.conname=expected_record.reference_name AND c.contype='c')))) INTO compatible;
    IF NOT compatible THEN
      SELECT ARRAY(SELECT pg_get_indexdef(i.oid,pos,true)
          FROM generate_series(1,x.indnkeyatts) pos ORDER BY pos),
        x.indoption::text, pg_get_expr(x.indpred,x.indrelid)
        INTO actual_keys,actual_options,actual_predicate
      FROM pg_class i JOIN pg_namespace ins ON ins.oid=i.relnamespace
      JOIN pg_index x ON x.indexrelid=i.oid JOIN pg_class t ON t.oid=x.indrelid
      JOIN pg_namespace tns ON tns.oid=t.relnamespace
      WHERE ins.nspname=target_schema AND i.relname=expected_record.index_name
        AND tns.nspname=target_schema AND t.relname=expected_record.table_name;
      expected_predicate := CASE WHEN expected_record.reference_oid IS NULL THEN NULL ELSE
        (SELECT pg_get_expr(c.conbin,c.conrelid) FROM pg_constraint c
          WHERE c.conrelid=expected_record.reference_oid
            AND c.conname=expected_record.reference_name AND c.contype='c') END;
      RAISE EXCEPTION 'index %.% has an incompatible definition: keys %, options %, predicate_match %',
        expected_record.table_name,expected_record.index_name,actual_keys,actual_options,
        actual_predicate IS NOT DISTINCT FROM expected_predicate;
    END IF;
  END LOOP;
END
$work_department_index_verification$;
`;
