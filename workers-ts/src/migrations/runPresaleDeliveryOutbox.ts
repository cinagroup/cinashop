import type { DbClient } from '@/lib/di';
import { PRESALE_DELIVERY_OUTBOX_SQL } from './presaleDeliveryOutbox';

/** Explicit maintenance root transaction; never invoked by a Queue consumer. */
export async function runPresaleDeliveryOutbox(db: Pick<DbClient, '$client'>): Promise<void> {
  if (!db.$client) throw Error('Presale outbox upgrade requires a root database');
  await db.$client.begin('isolation level read committed', async tx => {
    await tx.unsafe(PRESALE_DELIVERY_OUTBOX_SQL);
  });
}
