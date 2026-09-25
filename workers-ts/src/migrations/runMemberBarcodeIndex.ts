import type { DbClient } from '@/lib/di';
import { MEMBER_BARCODE_INDEX_SQL } from './memberBarcodeIndex';

/** Forward-only bounded maintenance transaction, never called by user requests. */
export async function runMemberBarcodeIndex(db: Pick<DbClient, '$client'>): Promise<void> {
  if (!db.$client) throw Error('Member barcode index requires a root database');
  await db.$client.begin('isolation level read committed', async tx => {
    await tx.unsafe(MEMBER_BARCODE_INDEX_SQL);
  });
}
