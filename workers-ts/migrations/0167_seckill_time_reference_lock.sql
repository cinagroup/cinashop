-- Explicit PG16 seckill time reference locking capability; NOLOGIN owner must already exist.
-- Set cinashop.seckill_time_reference_owner locally in this maintenance transaction.
SELECT
  pg_catalog.set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
  pg_catalog.set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
  pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true),
  pg_catalog.set_config('search_path','pg_catalog,pg_temp',true);
DO $seckill_time_reference_lock_install$
DECLARE
  reference_lock_owner text := nullif(pg_catalog.current_setting('cinashop.seckill_time_reference_owner',true),'');
  owner_oid text;
  namespace_oid integer;
  initial_state jsonb;
  locked_state jsonb;
  final_state jsonb;
BEGIN
  IF reference_lock_owner IS NULL OR reference_lock_owner !~ '^[a-z_][a-z0-9_]{0,62}$'
    OR pg_catalog.starts_with(reference_lock_owner,'pg_') OR reference_lock_owner='information_schema' THEN
    RAISE EXCEPTION 'Seckill time reference lock installation requires an explicit safe NOLOGIN owner setting';
  END IF;
  IF pg_catalog.current_setting('server_version_num')::integer/10000<>16
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR pg_catalog.current_setting('session_replication_role')<>'origin'
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') THEN
    RAISE EXCEPTION 'Seckill time reference lock capability requires reviewed PG16 READ COMMITTED';
  END IF;
  SELECT oid::integer INTO namespace_oid FROM pg_catalog.pg_namespace WHERE nspname='public';
  IF namespace_oid IS NULL OR NOT pg_catalog.pg_try_advisory_xact_lock(731644,namespace_oid) THEN
    RAISE EXCEPTION 'Seckill time reference lock capability maintenance is busy or schema is missing';
  END IF;
  SELECT q.oid INTO owner_oid FROM (SELECT oid::text AS oid FROM pg_catalog.pg_roles r
    WHERE rolname=reference_lock_owner AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
      AND NOT rolreplication AND NOT rolbypassrls
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity WHERE usesysid=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_database WHERE datdba=r.oid)
      AND NOT pg_catalog.has_schema_privilege(r.oid,'public','CREATE')
      AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET')
      AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','ALTER SYSTEM')) q;
  IF owner_oid IS NULL THEN
    RAISE EXCEPTION 'Seckill time reference lock capability owner must be a separate restricted NOLOGIN role';
  END IF;
  SELECT pg_catalog.to_jsonb(q) INTO initial_state FROM (WITH namespace AS (
    SELECT * FROM pg_catalog.pg_namespace WHERE nspname='public'
  ), relations AS (
    SELECT c.* FROM pg_catalog.pg_class c JOIN namespace n ON n.oid=c.relnamespace
    WHERE c.relname IN ('store_activity','store_seckill')
  ), routines AS (
    SELECT p.* FROM pg_catalog.pg_proc p JOIN namespace n ON n.oid=p.pronamespace WHERE p.proname='admin_lock_seckill_time_references_v1'
  ), target AS (
    SELECT p.*,r.rolcanlogin,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls
    FROM routines p JOIN pg_catalog.pg_roles r ON r.oid=p.proowner
    WHERE p.pronargs=0 AND p.prokind='f'
  ) SELECT
    current_setting('server_version_num')::integer/10000=16
    AND (SELECT count(*)=2 AND bool_and(relkind='r' AND relpersistence='p' AND NOT relispartition
      AND NOT relrowsecurity AND NOT relforcerowsecurity) FROM relations)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i JOIN relations r ON r.oid IN (i.inhrelid,i.inhparent))
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy p JOIN relations r ON r.oid=p.polrelid)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_rewrite w JOIN relations r ON r.oid=w.ev_class) AS "tablesSafe",
    (SELECT count(*)=0 FROM routines) AS "absent",
    (SELECT count(*)=1 FROM routines) AND EXISTS (SELECT 1 FROM target p
      JOIN pg_catalog.pg_language l ON l.oid=p.prolang
      WHERE l.lanname='plpgsql' AND l.lanpltrusted AND p.prosecdef AND p.prorettype='pg_catalog.void'::regtype
      AND p.provolatile='v' AND p.proparallel='u' AND NOT p.proleakproof AND NOT p.proisstrict AND NOT p.proretset
      AND p.prosrc='
BEGIN
  IF pg_catalog.current_setting(''transaction_isolation'') <> ''read committed'' THEN
    RAISE EXCEPTION ''Seckill time reference lock requires READ COMMITTED'' USING ERRCODE=''25000'';
  END IF;
  PERFORM pg_catalog.set_config(''statement_timeout'',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name=''statement_timeout''),0),5000)::text||''ms'',true),
    pg_catalog.set_config(''lock_timeout'',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name=''lock_timeout''),0),2000)::text||''ms'',true),
    pg_catalog.set_config(''idle_in_transaction_session_timeout'',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name=''idle_in_transaction_session_timeout''),0),5000)::text||''ms'',true);
  LOCK TABLE "public".store_activity, "public".store_seckill IN EXCLUSIVE MODE;
END
' AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[]
      AND p.prosupport=0 AND p.probin IS NULL AND p.prosqlbody IS NULL AND p.procost=100 AND p.prorows=0
      AND p.provariadic=0 AND p.pronargdefaults=0 AND p.proargtypes=''::oidvector
      AND p.proallargtypes IS NULL AND p.proargmodes IS NULL AND p.proargnames IS NULL AND p.proargdefaults IS NULL
      AND p.protrftypes IS NULL) AS "definitionSafe",
    EXISTS (SELECT 1 FROM target p WHERE NOT p.rolcanlogin AND NOT p.rolsuper AND NOT p.rolcreatedb
      AND NOT p.rolcreaterole AND NOT p.rolreplication AND NOT p.rolbypassrls
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity WHERE usesysid=p.proowner)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=p.proowner OR roleid=p.proowner)
      AND NOT EXISTS (SELECT 1 FROM relations WHERE relowner=p.proowner)
      AND NOT EXISTS (SELECT 1 FROM namespace WHERE nspowner=p.proowner OR pg_catalog.has_schema_privilege(p.proowner,oid,'CREATE'))
      AND EXISTS (SELECT 1 FROM namespace WHERE pg_catalog.has_schema_privilege(p.proowner,oid,'USAGE'))
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname=current_database() AND datdba=p.proowner)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc other WHERE other.proowner=p.proowner AND other.oid<>p.oid)
      AND NOT pg_catalog.has_parameter_privilege(p.proowner,'session_replication_role','SET')
      AND NOT pg_catalog.has_parameter_privilege(p.proowner,'session_replication_role','ALTER SYSTEM')
      AND NOT EXISTS (SELECT 1 FROM relations WHERE NOT pg_catalog.has_table_privilege(p.proowner,oid,'UPDATE'))
      AND NOT EXISTS (SELECT 1 FROM relations r CROSS JOIN LATERAL
        pg_catalog.aclexplode(COALESCE(r.relacl,pg_catalog.acldefault('r',r.relowner))) a
        WHERE a.grantee=p.proowner AND a.is_grantable)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_catalog.pg_attribute column_acl ON column_acl.attrelid=c.oid
        CROSS JOIN LATERAL pg_catalog.aclexplode(column_acl.attacl) a
        WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
          AND a.grantee=p.proowner AND a.is_grantable)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
          AND c.relkind IN ('r','p','v','m','f') AND (c.relowner=p.proowner
            OR pg_catalog.has_table_privilege(p.proowner,c.oid,'INSERT,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR pg_catalog.has_any_column_privilege(p.proowner,c.oid,'INSERT,REFERENCES')
            OR (NOT EXISTS(SELECT 1 FROM relations r WHERE r.oid=c.oid)
              AND (pg_catalog.has_table_privilege(p.proowner,c.oid,'UPDATE') OR pg_catalog.has_any_column_privilege(p.proowner,c.oid,'UPDATE')))))) AS "ownerSafe",
    EXISTS (SELECT 1 FROM target p WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
      WHERE a.grantee<>p.proowner AND (a.grantee=0 OR a.is_grantable OR a.privilege_type<>'EXECUTE'))) AS "aclSafe",
    (SELECT proowner::text FROM target) AS "ownerOid",
    (SELECT oid::text FROM target) AS "functionOid") q;
  IF initial_state->>'tablesSafe' IS DISTINCT FROM 'true'
    OR (initial_state->>'absent' IS DISTINCT FROM 'true'
      AND (NOT COALESCE((initial_state->>'tablesSafe'='true' AND initial_state->>'absent'='false'
    AND initial_state->>'definitionSafe'='true' AND initial_state->>'ownerSafe'='true' AND initial_state->>'aclSafe'='true'),false) OR initial_state->>'ownerOid' IS DISTINCT FROM owner_oid)) THEN
    RAISE EXCEPTION 'Seckill time reference lock capability catalog, owner or ACL drift requires review';
  END IF;
  LOCK TABLE "public".store_activity,"public".store_seckill IN ACCESS EXCLUSIVE MODE NOWAIT;
  SELECT pg_catalog.to_jsonb(q) INTO locked_state FROM (WITH namespace AS (
    SELECT * FROM pg_catalog.pg_namespace WHERE nspname='public'
  ), relations AS (
    SELECT c.* FROM pg_catalog.pg_class c JOIN namespace n ON n.oid=c.relnamespace
    WHERE c.relname IN ('store_activity','store_seckill')
  ), routines AS (
    SELECT p.* FROM pg_catalog.pg_proc p JOIN namespace n ON n.oid=p.pronamespace WHERE p.proname='admin_lock_seckill_time_references_v1'
  ), target AS (
    SELECT p.*,r.rolcanlogin,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls
    FROM routines p JOIN pg_catalog.pg_roles r ON r.oid=p.proowner
    WHERE p.pronargs=0 AND p.prokind='f'
  ) SELECT
    current_setting('server_version_num')::integer/10000=16
    AND (SELECT count(*)=2 AND bool_and(relkind='r' AND relpersistence='p' AND NOT relispartition
      AND NOT relrowsecurity AND NOT relforcerowsecurity) FROM relations)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i JOIN relations r ON r.oid IN (i.inhrelid,i.inhparent))
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy p JOIN relations r ON r.oid=p.polrelid)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_rewrite w JOIN relations r ON r.oid=w.ev_class) AS "tablesSafe",
    (SELECT count(*)=0 FROM routines) AS "absent",
    (SELECT count(*)=1 FROM routines) AND EXISTS (SELECT 1 FROM target p
      JOIN pg_catalog.pg_language l ON l.oid=p.prolang
      WHERE l.lanname='plpgsql' AND l.lanpltrusted AND p.prosecdef AND p.prorettype='pg_catalog.void'::regtype
      AND p.provolatile='v' AND p.proparallel='u' AND NOT p.proleakproof AND NOT p.proisstrict AND NOT p.proretset
      AND p.prosrc='
BEGIN
  IF pg_catalog.current_setting(''transaction_isolation'') <> ''read committed'' THEN
    RAISE EXCEPTION ''Seckill time reference lock requires READ COMMITTED'' USING ERRCODE=''25000'';
  END IF;
  PERFORM pg_catalog.set_config(''statement_timeout'',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name=''statement_timeout''),0),5000)::text||''ms'',true),
    pg_catalog.set_config(''lock_timeout'',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name=''lock_timeout''),0),2000)::text||''ms'',true),
    pg_catalog.set_config(''idle_in_transaction_session_timeout'',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name=''idle_in_transaction_session_timeout''),0),5000)::text||''ms'',true);
  LOCK TABLE "public".store_activity, "public".store_seckill IN EXCLUSIVE MODE;
END
' AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[]
      AND p.prosupport=0 AND p.probin IS NULL AND p.prosqlbody IS NULL AND p.procost=100 AND p.prorows=0
      AND p.provariadic=0 AND p.pronargdefaults=0 AND p.proargtypes=''::oidvector
      AND p.proallargtypes IS NULL AND p.proargmodes IS NULL AND p.proargnames IS NULL AND p.proargdefaults IS NULL
      AND p.protrftypes IS NULL) AS "definitionSafe",
    EXISTS (SELECT 1 FROM target p WHERE NOT p.rolcanlogin AND NOT p.rolsuper AND NOT p.rolcreatedb
      AND NOT p.rolcreaterole AND NOT p.rolreplication AND NOT p.rolbypassrls
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity WHERE usesysid=p.proowner)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=p.proowner OR roleid=p.proowner)
      AND NOT EXISTS (SELECT 1 FROM relations WHERE relowner=p.proowner)
      AND NOT EXISTS (SELECT 1 FROM namespace WHERE nspowner=p.proowner OR pg_catalog.has_schema_privilege(p.proowner,oid,'CREATE'))
      AND EXISTS (SELECT 1 FROM namespace WHERE pg_catalog.has_schema_privilege(p.proowner,oid,'USAGE'))
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname=current_database() AND datdba=p.proowner)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc other WHERE other.proowner=p.proowner AND other.oid<>p.oid)
      AND NOT pg_catalog.has_parameter_privilege(p.proowner,'session_replication_role','SET')
      AND NOT pg_catalog.has_parameter_privilege(p.proowner,'session_replication_role','ALTER SYSTEM')
      AND NOT EXISTS (SELECT 1 FROM relations WHERE NOT pg_catalog.has_table_privilege(p.proowner,oid,'UPDATE'))
      AND NOT EXISTS (SELECT 1 FROM relations r CROSS JOIN LATERAL
        pg_catalog.aclexplode(COALESCE(r.relacl,pg_catalog.acldefault('r',r.relowner))) a
        WHERE a.grantee=p.proowner AND a.is_grantable)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_catalog.pg_attribute column_acl ON column_acl.attrelid=c.oid
        CROSS JOIN LATERAL pg_catalog.aclexplode(column_acl.attacl) a
        WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
          AND a.grantee=p.proowner AND a.is_grantable)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
          AND c.relkind IN ('r','p','v','m','f') AND (c.relowner=p.proowner
            OR pg_catalog.has_table_privilege(p.proowner,c.oid,'INSERT,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR pg_catalog.has_any_column_privilege(p.proowner,c.oid,'INSERT,REFERENCES')
            OR (NOT EXISTS(SELECT 1 FROM relations r WHERE r.oid=c.oid)
              AND (pg_catalog.has_table_privilege(p.proowner,c.oid,'UPDATE') OR pg_catalog.has_any_column_privilege(p.proowner,c.oid,'UPDATE')))))) AS "ownerSafe",
    EXISTS (SELECT 1 FROM target p WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
      WHERE a.grantee<>p.proowner AND (a.grantee=0 OR a.is_grantable OR a.privilege_type<>'EXECUTE'))) AS "aclSafe",
    (SELECT proowner::text FROM target) AS "ownerOid",
    (SELECT oid::text FROM target) AS "functionOid") q;
  IF locked_state IS DISTINCT FROM initial_state THEN
    RAISE EXCEPTION 'Seckill time reference lock capability changed during installation';
  END IF;
  IF initial_state->>'absent'='true' THEN
    EXECUTE pg_catalog.format('GRANT USAGE,CREATE ON SCHEMA "public" TO %I',reference_lock_owner);
    EXECUTE pg_catalog.format('GRANT UPDATE ON "public".store_activity,"public".store_seckill TO %I',reference_lock_owner);
    EXECUTE 'CREATE FUNCTION "public".admin_lock_seckill_time_references_v1() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp
    AS $reference_lock$
BEGIN
  IF pg_catalog.current_setting(''transaction_isolation'') <> ''read committed'' THEN
    RAISE EXCEPTION ''Seckill time reference lock requires READ COMMITTED'' USING ERRCODE=''25000'';
  END IF;
  PERFORM pg_catalog.set_config(''statement_timeout'',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name=''statement_timeout''),0),5000)::text||''ms'',true),
    pg_catalog.set_config(''lock_timeout'',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name=''lock_timeout''),0),2000)::text||''ms'',true),
    pg_catalog.set_config(''idle_in_transaction_session_timeout'',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name=''idle_in_transaction_session_timeout''),0),5000)::text||''ms'',true);
  LOCK TABLE "public".store_activity, "public".store_seckill IN EXCLUSIVE MODE;
END
$reference_lock$';
    REVOKE ALL ON FUNCTION "public".admin_lock_seckill_time_references_v1() FROM PUBLIC;
    EXECUTE pg_catalog.format('ALTER FUNCTION "public".admin_lock_seckill_time_references_v1() OWNER TO %I',reference_lock_owner);
    EXECUTE pg_catalog.format('REVOKE CREATE ON SCHEMA "public" FROM %I',reference_lock_owner);
  END IF;
  SELECT pg_catalog.to_jsonb(q) INTO final_state FROM (WITH namespace AS (
    SELECT * FROM pg_catalog.pg_namespace WHERE nspname='public'
  ), relations AS (
    SELECT c.* FROM pg_catalog.pg_class c JOIN namespace n ON n.oid=c.relnamespace
    WHERE c.relname IN ('store_activity','store_seckill')
  ), routines AS (
    SELECT p.* FROM pg_catalog.pg_proc p JOIN namespace n ON n.oid=p.pronamespace WHERE p.proname='admin_lock_seckill_time_references_v1'
  ), target AS (
    SELECT p.*,r.rolcanlogin,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls
    FROM routines p JOIN pg_catalog.pg_roles r ON r.oid=p.proowner
    WHERE p.pronargs=0 AND p.prokind='f'
  ) SELECT
    current_setting('server_version_num')::integer/10000=16
    AND (SELECT count(*)=2 AND bool_and(relkind='r' AND relpersistence='p' AND NOT relispartition
      AND NOT relrowsecurity AND NOT relforcerowsecurity) FROM relations)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i JOIN relations r ON r.oid IN (i.inhrelid,i.inhparent))
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy p JOIN relations r ON r.oid=p.polrelid)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_rewrite w JOIN relations r ON r.oid=w.ev_class) AS "tablesSafe",
    (SELECT count(*)=0 FROM routines) AS "absent",
    (SELECT count(*)=1 FROM routines) AND EXISTS (SELECT 1 FROM target p
      JOIN pg_catalog.pg_language l ON l.oid=p.prolang
      WHERE l.lanname='plpgsql' AND l.lanpltrusted AND p.prosecdef AND p.prorettype='pg_catalog.void'::regtype
      AND p.provolatile='v' AND p.proparallel='u' AND NOT p.proleakproof AND NOT p.proisstrict AND NOT p.proretset
      AND p.prosrc='
BEGIN
  IF pg_catalog.current_setting(''transaction_isolation'') <> ''read committed'' THEN
    RAISE EXCEPTION ''Seckill time reference lock requires READ COMMITTED'' USING ERRCODE=''25000'';
  END IF;
  PERFORM pg_catalog.set_config(''statement_timeout'',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name=''statement_timeout''),0),5000)::text||''ms'',true),
    pg_catalog.set_config(''lock_timeout'',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name=''lock_timeout''),0),2000)::text||''ms'',true),
    pg_catalog.set_config(''idle_in_transaction_session_timeout'',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name=''idle_in_transaction_session_timeout''),0),5000)::text||''ms'',true);
  LOCK TABLE "public".store_activity, "public".store_seckill IN EXCLUSIVE MODE;
END
' AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[]
      AND p.prosupport=0 AND p.probin IS NULL AND p.prosqlbody IS NULL AND p.procost=100 AND p.prorows=0
      AND p.provariadic=0 AND p.pronargdefaults=0 AND p.proargtypes=''::oidvector
      AND p.proallargtypes IS NULL AND p.proargmodes IS NULL AND p.proargnames IS NULL AND p.proargdefaults IS NULL
      AND p.protrftypes IS NULL) AS "definitionSafe",
    EXISTS (SELECT 1 FROM target p WHERE NOT p.rolcanlogin AND NOT p.rolsuper AND NOT p.rolcreatedb
      AND NOT p.rolcreaterole AND NOT p.rolreplication AND NOT p.rolbypassrls
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity WHERE usesysid=p.proowner)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=p.proowner OR roleid=p.proowner)
      AND NOT EXISTS (SELECT 1 FROM relations WHERE relowner=p.proowner)
      AND NOT EXISTS (SELECT 1 FROM namespace WHERE nspowner=p.proowner OR pg_catalog.has_schema_privilege(p.proowner,oid,'CREATE'))
      AND EXISTS (SELECT 1 FROM namespace WHERE pg_catalog.has_schema_privilege(p.proowner,oid,'USAGE'))
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname=current_database() AND datdba=p.proowner)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc other WHERE other.proowner=p.proowner AND other.oid<>p.oid)
      AND NOT pg_catalog.has_parameter_privilege(p.proowner,'session_replication_role','SET')
      AND NOT pg_catalog.has_parameter_privilege(p.proowner,'session_replication_role','ALTER SYSTEM')
      AND NOT EXISTS (SELECT 1 FROM relations WHERE NOT pg_catalog.has_table_privilege(p.proowner,oid,'UPDATE'))
      AND NOT EXISTS (SELECT 1 FROM relations r CROSS JOIN LATERAL
        pg_catalog.aclexplode(COALESCE(r.relacl,pg_catalog.acldefault('r',r.relowner))) a
        WHERE a.grantee=p.proowner AND a.is_grantable)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_catalog.pg_attribute column_acl ON column_acl.attrelid=c.oid
        CROSS JOIN LATERAL pg_catalog.aclexplode(column_acl.attacl) a
        WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
          AND a.grantee=p.proowner AND a.is_grantable)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
          AND c.relkind IN ('r','p','v','m','f') AND (c.relowner=p.proowner
            OR pg_catalog.has_table_privilege(p.proowner,c.oid,'INSERT,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR pg_catalog.has_any_column_privilege(p.proowner,c.oid,'INSERT,REFERENCES')
            OR (NOT EXISTS(SELECT 1 FROM relations r WHERE r.oid=c.oid)
              AND (pg_catalog.has_table_privilege(p.proowner,c.oid,'UPDATE') OR pg_catalog.has_any_column_privilege(p.proowner,c.oid,'UPDATE')))))) AS "ownerSafe",
    EXISTS (SELECT 1 FROM target p WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
      WHERE a.grantee<>p.proowner AND (a.grantee=0 OR a.is_grantable OR a.privilege_type<>'EXECUTE'))) AS "aclSafe",
    (SELECT proowner::text FROM target) AS "ownerOid",
    (SELECT oid::text FROM target) AS "functionOid") q;
  IF NOT COALESCE((final_state->>'tablesSafe'='true' AND final_state->>'absent'='false'
    AND final_state->>'definitionSafe'='true' AND final_state->>'ownerSafe'='true' AND final_state->>'aclSafe'='true'),false) OR final_state->>'ownerOid' IS DISTINCT FROM owner_oid THEN
    RAISE EXCEPTION 'Seckill time reference lock capability final verification failed';
  END IF;
END
$seckill_time_reference_lock_install$;
