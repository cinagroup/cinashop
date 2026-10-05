import { and, desc, eq, gte, inArray, lt, sql, type SQL } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { storeOrder, storeOrderRefund, systemSupplier } from '@/models/schema';
import { ValidateException } from '@/utils/errors';

const DAY_MS = 86_400_000;
const SHANGHAI_OFFSET = 8 * 3_600;
const MAX_INT = 2_147_483_647;
const MAX_OPTIONS = 10_000;

type Range = { start: number; endExclusive: number; days: number; first: Date; last: Date };
type Scope = { range: Range; supplierId: number | null };
type Page = { page: number; limit: number; offset: number };

const CHANNELS = ['公众号', '小程序', 'H5', 'PC', 'APP'] as const;
const TYPES = ['普通订单', '秒杀订单', '砍价订单', '拼团订单', '积分订单',
  '套餐订单', '预售订单', '新人专享', '抽奖订单'] as const;

function allowed(params: URLSearchParams, keys: readonly string[]) {
  for (const key of params.keys()) {
    if (!keys.includes(key) || params.getAll(key).length !== 1) {
      throw new ValidateException('供应商订单统计查询参数未知或重复');
    }
  }
}

function parseDay(raw: string): Date {
  const match = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(raw);
  if (!match) throw new ValidateException('统计日期格式应为 YYYY/MM/DD');
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 1970 || year > 2037 || date.getUTCFullYear() !== year ||
      date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    throw new ValidateException('统计日期无效');
  }
  return date;
}

export function parseSupplierOrderStatisticsRange(raw: string | null): Range {
  const match = /^(\d{4}\/\d{2}\/\d{2})-(\d{4}\/\d{2}\/\d{2})$/.exec(raw ?? '');
  if (!match) throw new ValidateException('统计时间格式应为 YYYY/MM/DD-YYYY/MM/DD');
  const first = parseDay(match[1]), last = parseDay(match[2]);
  const days = Math.floor((last.getTime() - first.getTime()) / DAY_MS) + 1;
  if (days < 1 || days > 366) throw new ValidateException('统计时间范围须为 1 到 366 天');
  const start = first.getTime() / 1000 - SHANGHAI_OFFSET;
  const endExclusive = (last.getTime() + DAY_MS) / 1000 - SHANGHAI_OFFSET;
  if (start < 0 || endExclusive > MAX_INT) throw new ValidateException('统计日期超出可查询范围');
  return { start, endExclusive, days, first, last };
}

function positiveInt(raw: string | null, label: string, fallback: number, maximum: number): number {
  if (raw === null || raw === '') return fallback;
  if (!/^[1-9]\d*$/.test(raw)) throw new ValidateException(`${label}无效`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) throw new ValidateException(`${label}超出范围`);
  return value;
}

function scope(params: URLSearchParams, table = false): Scope & Partial<Page> {
  allowed(params, table ? ['time', 'supplier_id', 'page', 'limit'] : ['time', 'supplier_id']);
  const rawSupplier = params.get('supplier_id');
  const supplierId = rawSupplier === null || rawSupplier === '' || rawSupplier === '0'
    ? null : positiveInt(rawSupplier, '供应商', 0, MAX_INT);
  const result: Scope & Partial<Page> = { range: parseSupplierOrderStatisticsRange(params.get('time')), supplierId };
  if (table) {
    result.page = positiveInt(params.get('page'), '页码', 1, 1000);
    result.limit = positiveInt(params.get('limit'), '每页条数', 20, 100);
    result.offset = (result.page - 1) * result.limit;
    if (result.offset > 10_000) throw new ValidateException('统计表分页超出范围');
  }
  return result;
}

function supplierWhere(id: number | null, column: typeof storeOrder.supplierId | typeof storeOrderRefund.supplierId): SQL {
  // In PHP's searchSupplierIdAttr, -1 means supplier_id > 0.
  return id === null ? sql`${column} > 0` : eq(column, id);
}

function clockWhere(range: Range, column: typeof storeOrder.addTime | typeof storeOrderRefund.addTime): SQL {
  return and(gte(column, range.start), lt(column, range.endExclusive))!;
}

async function readOnly(tx: DbClient): Promise<void> {
  await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
  await tx.execute(sql`SELECT
    set_config('statement_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000),5000)::text||'ms',true),
    set_config('lock_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000),2000)::text||'ms',true),
    set_config('idle_in_transaction_session_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000),5000)::text||'ms',true)`);
}

function money(raw: string | null | undefined): string {
  const value = raw ?? '0';
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  return `${negative ? '-' : ''}${whole}.${fraction.padEnd(2, '0').slice(0, 2)}`;
}

function cents(raw: string): bigint {
  const negative = raw.startsWith('-');
  const [whole, fraction = ''] = (negative ? raw.slice(1) : raw).split('.');
  const value = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
  return negative ? -value : value;
}

function moneyFromCents(raw: bigint): string {
  const negative = raw < 0n;
  const value = negative ? -raw : raw;
  return `${negative ? '-' : ''}${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}

function percent(part: bigint, total: bigint): number {
  return total === 0n ? 0 : Number(part * 10_000n / total) / 100;
}

function axis(range: Range): { labels: string[]; bucket: 'hour' | 'day' | 'month' } {
  if (range.days === 1) return { bucket: 'hour', labels: Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0')) };
  if (range.days <= 92) {
    const labels: string[] = [];
    for (let current = range.first.getTime(); current <= range.last.getTime(); current += DAY_MS) {
      labels.push(new Date(current).toISOString().slice(0, 10));
    }
    return { bucket: 'day', labels };
  }
  const labels: string[] = [];
  for (let current = Date.UTC(range.first.getUTCFullYear(), range.first.getUTCMonth(), 1);
    current <= Date.UTC(range.last.getUTCFullYear(), range.last.getUTCMonth(), 1);
    current = Date.UTC(new Date(current).getUTCFullYear(), new Date(current).getUTCMonth() + 1, 1)) {
    labels.push(new Date(current).toISOString().slice(0, 7));
  }
  return { bucket: 'month', labels };
}

function bucketExpression(bucket: 'hour' | 'day' | 'month'): SQL<string> {
  // Inline fixed format literals: two separately-bound parameters in SELECT
  // and GROUP BY are different PostgreSQL expressions.
  return bucket === 'hour'
    ? sql<string>`to_char(to_timestamp(${storeOrder.addTime}) AT TIME ZONE 'Asia/Shanghai', 'HH24')`
    : bucket === 'day'
      ? sql<string>`to_char(to_timestamp(${storeOrder.addTime}) AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD')`
      : sql<string>`to_char(to_timestamp(${storeOrder.addTime}) AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM')`;
}

/** Platform Admin supplier-order statistics. Every endpoint reads a single RR snapshot. */
export class AdminSupplierOrderStatisticsScreenService {
  constructor(private readonly container: Container) {}

  async suppliers(params: URLSearchParams) {
    allowed(params, []);
    return withTx(this.container, async tx => {
      await readOnly(tx);
      const rows = await tx.select({ id: systemSupplier.id, supplierName: systemSupplier.supplierName })
        .from(systemSupplier).where(eq(systemSupplier.isDel, 0)).orderBy(desc(systemSupplier.id)).limit(MAX_OPTIONS + 1);
      if (rows.length > MAX_OPTIONS) throw new ValidateException('供应商选项超过 10000 条');
      return { list: rows };
    });
  }

  async summary(params: URLSearchParams) {
    const query = scope(params);
    return withTx(this.container, async tx => {
      await readOnly(tx);
      const [orders] = await tx.select({
        payPrice: sql<string>`COALESCE(SUM(${storeOrder.payPrice}),0)::text`,
        payCount: sql<number>`COUNT(*)::int`,
      }).from(storeOrder).where(and(clockWhere(query.range, storeOrder.addTime),
        supplierWhere(query.supplierId, storeOrder.supplierId), eq(storeOrder.paid, 1),
        eq(storeOrder.isSystemDel, 0), eq(storeOrder.refundStatus, 0)));
      // PHP header uses refund rows' refund_price (not refunded_price), without is_del/is_cancel.
      const [refunds] = await tx.select({
        refundPrice: sql<string>`COALESCE(SUM(${storeOrderRefund.refundPrice}),0)::text`,
        refundCount: sql<number>`COUNT(*)::int`,
      }).from(storeOrderRefund).where(and(clockWhere(query.range, storeOrderRefund.addTime),
        supplierWhere(query.supplierId, storeOrderRefund.supplierId), eq(storeOrderRefund.refundType, 6)));
      return { payPrice: money(orders?.payPrice), payCount: orders?.payCount ?? 0,
        refundPrice: money(refunds?.refundPrice), refundCount: refunds?.refundCount ?? 0 };
    });
  }

  async trend(params: URLSearchParams) {
    const query = scope(params);
    const { bucket, labels } = axis(query.range);
    return withTx(this.container, async tx => {
      await readOnly(tx);
      const expression = bucketExpression(bucket);
      const rows = await tx.select({ bucket: expression,
        payPrice: sql<string>`COALESCE(SUM(${storeOrder.payPrice}) FILTER
          (WHERE ${storeOrder.paid}=1 AND ${storeOrder.refundStatus} IN (0,3)),0)::text`,
        payCount: sql<number>`COUNT(*) FILTER
          (WHERE ${storeOrder.paid}=1 AND ${storeOrder.refundStatus} IN (0,3))::int`,
        refundPrice: sql<string>`COALESCE(SUM(${storeOrder.refundPrice}) FILTER
          (WHERE ${storeOrder.paid}=1 AND ${storeOrder.refundType}=6),0)::text`,
        refundCount: sql<number>`COUNT(*) FILTER
          (WHERE ${storeOrder.paid}=1 AND ${storeOrder.refundType}=6)::int`,
      }).from(storeOrder).where(and(clockWhere(query.range, storeOrder.addTime),
        supplierWhere(query.supplierId, storeOrder.supplierId), gte(storeOrder.pid, 0),
        eq(storeOrder.isDel, 0), eq(storeOrder.isSystemDel, 0))).groupBy(expression);
      const byBucket = new Map(rows.map(row => [row.bucket, row]));
      return { xAxis: labels, series: [
        { name: '订单金额', type: 'line' as const, data: labels.map(label => Number(byBucket.get(label)?.payPrice ?? 0)) },
        { name: '订单量', type: 'line' as const, data: labels.map(label => byBucket.get(label)?.payCount ?? 0) },
        { name: '退款金额', type: 'line' as const, data: labels.map(label => Number(byBucket.get(label)?.refundPrice ?? 0)) },
        { name: '退款订单量', type: 'line' as const, data: labels.map(label => byBucket.get(label)?.refundCount ?? 0) },
      ] };
    });
  }

  async channel(params: URLSearchParams) {
    const query = scope(params);
    return withTx(this.container, async tx => {
      await readOnly(tx);
      const rows = await tx.select({ key: storeOrder.isChannel, value: sql<number>`COUNT(*)::int` })
        .from(storeOrder).where(and(clockWhere(query.range, storeOrder.addTime),
          supplierWhere(query.supplierId, storeOrder.supplierId), eq(storeOrder.paid, 1),
          gte(storeOrder.pid, 0), inArray(storeOrder.isChannel, [0, 1, 2, 3, 4])))
        .groupBy(storeOrder.isChannel);
      const values = new Map(rows.map(row => [row.key, row.value]));
      const totalCount = rows.reduce((sum, row) => sum + row.value, 0);
      return { totalCount, items: CHANNELS.map((name, key) => ({ key, name,
        value: values.get(key) ?? 0, percent: percent(BigInt(values.get(key) ?? 0), BigInt(totalCount)) }))
        .sort((a, b) => b.value - a.value || a.key - b.key) };
    });
  }

  async type(params: URLSearchParams) {
    const query = scope(params);
    return withTx(this.container, async tx => {
      await readOnly(tx);
      const rows = await tx.select({ key: storeOrder.type,
        value: sql<string>`COALESCE(SUM(${storeOrder.payPrice}),0)::text` })
        .from(storeOrder).where(and(clockWhere(query.range, storeOrder.addTime),
          supplierWhere(query.supplierId, storeOrder.supplierId), eq(storeOrder.paid, 1),
          gte(storeOrder.pid, 0), inArray(storeOrder.type, [0, 1, 2, 3, 4, 5, 6, 7, 8])))
        .groupBy(storeOrder.type);
      const values = new Map(rows.map(row => [row.key, money(row.value)]));
      const total = rows.reduce((sum, row) => sum + cents(money(row.value)), 0n);
      const totalPrice = moneyFromCents(total);
      return { totalPrice,
        items: TYPES.map((name, key) => { const value = values.get(key) ?? '0.00';
          return { key, name, value, percent: percent(cents(value), total) }; })
          .sort((a, b) => { const first = cents(a.value), second = cents(b.value);
            return first === second ? a.key - b.key : first > second ? -1 : 1; }) };
    });
  }

  async supplierTable(params: URLSearchParams) {
    const query = scope(params, true) as Scope & Page;
    return withTx(this.container, async tx => {
      await readOnly(tx);
      const supplierFilter = and(eq(systemSupplier.isDel, 0), eq(systemSupplier.isShow, 1),
        query.supplierId === null ? undefined : eq(systemSupplier.id, query.supplierId));
      const [countRow] = await tx.select({ count: sql<number>`COUNT(*)::int` })
        .from(systemSupplier).where(supplierFilter);
      const suppliers = await tx.select({ id: systemSupplier.id, supplierName: systemSupplier.supplierName })
        .from(systemSupplier).where(supplierFilter).orderBy(desc(systemSupplier.id))
        .limit(query.limit).offset(query.offset);
      if (!suppliers.length) return { list: [], count: countRow?.count ?? 0, page: query.page, limit: query.limit };
      const ids = suppliers.map(row => row.id);
      const orders = await tx.select({ id: storeOrder.supplierId,
        orderPrice: sql<string>`COALESCE(SUM(${storeOrder.payPrice}),0)::text`,
        orderCount: sql<number>`COUNT(*)::int`,
      }).from(storeOrder).where(and(inArray(storeOrder.supplierId, ids),
        clockWhere(query.range, storeOrder.addTime), eq(storeOrder.paid, 1),
        gte(storeOrder.pid, 0), eq(storeOrder.isDel, 0), eq(storeOrder.isSystemDel, 0),
        inArray(storeOrder.refundStatus, [0, 3]))).groupBy(storeOrder.supplierId);
      // PHP supplier table uses refund rows' refunded_price, unlike the header.
      const refunds = await tx.select({ id: storeOrderRefund.supplierId,
        refundOrderPrice: sql<string>`COALESCE(SUM(${storeOrderRefund.refundedPrice}),0)::text`,
        refundOrderCount: sql<number>`COUNT(*)::int`,
      }).from(storeOrderRefund).where(and(inArray(storeOrderRefund.supplierId, ids),
        clockWhere(query.range, storeOrderRefund.addTime), eq(storeOrderRefund.refundType, 6)))
        .groupBy(storeOrderRefund.supplierId);
      const orderById = new Map(orders.map(row => [row.id, row]));
      const refundById = new Map(refunds.map(row => [row.id, row]));
      return { list: suppliers.map(item => ({ id: item.id, supplierName: item.supplierName,
        orderPrice: money(orderById.get(item.id)?.orderPrice), orderCount: orderById.get(item.id)?.orderCount ?? 0,
        refundOrderPrice: money(refundById.get(item.id)?.refundOrderPrice),
        refundOrderCount: refundById.get(item.id)?.refundOrderCount ?? 0 })),
        count: countRow?.count ?? 0, page: query.page, limit: query.limit };
    });
  }
}
