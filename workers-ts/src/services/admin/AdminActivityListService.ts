import { and, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { withTx, type Container } from '@/lib/di';
import { storeBargain, storeCombination, storeIntegral, storeSeckill } from '@/models/schema';
import { ValidateException } from '@/utils/errors';

const activityTables = { seckill: storeSeckill, combination: storeCombination, bargain: storeBargain, integral: storeIntegral };
type ActivityType = keyof typeof activityTables;
const allowedParameters = new Set(['page', 'limit', 'keyword', 'status']);

function positiveInteger(value: string | null, fallback: number, maximum: number): number {
  if (value === null) return fallback;
  if (!/^[1-9]\d{0,4}$/.test(value)) throw new ValidateException('活动分页参数错误');
  const parsed = Number(value);
  if (parsed > maximum) throw new ValidateException('活动分页参数超出范围');
  return parsed;
}

export function parseAdminActivityListQuery(parameters: URLSearchParams) {
  for (const key of parameters.keys()) {
    if (!allowedParameters.has(key) || parameters.getAll(key).length !== 1) {
      throw new ValidateException('活动查询包含不支持或重复的参数');
    }
  }
  const paginated = parameters.has('page') || parameters.has('limit');
  const page = positiveInteger(parameters.get('page'), 1, 10_001);
  const limit = positiveInteger(parameters.get('limit'), paginated ? 20 : 100, 100);
  const offset = (page - 1) * limit;
  if (offset > 10_000) throw new ValidateException('活动分页偏移超出范围');
  const rawKeyword = parameters.get('keyword') ?? '';
  if (rawKeyword.length > 200 || /[\u0000-\u001f\u007f]/.test(rawKeyword)) {
    throw new ValidateException('活动名称查询参数错误');
  }
  const keyword = rawKeyword.trim();
  if ([...keyword].length > 100) throw new ValidateException('活动名称查询过长');
  const status = parameters.get('status');
  if (status !== null && status !== '0' && status !== '1') throw new ValidateException('活动状态查询参数错误');
  return { paginated, page, limit, offset, keyword, status: status === null ? null : Number(status) };
}

/** Admin directory reads retain every stored field used by the existing editors.
 * Legacy callers without pagination still receive a bounded array. */
export async function listAdminActivities(container: Container, type: ActivityType, parameters: URLSearchParams) {
  const query = parseAdminActivityListQuery(parameters);
  const table = activityTables[type];
  const conditions: SQL[] = [eq(table.isDel, 0)];
  if (query.status !== null) conditions.push(eq(table.status, query.status));
  if (query.keyword) {
    const pattern = `%${query.keyword.replace(/[\\%_]/g, '\\$&')}%`;
    // Bargain's editor uses title; migrated records may retain storeName as well.
    conditions.push(type === 'bargain'
      ? or(ilike(storeBargain.title, pattern), ilike(storeBargain.storeName, pattern))!
      : ilike(table.storeName, pattern));
  }
  return withTx(container, async db => {
    await db.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    await db.execute(sql`SELECT set_config('statement_timeout',
      LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true)`);
    const predicate = and(...conditions);
    const list = await db.select().from(table).where(predicate)
      .orderBy(desc(table.sort), desc(table.id)).limit(query.limit).offset(query.offset);
    if (!query.paginated) return list;
    const [total] = await db.select({ count: sql<number>`COUNT(*)::integer` }).from(table).where(predicate);
    return { list, count: total.count, page: query.page, limit: query.limit };
  });
}
