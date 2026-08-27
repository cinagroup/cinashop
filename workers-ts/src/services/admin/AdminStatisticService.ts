/**
 * Admin 订单/商品统计。
 *
 * 对齐 PHP statistic/order 与 statistic/product 的运行时合同，并统一使用
 * Asia/Shanghai、左闭右开时间窗、根订单和软删除过滤。旧 PHP 的 3 天抽样
 * 会漏掉中间日期，本实现按连续 3 天真正聚合。
 */
import { sql, type SQL } from "drizzle-orm";
import type { Container } from "@/lib/di";
import { ValidateException } from "@/utils/errors";

const BUSINESS_OFFSET_SECONDS = 8 * 60 * 60;
const DAY_SECONDS = 24 * 60 * 60;
const MAX_RANGE_DAYS = 3_660;

export type StatisticGranularity = "hour" | "day" | "three_day" | "month";

export interface AdminStatisticRange {
  start: number;
  endExclusive: number;
  previousStart: number;
  days: number;
  granularity: StatisticGranularity;
  bucketKeys: string[];
  labels: string[];
  sqlPattern: "HH24" | "YYYY-MM-DD" | "YYYY-MM";
}

export interface StatisticSeries {
  name: string;
  data: number[];
  type: "line" | "bar";
  smooth?: "true";
  yAxisIndex?: 1;
}

export interface AdminOrderBasic {
  pay_price: string;
  pay_count: number;
  refund_price: string;
  refund_count: number;
  coupon_price: string;
  coupon_count: number;
}

export interface StatisticDistribution {
  bing_xdata: string[];
  bing_data: Array<{ name: string; value: number; itemStyle: { color: string } }>;
  list: Array<{ name: string; value: number; percent: number }>;
}

export interface MetricComparison {
  num: number;
  percent: number;
}

export type AdminProductBasic = Record<
  "browse" | "user" | "cart" | "order" | "pay" | "payPrice" | "cost" | "refundPrice" | "refund" | "payPercent",
  MetricComparison
>;

export type AdminProductRankingSort =
  | "visit"
  | "user"
  | "cart"
  | "orders"
  | "pay"
  | "price"
  | "profit"
  | "collect"
  | "changes";

export interface AdminProductRankingRow {
  product_id: number;
  store_name: string;
  image: string;
  product_price: string;
  stock: number;
  is_show: number;
  visit: number;
  user: number;
  cart: number;
  orders: number;
  pay: number;
  price: number;
  cost: number;
  profit: number;
  collect: number;
  changes: number;
  repeats: number;
}

export interface AggregateRow {
  [key: string]: unknown;
  metric: string;
  bucket: string;
  value: string | number;
}

interface OrderBasicRow {
  [key: string]: unknown;
  pay_price: string | number;
  pay_count: string | number;
  refund_price: string | number;
  refund_count: string | number;
  coupon_price: string | number;
  coupon_count: string | number;
}

interface DistributionRow {
  [key: string]: unknown;
  dimension: string | number;
  value: string | number;
}

interface ProductBasicRow {
  [key: string]: unknown;
  browse_current: string | number;
  browse_previous: string | number;
  user_current: string | number;
  user_previous: string | number;
  cart_current: string | number;
  cart_previous: string | number;
  order_current: string | number;
  order_previous: string | number;
  pay_current: string | number;
  pay_previous: string | number;
  pay_price_current: string | number;
  pay_price_previous: string | number;
  cost_current: string | number;
  cost_previous: string | number;
  refund_price_current: string | number;
  refund_price_previous: string | number;
  refund_current: string | number;
  refund_previous: string | number;
  pay_people_current: string | number;
  pay_people_previous: string | number;
}

interface LegacyOverviewRow {
  [key: string]: unknown;
  today_count: string | number;
  today_sales: string | number;
  yesterday_count: string | number;
  yesterday_sales: string | number;
  total_count: string | number;
  total_sales: string | number;
  product_count: string | number;
  user_count: string | number;
  refund_count: string | number;
}

export function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function money(value: unknown): string {
  return numberValue(value).toFixed(2);
}

function shiftedDate(epochSeconds: number): Date {
  return new Date((epochSeconds + BUSINESS_OFFSET_SECONDS) * 1000);
}

export function businessMidnight(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month, day) / 1000) - BUSINESS_OFFSET_SECONDS;
}

export function startOfBusinessDay(epochSeconds: number): number {
  const date = shiftedDate(epochSeconds);
  return businessMidnight(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function dateKey(epochSeconds: number): string {
  const date = shiftedDate(epochSeconds);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

export function slashDate(epochSeconds: number): string {
  return dateKey(epochSeconds).replaceAll("-", "/");
}

function parseCalendarDate(match: RegExpMatchArray): number {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 2000 || year > 2100 ||
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new ValidateException("统计日期无效");
  }
  return businessMidnight(year, month - 1, day);
}

function buildBuckets(start: number, endExclusive: number, days: number): Pick<
  AdminStatisticRange,
  "granularity" | "bucketKeys" | "labels" | "sqlPattern"
> {
  if (days === 1) {
    const keys = Array.from({ length: 24 }, (_, index) => pad2(index));
    return { granularity: "hour", bucketKeys: keys, labels: keys, sqlPattern: "HH24" };
  }
  if (days <= 31) {
    const keys = Array.from({ length: days }, (_, index) => dateKey(start + index * DAY_SECONDS));
    return { granularity: "day", bucketKeys: keys, labels: keys, sqlPattern: "YYYY-MM-DD" };
  }
  if (days <= 92) {
    const keys: string[] = [];
    for (let offset = 0; offset < days; offset += 3) keys.push(dateKey(start + offset * DAY_SECONDS));
    return { granularity: "three_day", bucketKeys: keys, labels: keys, sqlPattern: "YYYY-MM-DD" };
  }

  const keys: string[] = [];
  const startDate = shiftedDate(start);
  let year = startDate.getUTCFullYear();
  let month = startDate.getUTCMonth();
  while (businessMidnight(year, month, 1) < endExclusive) {
    keys.push(`${year}-${pad2(month + 1)}`);
    month += 1;
    if (month > 11) {
      year += 1;
      month = 0;
    }
  }
  return { granularity: "month", bucketKeys: keys, labels: keys, sqlPattern: "YYYY-MM" };
}

export function parseAdminStatisticRange(
  rawValue?: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): AdminStatisticRange {
  let start: number;
  let endDay: number;
  const value = rawValue?.trim() ?? "";
  if (!value) {
    endDay = startOfBusinessDay(nowSeconds);
    start = endDay - 29 * DAY_SECONDS;
  } else {
    const matches = Array.from(value.matchAll(/(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/g));
    if (matches.length !== 2) throw new ValidateException("time/data 必须包含起止日期");
    start = parseCalendarDate(matches[0]);
    endDay = parseCalendarDate(matches[1]);
  }
  if (endDay < start) throw new ValidateException("统计结束日期不能早于开始日期");
  const days = Math.floor((endDay - start) / DAY_SECONDS) + 1;
  if (days > MAX_RANGE_DAYS) throw new ValidateException(`统计跨度不能超过 ${MAX_RANGE_DAYS} 天`);
  const endExclusive = endDay + DAY_SECONDS;
  return {
    start,
    endExclusive,
    previousStart: start - days * DAY_SECONDS,
    days,
    ...buildBuckets(start, endExclusive, days),
  };
}

export function statisticComparison(current: number, previous: number): MetricComparison {
  const denominator = previous > 0 ? previous : 1;
  return { num: round(current), percent: round(((current - previous) / denominator) * 100) };
}

export function parseProductRankingSort(value?: string): AdminProductRankingSort {
  const sort = value?.trim() || "visit";
  const allowed = new Set<AdminProductRankingSort>([
    "visit", "user", "cart", "orders", "pay", "price", "profit", "collect", "changes",
  ]);
  if (!allowed.has(sort as AdminProductRankingSort)) throw new ValidateException("商品排行排序字段无效");
  return sort as AdminProductRankingSort;
}

export function parseCategoryIds(values: string[]): number[] {
  const result = new Set<number>();
  for (const value of values) {
    for (const part of value.split(",")) {
      if (!part.trim()) continue;
      const id = Number(part);
      if (!Number.isSafeInteger(id) || id <= 0) throw new ValidateException("商品分类参数无效");
      result.add(id);
    }
  }
  return [...result].slice(0, 100);
}

function aggregateBucket(range: AdminStatisticRange, rawKey: string): string | null {
  const key = rawKey.trim();
  if (range.granularity !== "three_day") return range.bucketKeys.includes(key) ? key : null;
  const match = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const epoch = businessMidnight(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const dayOffset = Math.floor((epoch - range.start) / DAY_SECONDS);
  if (dayOffset < 0 || dayOffset >= range.days) return null;
  return range.bucketKeys[Math.floor(dayOffset / 3)] ?? null;
}

export function seriesValues(range: AdminStatisticRange, rows: AggregateRow[], metric: string): number[] {
  const values = new Map<string, number>();
  for (const row of rows) {
    if (row.metric !== metric) continue;
    const key = aggregateBucket(range, row.bucket);
    if (key) values.set(key, (values.get(key) ?? 0) + numberValue(row.value));
  }
  return range.bucketKeys.map((key) => round(values.get(key) ?? 0));
}

function distribution(
  labels: string[],
  colors: string[],
  rows: DistributionRow[],
): StatisticDistribution {
  const values = new Map(rows.map((row) => [Number(row.dimension), numberValue(row.value)]));
  const bingData = labels.map((name, index) => ({
    name,
    value: round(values.get(index) ?? 0),
    itemStyle: { color: colors[index] },
  }));
  const total = bingData.reduce((sum, item) => sum + item.value, 0);
  const list = bingData
    .map((item) => ({ ...item, percent: total === 0 ? 0 : round((item.value / total) * 100) }))
    .sort((left, right) => right.value - left.value)
    .map(({ name, value, percent }) => ({ name, value, percent }));
  return { bing_xdata: labels, bing_data: bingData, list };
}

export function trendKey(column: SQL, range: AdminStatisticRange): SQL {
  return sql`to_char(to_timestamp(${column}) AT TIME ZONE 'Asia/Shanghai', ${range.sqlPattern})`;
}

export class AdminStatisticService {
  constructor(private readonly container: Container) {}

  async orderBasic(range: AdminStatisticRange): Promise<AdminOrderBasic> {
    const rows = await this.container.db.execute<OrderBasicRow>(sql`
      SELECT
        COALESCE(SUM(pay_price) FILTER (
          WHERE paid = 1 AND pid = 0 AND add_time >= ${range.start} AND add_time < ${range.endExclusive}
        ), 0)::text AS pay_price,
        COUNT(*) FILTER (
          WHERE paid = 1 AND pid = 0 AND add_time >= ${range.start} AND add_time < ${range.endExclusive}
        )::int AS pay_count,
        COALESCE(SUM(refund_price) FILTER (
          WHERE paid = 1 AND pid = 0 AND refund_status > 0
            AND refund_reason_time >= ${range.start} AND refund_reason_time < ${range.endExclusive}
        ), 0)::text AS refund_price,
        COUNT(*) FILTER (
          WHERE paid = 1 AND pid = 0 AND refund_status > 0
            AND refund_reason_time >= ${range.start} AND refund_reason_time < ${range.endExclusive}
        )::int AS refund_count,
        COALESCE(SUM(coupon_price) FILTER (
          WHERE paid = 1 AND pid = 0 AND coupon_id > 0
            AND add_time >= ${range.start} AND add_time < ${range.endExclusive}
        ), 0)::text AS coupon_price,
        COUNT(*) FILTER (
          WHERE paid = 1 AND pid = 0 AND coupon_id > 0
            AND add_time >= ${range.start} AND add_time < ${range.endExclusive}
        )::int AS coupon_count
      FROM store_order
      WHERE is_del = 0 AND is_system_del = 0
    `);
    const row = rows[0];
    if (!row) throw new Error("订单基础统计未返回数据");
    return {
      pay_price: money(row.pay_price),
      pay_count: numberValue(row.pay_count),
      refund_price: money(row.refund_price),
      refund_count: numberValue(row.refund_count),
      coupon_price: money(row.coupon_price),
      coupon_count: numberValue(row.coupon_count),
    };
  }

  async orderTrend(range: AdminStatisticRange): Promise<{ xAxis: string[]; series: StatisticSeries[] }> {
    const orderKey = trendKey(sql.raw("add_time"), range);
    const refundKey = trendKey(sql.raw("refund_reason_time"), range);
    const rows = await this.container.db.execute<AggregateRow>(sql`
      SELECT '订单金额' AS metric, ${orderKey} AS bucket, COALESCE(SUM(pay_price), 0)::text AS value
      FROM store_order
      WHERE pid = 0 AND paid = 1 AND is_del = 0 AND is_system_del = 0
        AND add_time >= ${range.start} AND add_time < ${range.endExclusive}
      GROUP BY 2
      UNION ALL
      SELECT '订单量', ${orderKey}, COUNT(*)::text
      FROM store_order
      WHERE pid = 0 AND paid = 1 AND is_del = 0 AND is_system_del = 0
        AND add_time >= ${range.start} AND add_time < ${range.endExclusive}
      GROUP BY 2
      UNION ALL
      SELECT '退款金额', ${refundKey}, COALESCE(SUM(refund_price), 0)::text
      FROM store_order
      WHERE pid = 0 AND paid = 1 AND refund_status > 0 AND is_del = 0 AND is_system_del = 0
        AND refund_reason_time >= ${range.start} AND refund_reason_time < ${range.endExclusive}
      GROUP BY 2
      UNION ALL
      SELECT '退款订单量', ${refundKey}, COUNT(*)::text
      FROM store_order
      WHERE pid = 0 AND paid = 1 AND refund_status > 0 AND is_del = 0 AND is_system_del = 0
        AND refund_reason_time >= ${range.start} AND refund_reason_time < ${range.endExclusive}
      GROUP BY 2
      UNION ALL
      SELECT '用券金额', ${orderKey}, COALESCE(SUM(coupon_price), 0)::text
      FROM store_order
      WHERE pid = 0 AND paid = 1 AND coupon_id > 0 AND is_del = 0 AND is_system_del = 0
        AND add_time >= ${range.start} AND add_time < ${range.endExclusive}
      GROUP BY 2
      UNION ALL
      SELECT '用券数量', ${orderKey}, COUNT(*)::text
      FROM store_order
      WHERE pid = 0 AND paid = 1 AND coupon_id > 0 AND is_del = 0 AND is_system_del = 0
        AND add_time >= ${range.start} AND add_time < ${range.endExclusive}
      GROUP BY 2
    `);
    const names = ["订单金额", "订单量", "退款金额", "退款订单量", "用券金额", "用券数量"];
    return {
      xAxis: range.labels,
      series: names.map((name) => ({ name, data: seriesValues(range, rows, name), type: "line" })),
    };
  }

  async orderChannel(range: AdminStatisticRange): Promise<StatisticDistribution> {
    const rows = await this.container.db.execute<DistributionRow>(sql`
      SELECT is_channel AS dimension, COUNT(*)::int AS value
      FROM store_order
      WHERE pid = 0 AND paid = 1 AND is_del = 0 AND is_system_del = 0
        AND add_time >= ${range.start} AND add_time < ${range.endExclusive}
        AND is_channel BETWEEN 0 AND 4
      GROUP BY is_channel
    `);
    return distribution(
      ["公众号", "小程序", "H5", "PC", "APP"],
      ["#64a1f4", "#3edeb5", "#70869f", "#ffc653", "#fc7d6a"],
      rows,
    );
  }

  async orderType(range: AdminStatisticRange): Promise<StatisticDistribution> {
    const rows = await this.container.db.execute<DistributionRow>(sql`
      SELECT type AS dimension, COALESCE(SUM(pay_price), 0)::text AS value
      FROM store_order
      WHERE pid = 0 AND paid = 1 AND is_del = 0 AND is_system_del = 0
        AND add_time >= ${range.start} AND add_time < ${range.endExclusive}
        AND type BETWEEN 0 AND 8
      GROUP BY type
    `);
    return distribution(
      ["普通订单", "秒杀订单", "砍价订单", "拼团订单", "积分订单", "套餐订单", "预售订单", "新人订单", "抽奖订单"],
      ["#64a1f4", "#3edeb5", "#70869f", "#ffc653", "#f6a623", "#fc7d6a", "#b37feb", "#ff85c0", "#6dd230"],
      rows,
    );
  }

  async productBasic(range: AdminStatisticRange): Promise<AdminProductBasic> {
    const rows = await this.container.db.execute<ProductBasicRow>(sql`
      WITH visit_stats AS (
        SELECT
          COALESCE(SUM(count) FILTER (WHERE add_time >= ${range.start}), 0)::text AS browse_current,
          COALESCE(SUM(count) FILTER (WHERE add_time < ${range.start}), 0)::text AS browse_previous,
          COUNT(DISTINCT uid) FILTER (WHERE add_time >= ${range.start})::int AS user_current,
          COUNT(DISTINCT uid) FILTER (WHERE add_time < ${range.start})::int AS user_previous
        FROM store_visit
        WHERE add_time >= ${range.previousStart} AND add_time < ${range.endExclusive}
      ), cart_stats AS (
        SELECT
          COALESCE(SUM(cart_num) FILTER (WHERE add_time >= ${range.start}), 0)::text AS cart_current,
          COALESCE(SUM(cart_num) FILTER (WHERE add_time < ${range.start}), 0)::text AS cart_previous
        FROM store_cart
        WHERE add_time >= ${range.previousStart} AND add_time < ${range.endExclusive}
      ), order_stats AS (
        SELECT
          COALESCE(SUM(total_num) FILTER (WHERE add_time >= ${range.start}), 0)::text AS order_current,
          COALESCE(SUM(total_num) FILTER (WHERE add_time < ${range.start}), 0)::text AS order_previous,
          COALESCE(SUM(total_num) FILTER (WHERE paid = 1 AND pay_time >= ${range.start}), 0)::text AS pay_current,
          COALESCE(SUM(total_num) FILTER (WHERE paid = 1 AND pay_time < ${range.start}), 0)::text AS pay_previous,
          COALESCE(SUM(pay_price) FILTER (WHERE paid = 1 AND pay_time >= ${range.start}), 0)::text AS pay_price_current,
          COALESCE(SUM(pay_price) FILTER (WHERE paid = 1 AND pay_time < ${range.start}), 0)::text AS pay_price_previous,
          COALESCE(SUM(cost) FILTER (WHERE paid = 1 AND pay_time >= ${range.start}), 0)::text AS cost_current,
          COALESCE(SUM(cost) FILTER (WHERE paid = 1 AND pay_time < ${range.start}), 0)::text AS cost_previous,
          COUNT(DISTINCT uid) FILTER (WHERE paid = 1 AND pay_time >= ${range.start})::int AS pay_people_current,
          COUNT(DISTINCT uid) FILTER (WHERE paid = 1 AND pay_time < ${range.start})::int AS pay_people_previous
        FROM store_order
        WHERE pid = 0 AND is_del = 0 AND is_system_del = 0
          AND (
            (add_time >= ${range.previousStart} AND add_time < ${range.endExclusive}) OR
            (pay_time >= ${range.previousStart} AND pay_time < ${range.endExclusive})
          )
      ), refund_stats AS (
        SELECT
          COALESCE(SUM(refunded_price) FILTER (WHERE add_time >= ${range.start}), 0)::text AS refund_price_current,
          COALESCE(SUM(refunded_price) FILTER (WHERE add_time < ${range.start}), 0)::text AS refund_price_previous,
          COALESCE(SUM(refund_num) FILTER (WHERE add_time >= ${range.start}), 0)::text AS refund_current,
          COALESCE(SUM(refund_num) FILTER (WHERE add_time < ${range.start}), 0)::text AS refund_previous
        FROM store_order_refund
        WHERE is_cancel = 0 AND is_del = 0 AND refund_type = 6
          AND add_time >= ${range.previousStart} AND add_time < ${range.endExclusive}
      )
      SELECT * FROM visit_stats CROSS JOIN cart_stats CROSS JOIN order_stats CROSS JOIN refund_stats
    `);
    const row = rows[0];
    if (!row) throw new Error("商品基础统计未返回数据");
    const currentVisitors = numberValue(row.user_current);
    const previousVisitors = numberValue(row.user_previous);
    const currentPayPercent = currentVisitors === 0 ? 0 : round(numberValue(row.pay_people_current) / currentVisitors * 100);
    const previousPayPercent = previousVisitors === 0 ? 0 : round(numberValue(row.pay_people_previous) / previousVisitors * 100);
    return {
      browse: statisticComparison(numberValue(row.browse_current), numberValue(row.browse_previous)),
      user: statisticComparison(currentVisitors, previousVisitors),
      cart: statisticComparison(numberValue(row.cart_current), numberValue(row.cart_previous)),
      order: statisticComparison(numberValue(row.order_current), numberValue(row.order_previous)),
      pay: statisticComparison(numberValue(row.pay_current), numberValue(row.pay_previous)),
      payPrice: statisticComparison(numberValue(row.pay_price_current), numberValue(row.pay_price_previous)),
      cost: statisticComparison(numberValue(row.cost_current), numberValue(row.cost_previous)),
      refundPrice: statisticComparison(numberValue(row.refund_price_current), numberValue(row.refund_price_previous)),
      refund: statisticComparison(numberValue(row.refund_current), numberValue(row.refund_previous)),
      payPercent: statisticComparison(currentPayPercent, previousPayPercent),
    };
  }

  async productTrend(range: AdminStatisticRange): Promise<{ xAxis: string[]; series: StatisticSeries[] }> {
    const visitKey = trendKey(sql.raw("add_time"), range);
    const payKey = trendKey(sql.raw("pay_time"), range);
    const rows = await this.container.db.execute<AggregateRow>(sql`
      SELECT '商品浏览量' AS metric, ${visitKey} AS bucket, COALESCE(SUM(count), 0)::text AS value
      FROM store_visit
      WHERE add_time >= ${range.start} AND add_time < ${range.endExclusive}
      GROUP BY 2
      UNION ALL
      SELECT '商品访客量', ${visitKey}, COUNT(DISTINCT uid)::text
      FROM store_visit
      WHERE add_time >= ${range.start} AND add_time < ${range.endExclusive}
      GROUP BY 2
      UNION ALL
      SELECT '支付金额', ${payKey}, COALESCE(SUM(pay_price), 0)::text
      FROM store_order
      WHERE pid = 0 AND paid = 1 AND is_del = 0 AND is_system_del = 0
        AND pay_time >= ${range.start} AND pay_time < ${range.endExclusive}
      GROUP BY 2
      UNION ALL
      SELECT '退款金额', ${visitKey}, COALESCE(SUM(refunded_price), 0)::text
      FROM store_order_refund
      WHERE is_cancel = 0 AND is_del = 0 AND refund_type = 6
        AND add_time >= ${range.start} AND add_time < ${range.endExclusive}
      GROUP BY 2
    `);
    const labels = range.labels.map((label) => range.granularity === "hour" || range.granularity === "month" ? label : label.slice(5));
    return {
      xAxis: labels,
      series: [
        { name: "商品浏览量", data: seriesValues(range, rows, "商品浏览量"), type: "line", smooth: "true", yAxisIndex: 1 },
        { name: "商品访客量", data: seriesValues(range, rows, "商品访客量"), type: "line", smooth: "true", yAxisIndex: 1 },
        { name: "支付金额", data: seriesValues(range, rows, "支付金额"), type: "bar" },
        { name: "退款金额", data: seriesValues(range, rows, "退款金额"), type: "bar" },
      ],
    };
  }

  async productRanking(
    range: AdminStatisticRange,
    sort: AdminProductRankingSort,
    categoryIds: number[] = [],
    limit = 20,
  ): Promise<AdminProductRankingRow[]> {
    const safeLimit = Math.min(50, Math.max(1, Math.trunc(limit) || 20));
    const categoryFilter = categoryIds.length
      ? sql`AND EXISTS (
          SELECT 1 FROM store_product_relation relation
          WHERE relation.product_id = log.product_id AND relation.type = 1
            AND relation.relation_id IN (${sql.join(categoryIds.map((id) => sql`${id}`), sql`, `)})
        )`
      : sql``;
    const sortExpression: Record<AdminProductRankingSort, SQL> = {
      visit: sql.raw('"visit"'),
      user: sql.raw('"user"'),
      cart: sql.raw('"cart"'),
      orders: sql.raw('"orders"'),
      pay: sql.raw('"pay"'),
      price: sql.raw('"price"'),
      profit: sql.raw('"profit"'),
      collect: sql.raw('"collect"'),
      changes: sql.raw('"changes"'),
    };
    const rows = await this.container.db.execute<Record<string, unknown>>(sql`
      WITH filtered AS MATERIALIZED (
        SELECT log.*
        FROM store_product_log log
        WHERE log.delete_time IS NULL
          AND log.add_time >= ${range.start} AND log.add_time < ${range.endExclusive}
          ${categoryFilter}
      ), repeaters AS (
        SELECT product_id, COUNT(*) FILTER (WHERE event_count > 1)::int AS repeat_buyers
        FROM (
          SELECT product_id, pay_uid, COUNT(*)::int AS event_count
          FROM filtered
          WHERE pay_uid > 0
          GROUP BY product_id, pay_uid
        ) repeated
        GROUP BY product_id
      )
      SELECT
        log.product_id,
        product.store_name,
        product.image,
        product.price::text AS product_price,
        product.stock,
        product.is_show,
        COALESCE(SUM(log.visit_num), 0)::int AS visit,
        COUNT(DISTINCT log.uid)::int AS "user",
        COALESCE(SUM(log.cart_num), 0)::int AS cart,
        COALESCE(SUM(log.order_num), 0)::int AS orders,
        COALESCE(SUM(log.pay_num), 0)::int AS pay,
        COALESCE(SUM(log.pay_price * log.pay_num), 0)::numeric AS price,
        COALESCE(SUM(log.cost_price), 0)::numeric AS cost,
        CASE WHEN SUM(log.pay_price * log.pay_num) > 0
          THEN ROUND((SUM(log.pay_price * log.pay_num) - SUM(log.cost_price)) / SUM(log.pay_price * log.pay_num) * 100, 2)
          ELSE 0 END AS profit,
        COALESCE(SUM(log.collect_num), 0)::int AS collect,
        CASE WHEN COUNT(DISTINCT log.uid) > 0
          THEN ROUND(COUNT(DISTINCT log.pay_uid) FILTER (WHERE log.pay_uid > 0)::numeric / COUNT(DISTINCT log.uid) * 100, 2)
          ELSE 0 END AS changes,
        CASE WHEN COUNT(DISTINCT log.pay_uid) FILTER (WHERE log.pay_uid > 0) > 0
          THEN ROUND(COALESCE(MAX(repeaters.repeat_buyers), 0)::numeric /
            (COUNT(DISTINCT log.pay_uid) FILTER (WHERE log.pay_uid > 0)), 2)
          ELSE 0 END AS repeats
      FROM filtered log
      JOIN store_product product ON product.id = log.product_id
      LEFT JOIN repeaters ON repeaters.product_id = log.product_id
      WHERE product.is_del = 0 AND product.store_name <> '' AND product.image <> ''
      GROUP BY log.product_id, product.store_name, product.image, product.price,
        product.stock, product.is_show
      ORDER BY ${sortExpression[sort]} DESC, log.product_id ASC
      LIMIT ${safeLimit}
    `);
    return rows.map((row) => ({
      product_id: numberValue(row.product_id),
      store_name: String(row.store_name ?? ""),
      image: String(row.image ?? ""),
      product_price: money(row.product_price),
      stock: numberValue(row.stock),
      is_show: numberValue(row.is_show),
      visit: numberValue(row.visit),
      user: numberValue(row.user),
      cart: numberValue(row.cart),
      orders: numberValue(row.orders),
      pay: numberValue(row.pay),
      price: round(numberValue(row.price)),
      cost: round(numberValue(row.cost)),
      profit: round(numberValue(row.profit)),
      collect: numberValue(row.collect),
      changes: round(numberValue(row.changes)),
      repeats: round(numberValue(row.repeats)),
    }));
  }

  async legacyOverview(nowSeconds = Math.floor(Date.now() / 1000)) {
    const todayStart = startOfBusinessDay(nowSeconds);
    const tomorrowStart = todayStart + DAY_SECONDS;
    const yesterdayStart = todayStart - DAY_SECONDS;
    const rows = await this.container.db.execute<LegacyOverviewRow>(sql`
      SELECT
        COUNT(*) FILTER (WHERE pid = 0 AND paid = 1 AND is_del = 0 AND is_system_del = 0
          AND pay_time >= ${todayStart} AND pay_time < ${tomorrowStart})::int AS today_count,
        COALESCE(SUM(pay_price) FILTER (WHERE pid = 0 AND paid = 1 AND is_del = 0 AND is_system_del = 0
          AND pay_time >= ${todayStart} AND pay_time < ${tomorrowStart}), 0)::text AS today_sales,
        COUNT(*) FILTER (WHERE pid = 0 AND paid = 1 AND is_del = 0 AND is_system_del = 0
          AND pay_time >= ${yesterdayStart} AND pay_time < ${todayStart})::int AS yesterday_count,
        COALESCE(SUM(pay_price) FILTER (WHERE pid = 0 AND paid = 1 AND is_del = 0 AND is_system_del = 0
          AND pay_time >= ${yesterdayStart} AND pay_time < ${todayStart}), 0)::text AS yesterday_sales,
        COUNT(*) FILTER (WHERE pid = 0 AND paid = 1 AND is_del = 0 AND is_system_del = 0)::int AS total_count,
        COALESCE(SUM(pay_price) FILTER (WHERE pid = 0 AND paid = 1 AND is_del = 0 AND is_system_del = 0), 0)::text AS total_sales,
        (SELECT COUNT(*)::int FROM store_product WHERE is_del = 0) AS product_count,
        (SELECT COUNT(*)::int FROM "user" WHERE delete_time IS NULL) AS user_count,
        (SELECT COUNT(*)::int FROM store_order_refund WHERE is_del = 0) AS refund_count
      FROM store_order
    `);
    const row = rows[0];
    if (!row) throw new Error("兼容统计概览未返回数据");
    return {
      today: { orderCount: numberValue(row.today_count), sales: money(row.today_sales) },
      yesterday: { orderCount: numberValue(row.yesterday_count), sales: money(row.yesterday_sales) },
      total: {
        orderCount: numberValue(row.total_count),
        sales: money(row.total_sales),
        productCount: numberValue(row.product_count),
        userCount: numberValue(row.user_count),
        refundCount: numberValue(row.refund_count),
      },
    };
  }

  async legacyTrend(days: number, nowSeconds = Math.floor(Date.now() / 1000)) {
    if (days !== 7 && days !== 30) throw new ValidateException("days 仅支持 7 或 30");
    const end = startOfBusinessDay(nowSeconds);
    const start = end - (days - 1) * DAY_SECONDS;
    const range = parseAdminStatisticRange(`${slashDate(start)}-${slashDate(end)}`, nowSeconds);
    const trend = await this.orderTrend(range);
    const count = trend.series.find((item) => item.name === "订单量")?.data ?? [];
    const sales = trend.series.find((item) => item.name === "订单金额")?.data ?? [];
    return range.bucketKeys.map((date, index) => ({
      date,
      orderCount: count[index] ?? 0,
      sales: sales[index] ?? 0,
    }));
  }

  async legacyRank(limit: number, nowSeconds = Math.floor(Date.now() / 1000)) {
    const end = startOfBusinessDay(nowSeconds);
    const range = parseAdminStatisticRange(`${slashDate(end - 29 * DAY_SECONDS)}-${slashDate(end)}`, nowSeconds);
    const rows = await this.productRanking(range, "pay", [], limit);
    return rows.map((row) => ({ productId: row.product_id, name: row.store_name, salesCount: row.pay }));
  }
}
