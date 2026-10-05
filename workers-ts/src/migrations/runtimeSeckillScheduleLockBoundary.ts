import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';

type Query = Pick<DbClient, 'execute'>;
export const SECKILL_SCHEDULE_LOCK_TABLES = ['store_activity', 'store_seckill_time'] as const;
export const SECKILL_SCHEDULE_LOCK_BOUNDARY = 'cinashop_runtime_seckill_schedule_lock_only_v1';
export interface SeckillScheduleRuntimeNames { app: string; admin: string; maintenance: string }

function validate(names: SeckillScheduleRuntimeNames) {
  const identities=[names.app,names.admin,names.maintenance];
  identities.forEach(pricingIdentifier);
  if (new Set(identities).size !== 3) throw Error('Distinct schedule runtime identities required');
}
function body(names: SeckillScheduleRuntimeNames) {
  validate(names);
  // UPDATE(id) is necessary for SELECT FOR SHARE. It must not permit changing
  // even that identity. This invoker trigger does not grant authority and does
  // not restrict the independently authenticated Admin or maintenance role.
  return `BEGIN\nIF current_user='${names.app}' THEN\nIF TG_TABLE_SCHEMA<>'public' OR TG_TABLE_NAME NOT IN ('store_activity','store_seckill_time') OR EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid=TG_RELID AND NOT t.tgisinternal AND (t.tgtype::integer & 16)<>0 AND (t.tgname<>'${SECKILL_SCHEDULE_LOCK_BOUNDARY}' OR t.tgfoid<>pg_catalog.to_regprocedure('public.${SECKILL_SCHEDULE_LOCK_BOUNDARY}()')::oid)) THEN\nRAISE EXCEPTION 'Runtime schedule lock boundary requires reviewed update triggers' USING ERRCODE='42501';\nEND IF;\nIF pg_catalog.to_jsonb(NEW) IS DISTINCT FROM pg_catalog.to_jsonb(OLD) THEN\nRAISE EXCEPTION 'Runtime schedule lock privilege cannot edit catalog rows' USING ERRCODE='42501';\nEND IF;\nEND IF;\nRETURN NEW;\nEND`;
}

/** Exact independent protocol: do not append these tables to the installed
 * cinashop_runtime_lock_only_v1 definition. No catalog repair or ACL writes. */
export async function inspectRuntimeSeckillScheduleLockBoundary(tx: Query, names: SeckillScheduleRuntimeNames) {
  const definition = body(names);
  const [r] = await tx.execute(sql`WITH routines AS (
    SELECT p.* FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=${SECKILL_SCHEDULE_LOCK_BOUNDARY}
  ), targets AS (
    SELECT c.* FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace
      AND c.relname IN (${sql.join(SECKILL_SCHEDULE_LOCK_TABLES.map(t=>sql`${t}`),sql`, `)})
  ), triggers AS (
    SELECT t.* FROM pg_catalog.pg_trigger t WHERE t.tgname=${SECKILL_SCHEDULE_LOCK_BOUNDARY}
      OR t.tgfoid IN (SELECT oid FROM routines)
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
    (SELECT count(*)=2 AND bool_and(c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition
      AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
      AND c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${names.maintenance})
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal
        AND (t.tgtype::integer & 16)<>0 AND t.tgname<>${SECKILL_SCHEDULE_LOCK_BOUNDARY})
      AND EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attname='id'
        AND a.attnum>0 AND NOT a.attisdropped AND a.atttypid='pg_catalog.int4'::regtype
        AND a.attnotnull AND a.attgenerated='')) FROM targets c) AS tables_safe,
    (SELECT count(*)=2 AND bool_and(t.tgname=${SECKILL_SCHEDULE_LOCK_BOUNDARY} AND t.tgrelid IN (SELECT oid FROM targets)
      AND t.tgenabled='O' AND t.tgtype=19 AND NOT t.tgisinternal
      AND t.tgnargs=0 AND t.tgargs=''::bytea AND t.tgattr=''::int2vector AND t.tgqual IS NULL
      AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND t.tgconstraint=0 AND t.tgparentid=0
      AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
      AND t.tgfoid=(SELECT oid FROM routines LIMIT 1)) FROM triggers t) AS triggers_safe`);
  return { absent:r?.absent===true, ready:r?.routine_safe===true && r?.tables_safe===true && r?.triggers_safe===true,
    tablesSafe:r?.tables_safe===true, routineSafe:r?.routine_safe===true, triggersSafe:r?.triggers_safe===true };
}

/** Maintenance transaction only, fixed parent then slot order, fail-fast on
 * contention. Stricter caller deadlines are retained; no role or data changes. */
export async function lockRuntimeSeckillScheduleBoundary(tx: Query, names: SeckillScheduleRuntimeNames) {
  if (Object.hasOwn(tx,'$client')) throw Error('Schedule boundary requires an existing transaction');
  validate(names);
  await tx.execute(sql`SELECT
    set_config('statement_timeout',least(nullif((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
    set_config('lock_timeout',least(nullif((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
    set_config('idle_in_transaction_session_timeout',least(nullif((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
  const [gate] = await tx.execute(sql`SELECT current_user=${names.maintenance} AND session_user=current_user
    AND current_setting('server_version_num')::int/10000=16 AND current_setting('transaction_isolation')='read committed'
    AND NOT current_setting('transaction_read_only')::boolean AND current_setting('session_replication_role')='origin'
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity a JOIN pg_catalog.pg_roles r ON r.oid=a.usesysid
      WHERE a.pid=pg_backend_pid() AND r.rolname=current_user AND r.rolsuper)
    AND (SELECT count(*)=2 AND bool_and(r.rolcanlogin
      AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid))
      FROM pg_catalog.pg_roles r WHERE r.rolname IN (${names.app},${names.admin}) AND r.rolname<>current_user)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS supported`);
  if (gate?.supported!==true) throw Error('Schedule boundary maintenance identity requires review');
  await tx.execute(sql.raw('LOCK TABLE public.store_activity, public.store_seckill_time IN ACCESS EXCLUSIVE MODE NOWAIT'));
}

/** Install once or accept the exact existing protocol. Never replace a drifted
 * function, rewrite a trigger, grant privileges or replay whole-shop grants. */
export async function installRuntimeSeckillScheduleLockBoundaryInTransaction(tx: Query, names: SeckillScheduleRuntimeNames) {
  await lockRuntimeSeckillScheduleBoundary(tx,names);
  const before=await inspectRuntimeSeckillScheduleLockBoundary(tx,names);
  if (before.ready) return {applied:false,...before};
  if (!before.absent || !before.tablesSafe) throw Error('Schedule boundary catalog drift');
  await tx.execute(sql.raw(`CREATE FUNCTION public.${SECKILL_SCHEDULE_LOCK_BOUNDARY}() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
    SET search_path=pg_catalog,pg_temp AS $schedule_boundary$${body(names)}$schedule_boundary$`));
  await tx.execute(sql.raw(`REVOKE ALL ON FUNCTION public.${SECKILL_SCHEDULE_LOCK_BOUNDARY}() FROM PUBLIC`));
  for (const table of SECKILL_SCHEDULE_LOCK_TABLES)
    await tx.execute(sql.raw(`CREATE TRIGGER ${SECKILL_SCHEDULE_LOCK_BOUNDARY} BEFORE UPDATE ON public.${table}
      FOR EACH ROW EXECUTE FUNCTION public.${SECKILL_SCHEDULE_LOCK_BOUNDARY}()`));
  const after=await inspectRuntimeSeckillScheduleLockBoundary(tx,names);
  if (!after.ready) throw Error('Schedule boundary verification failed');
  return {applied:true,...after};
}
