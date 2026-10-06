import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { inspectRuntimeBusinessProfileInTransaction } from './auditRuntimeBusinessPrivileges';
import { inspectSignDayConfigRuntimeCatalog } from './signDayConfigRuntimeCatalog';
import { installRuntimeSignDayGroupLockBoundaryInTransaction } from './runtimeSignDayGroupLockBoundary';
import type { SeckillScheduleRuntimeTarget } from './runSeckillScheduleRuntimeUpgrade';

export const SIGN_DAY_CONFIG_RUNTIME_UPGRADE = 'sign-day-config-admin-runtime-v1';

/** Explicit maintenance forward from the exact frozen gift-era profile. Only
 * the exact invoker guard and fixed ACL delta; no business tables, rows, roles,
 * credentials, default grants, revocations or drift repairs. */
export async function installSignDayConfigRuntimeUpgradeInTransaction(
  tx: Pick<DbClient, 'execute'>, target: SeckillScheduleRuntimeTarget,
) {
  if (Object.hasOwn(tx, '$client')) throw Error('Sign-day runtime upgrade requires an existing transaction');
  const identities = [target.maintenance, target.app, target.admin];
  [...identities, target.database].forEach(pricingIdentifier);
  if (new Set(identities).size !== 3) throw Error('Distinct sign-day runtime identities required');
  const [database] = await tx.execute(sql`SELECT current_database()=${target.database} AS same`);
  if (database?.same !== true) throw Error('Sign-day runtime database requires review');
  await tx.execute(sql`SELECT set_config('search_path','public,pg_temp',true),
    set_config('statement_timeout',least(nullif((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
    set_config('lock_timeout',least(nullif((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
    set_config('idle_in_transaction_session_timeout',least(nullif((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
  const [context] = await tx.execute(sql`SELECT current_user=${target.maintenance} AND session_user=current_user
    AND current_setting('server_version_num')::int/10000=16 AND current_setting('transaction_isolation')='read committed'
    AND NOT current_setting('transaction_read_only')::boolean AND current_setting('session_replication_role')='origin'
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity a JOIN pg_catalog.pg_roles r ON r.oid=a.usesysid
      WHERE a.pid=pg_backend_pid() AND r.rolname=current_user AND r.rolsuper)
    AND (SELECT count(*)=2 AND bool_and(r.rolcanlogin
      AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid))
      FROM pg_catalog.pg_roles r WHERE r.rolname IN (${target.app},${target.admin}) AND r.rolname<>current_user)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS supported`);
  if (context?.supported !== true) throw Error('Sign-day runtime maintenance identity requires review');
  const [gate] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(731626,6) AS locked`);
  if (gate?.locked !== true) throw Error('Sign-day runtime upgrade is busy');
  if (!(await inspectSignDayConfigRuntimeCatalog(tx, target.maintenance,target)).ready) throw Error('Sign-day runtime exact catalog required');
  await tx.execute(sql.raw('LOCK TABLE ONLY public.system_group, ONLY public.system_group_data IN SHARE ROW EXCLUSIVE MODE'));
  // A DDL owner may have acquired its lock before this transaction arrived.
  if (!(await inspectSignDayConfigRuntimeCatalog(tx, target.maintenance,target)).ready) throw Error('Sign-day runtime exact catalog required');
  const inspect = async (version: 'pre-sign-day' | 'pre-agent-levels' | 'current') => ({
    app: await inspectRuntimeBusinessProfileInTransaction(tx, 'app', target, version),
    admin: await inspectRuntimeBusinessProfileInTransaction(tx, 'admin', target, version),
  });
  const current = await inspect('current');
  if (current.app.ready && current.admin.ready)
    return { operation: SIGN_DAY_CONFIG_RUNTIME_UPGRADE, applied: false as const, profileStage: 'current' as const };
  const installed = await inspect('pre-agent-levels');
  if (installed.app.ready && installed.admin.ready)
    return { operation: SIGN_DAY_CONFIG_RUNTIME_UPGRADE, applied: false as const, profileStage: 'pre-agent-levels' as const };
  const previous = await inspect('pre-sign-day');
  if (!previous.app.ready || !previous.admin.ready) throw Error('Sign-day runtime exact pre-sign-day profile required');
  await installRuntimeSignDayGroupLockBoundaryInTransaction(tx,target);
  const admin = pricingIdentifier(target.admin);
  await tx.execute(sql.raw(`GRANT INSERT ON TABLE public.system_group TO ${admin}`));
  await tx.execute(sql.raw(`GRANT UPDATE(id) ON TABLE public.system_group TO ${admin}`));
  await tx.execute(sql.raw(`GRANT INSERT,DELETE ON TABLE public.system_group_data TO ${admin}`));
  await tx.execute(sql.raw(`GRANT UPDATE(value,sort,status) ON TABLE public.system_group_data TO ${admin}`));
  await tx.execute(sql.raw(`GRANT USAGE ON SEQUENCE public.system_group_id_seq,public.system_group_data_id_seq TO ${admin}`));
  const after = await inspect('pre-agent-levels');
  if (!after.app.ready || !after.admin.ready) throw Error('Sign-day runtime final profile verification failed');
  return { operation: SIGN_DAY_CONFIG_RUNTIME_UPGRADE, applied: true as const, profileStage: 'pre-agent-levels' as const };
}

export async function runSignDayConfigRuntimeUpgrade(db: DbClient, target: SeckillScheduleRuntimeTarget) {
  if (!Object.hasOwn(db, '$client') || !db.$client) throw Error('Sign-day runtime upgrade requires a root maintenance connection');
  return db.transaction(tx => installSignDayConfigRuntimeUpgradeInTransaction(tx, target),
    { isolationLevel: 'read committed', accessMode: 'read write' });
}
