import type { DbClient } from '@/lib/di';
import { REVIEW_COMMUNITY_SYNC_SQL } from './reviewCommunitySync';
/** Root-only bounded maintenance; never invoked by HTTP handlers. */
export async function runReviewCommunitySync(db: Pick<DbClient,'$client'>): Promise<void> {
  if(!db.$client)throw Error('Review synchronization requires a root database');
  await db.$client.begin('isolation level read committed',async tx=>{await tx.unsafe(REVIEW_COMMUNITY_SYNC_SQL);});
}
