import { sql, type SQL } from 'drizzle-orm';
import { pricingIdentifier } from './checkoutPricingLockCatalog';

export const SECKILL_TIME_REFERENCE_LOCK_FUNCTION = 'admin_lock_seckill_time_references_v1';
export const SECKILL_TIME_REFERENCE_LOCK_MAINTENANCE_KEY = 731644;
export const SECKILL_TIME_REFERENCE_OWNER_SETTING = 'cinashop.seckill_time_reference_owner';
const FUNCTION = SECKILL_TIME_REFERENCE_LOCK_FUNCTION;
export function seckillTimeReferenceLockBody(schema: string) {
  const namespace = pricingIdentifier(schema);
  return `
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Seckill time reference lock requires READ COMMITTED' USING ERRCODE='25000';
  END IF;
  PERFORM pg_catalog.set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
    pg_catalog.set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),2000)::text||'ms',true),
    pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true);
  LOCK TABLE ${namespace}.store_activity, ${namespace}.store_seckill IN EXCLUSIVE MODE;
END
`;
}

/** Shared by read-only runtime verification and the static SQL installer. */
export function seckillTimeReferenceLockCatalogQuery(schema: string) {
  pricingIdentifier(schema);
  return sql`WITH namespace AS (
    SELECT * FROM pg_catalog.pg_namespace WHERE nspname=${schema}
  ), relations AS (
    SELECT c.* FROM pg_catalog.pg_class c JOIN namespace n ON n.oid=c.relnamespace
    WHERE c.relname IN ('store_activity','store_seckill')
  ), routines AS (
    SELECT p.* FROM pg_catalog.pg_proc p JOIN namespace n ON n.oid=p.pronamespace WHERE p.proname=${FUNCTION}
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
      AND p.prosrc=${seckillTimeReferenceLockBody(schema)} AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[]
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
    (SELECT oid::text FROM target) AS "functionOid"`;
}

export function seckillTimeReferenceLockOwnerQuery(role: string | SQL, schema: string) {
  pricingIdentifier(schema);
  return sql`SELECT oid::text AS oid FROM pg_catalog.pg_roles r
    WHERE rolname=${role} AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
      AND NOT rolreplication AND NOT rolbypassrls
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity WHERE usesysid=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_database WHERE datdba=r.oid)
      AND NOT pg_catalog.has_schema_privilege(r.oid,${schema},'CREATE')
      AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET')
      AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','ALTER SYSTEM')`;
}

export function seckillTimeReferenceLockCatalogReady(state: { tablesSafe: boolean; absent: boolean; definitionSafe: boolean; ownerSafe: boolean; aclSafe: boolean }) {
  return state.tablesSafe && !state.absent && state.definitionSafe && state.ownerSafe && state.aclSafe;
}
