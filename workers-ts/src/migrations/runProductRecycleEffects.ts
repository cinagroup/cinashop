import type { DbClient } from '@/lib/di';
import { PRODUCT_RECYCLE_EFFECTS_SQL } from './productRecycleEffects';
/** Standalone, bounded maintenance transaction; no business DML or provider calls. */
export async function runProductRecycleEffects(db: Pick<DbClient, '$client'>): Promise<void> {
  if (!db.$client) throw Error('Recycle effects upgrade requires a root database');
  await db.$client.begin('isolation level read committed', async tx => { await tx.unsafe(PRODUCT_RECYCLE_EFFECTS_SQL); });
}
