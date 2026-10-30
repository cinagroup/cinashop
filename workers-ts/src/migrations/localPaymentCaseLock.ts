import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { pricingIdentifier } from './checkoutPricingLockCatalog';

type Query = Pick<DbClient, 'execute'>;
export const LOCAL_PAYMENT_CASE_LOCK_FUNCTION = 'local_payment_case_lock_v1';
export const LOCAL_PAYMENT_CASE_LOCK_SIGNATURE = 'public.local_payment_case_lock_v1(text)';
export const LOCAL_PAYMENT_CASE_LOCK_GATE = 731670;

/** No dynamic SQL or business function calls. The caller has already locked
 * its business order and the shared payment boundary. This capability grants
 * only row locks; the caller must still inspect all case/action/attempt data.
 * Three rows match the local admission overflow sentinel, not an allow limit. */
export const LOCAL_PAYMENT_CASE_LOCK_BODY = `
BEGIN
  IF $1 IS NULL OR pg_catalog.octet_length($1)<1 OR pg_catalog.octet_length($1)>64
    OR $1 ~ '[^A-Za-z0-9_-]' THEN
    RAISE EXCEPTION 'Invalid local payment case lock target' USING ERRCODE='22023';
  END IF;
  IF pg_catalog.current_setting('server_version_num')::integer/10000<>16
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR pg_catalog.current_setting('transaction_read_only')<>'off'
    OR pg_catalog.current_setting('session_replication_role')<>'origin'
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE pid=pg_catalog.pg_backend_pid()
      AND locktype='advisory' AND classid=731670 AND objid=0 AND objsubid=2 AND mode='ShareLock' AND granted)
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_settings WHERE name='statement_timeout' AND setting::bigint BETWEEN 1 AND 5000)
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_settings WHERE name='lock_timeout' AND setting::bigint BETWEEN 1 AND 2000)
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout' AND setting::bigint BETWEEN 1 AND 5000)
    OR pg_catalog.clock_timestamp()>pg_catalog.transaction_timestamp()+interval '5 seconds' THEN
    RAISE EXCEPTION 'Local payment case lock transaction is not ready' USING ERRCODE='42501';
  END IF;
  PERFORM c.id FROM public.payment_reconciliation_case AS c WHERE c.order_no=$1
    ORDER BY c.provider,c.id LIMIT 3 FOR UPDATE;
END
`;

const columns = [
  ['id','bigint',true],['replay_key','character varying(36)',true],['provider','character varying(16)',true],
  ['profile','character varying(16)',true],['order_domain','character varying(16)',true],['order_no','character varying(64)',true],
  ['expected_amount_cents','integer',true],['currency','character varying(3)',true],['status','character varying(16)',true],
  ['provider_status','character varying(16)',true],['provider_transaction_id','character varying(100)',true],
  ['provider_event_time','integer',true],['callback_event_id','bigint',false],['attempt_count','integer',true],
  ['next_check_time','integer',true],['lease_until','integer',true],['lease_token','character varying(36)',true],
  ['last_query_time','integer',true],['last_error_code','character varying(64)',true],['initiated_time','integer',true],
  ['resolved_time','integer',true],['retain_until','integer',true],['add_time','integer',true],['update_time','integer',true],
] as const;

/** Exact capability definition/owner/ACL and its fixed lock target. Business
 * constraints are not used as payment authority here. The independent ledger
 * addon and normal admission still validate their complete own catalogs/data.
 * Existing implicit PUBLIC invoker EXECUTE is tolerated, as in the manager
 * baseline. The owner cannot own another function or receive an explicit
 * other-function grant; every other executable SECURITY DEFINER is refused.
 * PostgreSQL cannot revoke PUBLIC EXECUTE from just one NOLOGIN principal. */
export function localPaymentCaseLockCatalogQuery(runtimeRole?: string) {
  if (runtimeRole !== undefined) pricingIdentifier(runtimeRole);
  return sql`WITH target AS (SELECT * FROM pg_catalog.pg_class WHERE oid=to_regclass('public.payment_reconciliation_case')),
    routines AS (SELECT * FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace AND proname=${LOCAL_PAYMENT_CASE_LOCK_FUNCTION}),
    owner AS (SELECT * FROM pg_catalog.pg_roles WHERE oid=(SELECT min(proowner) FROM routines)),
    runtime AS (SELECT * FROM pg_catalog.pg_roles WHERE rolname=${runtimeRole ?? null})
    SELECT (SELECT count(*)=0 FROM routines) AS absent,
    current_setting('server_version_num')::integer/10000=16
    AND (SELECT count(*)=1 AND bool_and(c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition
      AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity AND c.relnatts=24
      AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE oid=c.relowner AND rolsuper)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=c.oid AND attnum>0 AND (attisdropped OR attgenerated<>'' OR attidentity<>''))
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=c.oid)
      AND EXISTS(SELECT 1 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid
        WHERE i.indrelid=c.oid AND ic.relname='prc_provider_order_uq' AND ic.relowner=c.relowner AND ic.relnamespace=c.relnamespace
          AND i.indisunique AND i.indisvalid AND i.indisready AND i.indislive AND NOT i.indisexclusion
          AND i.indnkeyatts=2 AND i.indnatts=2 AND i.indkey::text='3 6' AND i.indoption::text='0 0'
          AND i.indexprs IS NULL AND i.indpred IS NULL
          AND ic.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='btree'))
      AND EXISTS(SELECT 1 FROM pg_catalog.pg_index i WHERE i.indrelid=c.oid AND i.indisprimary AND i.indisunique
        AND i.indisvalid AND i.indisready AND i.indislive AND i.indnkeyatts=1 AND i.indnatts=1
        AND i.indkey::text='1' AND i.indexprs IS NULL AND i.indpred IS NULL)) FROM target c) AS "tablesSafe",
    (SELECT jsonb_agg(jsonb_build_array(a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod),a.attnotnull) ORDER BY a.attnum)
      FROM target c JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid WHERE a.attnum>0) AS columns,
    (SELECT count(*)=1 AND bool_and(p.pronargs=1 AND p.proargtypes='25'::oidvector AND p.prokind='f'
      AND p.prorettype='pg_catalog.void'::regtype AND p.prosecdef AND NOT p.proleakproof AND NOT p.proisstrict
      AND NOT p.proretset AND p.provolatile='v' AND p.proparallel='u' AND p.prosrc=${LOCAL_PAYMENT_CASE_LOCK_BODY}
      AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[] AND p.prosupport=0
      AND p.probin IS NULL AND p.prosqlbody IS NULL AND p.procost=100 AND p.prorows=0 AND p.provariadic=0
      AND p.pronargdefaults=0 AND p.proallargtypes IS NULL AND p.proargmodes IS NULL AND p.proargnames IS NULL
      AND p.proargdefaults IS NULL AND p.protrftypes IS NULL
      AND p.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql' AND lanpltrusted)) FROM routines p) AS "definitionSafe",
    EXISTS(SELECT 1 FROM owner o WHERE NOT(o.rolcanlogin OR o.rolsuper OR o.rolcreatedb OR o.rolcreaterole
      OR o.rolinherit OR o.rolreplication OR o.rolbypassrls)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=o.oid OR roleid=o.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass
        AND refobjid=o.oid AND deptype='o' AND NOT(classid='pg_catalog.pg_proc'::regclass
          AND dbid=(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database())
          AND objid IN(SELECT oid FROM routines)))
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity WHERE usesysid=o.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_database WHERE datdba=o.oid OR has_database_privilege(o.oid,oid,'CREATE'))
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner=o.oid
        OR (nspname !~ '^pg_' AND nspname<>'information_schema' AND has_schema_privilege(o.oid,oid,'CREATE')))
      AND has_schema_privilege(o.oid,'public','USAGE')
      AND NOT has_parameter_privilege(o.oid,'session_replication_role','SET,ALTER SYSTEM')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_type WHERE typowner=o.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.proowner=o.oid AND p.oid NOT IN(SELECT oid FROM routines))
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND p.oid NOT IN(SELECT oid FROM routines)
          AND (p.prosecdef AND has_function_privilege(o.oid,p.oid,'EXECUTE') OR EXISTS(
            SELECT 1 FROM pg_catalog.aclexplode(p.proacl) a WHERE a.grantee=o.oid)))
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_default_acl d WHERE d.defaclrole=o.oid OR EXISTS(
        SELECT 1 FROM pg_catalog.aclexplode(d.defaclacl) a WHERE a.grantee=o.oid OR a.grantee=0 AND d.defaclobjtype IN('r','S')))
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
          AND (c.relowner=o.oid OR c.relkind='S' AND has_sequence_privilege(o.oid,c.oid,'USAGE,SELECT,UPDATE')
          OR c.relkind IN('r','p','v','m','f') AND (
            c.oid NOT IN(SELECT oid FROM target) AND (has_table_privilege(o.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
              OR has_any_column_privilege(o.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))
            OR c.oid IN(SELECT oid FROM target) AND (NOT has_table_privilege(o.oid,c.oid,'SELECT')
              OR has_table_privilege(o.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
              OR NOT has_column_privilege(o.oid,c.oid,'id','UPDATE')
              OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0
                AND (has_column_privilege(o.oid,c.oid,a.attnum,'INSERT,REFERENCES')
                  OR a.attname<>'id' AND has_column_privilege(o.oid,c.oid,a.attnum,'UPDATE')))
              OR EXISTS(SELECT 1 FROM pg_catalog.aclexplode(c.relacl) a WHERE a.grantee=o.oid AND a.is_grantable)
              OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute col CROSS JOIN LATERAL pg_catalog.aclexplode(col.attacl) a
                WHERE col.attrelid=c.oid AND a.grantee=o.oid AND (col.attname<>'id' OR a.privilege_type<>'UPDATE' OR a.is_grantable))))))) AS "ownerSafe",
    (SELECT count(*)=1 AND bool_and(NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
      LEFT JOIN pg_catalog.pg_roles r ON r.oid=a.grantee WHERE a.grantee<>p.proowner
        AND (a.grantee=0 OR a.is_grantable OR a.privilege_type<>'EXECUTE' OR r.oid IS NULL
          OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls
          OR NOT r.rolcanlogin OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
          OR EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o')
          OR has_database_privilege(r.oid,current_database(),'CREATE')
          OR has_parameter_privilege(r.oid,'session_replication_role','SET,ALTER SYSTEM')
          OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner=r.oid OR nspname !~ '^pg_'
            AND nspname<>'information_schema' AND has_schema_privilege(r.oid,oid,'CREATE'))))) FROM routines p) AS "aclSafe",
    (SELECT count(*)=1 AND bool_and(r.rolcanlogin AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner=r.oid OR nspname !~ '^pg_'
        AND nspname<>'information_schema' AND has_schema_privilege(r.oid,oid,'CREATE'))
      AND NOT has_database_privilege(r.oid,current_database(),'CREATE')
      AND NOT has_parameter_privilege(r.oid,'session_replication_role','SET,ALTER SYSTEM')
      AND EXISTS(SELECT 1 FROM target c WHERE has_table_privilege(r.oid,c.oid,'SELECT')
        AND NOT has_any_column_privilege(r.oid,c.oid,'UPDATE'))) FROM runtime r) AS "runtimeSafe",
    (SELECT count(*)=1 AND bool_and(has_function_privilege(r.oid,p.oid,'EXECUTE')) FROM runtime r CROSS JOIN routines p) AS executable,
    (SELECT oid::text FROM routines LIMIT 1) AS "functionOid",(SELECT oid::text FROM owner) AS "ownerOid",
    (SELECT rolname::text FROM owner) AS "ownerName",(SELECT oid::text FROM runtime) AS "runtimeOid",
    COALESCE((SELECT jsonb_agg(r.rolname::text ORDER BY r.rolname) FROM routines p
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
      JOIN pg_catalog.pg_roles r ON r.oid=a.grantee WHERE a.grantee<>p.proowner),'[]'::jsonb) AS grantees`;
}

export interface LocalPaymentCaseLockInspection {
  absent: boolean; tablesSafe: boolean; definitionSafe: boolean; ownerSafe: boolean; aclSafe: boolean;
  ready: boolean; runtimeSafe: boolean; executable: boolean; runtimeReady: boolean;
  functionOid: string | null; ownerOid: string | null; ownerName: string | null;
  runtimeRole: string | null; runtimeOid: string | null; grantees: string[];
}

export async function inspectLocalPaymentCaseLock(tx: Query, runtimeRole?: string): Promise<LocalPaymentCaseLockInspection> {
  const [row] = await tx.execute(localPaymentCaseLockCatalogQuery(runtimeRole));
  const state = { absent: row?.absent === true,
    tablesSafe: row?.tablesSafe === true && JSON.stringify(row.columns) === JSON.stringify(columns),
    definitionSafe: row?.definitionSafe === true, ownerSafe: row?.ownerSafe === true, aclSafe: row?.aclSafe === true,
    runtimeSafe: row?.runtimeSafe === true, executable: row?.executable === true,
    functionOid: typeof row?.functionOid === 'string' ? row.functionOid : null,
    ownerOid: typeof row?.ownerOid === 'string' ? row.ownerOid : null,
    ownerName: typeof row?.ownerName === 'string' ? row.ownerName : null,
    runtimeRole: runtimeRole ?? null, runtimeOid: typeof row?.runtimeOid === 'string' ? row.runtimeOid : null,
    grantees: Array.isArray(row?.grantees) && row.grantees.every((v: unknown) => typeof v === 'string') ? row.grantees as string[] : [],
  };
  const ready = !state.absent && state.tablesSafe && state.definitionSafe && state.ownerSafe && state.aclSafe;
  return { ...state, ready, runtimeReady: ready && state.runtimeSafe && state.executable };
}

/** Explicit maintenance component only. The owner/runtime roles already exist;
 * this never creates roles, repairs drift, grants runtime case UPDATE, or takes
 * witness 731669 after attempt 731670. Reentrant within the addon transaction. */
export async function installLocalPaymentCaseLock(tx: Query, raw: {
  database: string; maintenance: string; owner: string; runtimeRoles: readonly string[];
}) {
  if (Object.hasOwn(tx, '$client')) throw Error('Local case lock installation requires a caller-owned transaction');
  const { database, maintenance, owner } = raw, runtimeRoles = [...raw.runtimeRoles].sort();
  [database, maintenance, owner, ...runtimeRoles].forEach(pricingIdentifier);
  if (owner === maintenance || runtimeRoles.includes(owner) || runtimeRoles.includes(maintenance)
    || new Set(runtimeRoles).size !== runtimeRoles.length || runtimeRoles.length > 16) throw Error('Invalid explicit local case lock identities');
  await tx.execute(sql`SELECT
    set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
    set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000)::text||'ms',true),
    set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
  const [environment] = await tx.execute(sql`SELECT current_database()=${database} AND current_user=${maintenance}
    AND session_user=current_user AND current_setting('server_version_num')::integer/10000=16
    AND current_setting('transaction_isolation')='read committed' AND NOT current_setting('transaction_read_only')::boolean
    AND current_setting('session_replication_role')='origin'
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS safe,
    pg_try_advisory_xact_lock(731670,0) AS locked`);
  if (environment?.safe !== true || environment.locked !== true) throw Error('Local case lock maintenance identity/gate unavailable');
  await tx.execute(sql`LOCK TABLE ONLY public.payment_reconciliation_case IN ACCESS EXCLUSIVE MODE NOWAIT`);
  const before = await inspectLocalPaymentCaseLock(tx);
  if (!before.tablesSafe) throw Error('Local case lock target catalog drift');
  if (!before.absent) {
    if (!before.ready || before.ownerName !== owner || JSON.stringify(before.grantees) !== JSON.stringify(runtimeRoles))
      throw Error('Local case lock existing owner/catalog/ACL requires review');
    for (const runtimeRole of runtimeRoles) {
      if (!(await inspectLocalPaymentCaseLock(tx, runtimeRole)).runtimeReady)
        throw Error('Local case lock existing runtime binding requires review');
    }
    return { applied: false, ...before };
  }
  const [clean] = await tx.execute(sql`SELECT count(*)=1 AND bool_and(NOT(r.rolcanlogin OR r.rolsuper OR r.rolcreatedb
    OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity WHERE usesysid=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_database WHERE datdba=r.oid OR has_database_privilege(r.oid,oid,'CREATE'))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner=r.oid OR nspname !~ '^pg_'
      AND nspname<>'information_schema' AND has_schema_privilege(r.oid,oid,'CREATE'))
    AND NOT has_parameter_privilege(r.oid,'session_replication_role','SET,ALTER SYSTEM')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND (c.relowner=r.oid
        OR c.relkind='S' AND has_sequence_privilege(r.oid,c.oid,'USAGE,SELECT,UPDATE')
        OR c.relkind IN('r','p','v','m','f') AND (has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_type WHERE typowner=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE p.proowner=r.oid OR n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
        AND (p.prosecdef AND has_function_privilege(r.oid,p.oid,'EXECUTE') OR EXISTS(
          SELECT 1 FROM pg_catalog.aclexplode(p.proacl) a WHERE a.grantee=r.oid)))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_default_acl d WHERE d.defaclrole=r.oid OR EXISTS(
      SELECT 1 FROM pg_catalog.aclexplode(d.defaclacl) a WHERE a.grantee=r.oid OR a.grantee=0 AND d.defaclobjtype IN('r','S')))) AS safe
    FROM pg_catalog.pg_roles r WHERE rolname=${owner}`);
  if (clean?.safe !== true) throw Error('Explicit unused restricted NOLOGIN local case lock owner required');
  for (const runtimeRole of runtimeRoles) {
    const state = await inspectLocalPaymentCaseLock(tx, runtimeRole);
    if (!state.runtimeSafe) throw Error('Local case lock requires a real SELECT-only runtime principal');
  }
  const quotedOwner = pricingIdentifier(owner);
  await tx.execute(sql.raw(`GRANT USAGE,CREATE ON SCHEMA public TO ${quotedOwner};
    GRANT SELECT ON public.payment_reconciliation_case TO ${quotedOwner};
    GRANT UPDATE(id) ON public.payment_reconciliation_case TO ${quotedOwner};
    CREATE FUNCTION ${LOCAL_PAYMENT_CASE_LOCK_SIGNATURE} RETURNS void LANGUAGE plpgsql SECURITY DEFINER
      SET search_path=pg_catalog,pg_temp AS $local_payment_case_lock$${LOCAL_PAYMENT_CASE_LOCK_BODY}$local_payment_case_lock$;
    REVOKE ALL ON FUNCTION ${LOCAL_PAYMENT_CASE_LOCK_SIGNATURE} FROM PUBLIC;
    ALTER FUNCTION ${LOCAL_PAYMENT_CASE_LOCK_SIGNATURE} OWNER TO ${quotedOwner};
    REVOKE CREATE ON SCHEMA public FROM ${quotedOwner}`));
  for (const role of runtimeRoles) await tx.execute(sql.raw(`GRANT EXECUTE ON FUNCTION ${LOCAL_PAYMENT_CASE_LOCK_SIGNATURE} TO ${pricingIdentifier(role)}`));
  const after = await inspectLocalPaymentCaseLock(tx);
  if (!after.ready || after.ownerName !== owner || JSON.stringify(after.grantees) !== JSON.stringify(runtimeRoles))
    throw Error('Local case lock final owner/catalog/ACL verification failed');
  return { applied: true, ...after };
}

/** No fallback or request DDL. Only the actual SELECT-only backend is admitted.
 * Source/order/boundary locks and the full business guard belong to the caller. */
export async function lockLocalPaymentCasesTx(tx: DbClient, rawOrderNo: string): Promise<void> {
  if (Object.hasOwn(tx, '$client')) throw new ServiceUnavailableException('本地付款案件锁需要调用方事务');
  const orderNo = rawOrderNo;
  if (typeof orderNo !== 'string' || orderNo.length < 1 || orderNo.length > 64 || /[^A-Za-z0-9_-]/u.test(orderNo))
    throw new ValidateException('本地付款案件锁参数无效');
  const [identity] = await tx.execute<{ role: string; actual: boolean }>(sql`SELECT session_user AS role,
    current_user=session_user AND EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity a JOIN pg_catalog.pg_roles r ON r.oid=a.usesysid
      WHERE a.pid=pg_backend_pid() AND r.rolname=session_user) AS actual`);
  if (identity?.actual !== true || typeof identity.role !== 'string'
    || !(await inspectLocalPaymentCaseLock(tx, identity.role)).runtimeReady)
    throw new ServiceUnavailableException('本地付款案件锁权限未完整验收');
  await tx.execute(sql`SELECT public.local_payment_case_lock_v1(${orderNo})`);
}
