/**
 * Admin 用户、交易与余额统计，以及用户/商品导出。
 *
 * 兼容 cinashop-php 的响应字段，同时统一采用 Asia/Shanghai、左闭右开
 * 时间窗、有效根订单与软删除过滤。所有排序及渠道字段均经白名单校验。
 */
import { sql, type SQL } from "drizzle-orm";
import type { Container } from "@/lib/di";
import { ValidateException } from "@/utils/errors";
import {
  businessMidnight,
  numberValue,
  parseAdminStatisticRange,
  round,
  seriesValues,
  slashDate,
  startOfBusinessDay,
  statisticComparison,
  trendKey,
  type AdminStatisticRange,
  type AggregateRow,
  type MetricComparison,
  type StatisticDistribution,
  type StatisticSeries,
} from "./AdminStatisticService";

const DAY_SECONDS = 86_400;
const CHANNELS = new Set(["wechat", "routine", "h5", "pc", "app"]);

export type AdminStatisticChannel = "" | "wechat" | "routine" | "h5" | "pc" | "app";
export type UserRegionSort = "allNum" | "newNum" | "visitNum" | "payPrice";

export interface UserMetricComparison extends MetricComparison {
  last_num: number;
}

export type AdminUserBasic = Record<
  | "people" | "browse" | "newUser" | "payPeople" | "payPercent" | "payUser"
  | "rechargePeople" | "payPrice" | "cumulativeUser" | "cumulativePayUser"
  | "cumulativeRechargePeople" | "cumulativePayPeople",
  UserMetricComparison
>;

export interface ValueSeries {
  name: string;
  value: number[];
}

export interface ExportMetadata {
  header: string[];
  filekey: string[];
  export: Array<Record<string, string | number>>;
  filename: string;
}

export interface UserRegionRow {
  province: string;
  allNum: number;
  newNum: number;
  visitNum: number;
  payPrice: number;
}

export interface TradeSeries {
  name: string;
  desc: string;
  money: number;
  type: 0 | 1;
  rate: number;
  value: number[];
}

export interface TradeBottom {
  x: string[];
  series: TradeSeries[];
  export: string;
}

interface ExtendedAggregateRow extends AggregateRow {
  period?: "current" | "previous";
}

interface UserBasicRow {
  [key: string]: unknown;
}

interface DistributionStringRow {
  [key: string]: unknown;
  dimension: string;
  value: string | number;
}

interface TradeSnapshot {
  current: Map<string, number>;
  previous: Map<string, number>;
  currentVectors: Map<string, number[]>;
  previousVectors: Map<string, number[]>;
}

function channelClause(column: SQL, channel: AdminStatisticChannel): SQL {
  return channel ? sql`AND ${column} = ${channel}` : sql``;
}

function displayLabels(range: AdminStatisticRange): string[] {
  return range.labels.map((label) =>
    range.granularity === "hour" || range.granularity === "month" ? label : label.slice(5));
}

function comparison(current: number, previous: number): UserMetricComparison {
  const result = statisticComparison(current, previous);
  return { ...result, last_num: round(previous) };
}

function metricValue(rows: ExtendedAggregateRow[], metric: string, period: "current" | "previous"): number {
  return round(rows
    .filter((row) => row.metric === metric && row.period === period)
    .reduce((sum, row) => sum + numberValue(row.value), 0));
}

function periodSeries(
  range: AdminStatisticRange,
  rows: ExtendedAggregateRow[],
  metric: string,
  period: "current" | "previous",
): number[] {
  return seriesValues(range, rows.filter((row) => row.period === period), metric);
}

function addVectors(...vectors: number[][]): number[] {
  const size = Math.max(0, ...vectors.map((item) => item.length));
  return Array.from({ length: size }, (_, index) =>
    round(vectors.reduce((sum, vector) => sum + (vector[index] ?? 0), 0)));
}

function subtractVectors(left: number[], right: number[]): number[] {
  return left.map((value, index) => round(value - (right[index] ?? 0)));
}

function stringDistribution(
  labels: string[],
  types: string[],
  colors: string[],
  rows: DistributionStringRow[],
): StatisticDistribution {
  const values = new Map(rows.map((row) => [String(row.dimension), numberValue(row.value)]));
  const bingData = labels.map((name, index) => ({
    name,
    value: round(values.get(types[index]) ?? 0),
    itemStyle: { color: colors[index] },
  }));
  const total = bingData.reduce((sum, item) => sum + item.value, 0);
  const list = bingData
    .map(({ name, value }) => ({ name, value, percent: total ? round(value / total * 100) : 0 }))
    .sort((left, right) => right.value - left.value);
  return { bing_xdata: labels, bing_data: bingData, list };
}

function filename(prefix: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const date = new Date((nowSeconds + 8 * 3600) * 1000);
  const compact = [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
    String(date.getUTCHours()).padStart(2, "0"),
    String(date.getUTCMinutes()).padStart(2, "0"),
    String(date.getUTCSeconds()).padStart(2, "0"),
  ].join("");
  return `${prefix}_${compact}`;
}

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvDataUri(headers: string[], rows: Array<Array<string | number>>): string {
  const body = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  return `data:text/csv;charset=utf-8,${encodeURIComponent(`\uFEFF${body}`)}`;
}

export function parseAdminStatisticChannel(value?: string): AdminStatisticChannel {
  const channel = value?.trim().toLowerCase() ?? "";
  if (!channel || channel === "all") return "";
  if (!CHANNELS.has(channel)) throw new ValidateException("用户统计渠道无效");
  return channel as AdminStatisticChannel;
}

export function parseUserRegionSort(value?: string): UserRegionSort {
  const sort = value?.trim() || "allNum";
  if (!["allNum", "newNum", "visitNum", "payPrice"].includes(sort)) {
    throw new ValidateException("用户地域排序字段无效");
  }
  return sort as UserRegionSort;
}

export class AdminExtendedStatisticService {
  constructor(private readonly container: Container) {}

  async userBasic(range: AdminStatisticRange, channel: AdminStatisticChannel): Promise<AdminUserBasic> {
    const rows = await this.container.db.execute<UserBasicRow>(sql`
      WITH visits AS (
        SELECT
          COUNT(DISTINCT uid) FILTER (WHERE add_time >= ${range.start})::int AS people_current,
          COUNT(DISTINCT uid) FILTER (WHERE add_time < ${range.start})::int AS people_previous,
          COUNT(*) FILTER (WHERE add_time >= ${range.start})::int AS browse_current,
          COUNT(*) FILTER (WHERE add_time < ${range.start})::int AS browse_previous
        FROM user_visit
        WHERE add_time >= ${range.previousStart} AND add_time < ${range.endExclusive}
          ${channelClause(sql.raw("channel_type"), channel)}
      ), users AS (
        SELECT
          COUNT(*) FILTER (WHERE add_time >= ${range.start})::int AS new_current,
          COUNT(*) FILTER (WHERE add_time < ${range.start})::int AS new_previous,
          COUNT(*) FILTER (WHERE add_time < ${range.endExclusive})::int AS cumulative_current,
          COUNT(*) FILTER (WHERE add_time < ${range.start})::int AS cumulative_previous
        FROM "user"
        WHERE status = 1 AND is_del = 0 AND delete_time IS NULL
          ${channelClause(sql.raw("user_type"), channel)}
      ), orders AS (
        SELECT
          COUNT(DISTINCT uid) FILTER (WHERE pay_time >= ${range.start})::int AS paid_current,
          COUNT(DISTINCT uid) FILTER (WHERE pay_time < ${range.start})::int AS paid_previous,
          COALESCE(SUM(pay_price) FILTER (WHERE pay_time >= ${range.start}), 0)::text AS price_current,
          COALESCE(SUM(pay_price) FILTER (WHERE pay_time < ${range.start}), 0)::text AS price_previous,
          COUNT(DISTINCT uid) FILTER (WHERE pay_time < ${range.endExclusive})::int AS cumulative_current,
          COUNT(DISTINCT uid) FILTER (WHERE pay_time < ${range.start})::int AS cumulative_previous
        FROM store_order
        WHERE pid = 0 AND paid = 1 AND is_del = 0 AND is_system_del = 0
          AND pay_time >= 0 AND pay_time < ${range.endExclusive}
          ${channelClause(sql.raw("channel_type"), channel)}
      ), recharges AS (
        SELECT
          COUNT(DISTINCT uid) FILTER (WHERE pay_time >= ${range.start})::int AS current,
          COUNT(DISTINCT uid) FILTER (WHERE pay_time >= ${range.previousStart} AND pay_time < ${range.start})::int AS previous,
          COUNT(DISTINCT uid) FILTER (WHERE pay_time < ${range.endExclusive})::int AS cumulative_current,
          COUNT(DISTINCT uid) FILTER (WHERE pay_time < ${range.start})::int AS cumulative_previous
        FROM user_recharge
        WHERE paid = 1 AND pay_time >= 0 AND pay_time < ${range.endExclusive}
          ${channelClause(sql.raw("channel_type"), channel)}
      ), members AS (
        SELECT
          COUNT(DISTINCT uid) FILTER (WHERE pay_time >= ${range.start})::int AS current,
          COUNT(DISTINCT uid) FILTER (WHERE pay_time >= ${range.previousStart} AND pay_time < ${range.start})::int AS previous,
          COUNT(DISTINCT uid) FILTER (
            WHERE pay_time < ${range.endExclusive}
              AND (is_permanent = 1 OR overdue_time >= ${range.endExclusive})
          )::int AS cumulative_current,
          COUNT(DISTINCT uid) FILTER (
            WHERE pay_time < ${range.start}
              AND (is_permanent = 1 OR overdue_time >= ${range.start})
          )::int AS cumulative_previous
        FROM other_order
        WHERE type = 1 AND paid = 1 AND is_del = 0
          ${channelClause(sql.raw("channel_type"), channel)}
      )
      SELECT
        visits.people_current, visits.people_previous,
        visits.browse_current, visits.browse_previous,
        users.new_current, users.new_previous,
        users.cumulative_current AS cumulative_user_current,
        users.cumulative_previous AS cumulative_user_previous,
        orders.paid_current, orders.paid_previous,
        orders.price_current, orders.price_previous,
        orders.cumulative_current AS cumulative_paid_current,
        orders.cumulative_previous AS cumulative_paid_previous,
        recharges.current AS recharge_current, recharges.previous AS recharge_previous,
        recharges.cumulative_current AS cumulative_recharge_current,
        recharges.cumulative_previous AS cumulative_recharge_previous,
        members.current AS member_current, members.previous AS member_previous,
        members.cumulative_current AS cumulative_member_current,
        members.cumulative_previous AS cumulative_member_previous
      FROM visits CROSS JOIN users CROSS JOIN orders CROSS JOIN recharges CROSS JOIN members
    `);
    const row = rows[0];
    if (!row) throw new Error("用户基础统计未返回数据");
    const people = numberValue(row.people_current);
    const lastPeople = numberValue(row.people_previous);
    const paid = numberValue(row.paid_current);
    const lastPaid = numberValue(row.paid_previous);
    const payPercent = people ? round(paid / people * 100) : 0;
    const lastPayPercent = lastPeople ? round(lastPaid / lastPeople * 100) : 0;
    const payPrice = paid ? round(numberValue(row.price_current) / paid) : 0;
    const lastPayPrice = lastPaid ? round(numberValue(row.price_previous) / lastPaid) : 0;
    return {
      people: comparison(people, lastPeople),
      browse: comparison(numberValue(row.browse_current), numberValue(row.browse_previous)),
      newUser: comparison(numberValue(row.new_current), numberValue(row.new_previous)),
      payPeople: comparison(paid, lastPaid),
      payPercent: comparison(payPercent, lastPayPercent),
      payUser: comparison(numberValue(row.member_current), numberValue(row.member_previous)),
      rechargePeople: comparison(numberValue(row.recharge_current), numberValue(row.recharge_previous)),
      payPrice: comparison(payPrice, lastPayPrice),
      cumulativeUser: comparison(numberValue(row.cumulative_user_current), numberValue(row.cumulative_user_previous)),
      cumulativePayUser: comparison(numberValue(row.cumulative_member_current), numberValue(row.cumulative_member_previous)),
      cumulativeRechargePeople: comparison(numberValue(row.cumulative_recharge_current), numberValue(row.cumulative_recharge_previous)),
      cumulativePayPeople: comparison(numberValue(row.cumulative_paid_current), numberValue(row.cumulative_paid_previous)),
    };
  }

  async userTrend(
    range: AdminStatisticRange,
    channel: AdminStatisticChannel,
  ): Promise<{ xAxis: string[]; series: ValueSeries[] }> {
    const userKey = trendKey(sql.raw("add_time"), range);
    const visitKey = trendKey(sql.raw("add_time"), range);
    const payKey = trendKey(sql.raw("pay_time"), range);
    const rows = await this.container.db.execute<AggregateRow>(sql`
      SELECT '新增用户数' AS metric, ${userKey} AS bucket, COUNT(*)::text AS value
      FROM "user"
      WHERE status = 1 AND is_del = 0 AND delete_time IS NULL
        AND add_time >= ${range.start} AND add_time < ${range.endExclusive}
        ${channelClause(sql.raw("user_type"), channel)}
      GROUP BY 2
      UNION ALL
      SELECT '访客数', ${visitKey}, COUNT(DISTINCT uid)::text
      FROM user_visit
      WHERE add_time >= ${range.start} AND add_time < ${range.endExclusive}
        ${channelClause(sql.raw("channel_type"), channel)}
      GROUP BY 2
      UNION ALL
      SELECT '成交用户数', ${payKey}, COUNT(DISTINCT uid)::text
      FROM store_order
      WHERE pid = 0 AND paid = 1 AND is_del = 0 AND is_system_del = 0
        AND pay_time >= ${range.start} AND pay_time < ${range.endExclusive}
        ${channelClause(sql.raw("channel_type"), channel)}
      GROUP BY 2
      UNION ALL
      SELECT '充值用户', ${payKey}, COUNT(DISTINCT uid)::text
      FROM user_recharge
      WHERE paid = 1 AND pay_time >= ${range.start} AND pay_time < ${range.endExclusive}
        ${channelClause(sql.raw("channel_type"), channel)}
      GROUP BY 2
      UNION ALL
      SELECT '激活付费用户数', ${payKey}, COUNT(DISTINCT uid)::text
      FROM other_order
      WHERE type = 1 AND paid = 1 AND is_del = 0
        AND pay_time >= ${range.start} AND pay_time < ${range.endExclusive}
        ${channelClause(sql.raw("channel_type"), channel)}
      GROUP BY 2
    `);
    const names = ["新增用户数", "访客数", "成交用户数", "充值用户", "激活付费用户数"];
    return {
      xAxis: displayLabels(range),
      series: names.map((name) => ({ name, value: seriesValues(range, rows, name) })),
    };
  }

  async userExport(
    range: AdminStatisticRange,
    channel: AdminStatisticChannel,
    nowSeconds = Math.floor(Date.now() / 1000),
  ): Promise<ExportMetadata> {
    const trend = await this.userTrend(range, channel);
    const visitKey = trendKey(sql.raw("add_time"), range);
    const payKey = trendKey(sql.raw("pay_time"), range);
    const extraRows = await this.container.db.execute<AggregateRow>(sql`
      SELECT '浏览量' AS metric, ${visitKey} AS bucket, COUNT(*)::text AS value
      FROM user_visit
      WHERE add_time >= ${range.start} AND add_time < ${range.endExclusive}
        ${channelClause(sql.raw("channel_type"), channel)}
      GROUP BY 2
      UNION ALL
      SELECT '支付金额', ${payKey}, COALESCE(SUM(pay_price), 0)::text
      FROM store_order
      WHERE pid = 0 AND paid = 1 AND is_del = 0 AND is_system_del = 0
        AND pay_time >= ${range.start} AND pay_time < ${range.endExclusive}
        ${channelClause(sql.raw("channel_type"), channel)}
      GROUP BY 2
    `);
    const byName = new Map(trend.series.map((item) => [item.name, item.value]));
    const visitors = byName.get("访客数") ?? [];
    const paid = byName.get("成交用户数") ?? [];
    const payMoney = seriesValues(range, extraRows, "支付金额");
    const browse = seriesValues(range, extraRows, "浏览量");
    const rows = displayLabels(range).map((time, index) => ({
      time,
      user: visitors[index] ?? 0,
      browse: browse[index] ?? 0,
      new: byName.get("新增用户数")?.[index] ?? 0,
      paid: paid[index] ?? 0,
      changes: visitors[index] ? Math.min(100, round((paid[index] ?? 0) / visitors[index] * 100)) : 0,
      vip: byName.get("激活付费用户数")?.[index] ?? 0,
      recharge: byName.get("充值用户")?.[index] ?? 0,
      payPrice: paid[index] ? round((payMoney[index] ?? 0) / paid[index]) : 0,
    }));
    return {
      header: ["日期/时间", "访客数", "浏览量", "新增用户数", "成交用户数", "访客-支付转化率", "付费会员数", "充值用户数", "客单价"],
      filekey: ["time", "user", "browse", "new", "paid", "changes", "vip", "recharge", "payPrice"],
      export: rows,
      filename: filename("用户统计", nowSeconds),
    };
  }

  async userWechat(range: AdminStatisticRange): Promise<Record<string, MetricComparison>> {
    const rows = await this.container.db.execute<Record<string, unknown>>(sql`
      SELECT
        COUNT(*) FILTER (WHERE subscribe = 1 AND subscribe_time >= ${range.start})::int AS subscribe_current,
        COUNT(*) FILTER (WHERE subscribe = 1 AND subscribe_time >= ${range.previousStart} AND subscribe_time < ${range.start})::int AS subscribe_previous,
        COUNT(*) FILTER (WHERE subscribe = 0 AND subscribe_time > 0 AND subscribe_time >= ${range.start})::int AS unsubscribe_current,
        COUNT(*) FILTER (WHERE subscribe = 0 AND subscribe_time > 0 AND subscribe_time >= ${range.previousStart} AND subscribe_time < ${range.start})::int AS unsubscribe_previous,
        COUNT(*) FILTER (WHERE subscribe = 1 AND subscribe_time < ${range.endExclusive})::int AS cumulative_subscribe_current,
        COUNT(*) FILTER (WHERE subscribe = 1 AND subscribe_time < ${range.start})::int AS cumulative_subscribe_previous,
        COUNT(*) FILTER (WHERE subscribe = 0 AND subscribe_time > 0 AND subscribe_time < ${range.endExclusive})::int AS cumulative_unsubscribe_current,
        COUNT(*) FILTER (WHERE subscribe = 0 AND subscribe_time > 0 AND subscribe_time < ${range.start})::int AS cumulative_unsubscribe_previous
      FROM wechat_user
      WHERE is_del = 0 AND user_type = 'wechat'
    `);
    const row = rows[0] ?? {};
    const subscribe = numberValue(row.subscribe_current);
    const lastSubscribe = numberValue(row.subscribe_previous);
    const unsubscribe = numberValue(row.unsubscribe_current);
    const lastUnsubscribe = numberValue(row.unsubscribe_previous);
    return {
      subscribe: statisticComparison(subscribe, lastSubscribe),
      unSubscribe: statisticComparison(unsubscribe, lastUnsubscribe),
      increaseSubscribe: statisticComparison(subscribe - unsubscribe, lastSubscribe - lastUnsubscribe),
      cumulativeSubscribe: statisticComparison(numberValue(row.cumulative_subscribe_current), numberValue(row.cumulative_subscribe_previous)),
      cumulativeUnSubscribe: statisticComparison(numberValue(row.cumulative_unsubscribe_current), numberValue(row.cumulative_unsubscribe_previous)),
    };
  }

  async userWechatTrend(range: AdminStatisticRange): Promise<{ xAxis: string[]; series: ValueSeries[] }> {
    const key = trendKey(sql.raw("subscribe_time"), range);
    const rows = await this.container.db.execute<AggregateRow>(sql`
      SELECT CASE WHEN subscribe = 1 THEN '新增关注用户' ELSE '新增取关用户' END AS metric,
        ${key} AS bucket, COUNT(*)::text AS value
      FROM wechat_user
      WHERE is_del = 0 AND user_type = 'wechat' AND subscribe_time > 0
        AND subscribe_time >= ${range.start} AND subscribe_time < ${range.endExclusive}
      GROUP BY 1, 2
    `);
    const baseRows = await this.container.db.execute<Record<string, unknown>>(sql`
      SELECT
        COUNT(*) FILTER (WHERE subscribe = 1 AND subscribe_time < ${range.start})::int AS subscribed,
        COUNT(*) FILTER (WHERE subscribe = 0 AND subscribe_time > 0 AND subscribe_time < ${range.start})::int AS unsubscribed
      FROM wechat_user
      WHERE is_del = 0 AND user_type = 'wechat'
    `);
    const subscribed = seriesValues(range, rows, "新增关注用户");
    const unsubscribed = seriesValues(range, rows, "新增取关用户");
    let cumulativeSubscribed = numberValue(baseRows[0]?.subscribed);
    let cumulativeUnsubscribed = numberValue(baseRows[0]?.unsubscribed);
    const cumulativeSubscribe = subscribed.map((value) => (cumulativeSubscribed += value));
    const cumulativeUnSubscribe = unsubscribed.map((value) => (cumulativeUnsubscribed += value));
    return {
      xAxis: displayLabels(range),
      series: [
        { name: "新增关注用户", value: subscribed },
        { name: "新增取关用户", value: unsubscribed },
        { name: "累计关注用户", value: cumulativeSubscribe },
        { name: "累计取关用户", value: cumulativeUnSubscribe },
        { name: "净增用户数", value: subscribed.map((value, index) => value - (unsubscribed[index] ?? 0)) },
      ],
    };
  }

  async userRegion(
    range: AdminStatisticRange,
    channel: AdminStatisticChannel,
    sort: UserRegionSort,
  ): Promise<UserRegionRow[]> {
    const rows = await this.container.db.execute<Record<string, unknown>>(sql`
      WITH address_users AS (
        SELECT COALESCE(NULLIF(TRIM(address.province), ''), '未知') AS province, address.uid,
          users.add_time
        FROM user_address address
        JOIN "user" users ON users.uid = address.uid
        WHERE address.is_del = 0 AND users.status = 1 AND users.is_del = 0 AND users.delete_time IS NULL
          ${channelClause(sql.raw("users.user_type"), channel)}
      ), address_stats AS (
        SELECT province, COUNT(DISTINCT uid)::int AS all_num,
          COUNT(DISTINCT uid) FILTER (WHERE add_time >= ${range.start} AND add_time < ${range.endExclusive})::int AS new_num
        FROM address_users GROUP BY province
      ), visit_stats AS (
        SELECT COALESCE(NULLIF(TRIM(province), ''), '未知') AS province,
          COUNT(DISTINCT uid)::int AS visit_num
        FROM user_visit
        WHERE add_time >= ${range.start} AND add_time < ${range.endExclusive}
          ${channelClause(sql.raw("channel_type"), channel)}
        GROUP BY 1
      ), pay_stats AS (
        SELECT COALESCE(NULLIF(TRIM(province), ''), NULLIF(split_part(TRIM(user_address), ' ', 1), ''), '未知') AS province,
          COALESCE(SUM(pay_price), 0)::text AS pay_price
        FROM store_order
        WHERE pid = 0 AND paid = 1 AND is_del = 0 AND is_system_del = 0
          AND pay_time >= ${range.start} AND pay_time < ${range.endExclusive}
          ${channelClause(sql.raw("channel_type"), channel)}
        GROUP BY 1
      ), provinces AS (
        SELECT province FROM address_stats UNION SELECT province FROM visit_stats UNION SELECT province FROM pay_stats
      )
      SELECT provinces.province,
        COALESCE(address_stats.all_num, 0)::int AS all_num,
        COALESCE(address_stats.new_num, 0)::int AS new_num,
        COALESCE(visit_stats.visit_num, 0)::int AS visit_num,
        COALESCE(pay_stats.pay_price, '0') AS pay_price
      FROM provinces
      LEFT JOIN address_stats USING (province)
      LEFT JOIN visit_stats USING (province)
      LEFT JOIN pay_stats USING (province)
    `);
    const values = rows.map((row) => ({
      province: String(row.province ?? "未知"),
      allNum: numberValue(row.all_num),
      newNum: numberValue(row.new_num),
      visitNum: numberValue(row.visit_num),
      payPrice: round(numberValue(row.pay_price)),
    }));
    return values.sort((left, right) => right[sort] - left[sort] || left.province.localeCompare(right.province, "zh-CN"));
  }

  async userSex(range: AdminStatisticRange, channel: AdminStatisticChannel) {
    const rows = await this.container.db.execute<Record<string, unknown>>(sql`
      SELECT CASE WHEN sex IN (1, 2) THEN sex ELSE 0 END AS sex, COUNT(*)::int AS value
      FROM "user"
      WHERE status = 1 AND is_del = 0 AND delete_time IS NULL
        AND add_time >= ${range.start} AND add_time < ${range.endExclusive}
        ${channelClause(sql.raw("user_type"), channel)}
      GROUP BY 1
    `);
    const values = new Map(rows.map((row) => [numberValue(row.sex), numberValue(row.value)]));
    return [
      { value: values.get(0) ?? 0, name: "未知", name_key: 0 },
      { value: values.get(1) ?? 0, name: "男", name_key: 1 },
      { value: values.get(2) ?? 0, name: "女", name_key: 2 },
    ];
  }

  async productExport(
    range: AdminStatisticRange,
    nowSeconds = Math.floor(Date.now() / 1000),
  ): Promise<ExportMetadata> {
    const visitKey = trendKey(sql.raw("add_time"), range);
    const cartKey = trendKey(sql.raw("add_time"), range);
    const orderKey = trendKey(sql.raw("add_time"), range);
    const payKey = trendKey(sql.raw("pay_time"), range);
    const refundKey = trendKey(sql.raw("COALESCE(NULLIF(refunded_time, 0), add_time)"), range);
    const rows = await this.container.db.execute<AggregateRow>(sql`
      SELECT 'browse' AS metric, ${visitKey} AS bucket, COALESCE(SUM(count), 0)::text AS value
      FROM store_visit WHERE add_time >= ${range.start} AND add_time < ${range.endExclusive} GROUP BY 2
      UNION ALL SELECT 'user', ${visitKey}, COUNT(DISTINCT uid)::text
      FROM store_visit WHERE add_time >= ${range.start} AND add_time < ${range.endExclusive} GROUP BY 2
      UNION ALL SELECT 'cart', ${cartKey}, COALESCE(SUM(cart_num), 0)::text
      FROM store_cart WHERE is_del = 0 AND add_time >= ${range.start} AND add_time < ${range.endExclusive} GROUP BY 2
      UNION ALL SELECT 'order', ${orderKey}, COALESCE(SUM(total_num), 0)::text
      FROM store_order WHERE pid = 0 AND is_del = 0 AND is_system_del = 0
        AND add_time >= ${range.start} AND add_time < ${range.endExclusive} GROUP BY 2
      UNION ALL SELECT 'payNum', ${payKey}, COALESCE(SUM(total_num), 0)::text
      FROM store_order WHERE pid = 0 AND paid = 1 AND is_del = 0 AND is_system_del = 0
        AND pay_time >= ${range.start} AND pay_time < ${range.endExclusive} GROUP BY 2
      UNION ALL SELECT 'pay', ${payKey}, COALESCE(SUM(pay_price), 0)::text
      FROM store_order WHERE pid = 0 AND paid = 1 AND is_del = 0 AND is_system_del = 0
        AND pay_time >= ${range.start} AND pay_time < ${range.endExclusive} GROUP BY 2
      UNION ALL SELECT 'cost', ${payKey}, COALESCE(SUM(cost), 0)::text
      FROM store_order WHERE pid = 0 AND paid = 1 AND is_del = 0 AND is_system_del = 0
        AND pay_time >= ${range.start} AND pay_time < ${range.endExclusive} GROUP BY 2
      UNION ALL SELECT 'payPeople', ${payKey}, COUNT(DISTINCT uid)::text
      FROM store_order WHERE pid = 0 AND paid = 1 AND is_del = 0 AND is_system_del = 0
        AND pay_time >= ${range.start} AND pay_time < ${range.endExclusive} GROUP BY 2
      UNION ALL SELECT 'refund', ${refundKey}, COALESCE(SUM(refunded_price), 0)::text
      FROM store_order_refund WHERE refund_type = 6 AND is_cancel = 0 AND is_del = 0
        AND COALESCE(NULLIF(refunded_time, 0), add_time) >= ${range.start}
        AND COALESCE(NULLIF(refunded_time, 0), add_time) < ${range.endExclusive} GROUP BY 2
      UNION ALL SELECT 'refundNum', ${refundKey}, COALESCE(SUM(refund_num), 0)::text
      FROM store_order_refund WHERE refund_type = 6 AND is_cancel = 0 AND is_del = 0
        AND COALESCE(NULLIF(refunded_time, 0), add_time) >= ${range.start}
        AND COALESCE(NULLIF(refunded_time, 0), add_time) < ${range.endExclusive} GROUP BY 2
    `);
    const metric = (name: string) => seriesValues(range, rows, name);
    const visitors = metric("user");
    const payPeople = metric("payPeople");
    const data = displayLabels(range).map((time, index) => ({
      time,
      browse: metric("browse")[index] ?? 0,
      user: visitors[index] ?? 0,
      cart: metric("cart")[index] ?? 0,
      order: metric("order")[index] ?? 0,
      payNum: metric("payNum")[index] ?? 0,
      pay: metric("pay")[index] ?? 0,
      cost: metric("cost")[index] ?? 0,
      refund: metric("refund")[index] ?? 0,
      refundNum: metric("refundNum")[index] ?? 0,
      changes: visitors[index] ? round((payPeople[index] ?? 0) / visitors[index] * 100) : 0,
    }));
    return {
      header: ["日期/时间", "商品浏览量", "商品访客数", "加购件数", "下单件数", "支付件数", "支付金额", "成本金额", "退款金额", "退款件数", "访客-支付转化率"],
      filekey: ["time", "browse", "user", "cart", "order", "payNum", "pay", "cost", "refund", "refundNum", "changes"],
      export: data,
      filename: filename("商品统计", nowSeconds),
    };
  }

  async balanceBasic(): Promise<{ now_balance: number; add_balance: number; sub_balance: number }> {
    const rows = await this.container.db.execute<Record<string, unknown>>(sql`
      SELECT
        (SELECT COALESCE(SUM(now_money), 0) FROM "user"
          WHERE status = 1 AND is_del = 0 AND delete_time IS NULL)::text AS now_balance,
        COALESCE(SUM(number) FILTER (WHERE pm = 1 AND status = 1), 0)::text AS add_balance,
        COALESCE(SUM(number) FILTER (WHERE pm = 0 AND status = 1), 0)::text AS sub_balance
      FROM user_money
    `);
    return {
      now_balance: round(numberValue(rows[0]?.now_balance)),
      add_balance: round(numberValue(rows[0]?.add_balance)),
      sub_balance: round(numberValue(rows[0]?.sub_balance)),
    };
  }

  async balanceTrend(range: AdminStatisticRange): Promise<{ xAxis: string[]; series: StatisticSeries[] }> {
    const key = trendKey(sql.raw("add_time"), range);
    const rows = await this.container.db.execute<AggregateRow>(sql`
      SELECT CASE WHEN pm = 1 THEN '余额积累' ELSE '余额消耗' END AS metric,
        ${key} AS bucket, COALESCE(SUM(number), 0)::text AS value
      FROM user_money
      WHERE status = 1 AND pm IN (0, 1)
        AND add_time >= ${range.start} AND add_time < ${range.endExclusive}
      GROUP BY 1, 2
    `);
    return {
      xAxis: displayLabels(range),
      series: ["余额积累", "余额消耗"].map((name) => ({
        name, data: seriesValues(range, rows, name), type: "line",
      })),
    };
  }

  private async balanceDistribution(
    range: AdminStatisticRange,
    pm: 0 | 1,
    labels: string[],
    types: string[],
    colors: string[],
  ): Promise<StatisticDistribution> {
    const rows = await this.container.db.execute<DistributionStringRow>(sql`
      SELECT type AS dimension, COALESCE(SUM(number), 0)::text AS value
      FROM user_money
      WHERE status = 1 AND pm = ${pm}
        AND add_time >= ${range.start} AND add_time < ${range.endExclusive}
        AND type IN (${sql.join(types.map((type) => sql`${type}`), sql`, `)})
      GROUP BY type
    `);
    return stringDistribution(labels, types, colors, rows);
  }

  balanceChannel(range: AdminStatisticRange): Promise<StatisticDistribution> {
    return this.balanceDistribution(
      range, 1,
      ["系统增加", "用户充值", "佣金提现", "抽奖赠送", "商品退款"],
      ["system_add", "recharge", "extract", "lottery_add", "pay_product_refund"],
      ["#64a1f4", "#3edeb5", "#70869f", "#ffc653", "#fc7d6a"],
    );
  }

  balanceType(range: AdminStatisticRange): Promise<StatisticDistribution> {
    return this.balanceDistribution(
      range, 0,
      ["系统减少", "充值退款", "购买商品"],
      ["system_sub", "recharge_refund", "pay_product"],
      ["#64a1f4", "#3edeb5", "#70869f"],
    );
  }

  private async tradeSnapshot(range: AdminStatisticRange): Promise<TradeSnapshot> {
    const orderKey = trendKey(sql.raw("pay_time"), range);
    const rechargeKey = trendKey(sql.raw("pay_time"), range);
    const moneyKey = trendKey(sql.raw("add_time"), range);
    const memberKey = trendKey(sql.raw("pay_time"), range);
    const extractKey = trendKey(sql.raw("add_time"), range);
    const refundTime = sql.raw("COALESCE(NULLIF(refunded_time, 0), add_time)");
    const refundKey = trendKey(refundTime, range);
    const period = (column: SQL) => sql`CASE WHEN ${column} >= ${range.start} THEN 'current' ELSE 'previous' END`;
    const rows = await this.container.db.execute<ExtendedAggregateRow>(sql`
      SELECT 'goods' AS metric, ${period(sql.raw("pay_time"))} AS period, ${orderKey} AS bucket,
        COALESCE(SUM(pay_price), 0)::text AS value
      FROM store_order
      WHERE pid = 0 AND paid = 1 AND refund_status IN (0, 3)
        AND is_del = 0 AND is_system_del = 0
        AND pay_time >= ${range.previousStart} AND pay_time < ${range.endExclusive}
      GROUP BY 1, 2, 3
      UNION ALL
      SELECT 'recharge', ${period(sql.raw("pay_time"))}, ${rechargeKey}, COALESCE(SUM(price), 0)::text
      FROM user_recharge
      WHERE store_id = 0 AND paid = 1 AND refund_price = 0
        AND pay_time >= ${range.previousStart} AND pay_time < ${range.endExclusive}
      GROUP BY 1, 2, 3
      UNION ALL
      SELECT 'admin_recharge', ${period(sql.raw("add_time"))}, ${moneyKey}, COALESCE(SUM(number), 0)::text
      FROM user_money
      WHERE status = 1 AND pm = 1 AND type = 'system_add'
        AND add_time >= ${range.previousStart} AND add_time < ${range.endExclusive}
      GROUP BY 1, 2, 3
      UNION ALL
      SELECT 'member', ${period(sql.raw("pay_time"))}, ${memberKey}, COALESCE(SUM(pay_price), 0)::text
      FROM other_order
      WHERE store_id = 0 AND type = 1 AND paid = 1 AND is_del = 0
        AND pay_time >= ${range.previousStart} AND pay_time < ${range.endExclusive}
      GROUP BY 1, 2, 3
      UNION ALL
      SELECT 'offline', ${period(sql.raw("pay_time"))}, ${memberKey}, COALESCE(SUM(pay_price), 0)::text
      FROM other_order
      WHERE store_id = 0 AND type = 3 AND paid = 1 AND is_del = 0
        AND pay_time >= ${range.previousStart} AND pay_time < ${range.endExclusive}
      GROUP BY 1, 2, 3
      UNION ALL
      SELECT 'balance_goods', ${period(sql.raw("pay_time"))}, ${orderKey}, COALESCE(SUM(pay_price), 0)::text
      FROM store_order
      WHERE pid = 0 AND paid = 1 AND refund_status IN (0, 3) AND pay_type = 'yue'
        AND is_del = 0 AND is_system_del = 0
        AND pay_time >= ${range.previousStart} AND pay_time < ${range.endExclusive}
      GROUP BY 1, 2, 3
      UNION ALL
      SELECT 'balance_member', ${period(sql.raw("pay_time"))}, ${memberKey}, COALESCE(SUM(pay_price), 0)::text
      FROM other_order
      WHERE store_id = 0 AND type = 1 AND paid = 1 AND is_del = 0 AND pay_type = 'yue'
        AND pay_time >= ${range.previousStart} AND pay_time < ${range.endExclusive}
      GROUP BY 1, 2, 3
      UNION ALL
      SELECT 'extract', ${period(sql.raw("add_time"))}, ${extractKey}, COALESCE(SUM(extract_price), 0)::text
      FROM user_extract
      WHERE status = 1 AND add_time >= ${range.previousStart} AND add_time < ${range.endExclusive}
      GROUP BY 1, 2, 3
      UNION ALL
      SELECT 'refund', ${period(refundTime)}, ${refundKey}, COALESCE(SUM(refunded_price), 0)::text
      FROM store_order_refund
      WHERE refund_type = 6 AND is_cancel = 0 AND is_del = 0
        AND ${refundTime} >= ${range.previousStart} AND ${refundTime} < ${range.endExclusive}
      GROUP BY 1, 2, 3
    `);
    const metrics = ["goods", "recharge", "admin_recharge", "member", "offline", "balance_goods", "balance_member", "extract", "refund"];
    const current = new Map(metrics.map((metric) => [metric, metricValue(rows, metric, "current")]));
    const previous = new Map(metrics.map((metric) => [metric, metricValue(rows, metric, "previous")]));
    const currentVectors = new Map(metrics.map((metric) => [metric, periodSeries(range, rows, metric, "current")]));
    const previousVectors = new Map(metrics.map((metric) => [metric, periodSeries(range, rows, metric, "previous")]));
    return { current, previous, currentVectors, previousVectors };
  }

  private tradeComposites(snapshot: TradeSnapshot, period: "current" | "previous") {
    const totals = snapshot[period];
    const vectors = period === "current" ? snapshot.currentVectors : snapshot.previousVectors;
    const get = (metric: string) => totals.get(metric) ?? 0;
    const vector = (metric: string) => vectors.get(metric) ?? [];
    const revenue = round(get("goods") + get("recharge") + get("admin_recharge") + get("member") + get("offline"));
    const balance = round(get("balance_goods") + get("balance_member"));
    const expense = round(balance + get("extract") + get("refund"));
    const revenueVector = addVectors(vector("goods"), vector("recharge"), vector("admin_recharge"), vector("member"), vector("offline"));
    const balanceVector = addVectors(vector("balance_goods"), vector("balance_member"));
    const expenseVector = addVectors(balanceVector, vector("extract"), vector("refund"));
    return {
      revenue,
      balance,
      expense,
      gross: round(revenue - expense),
      revenueVector,
      balanceVector,
      expenseVector,
      grossVector: subtractVectors(revenueVector, expenseVector),
    };
  }

  async tradeBottom(range: AdminStatisticRange): Promise<TradeBottom> {
    const snapshot = await this.tradeSnapshot(range);
    const current = this.tradeComposites(snapshot, "current");
    const previous = this.tradeComposites(snapshot, "previous");
    const metric = (name: string) => snapshot.current.get(name) ?? 0;
    const lastMetric = (name: string) => snapshot.previous.get(name) ?? 0;
    const vector = (name: string) => snapshot.currentVectors.get(name) ?? [];
    const definitions: Array<[string, string, number, number, number[], 0 | 1]> = [
      ["营业额", "商品支付金额、充值金额、购买付费会员金额、线下收银金额", current.revenue, previous.revenue, current.revenueVector, 1],
      ["交易毛利金额", "交易毛利金额 = 营业额 - 支出金额", current.gross, previous.gross, current.grossVector, 1],
      ["商品支付金额", "有效根商品订单的实际支付金额", metric("goods"), lastMetric("goods"), vector("goods"), 1],
      ["购买会员金额", "成功购买付费会员的金额", metric("member"), lastMetric("member"), vector("member"), 1],
      ["充值金额", "成功充值与后台余额增加金额", round(metric("recharge") + metric("admin_recharge")), round(lastMetric("recharge") + lastMetric("admin_recharge")), addVectors(vector("recharge"), vector("admin_recharge")), 1],
      ["线下收银金额", "线下扫码支付金额", metric("offline"), lastMetric("offline"), vector("offline"), 0],
      ["支出金额", "余额支付金额、支付佣金金额、商品退款金额", current.expense, previous.expense, current.expenseVector, 1],
      ["余额支付金额", "商品与会员订单使用余额实际支付的金额", current.balance, previous.balance, current.balanceVector, 0],
      ["支付佣金金额", "已成功支付的推广佣金", metric("extract"), lastMetric("extract"), vector("extract"), 0],
      ["商品退款金额", "已成功退款的商品金额", metric("refund"), lastMetric("refund"), vector("refund"), 0],
    ];
    const series = definitions.map(([name, desc, currentValue, previousValue, value, type]) => ({
      name,
      desc,
      money: round(currentValue),
      type,
      rate: statisticComparison(currentValue, previousValue).percent,
      value,
    }));
    const labels = displayLabels(range);
    return {
      x: labels,
      series,
      export: csvDataUri(
        ["时间", ...series.map((item) => item.name)],
        labels.map((label, index) => [label, ...series.map((item) => item.value[index] ?? 0)]),
      ),
    };
  }

  private async orderPulse(
    start: number,
    endExclusive: number,
    previousStart: number,
    previousEnd: number,
    pattern: "HH24" | "YYYY-MM-DD",
  ) {
    const key = sql`to_char(to_timestamp(pay_time) AT TIME ZONE 'Asia/Shanghai', ${pattern})`;
    const rows = await this.container.db.execute<Record<string, unknown>>(sql`
      SELECT CASE WHEN pay_time >= ${start} THEN 'current' ELSE 'previous' END AS period,
        ${key} AS bucket, COUNT(*)::int AS order_count, COUNT(DISTINCT uid)::int AS people_count
      FROM store_order
      WHERE pid = 0 AND paid = 1 AND refund_status IN (0, 3)
        AND is_del = 0 AND is_system_del = 0
        AND ((pay_time >= ${previousStart} AND pay_time < ${previousEnd})
          OR (pay_time >= ${start} AND pay_time < ${endExclusive}))
      GROUP BY 1, 2
    `);
    return rows;
  }

  async tradeTop(nowSeconds = Math.floor(Date.now() / 1000)) {
    const todayStart = startOfBusinessDay(nowSeconds);
    const todayRange = parseAdminStatisticRange(`${slashDate(todayStart)}-${slashDate(todayStart)}`, nowSeconds);
    const snapshot = await this.tradeSnapshot(todayRange);
    const current = this.tradeComposites(snapshot, "current");
    const previous = this.tradeComposites(snapshot, "previous");
    const todayPulse = await this.orderPulse(todayStart, todayStart + DAY_SECONDS, todayStart - DAY_SECONDS, todayStart, "HH24");
    const date = new Date((todayStart + 8 * 3600) * 1000);
    const monthStart = businessMidnight(date.getUTCFullYear(), date.getUTCMonth(), 1);
    const lastMonthStart = businessMidnight(date.getUTCFullYear(), date.getUTCMonth() - 1, 1);
    const monthPulse = await this.orderPulse(monthStart, todayStart + DAY_SECONDS, lastMonthStart, monthStart, "YYYY-MM-DD");
    const hours = Array.from({ length: 24 }, (_, index) => String(index).padStart(2, "0"));
    const monthRange = parseAdminStatisticRange(`${slashDate(monthStart)}-${slashDate(todayStart)}`, nowSeconds);
    const pulseSeries = (
      rows: Record<string, unknown>[],
      keys: string[],
      metric: "order_count" | "people_count",
      name: string,
    ) => {
      const currentRows = rows.filter((row) => row.period === "current");
      const previousRows = rows.filter((row) => row.period === "previous");
      const currentMap = new Map(currentRows.map((row) => [String(row.bucket), numberValue(row[metric])]));
      const nowValue = currentRows.reduce((sum, row) => sum + numberValue(row[metric]), 0);
      const lastValue = previousRows.reduce((sum, row) => sum + numberValue(row[metric]), 0);
      return {
        name,
        now_money: nowValue,
        last_money: lastValue,
        rate: statisticComparison(nowValue, lastValue).percent,
        value: keys.map((key) => currentMap.get(key) ?? 0),
      };
    };
    return {
      left: {
        name: "当日订单金额",
        x: hours.map((hour) => `${hour}时`),
        series: [
          { money: current.revenue, value: current.revenueVector },
          { money: previous.revenue, value: previous.revenueVector },
        ],
      },
      right: {
        today: {
          x: hours,
          series: [
            pulseSeries(todayPulse, hours, "order_count", "今日订单数"),
            pulseSeries(todayPulse, hours, "people_count", "今日支付人数"),
          ],
        },
        month: [
          pulseSeries(monthPulse, monthRange.bucketKeys, "order_count", "本月订单数"),
          pulseSeries(monthPulse, monthRange.bucketKeys, "people_count", "本月支付人数"),
        ],
      },
    };
  }
}
