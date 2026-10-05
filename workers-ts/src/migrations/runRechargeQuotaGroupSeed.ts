import type { DbClient } from '@/lib/di';
import { RECHARGE_QUOTA_GROUP_SEED_SQL } from './rechargeQuotaGroupSeed';

/** Explicit bootstrap/maintenance entry point. The caller supplies its existing
 * maintenance connection; no HTTP route, runtime invocation or role grant. */
export async function runRechargeQuotaGroupSeed(db: Pick<DbClient, '$client'>): Promise<void> {
  if (!db.$client) throw Error('Recharge quota group seed requires a root database');
  await db.$client.begin('isolation level read committed', async tx => {
    await tx.unsafe(RECHARGE_QUOTA_GROUP_SEED_SQL);
  });
}
