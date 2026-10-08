import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { inspectRuntimeBusinessProfileInTransaction } from './auditRuntimeBusinessPrivileges';
import { installAdminAuthorityOperation } from './adminAuthorityOperation';
import type { SeckillScheduleRuntimeTarget } from './runSeckillScheduleRuntimeUpgrade';

export const ADMIN_AUTHORITY_OPERATION_UPGRADE='admin-authority-operation-v1';
/** Explicit maintenance only. Exact previously commissioned whole-shop
 * profiles are prerequisites. The receipt and Admin-only append grant commit
 * together; existing catalog/ACL drift is rejected rather than repaired. */
export async function installAdminAuthorityOperationUpgradeInTransaction(
  tx: Pick<DbClient,'execute'>,target: SeckillScheduleRuntimeTarget,
) {
  if (Object.hasOwn(tx,'$client')) throw Error('Authority receipt upgrade requires an existing maintenance transaction');
  const identities=[target.maintenance,target.app,target.admin];
  [...identities,target.database].forEach(pricingIdentifier);
  if (new Set(identities).size!==3) throw Error('Distinct authority runtime identities required');
  await tx.execute(sql`SELECT set_config('search_path','public,pg_temp',true),
    set_config('statement_timeout','5000',true),set_config('lock_timeout','1000',true),
    set_config('idle_in_transaction_session_timeout','5000',true)`);
  const [context]=await tx.execute(sql`SELECT current_database()=${target.database} AND current_user=${target.maintenance}
    AND session_user=current_user AND current_setting('server_version_num')::integer/10000=16
    AND current_setting('transaction_isolation')='read committed' AND NOT current_setting('transaction_read_only')::boolean
    AND current_setting('session_replication_role')='origin'
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS supported,
    to_regclass('public.admin_authority_operation') IS NOT NULL AS present`);
  if (context?.supported!==true) throw Error('Authority receipt maintenance identity/database requires review');
  const [gate]=await tx.execute(sql`SELECT pg_try_advisory_xact_lock(731626,8) AS locked`);
  if (gate?.locked!==true) throw Error('Authority receipt commissioning is busy');
  // Also fences the staff state while the independent profile addon changes.
  await tx.execute(sql.raw('LOCK TABLE ONLY public.system_admin, ONLY public.system_role IN SHARE ROW EXCLUSIVE MODE NOWAIT'));
  await tx.execute(sql.raw('LOCK TABLE ONLY public.system_menus IN SHARE MODE NOWAIT'));
  const inspect=async()=>({
    app:await inspectRuntimeBusinessProfileInTransaction(tx,'app',target,'current'),
    admin:await inspectRuntimeBusinessProfileInTransaction(tx,'admin',target,'current'),
  });
  const before=await inspect();
  if (!before.app.ready || !before.admin.ready) throw Error('Authority receipt commissioning requires exact existing runtime profiles');
  if (context.present===true) {
    await installAdminAuthorityOperation(tx);
    return { operation:ADMIN_AUTHORITY_OPERATION_UPGRADE,applied:false as const };
  }
  await installAdminAuthorityOperation(tx);
  await tx.execute(sql.raw(`GRANT SELECT, INSERT ON TABLE public.admin_authority_operation TO ${pricingIdentifier(target.admin)}`));
  await tx.execute(sql.raw(`GRANT EXECUTE ON FUNCTION public.admin_authority_menu_lock_v1() TO ${pricingIdentifier(target.admin)}`));
  const after=await inspect();
  if (!after.app.ready || !after.admin.ready) throw Error('Authority receipt commissioned profile verification failed');
  return { operation:ADMIN_AUTHORITY_OPERATION_UPGRADE,applied:true as const };
}

export async function runAdminAuthorityOperationUpgrade(db: DbClient,target: SeckillScheduleRuntimeTarget) {
  if (!Object.hasOwn(db,'$client') || !db.$client) throw Error('Authority receipt upgrade requires a root maintenance connection');
  return db.transaction(tx=>installAdminAuthorityOperationUpgradeInTransaction(tx,target),{isolationLevel:'read committed',accessMode:'read write'});
}
