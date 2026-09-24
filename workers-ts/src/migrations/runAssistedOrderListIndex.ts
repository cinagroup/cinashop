import type { DbClient } from '@/lib/di';
import { ASSISTED_ORDER_LIST_INDEX_SQL } from './assistedOrderListIndex';

/** Explicit bounded maintenance transaction, never called by the order worker. */
export async function runAssistedOrderListIndex(db: Pick<DbClient, '$client'>): Promise<void> {
  if (!db.$client) throw Error('Assisted order list index requires a root database');
  await db.$client.begin('isolation level read committed', async tx => {
    await tx.unsafe(ASSISTED_ORDER_LIST_INDEX_SQL);
  });
}
