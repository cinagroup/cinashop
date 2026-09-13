import { sql } from 'drizzle-orm';
import { SHIPPING_LIFECYCLE_LOCK_SQL } from './shippingLifecycleInspectionSql';
import type { DbClient } from '../lib/di';
import { boundShippingLifecycleInspection, inspectShippingLifecycleBaseline, inspectShippingLifecycleCatalog } from './inspectShippingLifecycleBaseline';
import { assertShippingLifecycleInstallationEnvironment } from './assertShippingLifecycleInstallationEnvironment';

type Transaction = Parameters<Parameters<DbClient['transaction']>[0]>[0];

/** Installation transaction primitive, not a registered migration or CLI.
 * The trusted installer callback must execute DDL on this transaction only.
 * No cached audit result is accepted. Locks and fresh validation precede DDL;
 * callback failure rolls everything back. Catalog/ACL verification of installed
 * protocol objects remains the installer's responsibility, not this primitive's.
 */
export async function withShippingLifecycleWriteBarrier<T>(
  db: Pick<DbClient, 'transaction'> & Partial<Pick<DbClient, '$client'>>,
  install: (tx: Transaction) => Promise<T>,
): Promise<T> {
  if (!db.$client) throw new Error('Shipping installation requires a root database');
  return db.transaction(async tx => {
    await boundShippingLifecycleInspection(tx);
    const [identity] = await tx.select({ version: sql<number>`current_setting('server_version_num')::int`,
      writable: sql<boolean>`current_setting('transaction_read_only')='off'`,
      readCommitted: sql<boolean>`current_setting('transaction_isolation')='read committed'` }).from(sql`(VALUES(1)) identity(n)`);
    if (!identity || Math.floor(identity.version / 10000) !== 16 || !identity.writable || !identity.readCommitted) {
      throw new Error('Shipping installation requires a PostgreSQL 16 read-write read-committed transaction');
    }
    await assertShippingLifecycleInstallationEnvironment(tx);
    // Reject known views/partitions/inheritance before requesting relation locks.
    // This initial catalog check is NOT trusted: the locked inspection repeats it.
    const shape = await inspectShippingLifecycleCatalog(tx);
    if (shape.length !== 7 || shape.some(row => !row.compatible)) {
      throw new Error('Shipping installation baseline is incompatible');
    }
    // Fixed schema, stable order, no automatic descendants, no wait/retry loop.
    // Self-conflicting lock serializes installers and excludes DML/DDL while
    // still permitting ordinary readers. A fresh RC inspection follows the lock.
    await tx.execute(sql.raw(SHIPPING_LIFECYCLE_LOCK_SQL));
    const baseline = await inspectShippingLifecycleBaseline(tx);
    if (!baseline.baselineReady) throw new Error('Shipping installation baseline is incompatible');
    // The earlier environment snapshot is not an installation permit. Recheck
    // after the table barriers and baseline work, immediately before trusted DDL.
    await assertShippingLifecycleInstallationEnvironment(tx);
    return install(tx);
  }, { isolationLevel: 'read committed', accessMode: 'read write' });
}
