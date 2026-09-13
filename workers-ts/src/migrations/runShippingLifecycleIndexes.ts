import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { SHIPPING_LIFECYCLE_INDEX_INSTALLATION_SQL } from './shippingLifecycleIndexInstallation';
import { SHIPPING_LIFECYCLE_INDEX_CATALOG_SQL, SHIPPING_LIFECYCLE_REUSED_INDEX_SQL } from './shippingLifecycleIndexes';

export async function inspectShippingLifecycleIndexes(db: Pick<DbClient,'execute'>) {
  const rows = Array.from(await db.execute(sql.raw(SHIPPING_LIFECYCLE_INDEX_CATALOG_SQL)));
  const [reused] = await db.execute(sql.raw(SHIPPING_LIFECYCLE_REUSED_INDEX_SQL));
  return { complete: rows.length === 10 && rows.every(r => r.compatible === true) && reused?.compatible === true,
    reusedPackageSourceCompatible: reused?.compatible === true,
    present: rows.filter(r => r.present === true).length,
    drift: rows.some(r => r.present === true && r.compatible !== true), rows };
}

/** Explicit maintenance entrypoint. Not a startup hook or historical runAll. */
export async function runShippingLifecycleIndexes(db: Pick<DbClient,'transaction'> & Partial<Pick<DbClient,'$client'>>): Promise<void> {
  if (!db.$client) throw new Error('Shipping indexes require a root database');
  await db.transaction(async tx => {
    await tx.execute(sql.raw(SHIPPING_LIFECYCLE_INDEX_INSTALLATION_SQL));
  }, { isolationLevel: 'read committed', accessMode: 'read write' });
}
