/** Exact bundled copy of migrations/0116_work_group_chat_current_projection.sql. */
export const WORK_GROUP_CHAT_CURRENT_PROJECTION_SQL = String.raw`-- Expand-only canonical Enterprise WeChat external group-chat projection.
-- Legacy work_group_chat/work_group_chat_member remain immutable import evidence.
DO $work_group_chat_current_projection$
DECLARE
  target_schema text := current_schema();
  callback_oid oid;
  qualified_oid oid;
  table_name text;
  constraint_name text;
BEGIN
  IF target_schema IS NULL OR target_schema = '' OR left(target_schema, 3) = 'pg_' THEN
    RAISE EXCEPTION '0116 requires a non-system current schema';
  END IF;
  callback_oid := to_regclass('work_callback_event');
  qualified_oid := to_regclass(format('%I.%I', target_schema, 'work_callback_event'));
  IF callback_oid IS NULL OR callback_oid IS DISTINCT FROM qualified_oid THEN
    RAISE EXCEPTION '0116 search_path resolves work_callback_event outside current schema %', target_schema;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = callback_oid AND relkind = 'r' AND relpersistence = 'p'
      AND NOT relispartition
  ) THEN
    RAISE EXCEPTION 'work_callback_event must be a permanent ordinary table';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = callback_oid AND conname = 'wce_department_ref_uq'
      AND contype = 'u' AND convalidated
  ) THEN
    RAISE EXCEPTION '0116 requires the canonical work_callback_event event-reference key';
  END IF;
  FOREACH table_name IN ARRAY ARRAY[
    'work_group_chat_current',
    'work_group_chat_projection_fence',
    'work_group_chat_member_current'
  ]
  LOOP
    qualified_oid := to_regclass(format('%I.%I', target_schema, table_name));
    IF to_regclass(table_name) IS NOT NULL
      AND to_regclass(table_name) IS DISTINCT FROM qualified_oid THEN
      RAISE EXCEPTION '0116 search_path misbinds % outside current schema %', table_name, target_schema;
    END IF;
  END LOOP;

  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %I.work_group_chat_current (
      id integer GENERATED ALWAYS AS IDENTITY,
      corp_id varchar(18) NOT NULL,
      chat_id varchar(64) NOT NULL,
      lifecycle_state varchar(16) NOT NULL DEFAULT 'UNRESOLVED',
      profile_complete boolean NOT NULL DEFAULT false,
      members_complete boolean NOT NULL DEFAULT false,
      name varchar(255),
      owner varchar(64),
      group_created_time integer,
      notice varchar(2048),
      admin_list jsonb,
      provider_status smallint,
      member_count integer,
      departed_member_count integer NOT NULL DEFAULT 0,
      last_event_id integer,
      last_event_key varchar(64),
      last_event_subject_key_hash varchar(64),
      last_event_time integer NOT NULL DEFAULT 0,
      last_sequence_rank integer NOT NULL DEFAULT 0,
      create_time integer NOT NULL DEFAULT 0,
      update_time integer NOT NULL DEFAULT 0,
      dismissed_time integer
    )
  $ddl$, target_schema);
  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %I.work_group_chat_projection_fence (
      corp_id varchar(18) NOT NULL,
      chat_id varchar(64) NOT NULL,
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
    CREATE TABLE IF NOT EXISTS %I.work_group_chat_member_current (
      id integer GENERATED ALWAYS AS IDENTITY,
      corp_id varchar(18) NOT NULL,
      group_id integer NOT NULL,
      userid varchar(64) NOT NULL,
      lifecycle_state varchar(16) NOT NULL DEFAULT 'ACTIVE',
      type smallint NOT NULL,
      unionid varchar(128),
      join_time integer NOT NULL,
      join_scene smallint NOT NULL,
      invitor_userid varchar(64),
      group_nickname varchar(128) NOT NULL,
      name varchar(128),
      state varchar(128),
      last_event_id integer NOT NULL,
      last_event_key varchar(64) NOT NULL,
      last_event_subject_key_hash varchar(64) NOT NULL,
      last_event_time integer NOT NULL,
      last_sequence_rank integer NOT NULL,
      create_time integer NOT NULL DEFAULT 0,
      update_time integer NOT NULL DEFAULT 0,
      left_time integer
    )
  $ddl$, target_schema);

  -- The fence references the stable tenant-scoped group identity.
  EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS wgcc_corp_chat_id_uq ON %I.work_group_chat_current (corp_id,chat_id)', target_schema);

  FOR table_name, constraint_name IN
    SELECT * FROM (VALUES
      ('work_group_chat_current','wgcc_pk'),
      ('work_group_chat_current','wgcc_last_event_fk'),
      ('work_group_chat_current','wgcc_corp_id_ck'),
      ('work_group_chat_current','wgcc_chat_id_ck'),
      ('work_group_chat_current','wgcc_lifecycle_state_ck'),
      ('work_group_chat_current','wgcc_values_ck'),
      ('work_group_chat_current','wgcc_event_fence_ck'),
      ('work_group_chat_current','wgcc_snapshot_ck'),
      ('work_group_chat_current','wgcc_time_ck'),
      ('work_group_chat_projection_fence','wgcpf_pk'),
      ('work_group_chat_projection_fence','wgcpf_group_fk'),
      ('work_group_chat_projection_fence','wgcpf_last_event_fk'),
      ('work_group_chat_projection_fence','wgcpf_corp_id_ck'),
      ('work_group_chat_projection_fence','wgcpf_chat_id_ck'),
      ('work_group_chat_projection_fence','wgcpf_event_fence_ck'),
      ('work_group_chat_projection_fence','wgcpf_time_ck'),
      ('work_group_chat_member_current','wgcmc_pk'),
      ('work_group_chat_member_current','wgcmc_group_fk'),
      ('work_group_chat_member_current','wgcmc_last_event_fk'),
      ('work_group_chat_member_current','wgcmc_corp_id_ck'),
      ('work_group_chat_member_current','wgcmc_userid_ck'),
      ('work_group_chat_member_current','wgcmc_lifecycle_state_ck'),
      ('work_group_chat_member_current','wgcmc_values_ck'),
      ('work_group_chat_member_current','wgcmc_event_fence_ck'),
      ('work_group_chat_member_current','wgcmc_snapshot_ck'),
      ('work_group_chat_member_current','wgcmc_time_ck')
    ) AS expected(table_name, constraint_name)
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass(format('%I.%I', target_schema, table_name))
        AND conname = constraint_name
    ) THEN CONTINUE; END IF;
    CASE constraint_name
      WHEN 'wgcc_pk' THEN EXECUTE format('ALTER TABLE %I.work_group_chat_current ADD CONSTRAINT wgcc_pk PRIMARY KEY (corp_id,id)', target_schema);
      WHEN 'wgcc_last_event_fk' THEN EXECUTE format('ALTER TABLE %I.work_group_chat_current ADD CONSTRAINT wgcc_last_event_fk FOREIGN KEY (last_event_id,corp_id,last_event_key,last_event_subject_key_hash,last_event_time,last_sequence_rank) REFERENCES %I.work_callback_event (id,corp_id,event_key,subject_key_hash,event_time,sequence_rank) ON DELETE RESTRICT', target_schema, target_schema);
      WHEN 'wgcc_corp_id_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_group_chat_current ADD CONSTRAINT wgcc_corp_id_ck CHECK (corp_id ~ '^[A-Za-z0-9_-]{1,18}$')$q$, target_schema);
      WHEN 'wgcc_chat_id_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_group_chat_current ADD CONSTRAINT wgcc_chat_id_ck CHECK (chat_id <> '' AND chat_id = btrim(chat_id) AND octet_length(chat_id) <= 64 AND chat_id !~ '[[:cntrl:]]')$q$, target_schema);
      WHEN 'wgcc_lifecycle_state_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_group_chat_current ADD CONSTRAINT wgcc_lifecycle_state_ck CHECK (lifecycle_state IN ('UNRESOLVED','ACTIVE','DISMISSED'))$q$, target_schema);
      WHEN 'wgcc_values_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_group_chat_current ADD CONSTRAINT wgcc_values_ck CHECK (id > 0 AND (name IS NULL OR name !~ '[[:cntrl:]]') AND (owner IS NULL OR (owner = lower(owner) AND owner ~ '^[a-z0-9][a-z0-9_@.-]{0,63}$')) AND (group_created_time IS NULL OR group_created_time >= 0) AND (notice IS NULL OR translate(notice, E'\t\r\n', '') !~ '[[:cntrl:]]') AND (admin_list IS NULL OR (jsonb_typeof(admin_list) = 'array' AND octet_length(admin_list::text) <= 8192)) AND (provider_status IS NULL OR provider_status BETWEEN 0 AND 255) AND (member_count IS NULL OR member_count BETWEEN 0 AND 2000) AND departed_member_count >= 0)$q$, target_schema);
      WHEN 'wgcc_event_fence_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_group_chat_current ADD CONSTRAINT wgcc_event_fence_ck CHECK ((last_event_id IS NULL AND last_event_key IS NULL AND last_event_subject_key_hash IS NULL AND last_event_time = 0 AND last_sequence_rank = 0) OR (last_event_id > 0 AND last_event_key ~ '^[0-9a-f]{64}$' AND last_event_subject_key_hash ~ '^[0-9a-f]{64}$' AND last_event_time > 0 AND last_sequence_rank >= 0))$q$, target_schema);
      WHEN 'wgcc_snapshot_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_group_chat_current ADD CONSTRAINT wgcc_snapshot_ck CHECK ((lifecycle_state = 'UNRESOLVED' AND profile_complete = false AND members_complete = false AND name IS NULL AND owner IS NULL AND group_created_time IS NULL AND notice IS NULL AND admin_list IS NULL AND provider_status IS NULL AND member_count IS NULL AND last_event_id IS NULL AND dismissed_time IS NULL) OR (lifecycle_state = 'ACTIVE' AND profile_complete = true AND members_complete = true AND name IS NOT NULL AND owner IS NOT NULL AND group_created_time IS NOT NULL AND notice IS NOT NULL AND admin_list IS NOT NULL AND provider_status IS NOT NULL AND member_count IS NOT NULL AND last_event_id IS NOT NULL AND dismissed_time IS NULL) OR (lifecycle_state = 'DISMISSED' AND profile_complete = false AND members_complete = false AND last_event_id IS NOT NULL AND dismissed_time IS NOT NULL))$q$, target_schema);
      WHEN 'wgcc_time_ck' THEN EXECUTE format('ALTER TABLE %I.work_group_chat_current ADD CONSTRAINT wgcc_time_ck CHECK (create_time >= 0 AND update_time >= 0 AND (dismissed_time IS NULL OR dismissed_time > 0))', target_schema);

      WHEN 'wgcpf_pk' THEN EXECUTE format('ALTER TABLE %I.work_group_chat_projection_fence ADD CONSTRAINT wgcpf_pk PRIMARY KEY (corp_id,chat_id)', target_schema);
      WHEN 'wgcpf_group_fk' THEN EXECUTE format('ALTER TABLE %I.work_group_chat_projection_fence ADD CONSTRAINT wgcpf_group_fk FOREIGN KEY (corp_id,chat_id) REFERENCES %I.work_group_chat_current (corp_id,chat_id) ON DELETE RESTRICT', target_schema, target_schema);
      WHEN 'wgcpf_last_event_fk' THEN EXECUTE format('ALTER TABLE %I.work_group_chat_projection_fence ADD CONSTRAINT wgcpf_last_event_fk FOREIGN KEY (last_event_id,corp_id,last_event_key,last_event_subject_key_hash,last_event_time,last_sequence_rank) REFERENCES %I.work_callback_event (id,corp_id,event_key,subject_key_hash,event_time,sequence_rank) ON DELETE RESTRICT', target_schema, target_schema);
      WHEN 'wgcpf_corp_id_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_group_chat_projection_fence ADD CONSTRAINT wgcpf_corp_id_ck CHECK (corp_id ~ '^[A-Za-z0-9_-]{1,18}$')$q$, target_schema);
      WHEN 'wgcpf_chat_id_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_group_chat_projection_fence ADD CONSTRAINT wgcpf_chat_id_ck CHECK (chat_id <> '' AND chat_id = btrim(chat_id) AND octet_length(chat_id) <= 64 AND chat_id !~ '[[:cntrl:]]')$q$, target_schema);
      WHEN 'wgcpf_event_fence_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_group_chat_projection_fence ADD CONSTRAINT wgcpf_event_fence_ck CHECK (last_event_id > 0 AND last_event_key ~ '^[0-9a-f]{64}$' AND last_event_subject_key_hash ~ '^[0-9a-f]{64}$' AND last_event_time > 0 AND last_sequence_rank >= 0)$q$, target_schema);
      WHEN 'wgcpf_time_ck' THEN EXECUTE format('ALTER TABLE %I.work_group_chat_projection_fence ADD CONSTRAINT wgcpf_time_ck CHECK (create_time >= 0 AND update_time >= 0)', target_schema);

      WHEN 'wgcmc_pk' THEN EXECUTE format('ALTER TABLE %I.work_group_chat_member_current ADD CONSTRAINT wgcmc_pk PRIMARY KEY (corp_id,id)', target_schema);
      WHEN 'wgcmc_group_fk' THEN EXECUTE format('ALTER TABLE %I.work_group_chat_member_current ADD CONSTRAINT wgcmc_group_fk FOREIGN KEY (corp_id,group_id) REFERENCES %I.work_group_chat_current (corp_id,id) ON DELETE RESTRICT', target_schema, target_schema);
      WHEN 'wgcmc_last_event_fk' THEN EXECUTE format('ALTER TABLE %I.work_group_chat_member_current ADD CONSTRAINT wgcmc_last_event_fk FOREIGN KEY (last_event_id,corp_id,last_event_key,last_event_subject_key_hash,last_event_time,last_sequence_rank) REFERENCES %I.work_callback_event (id,corp_id,event_key,subject_key_hash,event_time,sequence_rank) ON DELETE RESTRICT', target_schema, target_schema);
      WHEN 'wgcmc_corp_id_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_group_chat_member_current ADD CONSTRAINT wgcmc_corp_id_ck CHECK (corp_id ~ '^[A-Za-z0-9_-]{1,18}$')$q$, target_schema);
      WHEN 'wgcmc_userid_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_group_chat_member_current ADD CONSTRAINT wgcmc_userid_ck CHECK (userid <> '' AND userid = btrim(userid) AND userid ~ '^[A-Za-z0-9][A-Za-z0-9_@.-]{0,63}$' AND (type <> 1 OR userid = lower(userid)))$q$, target_schema);
      WHEN 'wgcmc_lifecycle_state_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_group_chat_member_current ADD CONSTRAINT wgcmc_lifecycle_state_ck CHECK (lifecycle_state IN ('ACTIVE','LEFT','DISMISSED'))$q$, target_schema);
      WHEN 'wgcmc_values_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_group_chat_member_current ADD CONSTRAINT wgcmc_values_ck CHECK (id > 0 AND group_id > 0 AND type IN (1,2) AND (unionid IS NULL OR (unionid <> '' AND unionid = btrim(unionid) AND unionid !~ '[[:cntrl:]]')) AND join_time >= 0 AND join_scene BETWEEN 0 AND 255 AND (invitor_userid IS NULL OR (invitor_userid = lower(invitor_userid) AND invitor_userid ~ '^[a-z0-9][a-z0-9_@.-]{0,63}$')) AND group_nickname !~ '[[:cntrl:]]' AND (name IS NULL OR name !~ '[[:cntrl:]]') AND (state IS NULL OR state !~ '[[:cntrl:]]'))$q$, target_schema);
      WHEN 'wgcmc_event_fence_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_group_chat_member_current ADD CONSTRAINT wgcmc_event_fence_ck CHECK (last_event_id > 0 AND last_event_key ~ '^[0-9a-f]{64}$' AND last_event_subject_key_hash ~ '^[0-9a-f]{64}$' AND last_event_time > 0 AND last_sequence_rank >= 0)$q$, target_schema);
      WHEN 'wgcmc_snapshot_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_group_chat_member_current ADD CONSTRAINT wgcmc_snapshot_ck CHECK ((lifecycle_state = 'ACTIVE' AND left_time IS NULL) OR (lifecycle_state IN ('LEFT','DISMISSED') AND left_time IS NOT NULL))$q$, target_schema);
      WHEN 'wgcmc_time_ck' THEN EXECUTE format('ALTER TABLE %I.work_group_chat_member_current ADD CONSTRAINT wgcmc_time_ck CHECK (create_time >= 0 AND update_time >= 0 AND (left_time IS NULL OR left_time > 0))', target_schema);
      ELSE RAISE EXCEPTION '0116 internal unknown constraint %', constraint_name;
    END CASE;
  END LOOP;

  EXECUTE format('CREATE INDEX IF NOT EXISTS wgcc_catalog_idx ON %I.work_group_chat_current (corp_id,lifecycle_state,update_time DESC,id)', target_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS wgcc_last_event_idx ON %I.work_group_chat_current (last_event_id) WHERE last_event_id IS NOT NULL', target_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS wgcpf_last_event_idx ON %I.work_group_chat_projection_fence (last_event_id)', target_schema);
  EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS wgcmc_group_userid_uq ON %I.work_group_chat_member_current (corp_id,group_id,userid)', target_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS wgcmc_active_user_idx ON %I.work_group_chat_member_current (corp_id,userid,group_id) WHERE lifecycle_state = ''ACTIVE''', target_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS wgcmc_group_state_idx ON %I.work_group_chat_member_current (corp_id,group_id,lifecycle_state,join_time DESC,userid)', target_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS wgcmc_last_event_idx ON %I.work_group_chat_member_current (last_event_id)', target_schema);
END
$work_group_chat_current_projection$;

-- Reject CREATE TABLE IF NOT EXISTS drift, including identity mode and defaults.
DO $work_group_chat_column_verification$
DECLARE
  target_schema text := current_schema();
  expected_record record;
  actual_shape text[];
BEGIN
  FOR expected_record IN SELECT * FROM (VALUES
    ('work_group_chat_current',ARRAY[
      'id|integer|N|a|','corp_id|character varying(18)|N||','chat_id|character varying(64)|N||',
      'lifecycle_state|character varying(16)|N||''UNRESOLVED''::character varying','profile_complete|boolean|N||false',
      'members_complete|boolean|N||false','name|character varying(255)|Y||','owner|character varying(64)|Y||',
      'group_created_time|integer|Y||','notice|character varying(2048)|Y||','admin_list|jsonb|Y||','provider_status|smallint|Y||',
      'member_count|integer|Y||','departed_member_count|integer|N||0','last_event_id|integer|Y||',
      'last_event_key|character varying(64)|Y||','last_event_subject_key_hash|character varying(64)|Y||',
      'last_event_time|integer|N||0','last_sequence_rank|integer|N||0','create_time|integer|N||0',
      'update_time|integer|N||0','dismissed_time|integer|Y||'
    ]::text[]),
    ('work_group_chat_projection_fence',ARRAY[
      'corp_id|character varying(18)|N||','chat_id|character varying(64)|N||','last_event_id|integer|N||',
      'last_event_key|character varying(64)|N||','last_event_subject_key_hash|character varying(64)|N||',
      'last_event_time|integer|N||','last_sequence_rank|integer|N||','create_time|integer|N||0','update_time|integer|N||0'
    ]::text[]),
    ('work_group_chat_member_current',ARRAY[
      'id|integer|N|a|','corp_id|character varying(18)|N||','group_id|integer|N||','userid|character varying(64)|N||',
      'lifecycle_state|character varying(16)|N||''ACTIVE''::character varying','type|smallint|N||','unionid|character varying(128)|Y||',
      'join_time|integer|N||','join_scene|smallint|N||','invitor_userid|character varying(64)|Y||',
      'group_nickname|character varying(128)|N||','name|character varying(128)|Y||','state|character varying(128)|Y||',
      'last_event_id|integer|N||','last_event_key|character varying(64)|N||','last_event_subject_key_hash|character varying(64)|N||',
      'last_event_time|integer|N||','last_sequence_rank|integer|N||','create_time|integer|N||0','update_time|integer|N||0',
      'left_time|integer|Y||'
    ]::text[])
  ) AS expected(table_name, expected_shape)
  LOOP
    IF to_regclass(expected_record.table_name) IS DISTINCT FROM to_regclass(format('%I.%I', target_schema, expected_record.table_name)) THEN
      RAISE EXCEPTION '0116 search_path misbinds % during verification', expected_record.table_name;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = target_schema AND c.relname = expected_record.table_name
        AND c.relkind = 'r' AND c.relpersistence = 'p' AND NOT c.relispartition
    ) THEN RAISE EXCEPTION '% is not a permanent ordinary table', expected_record.table_name; END IF;
    SELECT array_agg(a.attname||'|'||format_type(a.atttypid,a.atttypmod)||'|'||CASE WHEN a.attnotnull THEN 'N' ELSE 'Y' END||'|'||a.attidentity::text||'|'||COALESCE(pg_get_expr(d.adbin,d.adrelid),'') ORDER BY a.attnum)
      INTO actual_shape
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = to_regclass(format('%I.%I', target_schema, expected_record.table_name))
      AND a.attnum > 0 AND NOT a.attisdropped;
    IF actual_shape IS DISTINCT FROM expected_record.expected_shape THEN
      RAISE EXCEPTION '% has an incompatible column shape: %', expected_record.table_name, actual_shape;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
      WHERE a.attrelid = to_regclass(format('%I.%I', target_schema, expected_record.table_name))
        AND a.attnum > 0 AND NOT a.attisdropped
        AND (a.attgenerated <> '' OR a.attcollation <> t.typcollation)
    ) THEN RAISE EXCEPTION '% has an incompatible generated column or collation', expected_record.table_name; END IF;
  END LOOP;
END
$work_group_chat_column_verification$;

-- Verify exact key columns, FK targets/actions, validation state, and constraint count.
DO $work_group_chat_constraint_verification$
DECLARE
  target_schema text := current_schema();
  expected_record record;
  compatible boolean;
BEGIN
  FOR expected_record IN SELECT * FROM (VALUES
    ('work_callback_event','wce_department_ref_uq','u',ARRAY['id','corp_id','event_key','subject_key_hash','event_time','sequence_rank']::text[]),
    ('work_group_chat_current','wgcc_pk','p',ARRAY['corp_id','id']::text[]),
    ('work_group_chat_projection_fence','wgcpf_pk','p',ARRAY['corp_id','chat_id']::text[]),
    ('work_group_chat_member_current','wgcmc_pk','p',ARRAY['corp_id','id']::text[])
  ) AS expected(table_name, constraint_name, constraint_type, key_columns)
  LOOP
    SELECT count(*) = 1 AND COALESCE(bool_and(
      c.convalidated AND c.conislocal AND c.coninhcount = 0 AND c.conparentid = 0
      AND NOT c.condeferrable AND NOT c.condeferred
      AND ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(attnum,pos)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum ORDER BY k.pos) = expected_record.key_columns
    ), false) INTO compatible
    FROM pg_constraint c
    WHERE c.conrelid = to_regclass(format('%I.%I', target_schema, expected_record.table_name))
      AND c.conname = expected_record.constraint_name AND c.contype = expected_record.constraint_type::"char";
    IF NOT compatible THEN RAISE EXCEPTION 'constraint %.% has incompatible key metadata', expected_record.table_name, expected_record.constraint_name; END IF;
  END LOOP;

  FOR expected_record IN SELECT * FROM (VALUES
    ('work_group_chat_current','wgcc_last_event_fk',ARRAY['last_event_id','corp_id','last_event_key','last_event_subject_key_hash','last_event_time','last_sequence_rank']::text[],'work_callback_event',ARRAY['id','corp_id','event_key','subject_key_hash','event_time','sequence_rank']::text[]),
    ('work_group_chat_projection_fence','wgcpf_group_fk',ARRAY['corp_id','chat_id']::text[],'work_group_chat_current',ARRAY['corp_id','chat_id']::text[]),
    ('work_group_chat_projection_fence','wgcpf_last_event_fk',ARRAY['last_event_id','corp_id','last_event_key','last_event_subject_key_hash','last_event_time','last_sequence_rank']::text[],'work_callback_event',ARRAY['id','corp_id','event_key','subject_key_hash','event_time','sequence_rank']::text[]),
    ('work_group_chat_member_current','wgcmc_group_fk',ARRAY['corp_id','group_id']::text[],'work_group_chat_current',ARRAY['corp_id','id']::text[]),
    ('work_group_chat_member_current','wgcmc_last_event_fk',ARRAY['last_event_id','corp_id','last_event_key','last_event_subject_key_hash','last_event_time','last_sequence_rank']::text[],'work_callback_event',ARRAY['id','corp_id','event_key','subject_key_hash','event_time','sequence_rank']::text[])
  ) AS expected(table_name, constraint_name, key_columns, foreign_table, foreign_columns)
  LOOP
    SELECT count(*) = 1 AND COALESCE(bool_and(
      c.convalidated AND c.conislocal AND c.coninhcount = 0 AND c.conparentid = 0
      AND NOT c.condeferrable AND NOT c.condeferred AND c.confdeltype = 'r'
      AND c.confupdtype = 'a' AND c.confmatchtype = 's'
      AND c.confrelid = to_regclass(format('%I.%I', target_schema, expected_record.foreign_table))
      AND ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(attnum,pos)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum ORDER BY k.pos) = expected_record.key_columns
      AND ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(attnum,pos)
        JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum ORDER BY k.pos) = expected_record.foreign_columns
    ), false) INTO compatible
    FROM pg_constraint c
    WHERE c.conrelid = to_regclass(format('%I.%I', target_schema, expected_record.table_name))
      AND c.conname = expected_record.constraint_name AND c.contype = 'f';
    IF NOT compatible THEN RAISE EXCEPTION 'constraint %.% has incompatible FK metadata', expected_record.table_name, expected_record.constraint_name; END IF;
  END LOOP;

  IF EXISTS (
    SELECT expected.table_name, expected.constraint_name FROM (VALUES
      ('work_group_chat_current','wgcc_corp_id_ck'),('work_group_chat_current','wgcc_chat_id_ck'),
      ('work_group_chat_current','wgcc_lifecycle_state_ck'),('work_group_chat_current','wgcc_values_ck'),
      ('work_group_chat_current','wgcc_event_fence_ck'),('work_group_chat_current','wgcc_snapshot_ck'),('work_group_chat_current','wgcc_time_ck'),
      ('work_group_chat_projection_fence','wgcpf_corp_id_ck'),('work_group_chat_projection_fence','wgcpf_chat_id_ck'),
      ('work_group_chat_projection_fence','wgcpf_event_fence_ck'),('work_group_chat_projection_fence','wgcpf_time_ck'),
      ('work_group_chat_member_current','wgcmc_corp_id_ck'),('work_group_chat_member_current','wgcmc_userid_ck'),
      ('work_group_chat_member_current','wgcmc_lifecycle_state_ck'),('work_group_chat_member_current','wgcmc_values_ck'),
      ('work_group_chat_member_current','wgcmc_event_fence_ck'),('work_group_chat_member_current','wgcmc_snapshot_ck'),('work_group_chat_member_current','wgcmc_time_ck')
    ) AS expected(table_name, constraint_name)
    LEFT JOIN pg_constraint c
      ON c.conrelid = to_regclass(format('%I.%I', target_schema, expected.table_name))
      AND c.conname = expected.constraint_name AND c.contype = 'c' AND c.convalidated
      AND c.conislocal AND c.coninhcount = 0 AND c.conparentid = 0
      AND NOT c.condeferrable AND NOT c.condeferred
    WHERE c.oid IS NULL
  ) THEN RAISE EXCEPTION '0116 has missing or incompatible CHECK metadata'; END IF;

  IF (
    SELECT count(*) FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = target_schema
      AND t.relname IN ('work_group_chat_current','work_group_chat_projection_fence','work_group_chat_member_current')
  ) <> 26 THEN RAISE EXCEPTION '0116 projection constraint count drift'; END IF;
END
$work_group_chat_constraint_verification$;

-- These three tables are a closed authority surface. Unexpected indexes,
-- constraints, RLS, rules, policies, or user triggers are schema drift.
DO $work_group_chat_closed_surface_verification$
DECLARE
  target_schema text := current_schema();
  expected_record record;
  table_oid oid;
  actual_names text[];
BEGIN
  FOR expected_record IN SELECT * FROM (VALUES
    ('work_group_chat_current',ARRAY['wgcc_chat_id_ck','wgcc_corp_id_ck','wgcc_event_fence_ck','wgcc_last_event_fk','wgcc_lifecycle_state_ck','wgcc_pk','wgcc_snapshot_ck','wgcc_time_ck','wgcc_values_ck']::text[],ARRAY['wgcc_catalog_idx','wgcc_corp_chat_id_uq','wgcc_last_event_idx','wgcc_pk']::text[]),
    ('work_group_chat_projection_fence',ARRAY['wgcpf_chat_id_ck','wgcpf_corp_id_ck','wgcpf_event_fence_ck','wgcpf_group_fk','wgcpf_last_event_fk','wgcpf_pk','wgcpf_time_ck']::text[],ARRAY['wgcpf_last_event_idx','wgcpf_pk']::text[]),
    ('work_group_chat_member_current',ARRAY['wgcmc_corp_id_ck','wgcmc_event_fence_ck','wgcmc_group_fk','wgcmc_last_event_fk','wgcmc_lifecycle_state_ck','wgcmc_pk','wgcmc_snapshot_ck','wgcmc_time_ck','wgcmc_userid_ck','wgcmc_values_ck']::text[],ARRAY['wgcmc_active_user_idx','wgcmc_group_state_idx','wgcmc_group_userid_uq','wgcmc_last_event_idx','wgcmc_pk']::text[])
  ) AS expected(table_name, constraint_names, index_names)
  LOOP
    table_oid := to_regclass(format('%I.%I', target_schema, expected_record.table_name));
    SELECT array_agg(conname ORDER BY conname) INTO actual_names
      FROM pg_constraint WHERE conrelid = table_oid AND contype <> 'n';
    IF actual_names IS DISTINCT FROM expected_record.constraint_names THEN
      RAISE EXCEPTION '% has an unexpected constraint set: %', expected_record.table_name, actual_names;
    END IF;
    SELECT array_agg(i.relname ORDER BY i.relname) INTO actual_names
      FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid WHERE x.indrelid = table_oid;
    IF actual_names IS DISTINCT FROM expected_record.index_names THEN
      RAISE EXCEPTION '% has an unexpected index set: %', expected_record.table_name, actual_names;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = table_oid AND (c.relrowsecurity OR c.relforcerowsecurity OR c.relhasrules))
      OR EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = table_oid)
      OR EXISTS (SELECT 1 FROM pg_rewrite WHERE ev_class = table_oid)
      OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = table_oid AND NOT tgisinternal) THEN
      RAISE EXCEPTION '% has unexpected RLS, rules, policies, or user triggers', expected_record.table_name;
    END IF;
  END LOOP;
END
$work_group_chat_closed_surface_verification$;

DO $work_group_chat_index_sequence_verification$
DECLARE
  target_schema text := current_schema();
  expected_record record;
  compatible boolean;
  suffix text := substr(md5(pg_backend_pid()::text||clock_timestamp()::text),1,12);
  predicate_ref text;
  predicate_oid oid;
  identity_count integer;
BEGIN
  predicate_ref := '__wgcc_ix_'||suffix;
  EXECUTE format('CREATE TEMP TABLE %I (last_event_id integer,lifecycle_state varchar(16)) ON COMMIT DROP', predicate_ref);
  predicate_oid := to_regclass(format('pg_temp.%I', predicate_ref));
  EXECUTE format($q$ALTER TABLE pg_temp.%I
    ADD CONSTRAINT e_last_event CHECK (last_event_id IS NOT NULL),
    ADD CONSTRAINT e_active CHECK (lifecycle_state = 'ACTIVE')$q$, predicate_ref);
  FOR expected_record IN SELECT * FROM (VALUES
    ('wgcc_corp_chat_id_uq','work_group_chat_current',true,ARRAY['corp_id','chat_id']::text[],'0 0',NULL::text),
    ('wgcc_catalog_idx','work_group_chat_current',false,ARRAY['corp_id','lifecycle_state','update_time','id']::text[],'0 0 3 0',NULL::text),
    ('wgcc_last_event_idx','work_group_chat_current',false,ARRAY['last_event_id']::text[],'0','e_last_event'),
    ('wgcpf_last_event_idx','work_group_chat_projection_fence',false,ARRAY['last_event_id']::text[],'0',NULL::text),
    ('wgcmc_group_userid_uq','work_group_chat_member_current',true,ARRAY['corp_id','group_id','userid']::text[],'0 0 0',NULL::text),
    ('wgcmc_active_user_idx','work_group_chat_member_current',false,ARRAY['corp_id','userid','group_id']::text[],'0 0 0','e_active'),
    ('wgcmc_group_state_idx','work_group_chat_member_current',false,ARRAY['corp_id','group_id','lifecycle_state','join_time','userid']::text[],'0 0 0 3 0',NULL::text),
    ('wgcmc_last_event_idx','work_group_chat_member_current',false,ARRAY['last_event_id']::text[],'0',NULL::text)
  ) AS expected(index_name, table_name, is_unique, key_columns, key_options, predicate_name)
  LOOP
    SELECT EXISTS(
      SELECT 1 FROM pg_class x JOIN pg_namespace n ON n.oid = x.relnamespace
      JOIN pg_index i ON i.indexrelid = x.oid JOIN pg_am am ON am.oid = x.relam
      WHERE n.nspname = target_schema AND x.relname = expected_record.index_name
        AND i.indrelid = to_regclass(format('%I.%I', target_schema, expected_record.table_name))
        AND am.amname = 'btree' AND i.indisvalid AND i.indisready AND i.indislive
        AND i.indisunique = expected_record.is_unique AND NOT i.indisprimary
        AND NOT i.indisexclusion AND NOT i.indnullsnotdistinct AND NOT i.indcheckxmin
        AND i.indnkeyatts = cardinality(expected_record.key_columns)
        AND i.indnatts = cardinality(expected_record.key_columns) AND i.indexprs IS NULL
        AND ARRAY(SELECT replace(pg_get_indexdef(x.oid,pos,true),'"','')
          FROM generate_series(1,i.indnkeyatts) pos ORDER BY pos) = expected_record.key_columns
        AND i.indoption::text = expected_record.key_options
        AND ((expected_record.predicate_name IS NULL AND i.indpred IS NULL) OR
          (expected_record.predicate_name IS NOT NULL AND i.indpred IS NOT NULL
            AND pg_get_expr(i.indpred,i.indrelid) = (SELECT pg_get_expr(c.conbin,c.conrelid)
              FROM pg_constraint c WHERE c.conrelid = predicate_oid
                AND c.conname = expected_record.predicate_name AND c.contype = 'c')))
    ) INTO compatible;
    IF NOT compatible THEN RAISE EXCEPTION 'index % has incompatible metadata', expected_record.index_name; END IF;
  END LOOP;

  SELECT count(*) INTO identity_count
  FROM pg_attribute a
  JOIN pg_depend d ON d.refobjid = a.attrelid AND d.refobjsubid = a.attnum AND d.deptype = 'i'
  JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S' AND s.relpersistence = 'p'
  JOIN pg_namespace n ON n.oid = s.relnamespace
  WHERE a.attrelid IN (
      to_regclass(format('%I.work_group_chat_current', target_schema)),
      to_regclass(format('%I.work_group_chat_member_current', target_schema))
    ) AND a.attname = 'id' AND a.attidentity = 'a' AND n.nspname = target_schema;
  IF identity_count <> 2 THEN RAISE EXCEPTION '0116 identity sequence count drift: %', identity_count; END IF;

  IF (
    SELECT count(*) FROM pg_class x JOIN pg_namespace n ON n.oid = x.relnamespace
    JOIN pg_index i ON i.indexrelid = x.oid
    WHERE n.nspname = target_schema
      AND i.indrelid IN (
        to_regclass(format('%I.work_group_chat_current', target_schema)),
        to_regclass(format('%I.work_group_chat_projection_fence', target_schema)),
        to_regclass(format('%I.work_group_chat_member_current', target_schema))
      )
  ) <> 11 THEN RAISE EXCEPTION '0116 projection index count drift'; END IF;
END
$work_group_chat_index_sequence_verification$;
`;
