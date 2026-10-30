import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { inspectRuntimeBusinessProfileInTransaction } from './auditRuntimeBusinessPrivileges';
import { ADMIN_PARAMETER_OPERATION_SQL, inspectAdminParameterOperation } from './adminParameterOperation';
import type { SeckillScheduleRuntimeTarget } from './runSeckillScheduleRuntimeUpgrade';

export const ADMIN_PARAMETER_UPGRADE = 'admin-parameter-operation-v1';

/** Explicit maintenance only. Exact existing current runtime profiles precede
 * installation; the immutable receipt catalog and SELECT/INSERT-only Admin grants commit
 * together. No business rows, receipts, objects, credentials or old stages are
 * rewritten. Neither an HTTP request nor startup imports/calls this installer. */
export async function installAdminParameterUpgradeInTransaction(tx: Pick<DbClient,'execute'>, target: SeckillScheduleRuntimeTarget) {
  if (Object.hasOwn(tx,'$client')) throw Error('Parameter operation upgrade requires an existing maintenance transaction');
  const identities = [target.maintenance,target.app,target.admin];
  [...identities,target.database].forEach(pricingIdentifier);
  if (new Set(identities).size !== 3) throw Error('Distinct Parameter operation maintenance/runtime identities required');
  await tx.execute(sql`SELECT set_config('search_path','public,pg_temp',true),set_config('statement_timeout','5000',true),
    set_config('lock_timeout','1000',true),set_config('idle_in_transaction_session_timeout','5000',true)`);
  const [context] = await tx.execute(sql`SELECT current_database()=${target.database} AND current_user=${target.maintenance}
    AND current_user=session_user AND current_schema()='public' AND current_setting('server_version_num')::integer/10000=16
    AND current_setting('transaction_isolation')='read committed' AND NOT current_setting('transaction_read_only')::boolean
    AND current_setting('session_replication_role')='origin'
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS supported,
    to_regclass('public.admin_parameter_operation') IS NOT NULL AS operation_present,
    EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace AND proname='admin_parameter_operation_immutable_v1') AS function_present`);
  if (context?.supported !== true) throw Error('Parameter operation upgrade requires explicit PG16 owner/database maintenance');
  const [gate] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(731652,0) AS locked`);
  if (gate?.locked !== true) throw Error('Parameter operation commissioning is busy');
  await tx.execute(sql.raw('LOCK TABLE ONLY public.system_admin, ONLY public.system_role IN SHARE ROW EXCLUSIVE MODE NOWAIT'));
  const present = context.operation_present || context.function_present;
  if (present && !(context.operation_present && context.function_present)) throw Error('Partial Parameter operation catalog requires review');
  if (present) await tx.execute(sql.raw('LOCK TABLE ONLY public.admin_parameter_operation IN ACCESS EXCLUSIVE MODE NOWAIT'));
  const inspect = async () => ({
    app: await inspectRuntimeBusinessProfileInTransaction(tx,'app',target,'current'),
    admin: await inspectRuntimeBusinessProfileInTransaction(tx,'admin',target,'current'),
  });
  const before = await inspect();
  if (!before.app.ready || !before.admin.ready) throw Error('Parameter operation commissioning requires exact existing runtime profiles');
  if (present) {
    if (!await inspectAdminParameterOperation(tx,target)) throw Error('Existing Parameter operation catalog/owner/ACL drift requires review');
    return { operation: ADMIN_PARAMETER_UPGRADE, applied: false as const };
  }
  await tx.execute(sql.raw(ADMIN_PARAMETER_OPERATION_SQL));
  // Reject unexpected default grants instead of repairing somebody else's ACL.
  if (!await inspectAdminParameterOperation(tx)) throw Error('Parameter operation initial owner-only catalog verification failed');
  await tx.execute(sql.raw(`GRANT SELECT, INSERT ON TABLE public.admin_parameter_operation TO ${pricingIdentifier(target.admin)}`));
  if (!await inspectAdminParameterOperation(tx,target)) throw Error('Parameter operation installed catalog/ACL verification failed');
  const after = await inspect();
  if (!after.app.ready || !after.admin.ready) throw Error('Parameter operation commissioned runtime profiles failed verification');
  return { operation: ADMIN_PARAMETER_UPGRADE, applied: true as const };
}

export async function runAdminParameterUpgrade(db: DbClient, target: SeckillScheduleRuntimeTarget) {
  if (!Object.hasOwn(db,'$client') || !db.$client) throw Error('Parameter operation upgrade requires a root maintenance connection');
  return db.transaction(tx => installAdminParameterUpgradeInTransaction(tx,target), { isolationLevel: 'read committed', accessMode: 'read write' });
}
