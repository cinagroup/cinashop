import type { DbClient } from '@/lib/di';
import { PRODUCT_SAVE_EFFECTS_SQL } from './productSaveEffects';
/** Standalone, bounded maintenance transaction; no business DML or provider calls. */
export async function runProductSaveEffects(db: Pick<DbClient, '$client'>): Promise<void> {
  if (!db.$client) throw Error('Save effects upgrade requires a root database');
  await db.$client.begin('isolation level read committed', async tx => { await tx.unsafe(PRODUCT_SAVE_EFFECTS_SQL); });
}
