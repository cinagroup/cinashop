import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { ADMIN_REFUND_OPERATION_INSTALLATION_SQL } from './adminRefundOperationInstallation';
import { ADMIN_REFUND_OPERATION_COMPATIBILITY_SQL } from './adminRefundOperationCatalog';

/** Maintenance-owner read-only catalog check; never reads refund business rows. */
export async function inspectAdminRefundOperation(db: Pick<DbClient,'execute'>) {
  const [row] = await db.execute(sql.raw(ADMIN_REFUND_OPERATION_COMPATIBILITY_SQL));
  if (!row || typeof row.present !== 'boolean') throw new Error('Admin refund receipt catalog unavailable');
  return {present:row.present,complete:row.compatible===true,oid:row.oid};
}

/** Existing deployments use this one bounded upgrade, never the historical runAll. */
export async function runAdminRefundOperation(db: Pick<DbClient,'transaction'> & Partial<Pick<DbClient,'$client'>>): Promise<void> {
  if (!Object.hasOwn(db,'$client') || !db.$client) throw new Error('Admin refund receipt installation requires a root database');
  await db.transaction(async tx=>{await tx.execute(sql.raw(ADMIN_REFUND_OPERATION_INSTALLATION_SQL));},
    {isolationLevel:'read committed',accessMode:'read write'});
}
