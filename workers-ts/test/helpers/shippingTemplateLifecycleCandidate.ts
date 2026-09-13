import { sql } from 'drizzle-orm';
import type { DbClient } from '../../src/lib/di';
import { withShippingLifecycleWriteBarrier } from '../../src/migrations/withShippingLifecycleWriteBarrier';
import { inspectShippingLifecycleProtocol } from '../../src/migrations/inspectShippingLifecycleProtocol';
import { SHIPPING_LIFECYCLE_CANDIDATE_SQL } from '../../src/migrations/shippingLifecycleProtocol';
export { SHIPPING_LIFECYCLE_CANDIDATE_SQL } from '../../src/migrations/shippingLifecycleProtocol';

/** Owned PG16 test database only. No automatic overwrite, repair or grants.
 * Formal registration/runtime privilege policy is not provided by this helper. */
export async function installShippingTemplateLifecycleCandidate(db: DbClient) {
  const [target] = await db.select({ name: sql<string>`current_database()`, version: sql<string>`current_setting('server_version_num')` })
    .from(sql`(VALUES(1)) target(n)`);
  if (!/^cinashop_kefu_runner_[a-f0-9]{32}$/.test(target?.name ?? '') || Math.floor(Number(target.version) / 10000) !== 16) {
    throw new Error('Shipping lifecycle candidate requires an owned PG16 test database');
  }
  return withShippingLifecycleWriteBarrier(db, async tx => {
    const before = await inspectShippingLifecycleProtocol(tx);
    if (before.state === 'drift') throw new Error('Shipping lifecycle protocol catalog differs');
    if (before.state === 'complete') return { applied: false };
    await tx.execute(sql.raw(SHIPPING_LIFECYCLE_CANDIDATE_SQL));
    if ((await inspectShippingLifecycleProtocol(tx)).state !== 'complete') {
      throw new Error('Shipping lifecycle protocol catalog differs after installation');
    }
    return { applied: true };
  });
}
