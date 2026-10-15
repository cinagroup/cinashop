import type { DbClient } from '@/lib/di';
import { PRODUCT_AUTO_SHELF_SQL } from './productAutoShelf';
/** Explicit standalone upgrade only; never called by an HTTP or Queue admission. */
export async function runProductAutoShelf(db: Pick<DbClient, '$client'>): Promise<void> {
  if (!db.$client) throw Error('Product auto shelf upgrade requires a root database');
  await db.$client.begin('isolation level read committed', async tx => { await tx.unsafe(PRODUCT_AUTO_SHELF_SQL); });
}
