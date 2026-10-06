import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { inspectRuntimeBusinessProfileInTransaction } from './auditRuntimeBusinessPrivileges';
import { inspectAgentLevelRuntimeCatalog } from './agentLevelRuntimeCatalog';
import { installRuntimeAgentLevelCatalogBoundaryInTransaction } from './runtimeAgentLevelCatalogBoundary';
import { upgradeAgentLevelLockBoundaryInTransaction } from './runtimeLockOnlyBoundary';
import type { SeckillScheduleRuntimeTarget } from './runSeckillScheduleRuntimeUpgrade';

export const AGENT_LEVEL_RUNTIME_UPGRADE='agent-level-admin-runtime-v1';
/** Exact frozen sign-day profile -> current. Fixed invoker guards and narrow
 * Admin column/INSERT grants only. No business-row change, physical DELETE,
 * new unique constraints, role/credential change or repair of catalog drift. */
export async function installAgentLevelRuntimeUpgradeInTransaction(
  tx: Pick<DbClient,'execute'>,target:SeckillScheduleRuntimeTarget,
) {
  if(Object.hasOwn(tx,'$client'))throw Error('Distributor runtime upgrade requires an existing transaction');
  const identities=[target.maintenance,target.app,target.admin];
  [...identities,target.database].forEach(pricingIdentifier);
  if(new Set(identities).size!==3)throw Error('Distinct distributor runtime identities required');
  await tx.execute(sql`SELECT set_config('search_path','public,pg_temp',true),
    set_config('statement_timeout',least(nullif((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
    set_config('lock_timeout',least(nullif((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
    set_config('idle_in_transaction_session_timeout',least(nullif((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
  const [context]=await tx.execute(sql`SELECT current_database()=${target.database} AND current_user=${target.maintenance}
    AND session_user=current_user AND current_setting('server_version_num')::int/10000=16
    AND current_setting('transaction_isolation')='read committed' AND NOT current_setting('transaction_read_only')::boolean
    AND current_setting('session_replication_role')='origin'
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper)
    AND (SELECT count(*)=2 AND bool_and(r.rolcanlogin AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole
      OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o'))
      FROM pg_catalog.pg_roles r WHERE r.rolname IN (${target.app},${target.admin}))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS supported`);
  if(context?.supported!==true)throw Error('Distributor runtime maintenance identity/database requires review');
  const [gate]=await tx.execute(sql`SELECT pg_try_advisory_xact_lock(731626,7) AS locked`);
  if(gate?.locked!==true)throw Error('Distributor runtime upgrade is busy');
  if(!(await inspectAgentLevelRuntimeCatalog(tx,target.maintenance,target)).ready)throw Error('Distributor runtime exact catalog required');
  await tx.execute(sql`SELECT pg_advisory_xact_lock(731624,0)`);
  await tx.execute(sql.raw('LOCK TABLE ONLY public.agent_level, ONLY public.agent_level_task, ONLY public.agent_level_task_record IN ACCESS EXCLUSIVE MODE NOWAIT'));
  if(!(await inspectAgentLevelRuntimeCatalog(tx,target.maintenance,target)).ready)throw Error('Distributor runtime exact catalog required');
  const inspect=async(version:'pre-agent-levels'|'current')=>({
    app:await inspectRuntimeBusinessProfileInTransaction(tx,'app',target,version),
    admin:await inspectRuntimeBusinessProfileInTransaction(tx,'admin',target,version),
  });
  const current=await inspect('current');
  if(current.app.ready && current.admin.ready)return {operation:AGENT_LEVEL_RUNTIME_UPGRADE,applied:false as const,profileStage:'current' as const};
  const previous=await inspect('pre-agent-levels');
  if(!previous.app.ready || !previous.admin.ready)throw Error('Distributor runtime exact pre-agent-levels profile required');
  await upgradeAgentLevelLockBoundaryInTransaction(tx,target.app,target.admin,target.maintenance);
  await installRuntimeAgentLevelCatalogBoundaryInTransaction(tx,target);
  const admin=pricingIdentifier(target.admin);
  await tx.execute(sql.raw(`GRANT INSERT ON TABLE public.agent_level TO ${admin}`));
  await tx.execute(sql.raw(`GRANT UPDATE(id,name,image,color,one_brokerage,two_brokerage,grade,status,is_del) ON TABLE public.agent_level TO ${admin}`));
  await tx.execute(sql.raw(`GRANT USAGE ON SEQUENCE public.agent_level_id_seq TO ${admin}`));
  const after=await inspect('current');
  if(!after.app.ready || !after.admin.ready)throw Error('Distributor runtime final profile verification failed');
  return {operation:AGENT_LEVEL_RUNTIME_UPGRADE,applied:true as const,profileStage:'current' as const};
}
export async function runAgentLevelRuntimeUpgrade(db:DbClient,target:SeckillScheduleRuntimeTarget) {
  if(!Object.hasOwn(db,'$client') || !db.$client)throw Error('Distributor runtime upgrade requires a root maintenance connection');
  return db.transaction(tx=>installAgentLevelRuntimeUpgradeInTransaction(tx,target),{isolationLevel:'read committed',accessMode:'read write'});
}
