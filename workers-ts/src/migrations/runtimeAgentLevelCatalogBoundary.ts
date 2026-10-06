import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';

type Query = Pick<DbClient, 'execute'>;
export interface AgentLevelRuntimeNames { maintenance: string; app: string; admin: string }
export const AGENT_LEVEL_CATALOG_FENCE = 'cinashop_runtime_agent_level_catalog_fence_v1';
export const AGENT_LEVEL_ROW_GUARD = 'cinashop_runtime_agent_level_row_guard_v1';
const tables = ['agent_level', 'agent_level_task', 'agent_level_task_record'] as const;
function validate(names: AgentLevelRuntimeNames) {
  const identities=[names.maintenance,names.app,names.admin];
  identities.forEach(pricingIdentifier);
  if (new Set(identities).size !== 3) throw Error('Distinct distributor runtime identities required');
}
export function runtimeAgentLevelCatalogFenceBody(names: AgentLevelRuntimeNames) {
  validate(names);
  return `BEGIN
IF current_user IN ('${names.app}','${names.admin}') THEN
IF TG_TABLE_SCHEMA<>'public' OR TG_LEVEL<>'STATEMENT' OR TG_TABLE_NAME NOT IN ('agent_level','agent_level_task','agent_level_task_record') THEN
RAISE EXCEPTION 'Invalid distributor catalog fence' USING ERRCODE='42501';
END IF;
IF TG_TABLE_NAME='agent_level_task_record' THEN
PERFORM pg_catalog.pg_advisory_xact_lock_shared(731624,0);
ELSE
PERFORM pg_catalog.pg_advisory_xact_lock(731624,0);
END IF;
END IF;
RETURN NULL;
END`;
}
export function runtimeAgentLevelRowGuardBody(names: AgentLevelRuntimeNames) {
  validate(names);
  return `BEGIN
IF current_user IN ('${names.app}','${names.admin}') THEN
IF TG_TABLE_SCHEMA<>'public' OR TG_TABLE_NAME<>'agent_level' OR TG_LEVEL<>'ROW' THEN
RAISE EXCEPTION 'Invalid distributor row guard' USING ERRCODE='42501';
END IF;
IF TG_OP='DELETE' OR (current_user='${names.app}' AND TG_OP<>'UPDATE') THEN
RAISE EXCEPTION 'Distributor catalog requires soft deletion and Admin authority' USING ERRCODE='42501';
END IF;
IF TG_OP='UPDATE' THEN
IF current_user='${names.app}' AND pg_catalog.to_jsonb(NEW) IS DISTINCT FROM pg_catalog.to_jsonb(OLD) THEN
RAISE EXCEPTION 'Application distributor privilege is lock only' USING ERRCODE='42501';
END IF;
IF (pg_catalog.to_jsonb(NEW)-ARRAY['name','image','color','one_brokerage','two_brokerage','grade','status','is_del']::text[]) IS DISTINCT FROM
(pg_catalog.to_jsonb(OLD)-ARRAY['name','image','color','one_brokerage','two_brokerage','grade','status','is_del']::text[]) THEN
RAISE EXCEPTION 'Distributor identity and creation time are immutable' USING ERRCODE='42501';
END IF;
END IF;
END IF;
IF TG_OP='DELETE' THEN RETURN OLD; END IF;
RETURN NEW;
END`;
}

/** Statement fences run before any tuple lock. Thus raw runtime writers also
 * participate without table-wide UPDATE/DELETE privileges or a table lock
 * upgrade that could deadlock with a writer waiting for the advisory fence.
 * The separate row guard narrows the Admin column grants; neither invoker
 * function conveys SQL authority. Historical completion rows remain intact. */
export async function inspectRuntimeAgentLevelCatalogBoundary(tx: Query, names: AgentLevelRuntimeNames) {
  validate(names);
  const [row] = await tx.execute(sql`WITH expected(name,body) AS (VALUES
    (${AGENT_LEVEL_CATALOG_FENCE},${runtimeAgentLevelCatalogFenceBody(names)}),
    (${AGENT_LEVEL_ROW_GUARD},${runtimeAgentLevelRowGuardBody(names)})
  ), routines AS (SELECT p.* FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace
      AND p.proname IN (${AGENT_LEVEL_CATALOG_FENCE},${AGENT_LEVEL_ROW_GUARD})),
  targets AS (SELECT * FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace
      AND relname IN ('agent_level','agent_level_task','agent_level_task_record')),
  expected_triggers(table_name,name,kind) AS (VALUES
    ('agent_level',${AGENT_LEVEL_CATALOG_FENCE},30),('agent_level_task',${AGENT_LEVEL_CATALOG_FENCE},30),
    ('agent_level_task_record',${AGENT_LEVEL_CATALOG_FENCE},30),('agent_level',${AGENT_LEVEL_ROW_GUARD},31)),
  actual_triggers AS (SELECT g.*,t.relname AS table_name FROM pg_catalog.pg_trigger g JOIN targets t ON t.oid=g.tgrelid
    WHERE g.tgname IN (${AGENT_LEVEL_CATALOG_FENCE},${AGENT_LEVEL_ROW_GUARD})
      OR g.tgfoid IN (SELECT oid FROM routines))
  SELECT NOT EXISTS(SELECT 1 FROM routines) AND NOT EXISTS(SELECT 1 FROM actual_triggers) AS absent,
    (SELECT count(*)=2 AND bool_and(p.oid IS NOT NULL AND e.name IS NOT NULL AND p.proname=e.name AND p.prosrc=e.body AND p.pronargs=0 AND p.proargtypes=''::oidvector
      AND p.prokind='f' AND p.prorettype='pg_catalog.trigger'::regtype AND NOT p.prosecdef AND NOT p.proleakproof
      AND NOT p.proisstrict AND NOT p.proretset AND p.provolatile='v' AND p.proparallel='u'
      AND p.prosupport=0 AND p.probin IS NULL AND p.prosqlbody IS NULL AND p.procost=100 AND p.prorows=0
      AND p.provariadic=0 AND p.pronargdefaults=0 AND p.proallargtypes IS NULL AND p.proargmodes IS NULL
      AND p.proargnames IS NULL AND p.proargdefaults IS NULL AND p.protrftypes IS NULL
      AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[]
      AND p.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql' AND lanpltrusted)
      AND p.proowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${names.maintenance})
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner)) FROM routines p FULL JOIN expected e ON p.proname=e.name) AS routine_safe,
    (SELECT count(*)=3 AND bool_and(t.relkind='r' AND t.relpersistence='p' AND NOT t.relispartition
      AND NOT t.relrowsecurity AND NOT t.relforcerowsecurity
      AND t.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${names.maintenance})
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=t.oid OR inhparent=t.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=t.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger g WHERE g.tgrelid=t.oid AND NOT g.tgisinternal
        AND g.tgname NOT IN (${AGENT_LEVEL_CATALOG_FENCE},${AGENT_LEVEL_ROW_GUARD})
        AND NOT(t.relname='agent_level' AND g.tgname='cinashop_runtime_lock_only_v1'
          AND g.tgfoid=pg_catalog.to_regprocedure('public.cinashop_runtime_lock_only_v1()')::oid))) FROM targets t) AS tables_safe,
    (SELECT count(*)=4 AND bool_and(g.oid IS NOT NULL AND e.name IS NOT NULL AND g.table_name=e.table_name AND g.tgname=e.name AND g.tgtype=e.kind
      AND g.tgenabled='O' AND NOT g.tgisinternal AND g.tgnargs=0 AND g.tgargs=''::bytea
      AND g.tgattr=''::int2vector AND g.tgqual IS NULL AND NOT g.tgdeferrable AND NOT g.tginitdeferred
      AND g.tgconstraint=0 AND g.tgparentid=0 AND g.tgoldtable IS NULL AND g.tgnewtable IS NULL
      AND g.tgfoid=(SELECT oid FROM routines WHERE proname=e.name))
      FROM actual_triggers g FULL JOIN expected_triggers e ON g.table_name=e.table_name AND g.tgname=e.name)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger g WHERE g.tgfoid IN(SELECT oid FROM routines)
        AND g.tgrelid NOT IN(SELECT oid FROM targets)) AS triggers_safe`);
  return { absent: row?.absent===true, ready: row?.routine_safe===true && row?.tables_safe===true && row?.triggers_safe===true,
    tablesSafe: row?.tables_safe===true, routineSafe: row?.routine_safe===true, triggersSafe: row?.triggers_safe===true };
}
export async function installRuntimeAgentLevelCatalogBoundaryInTransaction(tx: Query, names: AgentLevelRuntimeNames) {
  if (Object.hasOwn(tx,'$client')) throw Error('Distributor guard requires an existing transaction');
  validate(names);
  await tx.execute(sql`SELECT set_config('search_path','public,pg_temp',true),
    set_config('statement_timeout',least(nullif((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
    set_config('lock_timeout',least(nullif((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
    set_config('idle_in_transaction_session_timeout',least(nullif((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
  const [context]=await tx.execute(sql`SELECT current_user=${names.maintenance} AND session_user=current_user
    AND current_setting('server_version_num')::int/10000=16 AND current_setting('transaction_isolation')='read committed'
    AND NOT current_setting('transaction_read_only')::boolean AND current_setting('session_replication_role')='origin'
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper)
    AND (SELECT count(*)=2 AND bool_and(r.rolcanlogin AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole
      OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o'))
      FROM pg_catalog.pg_roles r WHERE r.rolname IN (${names.app},${names.admin}))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS supported`);
  if(context?.supported!==true) throw Error('Distributor guard maintenance identity requires review');
  await tx.execute(sql`SELECT pg_advisory_xact_lock(731624,0)`);
  await tx.execute(sql.raw('LOCK TABLE '+tables.map(t=>'ONLY public.'+pricingIdentifier(t)).join(',')+' IN ACCESS EXCLUSIVE MODE NOWAIT'));
  const before=await inspectRuntimeAgentLevelCatalogBoundary(tx,names);
  if(before.ready) return {installed:false as const};
  if(!before.absent || !before.tablesSafe) throw Error('Distributor guard requires exact absent or installed protocol');
  for(const [name,body] of [[AGENT_LEVEL_CATALOG_FENCE,runtimeAgentLevelCatalogFenceBody(names)],
    [AGENT_LEVEL_ROW_GUARD,runtimeAgentLevelRowGuardBody(names)]]) {
    await tx.execute(sql.raw(`CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
      SET search_path=pg_catalog,pg_temp AS $agent_guard$${body}$agent_guard$`));
    await tx.execute(sql.raw(`REVOKE ALL ON FUNCTION public.${name}() FROM PUBLIC`));
  }
  for(const table of tables) await tx.execute(sql.raw(`CREATE TRIGGER ${AGENT_LEVEL_CATALOG_FENCE}
    BEFORE INSERT OR UPDATE OR DELETE ON public.${table} FOR EACH STATEMENT EXECUTE FUNCTION public.${AGENT_LEVEL_CATALOG_FENCE}()`));
  await tx.execute(sql.raw(`CREATE TRIGGER ${AGENT_LEVEL_ROW_GUARD} BEFORE INSERT OR UPDATE OR DELETE ON public.agent_level
    FOR EACH ROW EXECUTE FUNCTION public.${AGENT_LEVEL_ROW_GUARD}()`));
  if(!(await inspectRuntimeAgentLevelCatalogBoundary(tx,names)).ready) throw Error('Distributor guard installation verification failed');
  return {installed:true as const};
}
