-- Preserve the immutable callback fence on every resolved rename edge.
-- 0112 deliberately remains byte-for-byte immutable; this forward migration
-- accepts only its exact old CHECK or this migration's exact final state.
DO $work_member_resolved_rename_fence$
DECLARE
  alias_table_oid oid;
  target_schema text;
  lifecycle_constraint_oid oid;
  lifecycle_definition text;
  marker_definition text;
  old_reference_name text := format('__wmia_0113_old_%s', txid_current());
  new_reference_name text := format('__wmia_0113_new_%s', txid_current());
  old_reference_oid oid;
  new_reference_oid oid;
  old_definition text;
  new_definition text;
  expected_marker_definition text;
  guard_function_oid oid;
  guard_function_count integer;
  guard_trigger_oid oid;
  guard_trigger_count integer;
  guard_ready boolean := false;
  trigger_ready boolean := false;
  renamed_rows bigint;
  expected_guard_source text := $guard_source$
BEGIN
  IF OLD.lifecycle_state = 'RENAMED' AND (
    NEW.corp_id IS DISTINCT FROM OLD.corp_id
    OR NEW.userid IS DISTINCT FROM OLD.userid
    OR NEW.canonical_userid IS DISTINCT FROM OLD.canonical_userid
    OR NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state
    OR NEW.link_event_id IS DISTINCT FROM OLD.link_event_id
    OR NEW.link_event_time IS DISTINCT FROM OLD.link_event_time
    OR NEW.link_sequence_rank IS DISTINCT FROM OLD.link_sequence_rank
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'wmia_renamed_link_immutable',
      MESSAGE = 'RENAMED member alias link is immutable';
  END IF;
  RETURN NEW;
END
$guard_source$;
BEGIN
  alias_table_oid := to_regclass('work_member_identity_alias');
  IF alias_table_oid IS NULL THEN
    RAISE EXCEPTION 'work_member_identity_alias is required before 0113';
  END IF;
  SELECT namespace_row.nspname
    INTO target_schema
  FROM pg_class AS table_row
  JOIN pg_namespace AS namespace_row ON namespace_row.oid = table_row.relnamespace
  WHERE table_row.oid = alias_table_oid
    AND table_row.relkind = 'r'
    AND NOT table_row.relispartition;
  IF target_schema IS NULL OR left(target_schema, 3) = 'pg_' THEN
    RAISE EXCEPTION 'work_member_identity_alias must be a permanent ordinary application table';
  END IF;
  IF to_regclass(format('%I.%I', target_schema, 'work_callback_event')) IS NULL
    OR to_regclass(format('%I.%I', target_schema, 'work_member_current')) IS NULL THEN
    RAISE EXCEPTION '0113 prerequisite tables must be in schema %', target_schema;
  END IF;

  EXECUTE format('LOCK TABLE %I.%I IN SHARE MODE', target_schema, 'work_callback_event');
  EXECUTE format('LOCK TABLE %I.%I IN ACCESS EXCLUSIVE MODE', target_schema, 'work_member_identity_alias');

  EXECUTE format($reference_sql$
    CREATE TEMP TABLE %I (
      member_id integer,
      userid varchar(64) NOT NULL,
      canonical_userid varchar(64) NOT NULL,
      lifecycle_state varchar(16) NOT NULL,
      link_event_id integer
    ) ON COMMIT DROP
  $reference_sql$, old_reference_name);
  EXECUTE format($reference_sql$
    CREATE TEMP TABLE %I (
      member_id integer,
      userid varchar(64) NOT NULL,
      canonical_userid varchar(64) NOT NULL,
      lifecycle_state varchar(16) NOT NULL,
      link_event_id integer
    ) ON COMMIT DROP
  $reference_sql$, new_reference_name);
  EXECUTE format($reference_sql$
    ALTER TABLE pg_temp.%I ADD CONSTRAINT expected_old CHECK (
      ((
        lifecycle_state = 'UNRESOLVED'
        AND (
          (userid = canonical_userid AND link_event_id IS NULL)
          OR (userid <> canonical_userid AND link_event_id IS NOT NULL)
        )
      ) OR (
        lifecycle_state = 'ACTIVE'
        AND member_id IS NOT NULL
        AND userid = canonical_userid
        AND link_event_id IS NULL
      ) OR (
        lifecycle_state = 'RENAMED'
        AND member_id IS NOT NULL
        AND userid <> canonical_userid
        AND link_event_id IS NULL
      ) OR (
        lifecycle_state = 'DELETED'
        AND userid = canonical_userid
        AND link_event_id IS NULL
      ))
      AND (member_id IS NULL OR member_id > 0)
    )
  $reference_sql$, old_reference_name);
  EXECUTE format($reference_sql$
    ALTER TABLE pg_temp.%I
      ADD CONSTRAINT expected_new CHECK (
        ((
          lifecycle_state = 'UNRESOLVED'
          AND (
            (userid = canonical_userid AND link_event_id IS NULL)
            OR (userid <> canonical_userid AND link_event_id IS NOT NULL)
          )
        ) OR (
          lifecycle_state = 'ACTIVE'
          AND member_id IS NOT NULL
          AND userid = canonical_userid
          AND link_event_id IS NULL
        ) OR (
          lifecycle_state = 'RENAMED'
          AND member_id IS NOT NULL
          AND userid <> canonical_userid
          AND link_event_id IS NOT NULL
        ) OR (
          lifecycle_state = 'DELETED'
          AND userid = canonical_userid
          AND link_event_id IS NULL
        ))
        AND (member_id IS NULL OR member_id > 0)
      ),
      ADD CONSTRAINT expected_marker CHECK (
        lifecycle_state <> 'RENAMED' OR link_event_id IS NOT NULL
      )
  $reference_sql$, new_reference_name);

  old_reference_oid := to_regclass(format('pg_temp.%I', old_reference_name));
  new_reference_oid := to_regclass(format('pg_temp.%I', new_reference_name));
  SELECT pg_get_expr(conbin, conrelid) INTO old_definition
  FROM pg_constraint WHERE conrelid = old_reference_oid AND conname = 'expected_old';
  SELECT pg_get_expr(conbin, conrelid) INTO new_definition
  FROM pg_constraint WHERE conrelid = new_reference_oid AND conname = 'expected_new';
  SELECT pg_get_expr(conbin, conrelid) INTO expected_marker_definition
  FROM pg_constraint WHERE conrelid = new_reference_oid AND conname = 'expected_marker';

  SELECT constraint_row.oid, pg_get_expr(constraint_row.conbin, constraint_row.conrelid)
    INTO lifecycle_constraint_oid, lifecycle_definition
  FROM pg_constraint AS constraint_row
  WHERE constraint_row.conrelid = alias_table_oid
    AND constraint_row.conname = 'wmia_lifecycle_identity_ck'
    AND constraint_row.contype = 'c'
    AND constraint_row.convalidated
    AND NOT constraint_row.connoinherit;
  IF lifecycle_constraint_oid IS NULL THEN
    RAISE EXCEPTION 'wmia_lifecycle_identity_ck is missing or not fully validated';
  END IF;

  SELECT pg_get_expr(constraint_row.conbin, constraint_row.conrelid)
    INTO marker_definition
  FROM pg_constraint AS constraint_row
  WHERE constraint_row.conrelid = alias_table_oid
    AND constraint_row.conname = 'wmia_resolved_link_required_ck'
    AND constraint_row.contype = 'c'
    AND constraint_row.convalidated
    AND NOT constraint_row.connoinherit;

  SELECT count(*), min(function_row.oid::bigint)::oid
    INTO guard_function_count, guard_function_oid
  FROM pg_proc AS function_row
  JOIN pg_namespace AS function_namespace ON function_namespace.oid = function_row.pronamespace
  WHERE function_namespace.nspname = target_schema
    AND function_row.proname = 'wmia_guard_renamed_link_0113';
  IF guard_function_count = 1 THEN
    SELECT
      function_row.pronargs = 0
      AND function_row.prorettype = 'trigger'::regtype
      AND language_row.lanname = 'plpgsql'
      AND NOT function_row.prosecdef
      AND NOT function_row.proleakproof
      AND function_row.provolatile = 'v'
      AND function_row.proparallel = 'u'
      AND function_row.proconfig = ARRAY['search_path=pg_catalog']::text[]
      AND btrim(function_row.prosrc) = btrim(expected_guard_source)
      INTO guard_ready
    FROM pg_proc AS function_row
    JOIN pg_language AS language_row ON language_row.oid = function_row.prolang
    WHERE function_row.oid = guard_function_oid;
  END IF;

  SELECT count(*), min(trigger_row.oid::bigint)::oid
    INTO guard_trigger_count, guard_trigger_oid
  FROM pg_trigger AS trigger_row
  WHERE trigger_row.tgrelid = alias_table_oid
    AND trigger_row.tgname = 'wmia_guard_renamed_link_0113'
    AND NOT trigger_row.tgisinternal;
  IF guard_trigger_count = 1 THEN
    SELECT
      trigger_row.tgfoid = guard_function_oid
      AND trigger_row.tgtype = 19
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgnargs = 0
      AND trigger_row.tgattr = ''::int2vector
      AND trigger_row.tgqual IS NULL
      INTO trigger_ready
    FROM pg_trigger AS trigger_row
    WHERE trigger_row.oid = guard_trigger_oid;
  END IF;

  IF lifecycle_definition IS NOT DISTINCT FROM new_definition THEN
    IF marker_definition IS DISTINCT FROM expected_marker_definition
      OR guard_function_count <> 1 OR NOT guard_ready
      OR guard_trigger_count <> 1 OR NOT trigger_ready THEN
      RAISE EXCEPTION '0113 final state is incomplete or incompatible';
    END IF;
  ELSIF lifecycle_definition IS NOT DISTINCT FROM old_definition THEN
    IF marker_definition IS NOT NULL
      OR guard_function_count <> 0
      OR guard_trigger_count <> 0 THEN
      RAISE EXCEPTION '0113 old state contains incompatible final-state objects';
    END IF;
    EXECUTE format(
      'SELECT count(*) FROM %I.%I WHERE lifecycle_state = %L',
      target_schema, 'work_member_identity_alias', 'RENAMED'
    ) INTO renamed_rows;
    IF renamed_rows <> 0 THEN
      RAISE EXCEPTION
        '0113 cannot infer immutable edge fences for % pre-existing RENAMED aliases',
        renamed_rows;
    END IF;

    EXECUTE format(
      'ALTER TABLE %I.%I DROP CONSTRAINT %I',
      target_schema, 'work_member_identity_alias', 'wmia_lifecycle_identity_ck'
    );
    EXECUTE format($ddl$
      ALTER TABLE %I.%I
        ADD CONSTRAINT wmia_lifecycle_identity_ck CHECK (
          ((
            lifecycle_state = 'UNRESOLVED'
            AND (
              (userid = canonical_userid AND link_event_id IS NULL)
              OR (userid <> canonical_userid AND link_event_id IS NOT NULL)
            )
          ) OR (
            lifecycle_state = 'ACTIVE'
            AND member_id IS NOT NULL
            AND userid = canonical_userid
            AND link_event_id IS NULL
          ) OR (
            lifecycle_state = 'RENAMED'
            AND member_id IS NOT NULL
            AND userid <> canonical_userid
            AND link_event_id IS NOT NULL
          ) OR (
            lifecycle_state = 'DELETED'
            AND userid = canonical_userid
            AND link_event_id IS NULL
          ))
          AND (member_id IS NULL OR member_id > 0)
        ),
        ADD CONSTRAINT wmia_resolved_link_required_ck CHECK (
          lifecycle_state <> 'RENAMED' OR link_event_id IS NOT NULL
        )
    $ddl$, target_schema, 'work_member_identity_alias');
    EXECUTE format($ddl$
      CREATE FUNCTION %I.wmia_guard_renamed_link_0113()
      RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog
      AS $function$
BEGIN
  IF OLD.lifecycle_state = 'RENAMED' AND (
    NEW.corp_id IS DISTINCT FROM OLD.corp_id
    OR NEW.userid IS DISTINCT FROM OLD.userid
    OR NEW.canonical_userid IS DISTINCT FROM OLD.canonical_userid
    OR NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state
    OR NEW.link_event_id IS DISTINCT FROM OLD.link_event_id
    OR NEW.link_event_time IS DISTINCT FROM OLD.link_event_time
    OR NEW.link_sequence_rank IS DISTINCT FROM OLD.link_sequence_rank
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'wmia_renamed_link_immutable',
      MESSAGE = 'RENAMED member alias link is immutable';
  END IF;
  RETURN NEW;
END
$function$
    $ddl$, target_schema);
    EXECUTE format($ddl$
      CREATE TRIGGER wmia_guard_renamed_link_0113
      BEFORE UPDATE ON %I.%I
      FOR EACH ROW
      EXECUTE FUNCTION %I.wmia_guard_renamed_link_0113()
    $ddl$, target_schema, 'work_member_identity_alias', target_schema);
    EXECUTE format(
      'COMMENT ON COLUMN %I.%I.%I IS %L',
      target_schema,
      'work_member_identity_alias',
      'link_event_id',
      'Immutable rename-edge callback fence. Pending edges are stored on the target alias; resolved edges are stored on the source RENAMED alias.'
    );
  ELSE
    RAISE EXCEPTION 'wmia_lifecycle_identity_ck has an incompatible definition';
  END IF;

  SELECT pg_get_expr(constraint_row.conbin, constraint_row.conrelid)
    INTO lifecycle_definition
  FROM pg_constraint AS constraint_row
  WHERE constraint_row.conrelid = alias_table_oid
    AND constraint_row.conname = 'wmia_lifecycle_identity_ck'
    AND constraint_row.contype = 'c'
    AND constraint_row.convalidated
    AND NOT constraint_row.connoinherit;
  SELECT pg_get_expr(constraint_row.conbin, constraint_row.conrelid)
    INTO marker_definition
  FROM pg_constraint AS constraint_row
  WHERE constraint_row.conrelid = alias_table_oid
    AND constraint_row.conname = 'wmia_resolved_link_required_ck'
    AND constraint_row.contype = 'c'
    AND constraint_row.convalidated
    AND NOT constraint_row.connoinherit;
  IF lifecycle_definition IS DISTINCT FROM new_definition
    OR marker_definition IS DISTINCT FROM expected_marker_definition THEN
    RAISE EXCEPTION '0113 final CHECK verification failed';
  END IF;

  SELECT count(*), min(function_row.oid::bigint)::oid
    INTO guard_function_count, guard_function_oid
  FROM pg_proc AS function_row
  JOIN pg_namespace AS function_namespace ON function_namespace.oid = function_row.pronamespace
  WHERE function_namespace.nspname = target_schema
    AND function_row.proname = 'wmia_guard_renamed_link_0113';
  SELECT count(*), min(trigger_row.oid::bigint)::oid
    INTO guard_trigger_count, guard_trigger_oid
  FROM pg_trigger AS trigger_row
  WHERE trigger_row.tgrelid = alias_table_oid
    AND trigger_row.tgname = 'wmia_guard_renamed_link_0113'
    AND NOT trigger_row.tgisinternal;
  IF guard_function_count <> 1 OR guard_trigger_count <> 1 THEN
    RAISE EXCEPTION '0113 final guard object count verification failed';
  END IF;
  SELECT
    function_row.pronargs = 0
    AND function_row.prorettype = 'trigger'::regtype
    AND language_row.lanname = 'plpgsql'
    AND NOT function_row.prosecdef
    AND NOT function_row.proleakproof
    AND function_row.provolatile = 'v'
    AND function_row.proparallel = 'u'
    AND function_row.proconfig = ARRAY['search_path=pg_catalog']::text[]
    AND btrim(function_row.prosrc) = btrim(expected_guard_source)
    INTO guard_ready
  FROM pg_proc AS function_row
  JOIN pg_language AS language_row ON language_row.oid = function_row.prolang
  WHERE function_row.oid = guard_function_oid;
  SELECT
    trigger_row.tgfoid = guard_function_oid
    AND trigger_row.tgtype = 19
    AND trigger_row.tgenabled = 'O'
    AND trigger_row.tgnargs = 0
    AND trigger_row.tgattr = ''::int2vector
    AND trigger_row.tgqual IS NULL
    INTO trigger_ready
  FROM pg_trigger AS trigger_row
  WHERE trigger_row.oid = guard_trigger_oid;
  IF NOT guard_ready OR NOT trigger_ready THEN
    RAISE EXCEPTION '0113 final guard definition verification failed';
  END IF;
END
$work_member_resolved_rename_fence$;
