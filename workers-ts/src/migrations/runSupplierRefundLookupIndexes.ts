import type { DbClient } from '@/lib/di';
import { SUPPLIER_REFUND_LOOKUP_INDEX_SQL } from './supplierRefundLookupIndexes';

/** Explicit bounded maintenance transaction, never called by the payment worker. */
export async function runSupplierRefundLookupIndexes(db: Pick<DbClient, '$client'>): Promise<void> {
  if (!db.$client) throw Error('Supplier refund indexes require a root database');
  await db.$client.begin('isolation level read committed', async tx => {
    await tx.unsafe(SUPPLIER_REFUND_LOOKUP_INDEX_SQL);
  });
}
