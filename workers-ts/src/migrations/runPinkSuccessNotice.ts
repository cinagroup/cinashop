import type { DbClient } from '@/lib/di';
import { PINK_SUCCESS_NOTICE_SQL } from './pinkSuccessNotice';

/** Explicit maintenance root transaction; no Queue/provider or role changes. */
export async function runPinkSuccessNotice(db: Pick<DbClient, '$client'>): Promise<void> {
  if (!db.$client) throw Error('Pink success notice upgrade requires a root database');
  await db.$client.begin('isolation level read committed', async tx => { await tx.unsafe(PINK_SUCCESS_NOTICE_SQL); });
}
