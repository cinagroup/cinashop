import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { inspectRuntimeBusinessProfileInTransaction } from './auditRuntimeBusinessPrivileges';
import { installAdminPlatformMenuWriteCapabilityInTransaction, type AdminPlatformMenuWriteTarget } from './adminPlatformMenuWriteCapability';

export const ADMIN_PLATFORM_MENU_WRITE_UPGRADE = 'admin-platform-menu-write-v1';

/** Explicit commissioning, never a request/startup hook. Inspect exact current
 * profiles before and after; rollback the addon if either verification fails. */
export async function installAdminPlatformMenuWriteUpgradeInTransaction(tx: Pick<DbClient, 'execute'>, target: AdminPlatformMenuWriteTarget) {
  if (Object.hasOwn(tx, '$client')) throw Error('Platform menu upgrade requires an existing transaction');
  await tx.execute(sql`SELECT set_config('search_path','public,pg_temp',true),set_config('statement_timeout','5000',true),
    set_config('lock_timeout','1000',true),set_config('idle_in_transaction_session_timeout','5000',true)`);
  const inspect = async () => ({
    app: await inspectRuntimeBusinessProfileInTransaction(tx, 'app', target, 'current'),
    admin: await inspectRuntimeBusinessProfileInTransaction(tx, 'admin', target, 'current'),
  });
  const before = await inspect();
  if (!before.app.ready || !before.admin.ready) throw Error('Platform menu commissioning requires exact existing runtime profiles');
  const result = await installAdminPlatformMenuWriteCapabilityInTransaction(tx, target);
  const after = await inspect();
  if (!after.app.ready || !after.admin.ready) throw Error('Platform menu commissioned runtime profiles failed verification');
  return { operation: ADMIN_PLATFORM_MENU_WRITE_UPGRADE, applied: result.applied };
}

export async function runAdminPlatformMenuWriteUpgrade(db: DbClient, target: AdminPlatformMenuWriteTarget) {
  if (!Object.hasOwn(db, '$client') || !db.$client) throw Error('Platform menu upgrade requires a root maintenance connection');
  return db.transaction(tx => installAdminPlatformMenuWriteUpgradeInTransaction(tx, target), { isolationLevel: 'read committed', accessMode: 'read write' });
}
