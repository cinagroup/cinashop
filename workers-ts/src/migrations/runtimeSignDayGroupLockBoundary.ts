import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';

type Query = Pick<DbClient, 'execute'>;
export interface SignDayGroupRuntimeNames { maintenance: string; admin: string }
export const SIGN_DAY_GROUP_LOCK_BOUNDARY = 'cinashop_runtime_sign_day_group_lock_only_v1';
function validate(names: SignDayGroupRuntimeNames) {
  [names.maintenance, names.admin].forEach(pricingIdentifier);
  if (names.maintenance === names.admin) throw Error('Distinct sign-day group runtime identities required');
}
export function runtimeSignDayGroupLockBoundaryBody(admin: string) {
  pricingIdentifier(admin);
  return `BEGIN\nIF current_user='${admin}' THEN\nIF TG_TABLE_SCHEMA<>'public' OR TG_TABLE_NAME<>'system_group' OR EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid=TG_RELID AND NOT t.tgisinternal AND (t.tgtype::integer & 16)<>0 AND (t.tgname<>'${SIGN_DAY_GROUP_LOCK_BOUNDARY}' OR t.tgfoid<>pg_catalog.to_regprocedure('public.${SIGN_DAY_GROUP_LOCK_BOUNDARY}()')::oid)) OR pg_catalog.to_jsonb(NEW) IS DISTINCT FROM pg_catalog.to_jsonb(OLD) THEN\nRAISE EXCEPTION 'Runtime sign-day group lock privilege cannot edit metadata' USING ERRCODE='42501';\nEND IF;\nEND IF;\nRETURN NEW;\nEND`;
}

/** One exact invoker function and BEFORE UPDATE trigger. Ordinary runtime
 * identities cannot edit group metadata using their FOR SHARE column grant. */
export async function inspectRuntimeSignDayGroupLockBoundary(tx: Query, names: SignDayGroupRuntimeNames) {
  validate(names);
  const definition = runtimeSignDayGroupLockBoundaryBody(names.admin);
  const [row] = await tx.execute(sql`WITH routines AS (
    SELECT * FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace AND proname=${SIGN_DAY_GROUP_LOCK_BOUNDARY}
  ), targets AS (
    SELECT * FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace AND relname='system_group'
  ), triggers AS (
    SELECT * FROM pg_catalog.pg_trigger WHERE tgname=${SIGN_DAY_GROUP_LOCK_BOUNDARY} OR tgfoid IN(SELECT oid FROM routines)
  ) SELECT NOT EXISTS(SELECT 1 FROM routines) AND NOT EXISTS(SELECT 1 FROM triggers) AS absent,
    (SELECT count(*)=1 AND bool_and(p.pronargs=0 AND p.proargtypes=''::oidvector AND p.prokind='f'
      AND p.prorettype='pg_catalog.trigger'::regtype AND p.prosrc=${definition} AND NOT p.prosecdef AND NOT p.proleakproof
      AND NOT p.proisstrict AND NOT p.proretset AND p.provolatile='v' AND p.proparallel='u'
      AND p.prosupport=0 AND p.probin IS NULL AND p.prosqlbody IS NULL AND p.procost=100 AND p.prorows=0
      AND p.provariadic=0 AND p.pronargdefaults=0 AND p.proallargtypes IS NULL AND p.proargmodes IS NULL
      AND p.proargnames IS NULL AND p.proargdefaults IS NULL AND p.protrftypes IS NULL
      AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[]
      AND p.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql' AND lanpltrusted)
      AND p.proowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${names.maintenance})
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner)) FROM routines p) AS routine_safe,
    (SELECT count(*)=1 AND bool_and(t.relkind='r' AND t.relpersistence='p' AND NOT t.relispartition
      AND NOT t.relrowsecurity AND NOT t.relforcerowsecurity
      AND t.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${names.maintenance})
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=t.oid OR inhparent=t.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=t.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger g WHERE g.tgrelid=t.oid AND NOT g.tgisinternal
        AND g.tgname<>${SIGN_DAY_GROUP_LOCK_BOUNDARY})) FROM targets t) AS tables_safe,
    (SELECT count(*)=1 AND bool_and(g.tgname=${SIGN_DAY_GROUP_LOCK_BOUNDARY} AND g.tgrelid IN(SELECT oid FROM targets)
      AND g.tgenabled='O' AND g.tgtype=19 AND NOT g.tgisinternal AND g.tgnargs=0 AND g.tgargs=''::bytea
      AND g.tgattr=''::int2vector AND g.tgqual IS NULL AND NOT g.tgdeferrable AND NOT g.tginitdeferred
      AND g.tgconstraint=0 AND g.tgparentid=0 AND g.tgoldtable IS NULL AND g.tgnewtable IS NULL
      AND g.tgfoid=(SELECT oid FROM routines LIMIT 1)) FROM triggers g) AS triggers_safe`);
  return { absent: row?.absent === true, ready: row?.routine_safe === true && row?.tables_safe === true && row?.triggers_safe === true,
    tablesSafe: row?.tables_safe === true, routineSafe: row?.routine_safe === true, triggersSafe: row?.triggers_safe === true };
}

/** Explicit maintenance protocol only. The fixed invoker guard conveys no
 * authority, grants no role, and never replaces a drifted function or trigger. */
export async function installRuntimeSignDayGroupLockBoundaryInTransaction(tx: Query, names: SignDayGroupRuntimeNames) {
  if (Object.hasOwn(tx, '$client')) throw Error('Sign-day group guard requires an existing transaction');
  validate(names);
  await tx.execute(sql`SELECT set_config('search_path','public,pg_temp',true),
    set_config('statement_timeout',least(nullif((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
    set_config('lock_timeout',least(nullif((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
    set_config('idle_in_transaction_session_timeout',least(nullif((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
  const [context] = await tx.execute(sql`SELECT current_user=${names.maintenance} AND session_user=current_user
    AND current_setting('server_version_num')::int/10000=16 AND current_setting('transaction_isolation')='read committed'
    AND NOT current_setting('transaction_read_only')::boolean AND current_setting('session_replication_role')='origin'
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity a JOIN pg_catalog.pg_roles r ON r.oid=a.usesysid
      WHERE a.pid=pg_backend_pid() AND r.rolname=current_user AND r.rolsuper)
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname=${names.admin} AND r.rolcanlogin
      AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o'))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS supported`);
  if (context?.supported !== true) throw Error('Sign-day group guard maintenance identity requires review');
  await tx.execute(sql.raw('LOCK TABLE ONLY public.system_group IN SHARE ROW EXCLUSIVE MODE'));
  const before = await inspectRuntimeSignDayGroupLockBoundary(tx, names);
  if (before.ready) return { installed: false as const };
  if (!before.absent || !before.tablesSafe) throw Error('Sign-day group lock guard requires exact absent or installed protocol');
  const definition = runtimeSignDayGroupLockBoundaryBody(names.admin);
  await tx.execute(sql.raw(`CREATE FUNCTION public.${SIGN_DAY_GROUP_LOCK_BOUNDARY}() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
    SET search_path=pg_catalog,pg_temp AS $sign_day_group_guard$${definition}$sign_day_group_guard$`));
  await tx.execute(sql.raw(`REVOKE ALL ON FUNCTION public.${SIGN_DAY_GROUP_LOCK_BOUNDARY}() FROM PUBLIC`));
  await tx.execute(sql.raw(`CREATE TRIGGER ${SIGN_DAY_GROUP_LOCK_BOUNDARY} BEFORE UPDATE ON public.system_group
    FOR EACH ROW EXECUTE FUNCTION public.${SIGN_DAY_GROUP_LOCK_BOUNDARY}()`));
  if (!(await inspectRuntimeSignDayGroupLockBoundary(tx, names)).ready) throw Error('Sign-day group lock guard installation verification failed');
  return { installed: true as const };
}
