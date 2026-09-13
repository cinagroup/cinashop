import { sql } from 'drizzle-orm';
import type { DbClient } from '../../src/lib/di';
import { runShippingLifecycle } from '../../src/migrations/runShippingLifecycle';
export { SHIPPING_LIFECYCLE_CANDIDATE_SQL } from '../../src/migrations/shippingLifecycleProtocol';

/** Owned PG16 test adapter around the real maintenance runner. No grants,
 * overwrite, repair, or implicit permission to use this helper on a live DB. */
export async function installShippingTemplateLifecycleCandidate(db: DbClient) {
  const [target] = await db.select({ name: sql<string>`current_database()`, version: sql<string>`current_setting('server_version_num')` })
    .from(sql`(VALUES(1)) target(n)`);
  if (!/^cinashop_kefu_runner_[a-f0-9]{32}$/.test(target?.name ?? '') || Math.floor(Number(target.version) / 10000) !== 16) {
    throw new Error('Shipping lifecycle candidate requires an owned PG16 test database');
  }
  return runShippingLifecycle(db);
}
