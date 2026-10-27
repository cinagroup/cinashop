import { ValidateException } from '@/utils/errors';

export type DistributionRankingKind = 'promoter' | 'commission';
export interface DistributionRankingsPage { type: 'week' | 'month'; page: number; limit: 20 }

/** Only the explicit leaderboard view opts into this bounded modern contract. */
export function distributionRankingsPage(query: URLSearchParams): DistributionRankingsPage {
  for (const key of query.keys()) {
    if (!['view', 'type', 'page', 'limit'].includes(key) || query.getAll(key).length !== 1) {
      throw new ValidateException('分销排行查询参数无效');
    }
  }
  const type = query.get('type') ?? 'week', page = query.get('page') ?? '1';
  if (query.get('view') !== 'leaderboard' || !['week', 'month'].includes(type)
    || !/^[1-9]\d{0,2}$/.test(page) || Number(page) > 500
    || query.has('limit') && query.get('limit') !== '20') {
    throw new ValidateException('分销排行查询参数无效');
  }
  return { type: type as 'week' | 'month', page: Number(page), limit: 20 };
}
