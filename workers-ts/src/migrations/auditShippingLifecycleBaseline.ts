import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { boundShippingLifecycleInspection, inspectShippingLifecycleBaseline } from './inspectShippingLifecycleBaseline';

/** One bounded read-only snapshot, never authorization to install later.
 * Installation must repeat the shared inspection while holding its write barrier. */
export async function auditShippingLifecycleBaseline(
  db: Pick<DbClient, 'transaction'> & Partial<Pick<DbClient, '$client'>>,
) {
  if (!db.$client) throw new Error('Shipping baseline requires a root database');
  return db.transaction(async tx => {
    await boundShippingLifecycleInspection(tx);
    const [identity] = await tx.select({ version: sql<number>`current_setting('server_version_num')::int`,
      readOnly: sql<boolean>`current_setting('transaction_read_only')='on'`,
      repeatableRead: sql<boolean>`current_setting('transaction_isolation')='repeatable read'` }).from(sql`(VALUES(1)) identity(n)`);
    if (!identity || Math.floor(identity.version / 10000) !== 16 || !identity.readOnly || !identity.repeatableRead) {
      throw new Error('Shipping baseline requires a PostgreSQL 16 read-only repeatable-read snapshot');
    }
    return { ...await inspectShippingLifecycleBaseline(tx), readOnly: true as const };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
