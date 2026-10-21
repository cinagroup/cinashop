import type { DbClient } from '@/lib/di';
import { RecommendationNavigationService } from './RecommendationNavigationService';

/** Add the existing versioned navigation contract without changing PHP's raw
 * activity priority or an existing recommendation_target. /products and the
 * presale list already supply their RR snapshot; legacy recommendation paths
 * retain their existing transaction boundary. Final details/quotes still
 * revalidate identity, visibility, ownership and current admission. */
export async function decoratePublicProductActivities(db: DbClient, list: readonly Record<string, unknown>[], now = new Date()): Promise<Record<string, unknown>[]> {
  const resolved = await new RecommendationNavigationService({ db }, { strictOwners: true }).decorate(list, now);
  return list.map((row, index) => ({ ...row, diy_navigation: resolved[index].recommendation_target }));
}
