import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { withShippingLifecycleWriteBarrier } from './withShippingLifecycleWriteBarrier';
import { inspectShippingLifecycleProtocol } from './inspectShippingLifecycleProtocol';
import { SHIPPING_LIFECYCLE_INSTALLATION_SQL } from './shippingLifecycleInstallation';

/** Explicit public-schema maintenance entrypoint. Caller must authorize the
 * target and coordinate other maintenance identities. Not a startup hook, grant
 * installer, data repair, or permission to use historical runAll on existing DBs.
 */
export async function runShippingLifecycle(
  db: Pick<DbClient, 'transaction'> & Partial<Pick<DbClient, '$client'>>,
): Promise<{ applied: boolean }> {
  return withShippingLifecycleWriteBarrier(db, async tx => {
    const before = await inspectShippingLifecycleProtocol(tx);
    if (before.state === 'drift') throw new Error('Shipping lifecycle protocol catalog differs');
    // The SQL also independently verifies and fences installation, so direct
    // filesystem use cannot bypass the TypeScript runner's checks.
    await tx.execute(sql.raw(SHIPPING_LIFECYCLE_INSTALLATION_SQL));
    if ((await inspectShippingLifecycleProtocol(tx)).state !== 'complete') {
      throw new Error('Shipping lifecycle protocol catalog differs after installation');
    }
    return { applied: before.state === 'absent' };
  });
}
