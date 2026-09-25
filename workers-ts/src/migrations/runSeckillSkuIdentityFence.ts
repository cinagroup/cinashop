import type { DbClient } from '@/lib/di';
import { SECKILL_SKU_IDENTITY_FENCE_SQL } from './seckillSkuIdentityFence';

/** Explicit bounded maintenance transaction, never called by checkout. */
export async function runSeckillSkuIdentityFence(db: Pick<DbClient, '$client'>): Promise<void> {
  if (!db.$client) throw Error('Seckill SKU identity fence requires a root database');
  await db.$client.begin('isolation level read committed', async tx => {
    await tx.unsafe(SECKILL_SKU_IDENTITY_FENCE_SQL);
  });
}
