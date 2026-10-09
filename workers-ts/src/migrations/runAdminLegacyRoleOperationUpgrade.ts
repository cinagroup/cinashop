import { sql } from 'drizzle-orm';
import { ADMIN_LEGACY_ROLE_OPERATION_UPGRADE_SQL } from './adminLegacyRoleOperationCatalog';
import type { DbClient } from '../lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { inspectRuntimeBusinessProfileInTransaction } from './auditRuntimeBusinessPrivileges';
import { inspectAdminAuthorityMenuLock, inspectAdminAuthorityOperation } from './adminAuthorityOperation';
import type { SeckillScheduleRuntimeTarget } from './runSeckillScheduleRuntimeUpgrade';

export const ADMIN_LEGACY_ROLE_OPERATION_UPGRADE = 'admin-legacy-role-operation-v3';

/** Only two reviewed CHECK constraints change. No receipt/business-row DML,
 * grant, trigger, sequence, function or ownership change is included. */
export { ADMIN_LEGACY_ROLE_OPERATION_UPGRADE_SQL } from './adminLegacyRoleOperationCatalog';

/** Low-level installer for an already-open, explicit PG16 maintenance
 * transaction. Without supplied runtime identities it permits owner-only ACLs.
 * Runtime/startup/request handlers never call this function. */
export async function installAdminLegacyRoleOperationUpgrade(
  tx: Pick<DbClient, 'execute'>, names?: { maintenance: string; admin: string },
): Promise<{ operation: typeof ADMIN_LEGACY_ROLE_OPERATION_UPGRADE; applied: boolean }> {
  if (Object.hasOwn(tx, '$client')) throw Error('Legacy role receipt upgrade requires an existing maintenance transaction');
  if (names) [names.maintenance, names.admin].forEach(pricingIdentifier);
  const [gate] = await tx.execute(sql`SELECT current_user AS identity,
    current_user=session_user AND current_setting('server_version_num')::integer/10000=16
    AND current_setting('transaction_isolation')='read committed'
    AND NOT current_setting('transaction_read_only')::boolean
    AND current_setting('session_replication_role')='origin' AND current_schema()='public'
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D')
    AND pg_try_advisory_xact_lock(731626,8) AS supported,
    (SELECT relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)
      FROM pg_catalog.pg_class WHERE oid=to_regclass('public.admin_authority_operation')) AS owned`);
  if (gate?.supported !== true || gate.owned !== true || typeof gate.identity !== 'string'
    || names && names.maintenance !== gate.identity) {
    throw Error('Legacy role receipt upgrade requires explicit PG16 owner maintenance');
  }
  const identities = names ?? { maintenance: gate.identity, admin: gate.identity };
  await tx.execute(sql.raw('LOCK TABLE ONLY public.system_admin, ONLY public.system_role IN SHARE ROW EXCLUSIVE MODE NOWAIT'));
  await tx.execute(sql.raw('LOCK TABLE ONLY public.system_menus IN SHARE MODE NOWAIT'));
  // Fence both existing evidence and its schema before deciding which exact
  // version is present. No malformed or third-party catalog is repaired.
  await tx.execute(sql.raw('LOCK TABLE ONLY public.admin_authority_operation IN ACCESS EXCLUSIVE MODE NOWAIT'));
  if (!(await inspectAdminAuthorityMenuLock(tx, identities))) throw Error('Legacy role receipt lock catalog drift requires review');
  if (await inspectAdminAuthorityOperation(tx, identities, 'legacy-role-v3')) {
    return { operation: ADMIN_LEGACY_ROLE_OPERATION_UPGRADE, applied: false };
  }
  if (!(await inspectAdminAuthorityOperation(tx, identities, 'legacy-admin-v2'))) throw Error('Legacy role receipt catalog drift requires review');
  await tx.execute(sql.raw(ADMIN_LEGACY_ROLE_OPERATION_UPGRADE_SQL));
  if (!(await inspectAdminAuthorityOperation(tx, identities, 'legacy-role-v3'))) throw Error('Legacy role receipt upgraded catalog verification failed');
  return { operation: ADMIN_LEGACY_ROLE_OPERATION_UPGRADE, applied: true };
}

/** Full commissioning verifies exact prior profiles, then atomically installs
 * v3 and the single Admin-only system_role DELETE grant. Exact v3 repeats
 * refuse ACL drift. App grants and fixed historical plans remain unchanged. */
export async function installAdminLegacyRoleOperationUpgradeInTransaction(
  tx: Pick<DbClient, 'execute'>, target: SeckillScheduleRuntimeTarget,
) {
  if (Object.hasOwn(tx, '$client')) throw Error('Legacy role receipt upgrade requires an existing maintenance transaction');
  const identities = [target.maintenance, target.app, target.admin];
  [...identities, target.database].forEach(pricingIdentifier);
  if (new Set(identities).size !== 3) throw Error('Distinct legacy role runtime identities required');
  await tx.execute(sql`SELECT set_config('search_path','public,pg_temp',true),
    set_config('statement_timeout','5000',true),set_config('lock_timeout','1000',true),
    set_config('idle_in_transaction_session_timeout','5000',true)`);
  const [context] = await tx.execute(sql`SELECT current_database()=${target.database} AND current_user=${target.maintenance}
    AND session_user=current_user AND current_setting('server_version_num')::integer/10000=16
    AND current_setting('transaction_isolation')='read committed' AND NOT current_setting('transaction_read_only')::boolean
    AND current_setting('session_replication_role')='origin'
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS supported`);
  if (context?.supported !== true) throw Error('Legacy role receipt maintenance identity/database requires review');
  const [gate] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(731626,8) AS locked`);
  if (gate?.locked !== true) throw Error('Legacy role receipt commissioning is busy');
  await tx.execute(sql.raw('LOCK TABLE ONLY public.system_admin, ONLY public.system_role IN SHARE ROW EXCLUSIVE MODE NOWAIT'));
  await tx.execute(sql.raw('LOCK TABLE ONLY public.system_menus IN SHARE MODE NOWAIT'));
  const inspect = async () => ({
    app: await inspectRuntimeBusinessProfileInTransaction(tx, 'app', target, 'current'),
    admin: await inspectRuntimeBusinessProfileInTransaction(tx, 'admin', target, 'current'),
  });
  const before = await inspect();
  if (!before.app.ready || !before.admin.ready) throw Error('Legacy role receipt commissioning requires exact existing runtime profiles');
  const result = await installAdminLegacyRoleOperationUpgrade(tx, { maintenance: target.maintenance, admin: target.admin });
  if (result.applied) {
    await tx.execute(sql.raw('GRANT DELETE ON TABLE public.system_role TO '+pricingIdentifier(target.admin)));
  }
  const after = await inspect();
  if (!after.app.ready || !after.admin.ready) throw Error('Legacy role receipt commissioned profile verification failed');
  return result;
}

export async function runAdminLegacyRoleOperationUpgrade(db: DbClient, target: SeckillScheduleRuntimeTarget) {
  if (!Object.hasOwn(db, '$client') || !db.$client) throw Error('Legacy role receipt upgrade requires a root maintenance connection');
  return db.transaction(tx => installAdminLegacyRoleOperationUpgradeInTransaction(tx, target),
    { isolationLevel: 'read committed', accessMode: 'read write' });
}
