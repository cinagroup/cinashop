-- Expand-only canonical Enterprise WeChat external-contact projection. Legacy
-- work_client/work_client_follow/work_client_follow_tags remain import evidence.
DO $work_client_current_projection$
DECLARE
  target_schema text := current_schema();
  callback_oid oid;
  qualified_oid oid;
  table_name text;
  constraint_name text;
BEGIN
  IF target_schema IS NULL OR target_schema = '' OR left(target_schema, 3) = 'pg_' THEN
    RAISE EXCEPTION '0115 requires a non-system current schema';
  END IF;
  callback_oid := to_regclass('work_callback_event');
  qualified_oid := to_regclass(format('%I.%I', target_schema, 'work_callback_event'));
  IF callback_oid IS NULL OR callback_oid IS DISTINCT FROM qualified_oid THEN
    RAISE EXCEPTION '0115 search_path resolves work_callback_event outside current schema %', target_schema;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = callback_oid AND relkind = 'r' AND relpersistence = 'p'
      AND NOT relispartition
  ) THEN
    RAISE EXCEPTION 'work_callback_event must be a permanent ordinary table';
  END IF;
  FOREACH table_name IN ARRAY ARRAY[
    'work_client_current',
    'work_client_projection_fence',
    'work_client_follow_current',
    'work_client_follow_projection_fence',
    'work_client_follow_tag_current'
  ]
  LOOP
    qualified_oid := to_regclass(format('%I.%I', target_schema, table_name));
    IF to_regclass(table_name) IS NOT NULL
      AND to_regclass(table_name) IS DISTINCT FROM qualified_oid THEN
      RAISE EXCEPTION '0115 search_path misbinds % outside current schema %', table_name, target_schema;
    END IF;
  END LOOP;

  EXECUTE format('LOCK TABLE %I.work_callback_event IN ACCESS EXCLUSIVE MODE', target_schema);
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = callback_oid AND conname = 'wce_department_ref_uq'
  ) THEN
    EXECUTE format(
      'ALTER TABLE %I.work_callback_event ADD CONSTRAINT wce_department_ref_uq UNIQUE '
      || '(id, corp_id, event_key, subject_key_hash, event_time, sequence_rank)',
      target_schema
    );
  END IF;

  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %I.work_client_current (
      id integer GENERATED ALWAYS AS IDENTITY,
      corp_id varchar(18) NOT NULL,
      external_userid varchar(64) NOT NULL,
      lifecycle_state varchar(16) NOT NULL DEFAULT 'UNRESOLVED',
      profile_complete boolean NOT NULL DEFAULT false,
      provider_snapshot_complete boolean NOT NULL DEFAULT false,
      uid integer,
      name varchar(128),
      avatar varchar(1024),
      type smallint,
      gender smallint,
      unionid varchar(128),
      position varchar(128),
      corp_name varchar(128),
      corp_full_name varchar(256),
      external_profile jsonb,
      last_event_id integer,
      last_event_key varchar(64),
      last_event_subject_key_hash varchar(64),
      last_event_time integer NOT NULL DEFAULT 0,
      last_sequence_rank integer NOT NULL DEFAULT 0,
      create_time integer NOT NULL DEFAULT 0,
      update_time integer NOT NULL DEFAULT 0,
      inactive_time integer
    )
  $ddl$, target_schema);
  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %I.work_client_projection_fence (
      corp_id varchar(18) NOT NULL,
      external_userid varchar(64) NOT NULL,
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
    CREATE TABLE IF NOT EXISTS %I.work_client_follow_current (
      corp_id varchar(18) NOT NULL,
      client_id integer NOT NULL,
      userid varchar(64) NOT NULL,
      lifecycle_state varchar(16) NOT NULL DEFAULT 'DELETED',
      source_kind varchar(16) NOT NULL DEFAULT 'DIRECT',
      profile_complete boolean NOT NULL DEFAULT false,
      tags_complete boolean NOT NULL DEFAULT false,
      remark varchar(512),
      description varchar(1024),
      follow_created_time integer,
      remark_corp_name varchar(128),
      remark_mobiles text,
      add_way integer,
      oper_userid varchar(64),
      state varchar(128),
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
    CREATE TABLE IF NOT EXISTS %I.work_client_follow_projection_fence (
      corp_id varchar(18) NOT NULL,
      client_id integer NOT NULL,
      userid varchar(64) NOT NULL,
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
    CREATE TABLE IF NOT EXISTS %I.work_client_follow_tag_current (
      corp_id varchar(18) NOT NULL,
      client_id integer NOT NULL,
      userid varchar(64) NOT NULL,
      tag_key_hash varchar(64) NOT NULL,
      tag_id varchar(128),
      group_name varchar(256),
      tag_name varchar(256) NOT NULL,
      type smallint NOT NULL,
      sort_order integer NOT NULL,
      create_time integer NOT NULL DEFAULT 0,
      update_time integer NOT NULL DEFAULT 0
    )
  $ddl$, target_schema);

  -- The profile fence references the stable tenant-scoped external identity.
  EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS wcc_corp_external_userid_uq ON %I.work_client_current (corp_id,external_userid)',target_schema);

  FOR table_name, constraint_name IN
    SELECT * FROM (VALUES
      ('work_client_current','wcc_pk'),
      ('work_client_current','wcc_last_event_fk'),
      ('work_client_current','wcc_corp_id_ck'),
      ('work_client_current','wcc_external_userid_ck'),
      ('work_client_current','wcc_lifecycle_state_ck'),
      ('work_client_current','wcc_values_ck'),
      ('work_client_current','wcc_event_fence_ck'),
      ('work_client_current','wcc_snapshot_ck'),
      ('work_client_current','wcc_time_ck'),
      ('work_client_projection_fence','wcpf_pk'),
      ('work_client_projection_fence','wcpf_client_fk'),
      ('work_client_projection_fence','wcpf_last_event_fk'),
      ('work_client_projection_fence','wcpf_corp_id_ck'),
      ('work_client_projection_fence','wcpf_external_userid_ck'),
      ('work_client_projection_fence','wcpf_event_fence_ck'),
      ('work_client_projection_fence','wcpf_time_ck'),
      ('work_client_follow_current','wcfc_pk'),
      ('work_client_follow_current','wcfc_client_fk'),
      ('work_client_follow_current','wcfc_last_event_fk'),
      ('work_client_follow_current','wcfc_corp_id_ck'),
      ('work_client_follow_current','wcfc_userid_ck'),
      ('work_client_follow_current','wcfc_lifecycle_state_ck'),
      ('work_client_follow_current','wcfc_source_kind_ck'),
      ('work_client_follow_current','wcfc_values_ck'),
      ('work_client_follow_current','wcfc_event_fence_ck'),
      ('work_client_follow_current','wcfc_snapshot_ck'),
      ('work_client_follow_current','wcfc_time_ck'),
      ('work_client_follow_projection_fence','wcfpf_pk'),
      ('work_client_follow_projection_fence','wcfpf_client_fk'),
      ('work_client_follow_projection_fence','wcfpf_last_event_fk'),
      ('work_client_follow_projection_fence','wcfpf_corp_id_ck'),
      ('work_client_follow_projection_fence','wcfpf_userid_ck'),
      ('work_client_follow_projection_fence','wcfpf_event_fence_ck'),
      ('work_client_follow_projection_fence','wcfpf_time_ck'),
      ('work_client_follow_tag_current','wcftc_pk'),
      ('work_client_follow_tag_current','wcftc_follow_fk'),
      ('work_client_follow_tag_current','wcftc_corp_id_ck'),
      ('work_client_follow_tag_current','wcftc_userid_ck'),
      ('work_client_follow_tag_current','wcftc_values_ck')
    ) AS expected(table_name, constraint_name)
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass(format('%I.%I', target_schema, table_name))
        AND conname = constraint_name
    ) THEN CONTINUE; END IF;
    CASE constraint_name
      WHEN 'wcc_pk' THEN EXECUTE format('ALTER TABLE %I.work_client_current ADD CONSTRAINT wcc_pk PRIMARY KEY (corp_id,id)',target_schema);
      WHEN 'wcc_last_event_fk' THEN EXECUTE format('ALTER TABLE %I.work_client_current ADD CONSTRAINT wcc_last_event_fk FOREIGN KEY (last_event_id,corp_id,last_event_key,last_event_subject_key_hash,last_event_time,last_sequence_rank) REFERENCES %I.work_callback_event (id,corp_id,event_key,subject_key_hash,event_time,sequence_rank) ON DELETE RESTRICT',target_schema,target_schema);
      WHEN 'wcc_corp_id_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_client_current ADD CONSTRAINT wcc_corp_id_ck CHECK (corp_id ~ '^[A-Za-z0-9_-]{1,18}$')$q$,target_schema);
      WHEN 'wcc_external_userid_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_client_current ADD CONSTRAINT wcc_external_userid_ck CHECK (external_userid <> '' AND external_userid = btrim(external_userid) AND octet_length(external_userid) <= 64 AND external_userid !~ '[[:cntrl:]]')$q$,target_schema);
      WHEN 'wcc_lifecycle_state_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_client_current ADD CONSTRAINT wcc_lifecycle_state_ck CHECK (lifecycle_state IN ('UNRESOLVED','ACTIVE','INACTIVE'))$q$,target_schema);
      WHEN 'wcc_values_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_client_current ADD CONSTRAINT wcc_values_ck CHECK (id > 0 AND (uid IS NULL OR uid > 0) AND (type IS NULL OR type IN (1,2)) AND (gender IS NULL OR gender IN (0,1,2)) AND (name IS NULL OR (name <> '' AND name = btrim(name) AND name !~ '[[:cntrl:]]')) AND (avatar IS NULL OR avatar !~ '[[:cntrl:]]') AND (unionid IS NULL OR unionid !~ '[[:cntrl:]]') AND (position IS NULL OR position !~ '[[:cntrl:]]') AND (corp_name IS NULL OR corp_name !~ '[[:cntrl:]]') AND (corp_full_name IS NULL OR corp_full_name !~ '[[:cntrl:]]') AND (external_profile IS NULL OR octet_length(external_profile::text) <= 65536))$q$,target_schema);
      WHEN 'wcc_event_fence_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_client_current ADD CONSTRAINT wcc_event_fence_ck CHECK ((last_event_id IS NULL AND last_event_key IS NULL AND last_event_subject_key_hash IS NULL AND last_event_time = 0 AND last_sequence_rank = 0) OR (last_event_id > 0 AND last_event_key ~ '^[0-9a-f]{64}$' AND last_event_subject_key_hash ~ '^[0-9a-f]{64}$' AND last_event_time > 0 AND last_sequence_rank >= 0))$q$,target_schema);
      WHEN 'wcc_snapshot_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_client_current ADD CONSTRAINT wcc_snapshot_ck CHECK ((lifecycle_state = 'UNRESOLVED' AND profile_complete = false AND provider_snapshot_complete = false AND name IS NULL AND type IS NULL AND gender IS NULL AND external_profile IS NULL AND inactive_time IS NULL) OR (lifecycle_state = 'ACTIVE' AND profile_complete = true AND provider_snapshot_complete = true AND name IS NOT NULL AND type IS NOT NULL AND gender IS NOT NULL AND external_profile IS NOT NULL AND last_event_id IS NOT NULL AND inactive_time IS NULL) OR (lifecycle_state = 'INACTIVE' AND profile_complete = true AND provider_snapshot_complete = true AND name IS NOT NULL AND type IS NOT NULL AND gender IS NOT NULL AND external_profile IS NOT NULL AND last_event_id IS NOT NULL AND inactive_time IS NOT NULL))$q$,target_schema);
      WHEN 'wcc_time_ck' THEN EXECUTE format('ALTER TABLE %I.work_client_current ADD CONSTRAINT wcc_time_ck CHECK (create_time >= 0 AND update_time >= 0 AND (inactive_time IS NULL OR inactive_time > 0))',target_schema);

      WHEN 'wcpf_pk' THEN EXECUTE format('ALTER TABLE %I.work_client_projection_fence ADD CONSTRAINT wcpf_pk PRIMARY KEY (corp_id,external_userid)',target_schema);
      WHEN 'wcpf_client_fk' THEN EXECUTE format('ALTER TABLE %I.work_client_projection_fence ADD CONSTRAINT wcpf_client_fk FOREIGN KEY (corp_id,external_userid) REFERENCES %I.work_client_current (corp_id,external_userid) ON DELETE RESTRICT',target_schema,target_schema);
      WHEN 'wcpf_last_event_fk' THEN EXECUTE format('ALTER TABLE %I.work_client_projection_fence ADD CONSTRAINT wcpf_last_event_fk FOREIGN KEY (last_event_id,corp_id,last_event_key,last_event_subject_key_hash,last_event_time,last_sequence_rank) REFERENCES %I.work_callback_event (id,corp_id,event_key,subject_key_hash,event_time,sequence_rank) ON DELETE RESTRICT',target_schema,target_schema);
      WHEN 'wcpf_corp_id_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_client_projection_fence ADD CONSTRAINT wcpf_corp_id_ck CHECK (corp_id ~ '^[A-Za-z0-9_-]{1,18}$')$q$,target_schema);
      WHEN 'wcpf_external_userid_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_client_projection_fence ADD CONSTRAINT wcpf_external_userid_ck CHECK (external_userid <> '' AND external_userid = btrim(external_userid) AND octet_length(external_userid) <= 64 AND external_userid !~ '[[:cntrl:]]')$q$,target_schema);
      WHEN 'wcpf_event_fence_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_client_projection_fence ADD CONSTRAINT wcpf_event_fence_ck CHECK (last_event_id > 0 AND last_event_key ~ '^[0-9a-f]{64}$' AND last_event_subject_key_hash ~ '^[0-9a-f]{64}$' AND last_event_time > 0 AND last_sequence_rank >= 0)$q$,target_schema);
      WHEN 'wcpf_time_ck' THEN EXECUTE format('ALTER TABLE %I.work_client_projection_fence ADD CONSTRAINT wcpf_time_ck CHECK (create_time >= 0 AND update_time >= 0)',target_schema);

      WHEN 'wcfc_pk' THEN EXECUTE format('ALTER TABLE %I.work_client_follow_current ADD CONSTRAINT wcfc_pk PRIMARY KEY (corp_id,client_id,userid)',target_schema);
      WHEN 'wcfc_client_fk' THEN EXECUTE format('ALTER TABLE %I.work_client_follow_current ADD CONSTRAINT wcfc_client_fk FOREIGN KEY (corp_id,client_id) REFERENCES %I.work_client_current (corp_id,id) ON DELETE RESTRICT',target_schema,target_schema);
      WHEN 'wcfc_last_event_fk' THEN EXECUTE format('ALTER TABLE %I.work_client_follow_current ADD CONSTRAINT wcfc_last_event_fk FOREIGN KEY (last_event_id,corp_id,last_event_key,last_event_subject_key_hash,last_event_time,last_sequence_rank) REFERENCES %I.work_callback_event (id,corp_id,event_key,subject_key_hash,event_time,sequence_rank) ON DELETE RESTRICT',target_schema,target_schema);
      WHEN 'wcfc_corp_id_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_client_follow_current ADD CONSTRAINT wcfc_corp_id_ck CHECK (corp_id ~ '^[A-Za-z0-9_-]{1,18}$')$q$,target_schema);
      WHEN 'wcfc_userid_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_client_follow_current ADD CONSTRAINT wcfc_userid_ck CHECK (userid <> '' AND userid = btrim(userid) AND userid = lower(userid) AND userid ~ '^[a-z0-9][a-z0-9_@.-]{0,63}$' AND userid !~ '[[:cntrl:]]')$q$,target_schema);
      WHEN 'wcfc_lifecycle_state_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_client_follow_current ADD CONSTRAINT wcfc_lifecycle_state_ck CHECK (lifecycle_state IN ('ACTIVE','DELETED'))$q$,target_schema);
      WHEN 'wcfc_source_kind_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_client_follow_current ADD CONSTRAINT wcfc_source_kind_ck CHECK (source_kind IN ('DIRECT','SNAPSHOT'))$q$,target_schema);
      WHEN 'wcfc_values_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_client_follow_current ADD CONSTRAINT wcfc_values_ck CHECK (client_id > 0 AND (follow_created_time IS NULL OR follow_created_time >= 0) AND (add_way IS NULL OR add_way BETWEEN 0 AND 1000) AND (remark IS NULL OR remark !~ '[[:cntrl:]]') AND (description IS NULL OR description !~ '[[:cntrl:]]') AND (remark_corp_name IS NULL OR remark_corp_name !~ '[[:cntrl:]]') AND (remark_mobiles IS NULL OR (octet_length(remark_mobiles) <= 2048 AND jsonb_typeof(remark_mobiles::jsonb) = 'array')) AND (oper_userid IS NULL OR (oper_userid = lower(oper_userid) AND oper_userid ~ '^[a-z0-9][a-z0-9_@.-]{0,63}$')) AND (state IS NULL OR state !~ '[[:cntrl:]]'))$q$,target_schema);
      WHEN 'wcfc_event_fence_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_client_follow_current ADD CONSTRAINT wcfc_event_fence_ck CHECK (last_event_id > 0 AND last_event_key ~ '^[0-9a-f]{64}$' AND last_event_subject_key_hash ~ '^[0-9a-f]{64}$' AND last_event_time > 0 AND last_sequence_rank >= 0)$q$,target_schema);
      WHEN 'wcfc_snapshot_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_client_follow_current ADD CONSTRAINT wcfc_snapshot_ck CHECK ((lifecycle_state = 'ACTIVE' AND profile_complete = true AND tags_complete = true AND follow_created_time IS NOT NULL AND remark_mobiles IS NOT NULL AND deleted_time IS NULL) OR (lifecycle_state = 'DELETED' AND source_kind = 'DIRECT' AND tags_complete = false AND deleted_time IS NOT NULL))$q$,target_schema);
      WHEN 'wcfc_time_ck' THEN EXECUTE format('ALTER TABLE %I.work_client_follow_current ADD CONSTRAINT wcfc_time_ck CHECK (create_time >= 0 AND update_time >= 0 AND (deleted_time IS NULL OR deleted_time > 0))',target_schema);

      WHEN 'wcfpf_pk' THEN EXECUTE format('ALTER TABLE %I.work_client_follow_projection_fence ADD CONSTRAINT wcfpf_pk PRIMARY KEY (corp_id,client_id,userid)',target_schema);
      WHEN 'wcfpf_client_fk' THEN EXECUTE format('ALTER TABLE %I.work_client_follow_projection_fence ADD CONSTRAINT wcfpf_client_fk FOREIGN KEY (corp_id,client_id) REFERENCES %I.work_client_current (corp_id,id) ON DELETE RESTRICT',target_schema,target_schema);
      WHEN 'wcfpf_last_event_fk' THEN EXECUTE format('ALTER TABLE %I.work_client_follow_projection_fence ADD CONSTRAINT wcfpf_last_event_fk FOREIGN KEY (last_event_id,corp_id,last_event_key,last_event_subject_key_hash,last_event_time,last_sequence_rank) REFERENCES %I.work_callback_event (id,corp_id,event_key,subject_key_hash,event_time,sequence_rank) ON DELETE RESTRICT',target_schema,target_schema);
      WHEN 'wcfpf_corp_id_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_client_follow_projection_fence ADD CONSTRAINT wcfpf_corp_id_ck CHECK (corp_id ~ '^[A-Za-z0-9_-]{1,18}$')$q$,target_schema);
      WHEN 'wcfpf_userid_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_client_follow_projection_fence ADD CONSTRAINT wcfpf_userid_ck CHECK (userid <> '' AND userid = btrim(userid) AND userid = lower(userid) AND userid ~ '^[a-z0-9][a-z0-9_@.-]{0,63}$')$q$,target_schema);
      WHEN 'wcfpf_event_fence_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_client_follow_projection_fence ADD CONSTRAINT wcfpf_event_fence_ck CHECK (client_id > 0 AND last_event_id > 0 AND last_event_key ~ '^[0-9a-f]{64}$' AND last_event_subject_key_hash ~ '^[0-9a-f]{64}$' AND last_event_time > 0 AND last_sequence_rank >= 0)$q$,target_schema);
      WHEN 'wcfpf_time_ck' THEN EXECUTE format('ALTER TABLE %I.work_client_follow_projection_fence ADD CONSTRAINT wcfpf_time_ck CHECK (create_time >= 0 AND update_time >= 0)',target_schema);

      WHEN 'wcftc_pk' THEN EXECUTE format('ALTER TABLE %I.work_client_follow_tag_current ADD CONSTRAINT wcftc_pk PRIMARY KEY (corp_id,client_id,userid,tag_key_hash)',target_schema);
      WHEN 'wcftc_follow_fk' THEN EXECUTE format('ALTER TABLE %I.work_client_follow_tag_current ADD CONSTRAINT wcftc_follow_fk FOREIGN KEY (corp_id,client_id,userid) REFERENCES %I.work_client_follow_current (corp_id,client_id,userid) ON DELETE RESTRICT',target_schema,target_schema);
      WHEN 'wcftc_corp_id_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_client_follow_tag_current ADD CONSTRAINT wcftc_corp_id_ck CHECK (corp_id ~ '^[A-Za-z0-9_-]{1,18}$')$q$,target_schema);
      WHEN 'wcftc_userid_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_client_follow_tag_current ADD CONSTRAINT wcftc_userid_ck CHECK (userid <> '' AND userid = btrim(userid) AND userid = lower(userid) AND userid ~ '^[a-z0-9][a-z0-9_@.-]{0,63}$')$q$,target_schema);
      WHEN 'wcftc_values_ck' THEN EXECUTE format($q$ALTER TABLE %I.work_client_follow_tag_current ADD CONSTRAINT wcftc_values_ck CHECK (client_id > 0 AND tag_key_hash ~ '^[0-9a-f]{64}$' AND (tag_id IS NULL OR (tag_id <> '' AND tag_id = btrim(tag_id) AND tag_id !~ '[[:cntrl:]]')) AND (group_name IS NULL OR group_name !~ '[[:cntrl:]]') AND tag_name <> '' AND tag_name = btrim(tag_name) AND tag_name !~ '[[:cntrl:]]' AND type BETWEEN 1 AND 3 AND sort_order BETWEEN 0 AND 255 AND create_time >= 0 AND update_time >= 0)$q$,target_schema);
      ELSE RAISE EXCEPTION '0115 internal unknown constraint %', constraint_name;
    END CASE;
  END LOOP;

  EXECUTE format('CREATE INDEX IF NOT EXISTS wcc_catalog_idx ON %I.work_client_current (corp_id,lifecycle_state,update_time DESC,id)',target_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS wcc_last_event_idx ON %I.work_client_current (last_event_id) WHERE last_event_id IS NOT NULL',target_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS wcpf_last_event_idx ON %I.work_client_projection_fence (last_event_id)',target_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS wcfc_active_user_idx ON %I.work_client_follow_current (corp_id,userid,client_id) WHERE lifecycle_state = ''ACTIVE''',target_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS wcfc_last_event_idx ON %I.work_client_follow_current (last_event_id)',target_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS wcfpf_last_event_idx ON %I.work_client_follow_projection_fence (last_event_id)',target_schema);
  EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS wcftc_position_uq ON %I.work_client_follow_tag_current (corp_id,client_id,userid,sort_order)',target_schema);
END
$work_client_current_projection$;

-- Reject CREATE TABLE IF NOT EXISTS drift, including identity mode and defaults.
DO $work_client_column_verification$
DECLARE
  target_schema text := current_schema();
  expected_record record;
  actual_shape text[];
BEGIN
  FOR expected_record IN SELECT * FROM (VALUES
    ('work_client_current',ARRAY[
      'id|integer|N|a|','corp_id|character varying(18)|N||','external_userid|character varying(64)|N||',
      'lifecycle_state|character varying(16)|N||''UNRESOLVED''::character varying','profile_complete|boolean|N||false',
      'provider_snapshot_complete|boolean|N||false','uid|integer|Y||','name|character varying(128)|Y||',
      'avatar|character varying(1024)|Y||','type|smallint|Y||','gender|smallint|Y||','unionid|character varying(128)|Y||',
      'position|character varying(128)|Y||','corp_name|character varying(128)|Y||','corp_full_name|character varying(256)|Y||',
      'external_profile|jsonb|Y||','last_event_id|integer|Y||','last_event_key|character varying(64)|Y||',
      'last_event_subject_key_hash|character varying(64)|Y||','last_event_time|integer|N||0','last_sequence_rank|integer|N||0',
      'create_time|integer|N||0','update_time|integer|N||0','inactive_time|integer|Y||'
    ]::text[]),
    ('work_client_projection_fence',ARRAY[
      'corp_id|character varying(18)|N||','external_userid|character varying(64)|N||','last_event_id|integer|N||',
      'last_event_key|character varying(64)|N||','last_event_subject_key_hash|character varying(64)|N||',
      'last_event_time|integer|N||','last_sequence_rank|integer|N||','create_time|integer|N||0','update_time|integer|N||0'
    ]::text[]),
    ('work_client_follow_current',ARRAY[
      'corp_id|character varying(18)|N||','client_id|integer|N||','userid|character varying(64)|N||',
      'lifecycle_state|character varying(16)|N||''DELETED''::character varying','source_kind|character varying(16)|N||''DIRECT''::character varying',
      'profile_complete|boolean|N||false','tags_complete|boolean|N||false','remark|character varying(512)|Y||',
      'description|character varying(1024)|Y||','follow_created_time|integer|Y||','remark_corp_name|character varying(128)|Y||',
      'remark_mobiles|text|Y||','add_way|integer|Y||','oper_userid|character varying(64)|Y||','state|character varying(128)|Y||',
      'last_event_id|integer|N||','last_event_key|character varying(64)|N||','last_event_subject_key_hash|character varying(64)|N||',
      'last_event_time|integer|N||','last_sequence_rank|integer|N||','create_time|integer|N||0','update_time|integer|N||0','deleted_time|integer|Y||'
    ]::text[]),
    ('work_client_follow_projection_fence',ARRAY[
      'corp_id|character varying(18)|N||','client_id|integer|N||','userid|character varying(64)|N||','last_event_id|integer|N||',
      'last_event_key|character varying(64)|N||','last_event_subject_key_hash|character varying(64)|N||','last_event_time|integer|N||',
      'last_sequence_rank|integer|N||','create_time|integer|N||0','update_time|integer|N||0'
    ]::text[]),
    ('work_client_follow_tag_current',ARRAY[
      'corp_id|character varying(18)|N||','client_id|integer|N||','userid|character varying(64)|N||','tag_key_hash|character varying(64)|N||',
      'tag_id|character varying(128)|Y||','group_name|character varying(256)|Y||','tag_name|character varying(256)|N||',
      'type|smallint|N||','sort_order|integer|N||','create_time|integer|N||0','update_time|integer|N||0'
    ]::text[])
  ) AS expected(table_name,expected_shape)
  LOOP
    IF to_regclass(expected_record.table_name) IS DISTINCT FROM to_regclass(format('%I.%I',target_schema,expected_record.table_name)) THEN
      RAISE EXCEPTION '0115 search_path misbinds % during verification',expected_record.table_name;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=target_schema AND c.relname=expected_record.table_name AND c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition) THEN
      RAISE EXCEPTION '% is not a permanent ordinary table',expected_record.table_name;
    END IF;
    SELECT array_agg(a.attname||'|'||format_type(a.atttypid,a.atttypmod)||'|'||CASE WHEN a.attnotnull THEN 'N' ELSE 'Y' END||'|'||a.attidentity::text||'|'||COALESCE(pg_get_expr(d.adbin,d.adrelid),'') ORDER BY a.attnum)
      INTO actual_shape
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=to_regclass(format('%I.%I',target_schema,expected_record.table_name)) AND a.attnum>0 AND NOT a.attisdropped;
    IF actual_shape IS DISTINCT FROM expected_record.expected_shape THEN
      RAISE EXCEPTION '% has an incompatible column shape: %',expected_record.table_name,actual_shape;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid WHERE a.attrelid=to_regclass(format('%I.%I',target_schema,expected_record.table_name)) AND a.attnum>0 AND NOT a.attisdropped AND (a.attgenerated<>'' OR a.attcollation<>t.typcollation)) THEN
      RAISE EXCEPTION '% has an incompatible generated column or collation',expected_record.table_name;
    END IF;
  END LOOP;
END
$work_client_column_verification$;

-- Verify exact key columns, FK targets/actions, validation state, and object count.
DO $work_client_constraint_verification$
DECLARE
  target_schema text := current_schema();
  expected_record record;
  compatible boolean;
BEGIN
  FOR expected_record IN SELECT * FROM (VALUES
    ('work_callback_event','wce_department_ref_uq','u',ARRAY['id','corp_id','event_key','subject_key_hash','event_time','sequence_rank']::text[]),
    ('work_client_current','wcc_pk','p',ARRAY['corp_id','id']::text[]),
    ('work_client_projection_fence','wcpf_pk','p',ARRAY['corp_id','external_userid']::text[]),
    ('work_client_follow_current','wcfc_pk','p',ARRAY['corp_id','client_id','userid']::text[]),
    ('work_client_follow_projection_fence','wcfpf_pk','p',ARRAY['corp_id','client_id','userid']::text[]),
    ('work_client_follow_tag_current','wcftc_pk','p',ARRAY['corp_id','client_id','userid','tag_key_hash']::text[])
  ) AS expected(table_name,constraint_name,constraint_type,key_columns)
  LOOP
    SELECT count(*)=1 AND COALESCE(bool_and(c.convalidated AND c.conislocal AND c.coninhcount=0 AND c.conparentid=0 AND NOT c.condeferrable AND NOT c.condeferred AND ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(attnum,pos) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum ORDER BY k.pos)=expected_record.key_columns),false)
      INTO compatible
    FROM pg_constraint c WHERE c.conrelid=to_regclass(format('%I.%I',target_schema,expected_record.table_name)) AND c.conname=expected_record.constraint_name AND c.contype=expected_record.constraint_type::"char";
    IF NOT compatible THEN RAISE EXCEPTION 'constraint %.% has incompatible key metadata',expected_record.table_name,expected_record.constraint_name; END IF;
  END LOOP;

  FOR expected_record IN SELECT * FROM (VALUES
    ('work_client_current','wcc_last_event_fk',ARRAY['last_event_id','corp_id','last_event_key','last_event_subject_key_hash','last_event_time','last_sequence_rank']::text[],'work_callback_event',ARRAY['id','corp_id','event_key','subject_key_hash','event_time','sequence_rank']::text[]),
    ('work_client_projection_fence','wcpf_client_fk',ARRAY['corp_id','external_userid']::text[],'work_client_current',ARRAY['corp_id','external_userid']::text[]),
    ('work_client_projection_fence','wcpf_last_event_fk',ARRAY['last_event_id','corp_id','last_event_key','last_event_subject_key_hash','last_event_time','last_sequence_rank']::text[],'work_callback_event',ARRAY['id','corp_id','event_key','subject_key_hash','event_time','sequence_rank']::text[]),
    ('work_client_follow_current','wcfc_client_fk',ARRAY['corp_id','client_id']::text[],'work_client_current',ARRAY['corp_id','id']::text[]),
    ('work_client_follow_current','wcfc_last_event_fk',ARRAY['last_event_id','corp_id','last_event_key','last_event_subject_key_hash','last_event_time','last_sequence_rank']::text[],'work_callback_event',ARRAY['id','corp_id','event_key','subject_key_hash','event_time','sequence_rank']::text[]),
    ('work_client_follow_projection_fence','wcfpf_client_fk',ARRAY['corp_id','client_id']::text[],'work_client_current',ARRAY['corp_id','id']::text[]),
    ('work_client_follow_projection_fence','wcfpf_last_event_fk',ARRAY['last_event_id','corp_id','last_event_key','last_event_subject_key_hash','last_event_time','last_sequence_rank']::text[],'work_callback_event',ARRAY['id','corp_id','event_key','subject_key_hash','event_time','sequence_rank']::text[]),
    ('work_client_follow_tag_current','wcftc_follow_fk',ARRAY['corp_id','client_id','userid']::text[],'work_client_follow_current',ARRAY['corp_id','client_id','userid']::text[])
  ) AS expected(table_name,constraint_name,key_columns,foreign_table,foreign_columns)
  LOOP
    SELECT count(*)=1 AND COALESCE(bool_and(c.convalidated AND c.conislocal AND c.coninhcount=0 AND c.conparentid=0 AND NOT c.condeferrable AND NOT c.condeferred AND c.confdeltype='r' AND c.confupdtype='a' AND c.confmatchtype='s' AND c.confrelid=to_regclass(format('%I.%I',target_schema,expected_record.foreign_table)) AND ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(attnum,pos) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum ORDER BY k.pos)=expected_record.key_columns AND ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(attnum,pos) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.attnum ORDER BY k.pos)=expected_record.foreign_columns),false)
      INTO compatible
    FROM pg_constraint c WHERE c.conrelid=to_regclass(format('%I.%I',target_schema,expected_record.table_name)) AND c.conname=expected_record.constraint_name AND c.contype='f';
    IF NOT compatible THEN RAISE EXCEPTION 'constraint %.% has incompatible FK metadata',expected_record.table_name,expected_record.constraint_name; END IF;
  END LOOP;

  IF EXISTS (
    SELECT expected.table_name,expected.constraint_name FROM (VALUES
      ('work_client_current','wcc_corp_id_ck'),('work_client_current','wcc_external_userid_ck'),('work_client_current','wcc_lifecycle_state_ck'),('work_client_current','wcc_values_ck'),('work_client_current','wcc_event_fence_ck'),('work_client_current','wcc_snapshot_ck'),('work_client_current','wcc_time_ck'),
      ('work_client_projection_fence','wcpf_corp_id_ck'),('work_client_projection_fence','wcpf_external_userid_ck'),('work_client_projection_fence','wcpf_event_fence_ck'),('work_client_projection_fence','wcpf_time_ck'),
      ('work_client_follow_current','wcfc_corp_id_ck'),('work_client_follow_current','wcfc_userid_ck'),('work_client_follow_current','wcfc_lifecycle_state_ck'),('work_client_follow_current','wcfc_source_kind_ck'),('work_client_follow_current','wcfc_values_ck'),('work_client_follow_current','wcfc_event_fence_ck'),('work_client_follow_current','wcfc_snapshot_ck'),('work_client_follow_current','wcfc_time_ck'),
      ('work_client_follow_projection_fence','wcfpf_corp_id_ck'),('work_client_follow_projection_fence','wcfpf_userid_ck'),('work_client_follow_projection_fence','wcfpf_event_fence_ck'),('work_client_follow_projection_fence','wcfpf_time_ck'),
      ('work_client_follow_tag_current','wcftc_corp_id_ck'),('work_client_follow_tag_current','wcftc_userid_ck'),('work_client_follow_tag_current','wcftc_values_ck')
    ) AS expected(table_name,constraint_name)
    LEFT JOIN pg_constraint c ON c.conrelid=to_regclass(format('%I.%I',target_schema,expected.table_name)) AND c.conname=expected.constraint_name AND c.contype='c' AND c.convalidated AND c.conislocal AND c.coninhcount=0 AND c.conparentid=0 AND NOT c.condeferrable AND NOT c.condeferred
    WHERE c.oid IS NULL
  ) THEN RAISE EXCEPTION '0115 has missing or incompatible CHECK metadata'; END IF;

  IF (SELECT count(*) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=target_schema AND t.relname IN ('work_client_current','work_client_projection_fence','work_client_follow_current','work_client_follow_projection_fence','work_client_follow_tag_current')) <> 39 THEN
    RAISE EXCEPTION '0115 projection constraint count drift';
  END IF;
END
$work_client_constraint_verification$;

-- These five tables are a closed authority surface. Unexpected indexes,
-- constraints, RLS, rules, policies, or user triggers are schema drift.
DO $work_client_closed_surface_verification$
DECLARE
  target_schema text := current_schema();
  expected_record record;
  table_oid oid;
  actual_names text[];
BEGIN
  FOR expected_record IN SELECT * FROM (VALUES
    ('work_client_current',ARRAY['wcc_corp_id_ck','wcc_event_fence_ck','wcc_external_userid_ck','wcc_last_event_fk','wcc_lifecycle_state_ck','wcc_pk','wcc_snapshot_ck','wcc_time_ck','wcc_values_ck']::text[],ARRAY['wcc_catalog_idx','wcc_corp_external_userid_uq','wcc_last_event_idx','wcc_pk']::text[]),
    ('work_client_projection_fence',ARRAY['wcpf_client_fk','wcpf_corp_id_ck','wcpf_event_fence_ck','wcpf_external_userid_ck','wcpf_last_event_fk','wcpf_pk','wcpf_time_ck']::text[],ARRAY['wcpf_last_event_idx','wcpf_pk']::text[]),
    ('work_client_follow_current',ARRAY['wcfc_client_fk','wcfc_corp_id_ck','wcfc_event_fence_ck','wcfc_last_event_fk','wcfc_lifecycle_state_ck','wcfc_pk','wcfc_snapshot_ck','wcfc_source_kind_ck','wcfc_time_ck','wcfc_userid_ck','wcfc_values_ck']::text[],ARRAY['wcfc_active_user_idx','wcfc_last_event_idx','wcfc_pk']::text[]),
    ('work_client_follow_projection_fence',ARRAY['wcfpf_client_fk','wcfpf_corp_id_ck','wcfpf_event_fence_ck','wcfpf_last_event_fk','wcfpf_pk','wcfpf_time_ck','wcfpf_userid_ck']::text[],ARRAY['wcfpf_last_event_idx','wcfpf_pk']::text[]),
    ('work_client_follow_tag_current',ARRAY['wcftc_corp_id_ck','wcftc_follow_fk','wcftc_pk','wcftc_userid_ck','wcftc_values_ck']::text[],ARRAY['wcftc_pk','wcftc_position_uq']::text[])
  ) AS expected(table_name,constraint_names,index_names)
  LOOP
    table_oid := to_regclass(format('%I.%I',target_schema,expected_record.table_name));
    SELECT array_agg(conname ORDER BY conname) INTO actual_names FROM pg_constraint WHERE conrelid=table_oid AND contype<>'n';
    IF actual_names IS DISTINCT FROM expected_record.constraint_names THEN RAISE EXCEPTION '% has an unexpected constraint set',expected_record.table_name; END IF;
    SELECT array_agg(i.relname ORDER BY i.relname) INTO actual_names FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid WHERE x.indrelid=table_oid;
    IF actual_names IS DISTINCT FROM expected_record.index_names THEN RAISE EXCEPTION '% has an unexpected index set',expected_record.table_name; END IF;
    IF EXISTS (SELECT 1 FROM pg_class c WHERE c.oid=table_oid AND (c.relrowsecurity OR c.relforcerowsecurity OR c.relhasrules))
      OR EXISTS (SELECT 1 FROM pg_policy WHERE polrelid=table_oid)
      OR EXISTS (SELECT 1 FROM pg_rewrite WHERE ev_class=table_oid)
      OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=table_oid AND NOT tgisinternal) THEN
      RAISE EXCEPTION '% has unexpected RLS, rules, policies, or user triggers',expected_record.table_name;
    END IF;
  END LOOP;
END
$work_client_closed_surface_verification$;

DO $work_client_index_sequence_verification$
DECLARE
  target_schema text := current_schema();
  expected_record record;
  compatible boolean;
  suffix text := substr(md5(pg_backend_pid()::text||clock_timestamp()::text),1,12);
  predicate_ref text;
  predicate_oid oid;
BEGIN
  predicate_ref := '__wcc_ix_'||suffix;
  EXECUTE format('CREATE TEMP TABLE %I (last_event_id integer,lifecycle_state varchar(16)) ON COMMIT DROP',predicate_ref);
  predicate_oid := to_regclass(format('pg_temp.%I',predicate_ref));
  EXECUTE format($q$ALTER TABLE pg_temp.%I
    ADD CONSTRAINT e_last_event CHECK (last_event_id IS NOT NULL),
    ADD CONSTRAINT e_active CHECK (lifecycle_state = 'ACTIVE')$q$,predicate_ref);
  FOR expected_record IN SELECT * FROM (VALUES
    ('wcc_corp_external_userid_uq','work_client_current',true,ARRAY['corp_id','external_userid']::text[],'0 0',NULL::text),
    ('wcc_catalog_idx','work_client_current',false,ARRAY['corp_id','lifecycle_state','update_time','id']::text[],'0 0 3 0',NULL::text),
    ('wcc_last_event_idx','work_client_current',false,ARRAY['last_event_id']::text[],'0','e_last_event'),
    ('wcpf_last_event_idx','work_client_projection_fence',false,ARRAY['last_event_id']::text[],'0',NULL::text),
    ('wcfc_active_user_idx','work_client_follow_current',false,ARRAY['corp_id','userid','client_id']::text[],'0 0 0','e_active'),
    ('wcfc_last_event_idx','work_client_follow_current',false,ARRAY['last_event_id']::text[],'0',NULL::text),
    ('wcfpf_last_event_idx','work_client_follow_projection_fence',false,ARRAY['last_event_id']::text[],'0',NULL::text),
    ('wcftc_position_uq','work_client_follow_tag_current',true,ARRAY['corp_id','client_id','userid','sort_order']::text[],'0 0 0 0',NULL::text)
  ) AS expected(index_name,table_name,is_unique,key_columns,key_options,predicate_name)
  LOOP
    SELECT EXISTS(SELECT 1 FROM pg_class x JOIN pg_namespace n ON n.oid=x.relnamespace
      JOIN pg_index i ON i.indexrelid=x.oid JOIN pg_am am ON am.oid=x.relam
      WHERE n.nspname=target_schema AND x.relname=expected_record.index_name
        AND i.indrelid=to_regclass(format('%I.%I',target_schema,expected_record.table_name))
        AND am.amname='btree' AND i.indisvalid AND i.indisready AND i.indislive
        AND i.indisunique=expected_record.is_unique AND NOT i.indisprimary
        AND NOT i.indisexclusion AND NOT i.indnullsnotdistinct AND NOT i.indcheckxmin
        AND i.indnkeyatts=cardinality(expected_record.key_columns)
        AND i.indnatts=cardinality(expected_record.key_columns) AND i.indexprs IS NULL
        AND ARRAY(SELECT replace(pg_get_indexdef(x.oid,pos,true),'"','') FROM generate_series(1,i.indnkeyatts) pos ORDER BY pos)=expected_record.key_columns
        AND i.indoption::text=expected_record.key_options
        AND ((expected_record.predicate_name IS NULL AND i.indpred IS NULL) OR
          (expected_record.predicate_name IS NOT NULL AND i.indpred IS NOT NULL
            AND pg_get_expr(i.indpred,i.indrelid)=(SELECT pg_get_expr(c.conbin,c.conrelid)
              FROM pg_constraint c WHERE c.conrelid=predicate_oid
                AND c.conname=expected_record.predicate_name AND c.contype='c')))) INTO compatible;
    IF NOT compatible THEN RAISE EXCEPTION 'index % has incompatible metadata',expected_record.index_name; END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_class x JOIN pg_namespace n ON n.oid=x.relnamespace JOIN pg_index i ON i.indexrelid=x.oid WHERE n.nspname=target_schema AND x.relname IN ('wcc_corp_external_userid_uq','wcc_catalog_idx','wcc_last_event_idx','wcpf_last_event_idx','wcfc_active_user_idx','wcfc_last_event_idx','wcfpf_last_event_idx','wcftc_position_uq')) <> 8 THEN
    RAISE EXCEPTION '0115 projection index count drift';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a
    JOIN pg_depend d ON d.refobjid=a.attrelid AND d.refobjsubid=a.attnum AND d.deptype='i'
    JOIN pg_class s ON s.oid=d.objid AND s.relkind='S' AND s.relpersistence='p'
    JOIN pg_namespace n ON n.oid=s.relnamespace
    WHERE a.attrelid=to_regclass(format('%I.work_client_current',target_schema))
      AND a.attname='id' AND a.attidentity='a' AND n.nspname=target_schema
  ) THEN RAISE EXCEPTION 'work_client_current.id identity sequence is missing or incompatible'; END IF;
END
$work_client_index_sequence_verification$;
