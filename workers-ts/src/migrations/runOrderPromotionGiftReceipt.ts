import type { DbClient } from '@/lib/di';
import { ORDER_PROMOTION_GIFT_RECEIPT_SQL } from './orderPromotionGiftReceipt';

/** Explicit maintenance connection only; checkout and payment never install DDL. */
export async function runOrderPromotionGiftReceipt(db: Pick<DbClient, '$client'>): Promise<void> {
  if (!Object.hasOwn(db, '$client') || !db.$client) throw Error('Promotion gift receipt requires a root database');
  await db.$client.begin('isolation level read committed', async tx => {
    await tx.unsafe(ORDER_PROMOTION_GIFT_RECEIPT_SQL);
  });
}
