import { ValidateException } from '@/utils/errors';

export interface UserGrowthRecordsPagination {
  page: number;
  limit: number;
  offset: number;
}

/** Bound direct service calls too: no string/float/unsafe-integer coercion. */
export function userGrowthRecordsPagination(page: unknown = 1, limit: unknown = 20): UserGrowthRecordsPagination {
  if (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1 || page > 1_000
    || typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new ValidateException('成长记录分页参数无效');
  }
  return { page, limit, offset: (page - 1) * limit };
}

/** Only page/limit are interpreted; legacy unrelated query keys never select an owner. */
export function parseUserGrowthRecordsQuery(query: URLSearchParams): UserGrowthRecordsPagination {
  const value = (key: 'page' | 'limit', fallback: number, maximum: number): number => {
    const entries = query.getAll(key);
    if (!entries.length) return fallback;
    const entry = entries[0]!;
    if (entries.length !== 1 || !/^[1-9][0-9]*$/u.test(entry) || entry.length > String(maximum).length) {
      throw new ValidateException('成长记录分页参数无效');
    }
    const parsed = Number(entry);
    if (parsed > maximum) throw new ValidateException('成长记录分页参数无效');
    return parsed;
  };
  return userGrowthRecordsPagination(value('page', 1, 1_000), value('limit', 20, 100));
}
