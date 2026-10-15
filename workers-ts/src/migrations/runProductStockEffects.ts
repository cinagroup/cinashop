import type { DbClient } from '@/lib/di';
import { PRODUCT_STOCK_EFFECTS_SQL } from './productStockEffects';
/** Standalone, bounded maintenance transaction; no business DML or provider calls. */
export async function runProductStockEffects(db: Pick<DbClient, '$client'>): Promise<void> {
  if (!db.$client) throw Error('Stock effects upgrade requires a root database');
  await db.$client.begin('isolation level read committed', async tx => { await tx.unsafe(PRODUCT_STOCK_EFFECTS_SQL); });
}
