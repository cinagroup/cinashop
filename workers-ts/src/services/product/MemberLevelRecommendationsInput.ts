import { ValidateException } from '@/utils/errors';

export interface MemberLevelRecommendationsPage { page: number; limit: 10 }
/** Only the explicit modern view is strict; the legacy hot parser is unchanged. */
export function memberLevelRecommendationsPage(query: URLSearchParams): MemberLevelRecommendationsPage {
  for (const key of query.keys()) {
    if (!['view', 'page', 'limit'].includes(key) || query.getAll(key).length !== 1) {
      throw new ValidateException('会员推荐查询参数无效');
    }
  }
  const page = query.get('page') ?? '1';
  if (query.get('view') !== 'member_level' || !/^[1-9]\d{0,4}$/.test(page)
    || Number(page) > 10000 || query.has('limit') && query.get('limit') !== '10') {
    throw new ValidateException('会员推荐查询参数无效');
  }
  return { page: Number(page), limit: 10 };
}
