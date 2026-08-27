/**
 * 管理后台首页统计。
 *
 * 对齐 PHP Common::homeStatics/orderChart/userChart/purchaseRanking，同时修复
 * PHP/早期 Worker 版本中的 UTC 切日、周期重叠与软删除数据混入问题。
 */
import { sql } from "drizzle-orm";
import type { Container } from "@/lib/di";
import { ValidateException } from "@/utils/errors";

const BUSINESS_TIMEZONE_OFFSET_SECONDS = 8 * 60 * 60;
const DAY_SECONDS = 24 * 60 * 60;

export type AdminHomeCycle = "thirtyday" | "week" | "month" | "year";

export interface AdminHomeStatCard {
  today: string | number;
  yesterday: string | number;
  today_ratio: number;
  total: string;
  date: "今日";
  title: string;
  total_name: string;
}

export interface AdminOrderChartSeries {
  name: string;
  type: "bar" | "line";
  itemStyle: Record<string, unknown>;
  data: number[];
  yAxisIndex?: 1;
}

export interface AdminOrderChartData {
  yAxis: { maxnum: number; maxprice: number };
  legend: string[];
  xAxis: string[];
  series: AdminOrderChartSeries[];
  pre_cycle: {
    count: { data: number };
    price: { data: number };
  };
  cycle: {
    count: { data: number; percent: number; is_plus: -1 | 0 | 1 };
    price: { data: number; percent: number; is_plus: -1 | 0 | 1 };
  };
}

export interface AdminUserChartData {
  legend: ["用户数"];
  yAxis: { maxnum: number };
  xAxis: string[];
  series: number[];
  bing_xdata: ["未消费用户", "消费一次用户", "留存客户", "回流客户"];
  bing_data: Array<{
    name: string;
    value: number;
    itemStyle: { color: string };
  }>;
}

export interface AdminDashboardPeriod {
  cycle: AdminHomeCycle;
  previousStart: number;
  currentStart: number;
  currentEnd: number;
  bucketPattern: "MM-DD" | "ID" | "DD" | "MM";
  bucketKeys: string[];
  labels: string[];
}

interface HeaderRow {
  [key: string]: unknown;
  sales_today: string | number;
  sales_yesterday: string | number;
  sales_month: string | number;
  order_today: string | number;
  order_yesterday: string | number;
  order_month: string | number;
  user_today: string | number;
  user_yesterday: string | number;
  user_month: string | number;
  visits_today: string | number;
  visits_yesterday: string | number;
  visits_month: string | number;
}

interface OrderAggregateRow {
  [key: string]: unknown;
  period: "previous" | "current";
  bucket: string;
  count: string | number;
  price: string | number;
}

interface UserAggregateRow {
  [key: string]: unknown;
  daily: Array<{ day: string; count: number | string }> | null;
  never_paid: string | number;
  paid_once: string | number;
  retained: string | number;
  returned: string | number;
}

const ORDER_AMOUNT_STYLE = {
  normal: {
    color: {
      x: 0,
      y: 0,
      x2: 0,
      y2: 1,
      colorStops: [
        { offset: 0, color: "#69cdff" },
        { offset: 0.5, color: "#3eb3f7" },
        { offset: 1, color: "#1495eb" },
      ],
    },
  },
};

const ORDER_COUNT_STYLE = {
  normal: {
    color: {
      x: 0,
      y: 0,
      x2: 0,
      y2: 1,
      colorStops: [
        { offset: 0, color: "#6fdeab" },
        { offset: 0.5, color: "#44d693" },
        { offset: 1, color: "#2cc981" },
      ],
    },
  },
};

function businessDate(nowSeconds: number): Date {
  return new Date((nowSeconds + BUSINESS_TIMEZONE_OFFSET_SECONDS) * 1000);
}

function businessMidnight(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month, day) / 1000) - BUSINESS_TIMEZONE_OFFSET_SECONDS;
}

function startOfBusinessDay(nowSeconds: number): number {
  const shifted = businessDate(nowSeconds);
  return businessMidnight(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  );
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function monthDay(epochSeconds: number): string {
  const shifted = businessDate(epochSeconds);
  return `${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

export function parseAdminHomeCycle(value?: string): AdminHomeCycle {
  const cycle = value?.trim() || "thirtyday";
  if (!new Set<AdminHomeCycle>(["thirtyday", "week", "month", "year"]).has(cycle as AdminHomeCycle)) {
    throw new ValidateException("cycle 仅支持 thirtyday、week、month、year");
  }
  return cycle as AdminHomeCycle;
}

/** Build non-overlapping Asia/Shanghai comparison windows with an exclusive end. */
export function buildAdminDashboardPeriod(
  cycle: AdminHomeCycle,
  nowSeconds = Math.floor(Date.now() / 1000),
): AdminDashboardPeriod {
  const todayStart = startOfBusinessDay(nowSeconds);
  const shifted = businessDate(nowSeconds);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth();

  if (cycle === "thirtyday") {
    const currentStart = todayStart - 29 * DAY_SECONDS;
    return {
      cycle,
      previousStart: currentStart - 30 * DAY_SECONDS,
      currentStart,
      currentEnd: todayStart + DAY_SECONDS,
      bucketPattern: "MM-DD",
      bucketKeys: Array.from({ length: 30 }, (_, index) => monthDay(currentStart + index * DAY_SECONDS)),
      labels: Array.from({ length: 30 }, (_, index) => monthDay(currentStart + index * DAY_SECONDS)),
    };
  }

  if (cycle === "week") {
    const day = shifted.getUTCDay();
    const mondayOffset = (day + 6) % 7;
    const currentStart = todayStart - mondayOffset * DAY_SECONDS;
    return {
      cycle,
      previousStart: currentStart - 7 * DAY_SECONDS,
      currentStart,
      currentEnd: currentStart + 7 * DAY_SECONDS,
      bucketPattern: "ID",
      bucketKeys: ["1", "2", "3", "4", "5", "6", "7"],
      labels: ["周一", "周二", "周三", "周四", "周五", "周六", "周日"],
    };
  }

  if (cycle === "month") {
    const currentStart = businessMidnight(year, month, 1);
    const previousStart = businessMidnight(year, month - 1, 1);
    const currentEnd = businessMidnight(year, month + 1, 1);
    const slots = Math.max(daysInMonth(year, month), daysInMonth(year, month - 1));
    const keys = Array.from({ length: slots }, (_, index) => pad2(index + 1));
    return {
      cycle,
      previousStart,
      currentStart,
      currentEnd,
      bucketPattern: "DD",
      bucketKeys: keys,
      labels: keys.map((key) => String(Number(key))),
    };
  }

  const currentStart = businessMidnight(year, 0, 1);
  return {
    cycle,
    previousStart: businessMidnight(year - 1, 0, 1),
    currentStart,
    currentEnd: businessMidnight(year + 1, 0, 1),
    bucketPattern: "MM",
    bucketKeys: Array.from({ length: 12 }, (_, index) => pad2(index + 1)),
    labels: Array.from({ length: 12 }, (_, index) => String(index + 1)),
  };
}

export function dashboardComparison(current: number, previous: number): {
  data: number;
  percent: number;
  is_plus: -1 | 0 | 1;
} {
  const difference = current - previous;
  const percent = Math.round((Math.abs(difference) / (previous === 0 ? 1 : previous)) * 10_000) / 100;
  return {
    data: current,
    percent,
    is_plus: difference > 0 ? 1 : difference < 0 ? -1 : 0,
  };
}

function countRate(current: number, previous: number): number {
  if (current === 0 && previous === 0) return 0;
  const denominator = previous === 0 ? 1 : previous;
  return Math.round(((current - previous) / denominator) * 10_000) / 100;
}

function number(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value: string | number | null | undefined): string {
  return number(value).toFixed(2);
}

export class AdminDashboardService {
  constructor(private readonly container: Container) {}

  async header(nowSeconds = Math.floor(Date.now() / 1000)): Promise<{ info: AdminHomeStatCard[] }> {
    const todayStart = startOfBusinessDay(nowSeconds);
    const tomorrowStart = todayStart + DAY_SECONDS;
    const yesterdayStart = todayStart - DAY_SECONDS;
    const shifted = businessDate(nowSeconds);
    const monthStart = businessMidnight(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1);
    const nextMonthStart = businessMidnight(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 1);

    const rows = await this.container.db.execute<HeaderRow>(sql`
      WITH order_stats AS (
        SELECT
          COALESCE(SUM(pay_price) FILTER (WHERE pay_time >= ${todayStart} AND pay_time < ${tomorrowStart}), 0)::text AS sales_today,
          COALESCE(SUM(pay_price) FILTER (WHERE pay_time >= ${yesterdayStart} AND pay_time < ${todayStart}), 0)::text AS sales_yesterday,
          COALESCE(SUM(pay_price) FILTER (WHERE pay_time >= ${monthStart} AND pay_time < ${nextMonthStart}), 0)::text AS sales_month,
          COUNT(*) FILTER (WHERE add_time >= ${todayStart} AND add_time < ${tomorrowStart})::int AS order_today,
          COUNT(*) FILTER (WHERE add_time >= ${yesterdayStart} AND add_time < ${todayStart})::int AS order_yesterday,
          COUNT(*) FILTER (WHERE add_time >= ${monthStart} AND add_time < ${nextMonthStart})::int AS order_month
        FROM store_order
        WHERE pid = 0 AND paid = 1 AND is_del = 0 AND is_system_del = 0 AND refund_status IN (0, 3)
      ), user_stats AS (
        SELECT
          COUNT(*) FILTER (WHERE add_time >= ${todayStart} AND add_time < ${tomorrowStart})::int AS user_today,
          COUNT(*) FILTER (WHERE add_time >= ${yesterdayStart} AND add_time < ${todayStart})::int AS user_yesterday,
          COUNT(*) FILTER (WHERE add_time >= ${monthStart} AND add_time < ${nextMonthStart})::int AS user_month
        FROM "user"
        WHERE delete_time IS NULL
      ), visit_stats AS (
        SELECT
          COUNT(*) FILTER (WHERE add_time >= ${todayStart} AND add_time < ${tomorrowStart})::int AS visits_today,
          COUNT(*) FILTER (WHERE add_time >= ${yesterdayStart} AND add_time < ${todayStart})::int AS visits_yesterday,
          COUNT(*) FILTER (WHERE add_time >= ${monthStart} AND add_time < ${nextMonthStart})::int AS visits_month
        FROM store_product_log
        WHERE type = 'visit' AND delete_time IS NULL
      )
      SELECT * FROM order_stats CROSS JOIN user_stats CROSS JOIN visit_stats
    `);
    const row = rows[0];
    if (!row) throw new Error("首页统计查询未返回数据");

    const salesToday = number(row.sales_today);
    const salesYesterday = number(row.sales_yesterday);
    const visitsToday = number(row.visits_today);
    const visitsYesterday = number(row.visits_yesterday);
    const orderToday = number(row.order_today);
    const orderYesterday = number(row.order_yesterday);
    const userToday = number(row.user_today);
    const userYesterday = number(row.user_yesterday);

    return {
      info: [
        {
          today: money(row.sales_today),
          yesterday: money(row.sales_yesterday),
          today_ratio: countRate(salesToday, salesYesterday),
          total: `${money(row.sales_month)}元`,
          date: "今日",
          title: "销售额",
          total_name: "本月销售额",
        },
        {
          today: visitsToday,
          yesterday: visitsYesterday,
          today_ratio: countRate(visitsToday, visitsYesterday),
          total: `${number(row.visits_month)}Pv`,
          date: "今日",
          title: "用户访问量",
          total_name: "本月访问量",
        },
        {
          today: orderToday,
          yesterday: orderYesterday,
          today_ratio: countRate(orderToday, orderYesterday),
          total: `${number(row.order_month)}单`,
          date: "今日",
          title: "订单量",
          total_name: "本月订单量",
        },
        {
          today: userToday,
          yesterday: userYesterday,
          today_ratio: countRate(userToday, userYesterday),
          total: `${number(row.user_month)}人`,
          date: "今日",
          title: "新增用户",
          total_name: "本月新增用户",
        },
      ],
    };
  }

  async orderChart(
    cycle: AdminHomeCycle,
    nowSeconds = Math.floor(Date.now() / 1000),
  ): Promise<AdminOrderChartData> {
    const period = buildAdminDashboardPeriod(cycle, nowSeconds);
    const rows = await this.container.db.execute<OrderAggregateRow>(sql`
      SELECT
        CASE WHEN add_time >= ${period.currentStart} THEN 'current' ELSE 'previous' END AS period,
        to_char(to_timestamp(add_time) AT TIME ZONE 'Asia/Shanghai', ${period.bucketPattern}) AS bucket,
        COUNT(*)::int AS count,
        COALESCE(SUM(pay_price), 0)::text AS price
      FROM store_order
      WHERE add_time >= ${period.previousStart} AND add_time < ${period.currentEnd}
        AND pid >= 0 AND paid = 1 AND is_del = 0 AND is_system_del = 0
        AND refund_status IN (0, 3)
      GROUP BY 1, 2
      ORDER BY 1, 2
    `);

    const previous = new Map<string, { count: number; price: number }>();
    const current = new Map<string, { count: number; price: number }>();
    for (const row of rows) {
      const target = row.period === "current" ? current : previous;
      target.set(row.bucket.trim(), { count: number(row.count), price: number(row.price) });
    }
    const previousCount = period.bucketKeys.map((key) => previous.get(key)?.count ?? 0);
    const previousPrice = period.bucketKeys.map((key) => previous.get(key)?.price ?? 0);
    const currentCount = period.bucketKeys.map((key) => current.get(key)?.count ?? 0);
    const currentPrice = period.bucketKeys.map((key) => current.get(key)?.price ?? 0);
    // thirtyday 的上期和本期使用不同 MM-DD 键，比较总数必须直接聚合原始行；
    // 周/月/年虽能按同一槽位映射，也沿用这一口径避免展示填充影响总数。
    const previousRows = rows.filter((row) => row.period === "previous");
    const currentRows = rows.filter((row) => row.period === "current");
    const previousCountTotal = previousRows.reduce((sum, row) => sum + number(row.count), 0);
    const previousPriceTotal = previousRows.reduce((sum, row) => sum + number(row.price), 0);
    const currentCountTotal = currentRows.reduce((sum, row) => sum + number(row.count), 0);
    const currentPriceTotal = currentRows.reduce((sum, row) => sum + number(row.price), 0);

    let legend: string[];
    let series: AdminOrderChartSeries[];
    if (cycle === "thirtyday") {
      legend = ["订单金额", "订单数"];
      series = [
        { name: legend[0], type: "bar", itemStyle: ORDER_AMOUNT_STYLE, data: currentPrice },
        { name: legend[1], type: "line", itemStyle: ORDER_COUNT_STYLE, data: currentCount, yAxisIndex: 1 },
      ];
    } else {
      const periodNames = cycle === "week"
        ? ["上周", "本周"]
        : cycle === "month"
          ? ["上月", "本月"]
          : ["去年", "今年"];
      legend = [
        `${periodNames[0]}金额`,
        `${periodNames[1]}金额`,
        `${periodNames[0]}订单数`,
        `${periodNames[1]}订单数`,
      ];
      series = [
        { name: legend[0], type: "bar", itemStyle: ORDER_AMOUNT_STYLE, data: previousPrice },
        { name: legend[1], type: "bar", itemStyle: ORDER_AMOUNT_STYLE, data: currentPrice },
        { name: legend[2], type: "line", itemStyle: ORDER_COUNT_STYLE, data: previousCount, yAxisIndex: 1 },
        { name: legend[3], type: "line", itemStyle: ORDER_COUNT_STYLE, data: currentCount, yAxisIndex: 1 },
      ];
    }

    return {
      yAxis: {
        maxnum: Math.max(0, ...previousCount, ...currentCount),
        maxprice: Math.max(0, ...previousPrice, ...currentPrice),
      },
      legend,
      xAxis: period.labels,
      series,
      pre_cycle: {
        count: { data: previousCountTotal },
        price: { data: Number(previousPriceTotal.toFixed(2)) },
      },
      cycle: {
        count: dashboardComparison(currentCountTotal, previousCountTotal),
        price: dashboardComparison(
          Number(currentPriceTotal.toFixed(2)),
          Number(previousPriceTotal.toFixed(2)),
        ),
      },
    };
  }

  async userChart(nowSeconds = Math.floor(Date.now() / 1000)): Promise<AdminUserChartData> {
    const period = buildAdminDashboardPeriod("thirtyday", nowSeconds);
    const rows = await this.container.db.execute<UserAggregateRow>(sql`
      WITH active_users AS MATERIALIZED (
        SELECT add_time, pay_count FROM "user" WHERE delete_time IS NULL
      ), daily AS (
        SELECT
          to_char(to_timestamp(add_time) AT TIME ZONE 'Asia/Shanghai', 'MM-DD') AS day,
          COUNT(*)::int AS count
        FROM active_users
        WHERE add_time >= ${period.currentStart} AND add_time < ${period.currentEnd}
        GROUP BY 1
        ORDER BY 1
      )
      SELECT
        COALESCE((SELECT jsonb_agg(jsonb_build_object('day', day, 'count', count) ORDER BY day) FROM daily), '[]'::jsonb) AS daily,
        COUNT(*) FILTER (WHERE pay_count = 0)::int AS never_paid,
        COUNT(*) FILTER (WHERE pay_count = 1)::int AS paid_once,
        COUNT(*) FILTER (WHERE pay_count > 1 AND pay_count <= 4)::int AS retained,
        COUNT(*) FILTER (WHERE pay_count > 4)::int AS returned
      FROM active_users
    `);
    const row = rows[0];
    if (!row) throw new Error("用户图表查询未返回数据");
    const daily = new Map((row.daily ?? []).map((item) => [item.day, number(item.count)]));
    const series = period.bucketKeys.map((key) => daily.get(key) ?? 0);
    const names: AdminUserChartData["bing_xdata"] = [
      "未消费用户",
      "消费一次用户",
      "留存客户",
      "回流客户",
    ];
    const values = [row.never_paid, row.paid_once, row.retained, row.returned].map(number);
    const colors = ["#5cadff", "#b37feb", "#19be6b", "#ff9900"];
    return {
      legend: ["用户数"],
      yAxis: { maxnum: Math.max(0, ...series) },
      xAxis: period.labels,
      series,
      bing_xdata: names,
      bing_data: names.map((name, index) => ({
        name,
        value: values[index],
        itemStyle: { color: colors[index] },
      })),
    };
  }

  purchaseRanking(): { list: never[] } {
    // PHP Common::purchaseRanking 中实际查询已注释，稳定契约就是空列表。
    return { list: [] };
  }
}
