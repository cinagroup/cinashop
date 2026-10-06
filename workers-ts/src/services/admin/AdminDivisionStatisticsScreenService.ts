import { and, eq, gt, gte, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { storeOrder, user } from '@/models/schema';
import { ValidateException } from '@/utils/errors';
import type { DivisionAdminScope } from '@/services/division/DivisionManagementService';

const MAX_RANKED_ROLES = 500;
const MAX_DAYS = 366;
const DAY_MS = 86_400_000;
const SHANGHAI_OFFSET_SECONDS = 8 * 3_600;

type Range = { start: number; endExclusive: number; xAxis: string[]; bucket: 'hour' | 'day' | 'month' };

function validateScope(scope: DivisionAdminScope): void {
  if (!Number.isSafeInteger(scope.level) || !Number.isSafeInteger(scope.divisionId)) {
    throw new ValidateException('事业部统计范围无效');
  }
  if (scope.level !== 0 && scope.divisionId <= 0) {
    throw new ValidateException('当前管理员未绑定事业部');
  }
}

function parseDay(text: string): Date {
  const match = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(text);
  if (!match) throw new ValidateException('统计日期格式应为 YYYY/MM/DD');
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 1970 || year > 2037 || date.getUTCFullYear() !== year ||
      date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    throw new ValidateException('统计日期无效');
  }
  return date;
}

function ymd(date: Date): string { return date.toISOString().slice(0, 10); }
function ym(date: Date): string { return date.toISOString().slice(0, 7); }

/** The PHP chart samples every third day; it does not aggregate three-day intervals. */
export function parseStatisticsScreenRange(raw: string): Range {
  const match = /^(\d{4}\/\d{2}\/\d{2})-(\d{4}\/\d{2}\/\d{2})$/.exec(raw);
  if (!match) throw new ValidateException('统计时间格式应为 YYYY/MM/DD-YYYY/MM/DD');
  const first = parseDay(match[1]), last = parseDay(match[2]);
  const days = Math.floor((last.getTime() - first.getTime()) / DAY_MS) + 1;
  if (days < 1 || days > MAX_DAYS) throw new ValidateException('统计时间范围须为 1 到 366 天');
  const start = first.getTime() / 1000 - SHANGHAI_OFFSET_SECONDS;
  const endExclusive = (last.getTime() + DAY_MS) / 1000 - SHANGHAI_OFFSET_SECONDS;
  if (days === 1) return { start, endExclusive, bucket: 'hour',
    xAxis: Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, '0')) };
  if (days <= 92) {
    const step = days <= 31 ? 1 : 3;
    const xAxis: string[] = [];
    for (let current = first.getTime(); current <= last.getTime(); current += step * DAY_MS) {
      xAxis.push(ymd(new Date(current)));
    }
    return { start, endExclusive, bucket: 'day', xAxis };
  }
  const xAxis: string[] = [];
  // PHP strtotime('+1 month') retains the initial day, including overflow at month end.
  for (let current = first; current.getTime() <= last.getTime();
    current = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, current.getUTCDate()))) {
    xAxis.push(ym(current));
  }
  return { start, endExclusive, bucket: 'month', xAxis };
}

async function readOnly(tx: DbClient): Promise<void> {
  await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
  await tx.execute(sql`SELECT
    set_config('statement_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000),5000)::text||'ms',true),
    set_config('lock_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000),2000)::text||'ms',true),
    set_config('idle_in_transaction_session_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000),5000)::text||'ms',true)`);
}

function money(amount: string | undefined): string {
  const value = amount ?? '0';
  const [whole, fraction = ''] = value.split('.');
  return `${whole}.${fraction.padEnd(2, '0').slice(0, 2)}`;
}

function orderBrokerage(): SQL {
  return sql`${storeOrder.divisionBrokerage} + ${storeOrder.divisionAgentBrokerage} + ${storeOrder.divisionStaffBrokerage}`;
}

/** Isolated legacy statistics-screen reads; existing division management statistics are unchanged. */
export class AdminDivisionStatisticsScreenService {
  constructor(private readonly container: Container) {}

  async summary(scope: DivisionAdminScope) {
    validateScope(scope);
    return withTx(this.container, async tx => {
      await readOnly(tx);
      const [roles] = await tx.select({
        divisionNum: sql<number>`COUNT(*) FILTER (WHERE ${user.divisionType} = 1)::int`,
        agentNum: sql<number>`COUNT(*) FILTER (WHERE ${user.divisionType} = 2 AND (${scope.level === 0} OR ${user.divisionId} = ${scope.divisionId}))::int`,
        staffNum: sql<number>`COUNT(*) FILTER (WHERE ${user.divisionType} = 3 AND (${scope.level === 0} OR ${user.divisionId} = ${scope.divisionId}))::int`,
      }).from(user).where(isNull(user.deleteTime));
      // The PHP division_type searcher is an OR across all three role IDs.
      const where = and(or(gt(storeOrder.divisionId, 0), gt(storeOrder.divisionAgentId, 0),
        gt(storeOrder.divisionStaffId, 0)), gte(storeOrder.pid, 0),
        eq(storeOrder.paid, 1), scope.level === 0 ? undefined : eq(storeOrder.divisionId, scope.divisionId));
      const [orders] = await tx.select({
        orderNum: sql<number>`COUNT(*)::int`,
        orderPrice: sql<string>`COALESCE(SUM(${storeOrder.payPrice}),0)::text`,
        brokeragePrice: sql<string>`COALESCE(SUM(${orderBrokerage()}),0)::text`,
      }).from(storeOrder).where(where);
      return { divisionNum: roles?.divisionNum ?? 0, agentNum: roles?.agentNum ?? 0,
        staffNum: roles?.staffNum ?? 0, orderNum: orders?.orderNum ?? 0,
        orderPrice: money(orders?.orderPrice), brokeragePrice: money(orders?.brokeragePrice) };
    });
  }

  async trend(rawTime: string, scope: DivisionAdminScope) {
    validateScope(scope);
    const range = parseStatisticsScreenRange(rawTime);
    return withTx(this.container, async tx => {
      await readOnly(tx);
      const bucket = range.bucket === 'hour'
        ? sql<string>`to_char(to_timestamp(${storeOrder.addTime}) AT TIME ZONE 'Asia/Shanghai', 'HH24')`
        : range.bucket === 'day'
          ? sql<string>`to_char(to_timestamp(${storeOrder.addTime}) AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD')`
          : sql<string>`to_char(to_timestamp(${storeOrder.addTime}) AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM')`;
      const rows = await tx.select({ bucket,
        orderPrice: sql<string>`COALESCE(SUM(${storeOrder.payPrice}),0)::text`,
        orderCount: sql<number>`COUNT(*)::int`,
      }).from(storeOrder).where(and(eq(storeOrder.paid, 1), gte(storeOrder.pid, 0),
        scope.level === 0 ? gt(storeOrder.divisionId, 0) : eq(storeOrder.divisionId, scope.divisionId),
        gte(storeOrder.addTime, range.start), lt(storeOrder.addTime, range.endExclusive)))
        .groupBy(bucket).orderBy(bucket);
      const byBucket = new Map(rows.map(row => [row.bucket, row]));
      return { xAxis: range.xAxis, series: [
        { name: '订单金额', type: 'line' as const,
          data: range.xAxis.map(label => Number(byBucket.get(label)?.orderPrice ?? 0)) },
        { name: '订单量', type: 'line' as const,
          data: range.xAxis.map(label => byBucket.get(label)?.orderCount ?? 0) },
      ] };
    });
  }

  async ranking(scope: DivisionAdminScope) {
    validateScope(scope);
    return withTx(this.container, async tx => {
      await readOnly(tx);
      const roleType = scope.level === 0 ? 1 : 2;
      const roles = await tx.select({ uid: user.uid, nickname: user.nickname }).from(user)
        .where(and(eq(user.divisionType, roleType), eq(user.status, 1), eq(user.isDel, 0),
          isNull(user.deleteTime),
          scope.level === 0 ? undefined : eq(user.divisionId, scope.divisionId)))
        .orderBy(user.uid).limit(MAX_RANKED_ROLES + 1);
      if (roles.length > MAX_RANKED_ROLES) {
        throw new ValidateException('事业部统计排行超过 500 行，请联系管理员缩小范围');
      }
      if (!roles.length) return { list: [] };
      const ids = roles.map(role => role.uid);
      const childRows = await tx.select({ parentId: user.divisionId,
        spreadAgent: sql<number>`COUNT(*) FILTER (WHERE ${user.divisionType} = 2)::int`,
        spreadStaff: sql<number>`COUNT(*) FILTER (WHERE ${user.divisionType} = 3)::int`,
      }).from(user).where(and(inArray(user.divisionId, ids), inArray(user.divisionType, [2, 3]),
        eq(user.status, 1), eq(user.isDel, 0), isNull(user.deleteTime),
        scope.level === 0 ? undefined : eq(user.divisionId, scope.divisionId)))
        .groupBy(user.divisionId);
      const orderRows = await tx.select({ roleId: storeOrder.divisionId,
        orderNum: sql<number>`COUNT(*)::int`,
        // Legacy order_num counts unpaid rows; money sums only paid rows.
        orderPrice: sql<string>`COALESCE(SUM(${storeOrder.payPrice}) FILTER (WHERE ${storeOrder.paid} = 1),0)::text`,
        brokeragePrice: sql<string>`COALESCE(SUM(${orderBrokerage()}) FILTER (WHERE ${storeOrder.paid} = 1),0)::text`,
      }).from(storeOrder).where(and(inArray(storeOrder.divisionId, ids),
        gte(storeOrder.pid, 0),
        scope.level === 0 ? undefined : eq(storeOrder.divisionId, scope.divisionId)))
        .groupBy(storeOrder.divisionId);
      const children = new Map(childRows.map(row => [row.parentId, row]));
      const orders = new Map(orderRows.map(row => [row.roleId, row]));
      return { list: roles.map(role => ({ uid: role.uid, nickname: role.nickname,
        spreadAgent: children.get(role.uid)?.spreadAgent ?? 0,
        spreadStaff: children.get(role.uid)?.spreadStaff ?? 0,
        orderNum: orders.get(role.uid)?.orderNum ?? 0,
        orderPrice: money(orders.get(role.uid)?.orderPrice),
        brokeragePrice: money(orders.get(role.uid)?.brokeragePrice) })) };
    });
  }
}
