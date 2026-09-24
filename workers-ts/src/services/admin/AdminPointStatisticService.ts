/** Read-only projections for the old Admin integral statistics screen. */
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { Container } from "@/lib/di";
import { user, userBill } from "@/models/schema";
import {
  parseAdminStatisticRange,
  seriesValues,
  slashDate,
  startOfBusinessDay,
  type AdminStatisticRange,
  type StatisticDistribution,
} from "@/services/admin/AdminStatisticService";
import { ValidateException } from "@/utils/errors";

const colors = ["#64a1f4", "#3edeb5", "#70869f", "#ffc653", "#fc7d6a"];
const DAY_SECONDS = 86_400;
const SHANGHAI_OFFSET_SECONDS = 8 * 60 * 60;
// PHP UserPointServices::getChannel deliberately queries `gain` twice. Historical
// rows have no reliable order-vs-product discriminator, so keep both visible
// legacy buckets instead of inventing an attribution from newer event keys.
export const sourceBuckets = [
  { name: "订单赠送", type: "gain" },
  { name: "商品赠送", type: "gain" },
  { name: "后台赠送", type: "system_add" },
  { name: "签到获得", type: "sign" },
  { name: "九宫格抽奖", type: "lottery_add" },
] as const;

// PHP does not constrain pm here: refunded points appear under 退款退回.
export const spendBuckets = [
  { name: "订单抵扣", type: "deduction" },
  { name: "九宫格抽奖", type: "lottery_use" },
  { name: "后台减少", type: "system_sub" },
  { name: "退款退回", type: "pay_product_integral_back" },
  { name: "兑换商品", type: "storeIntegral_use" },
] as const;

const date = String.raw`(?:\d{4}/\d{1,2}/\d{1,2}|\d{4}-\d{1,2}-\d{1,2})`;
const rangeShape = new RegExp(`^${date}-${date}$`, "u");

function pointTrendBuckets(range: AdminStatisticRange): Pick<AdminStatisticRange,
  "granularity" | "bucketKeys" | "labels" | "sqlPattern"> {
  // The old controller expands a date-only end to 23:59:59 before PHP counts
  // days. Its effective thresholds are therefore 1–30 daily, 31–91 three-day,
  // and 92+ monthly; even a same-day request has one MM-DD point, not 24 hours.
  if (range.days <= 91) {
    const step = range.days <= 30 ? 1 : 3;
    const bucketKeys: string[] = [];
    for (let offset = 0; offset < range.days; offset += step) {
      bucketKeys.push(slashDate(range.start + offset * DAY_SECONDS).replaceAll("/", "-"));
    }
    return {
      granularity: step === 1 ? "day" : "three_day",
      bucketKeys,
      labels: bucketKeys.map((key) => key.slice(5)),
      sqlPattern: "YYYY-MM-DD",
    };
  }

  // PHP advances the axis from the selected start day by `+1 month`. Keep
  // that visible sequence, including its possible month-end overflow/tail
  // omission. The 3-day path alone deliberately aggregates full intervals.
  const bucketKeys: string[] = [];
  let cursor = range.start;
  while (cursor < range.endExclusive) {
    const day = new Date((cursor + SHANGHAI_OFFSET_SECONDS) * 1000);
    const year = day.getUTCFullYear();
    const month = day.getUTCMonth();
    bucketKeys.push(`${year}-${String(month + 1).padStart(2, "0")}`);
    cursor = Math.floor(Date.UTC(year, month + 1, day.getUTCDate()) / 1000) - SHANGHAI_OFFSET_SECONDS;
  }
  return { granularity: "month", bucketKeys, labels: bucketKeys, sqlPattern: "YYYY-MM" };
}

/** Exact old date-only input and blank default, bounded by the shared Shanghai parser. */
export function parsePointStatisticRange(raw?: string, nowSeconds?: number): AdminStatisticRange {
  const value = raw?.trim() ?? "";
  if (value && (value.length > 32 || !rangeShape.test(value))) throw new ValidateException("积分统计时间范围无效");
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const today = startOfBusinessDay(now);
  // UserPoint::getDay('') starts 30 calendar days before today, inclusive.
  const effective = value || `${slashDate(today - 30 * DAY_SECONDS)}-${slashDate(today)}`;
  const range = parseAdminStatisticRange(effective, now);
  return { ...range, ...pointTrendBuckets(range) };
}

function decimalAmount(value: unknown): { cents: bigint; number: number } {
  const raw = String(value ?? "0");
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(raw);
  const number = Number(raw);
  if (!match || !Number.isFinite(number)) throw new Error("积分统计金额无效");
  const fraction = (match[3] ?? "").padEnd(2, "0") || "0";
  const cents = (BigInt(match[2]) * 100n + BigInt(fraction)) * (match[1] ? -1n : 1n);
  return { cents, number };
}

function distribution(
  buckets: readonly { name: string; type: string }[],
  rows: Array<{ type: string; amount: string }>,
): StatisticDistribution {
  const byType = new Map(rows.map((row) => [row.type, decimalAmount(row.amount)]));
  const amounts = buckets.map((bucket, index) => ({
    name: bucket.name,
    ...(byType.get(bucket.type) ?? { cents: 0n, number: 0 }),
    color: colors[index],
    index,
  }));
  const bing_data = amounts.map((row) => ({ name: row.name, value: row.number, itemStyle: { color: row.color } }));
  // The old denominator includes both gain buckets. Percent is truncated to
  // one decimal place, matching PHP bcdiv(scale=4) then bcmul(scale=1).
  // Use integer cents to avoid IEEE-754 undershooting exact values like 0.01/0.05.
  const total = amounts.reduce((sum, row) => sum + row.cents, 0n);
  const list = amounts.map((row) => ({
    name: row.name,
    value: row.number,
    percent: total === 0n ? 0 : Number(row.cents * 1000n / total) / 10,
    cents: row.cents,
    index: row.index,
  })).sort((left, right) => left.cents === right.cents ? left.index - right.index : left.cents > right.cents ? -1 : 1)
    .map(({ name, value, percent }) => ({ name, value, percent }));
  return { bing_xdata: buckets.map((bucket) => bucket.name), bing_data, list };
}

export class AdminPointStatisticService {
  constructor(private readonly container: Container) {}

  private window(range: AdminStatisticRange) {
    return and(
      eq(userBill.category, "integral"),
      gte(userBill.addTime, range.start),
      lt(userBill.addTime, range.endExclusive),
    )!;
  }

  async basic(range: AdminStatisticRange) {
    const [balances, ledger] = await Promise.all([
      this.container.db.select({
        now_point: sql<string>`COALESCE(SUM(${user.integral}), 0)::text`,
      }).from(user).where(eq(user.status, 1)),
      this.container.db.select({
        all_point: sql<string>`COALESCE(SUM(${userBill.number}) FILTER (WHERE ${userBill.pm}=1), 0)::text`,
        pay_point: sql<string>`COALESCE(SUM(${userBill.number}) FILTER (WHERE ${userBill.pm}=0), 0)::text`,
      }).from(userBill).where(this.window(range)),
    ]);
    return {
      now_point: balances[0]?.now_point ?? "0",
      all_point: ledger[0]?.all_point ?? "0",
      pay_point: ledger[0]?.pay_point ?? "0",
    };
  }

  async trend(range: AdminStatisticRange) {
    const bucket = sql<string>`to_char(to_timestamp(${userBill.addTime}) AT TIME ZONE 'Asia/Shanghai', ${range.sqlPattern})`;
    const rows = await this.container.db.select({
      pm: userBill.pm,
      bucket,
      value: sql<string>`COALESCE(SUM(${userBill.number}), 0)::text`,
    // GROUP BY 2 reuses the selected expression. Rendering it twice would
    // bind two distinct PostgreSQL parameters for the same date pattern.
    }).from(userBill).where(and(this.window(range), inArray(userBill.pm, [0, 1]))).groupBy(userBill.pm, sql`2`);
    const metrics = rows.map((row) => ({
      metric: row.pm === 1 ? "积分积累" : "积分消耗",
      bucket: row.bucket,
      value: row.value,
    }));
    return {
      xAxis: range.labels,
      series: ["积分积累", "积分消耗"].map((name) => ({
        name,
        data: seriesValues(range, metrics, name),
        type: "line" as const,
      })),
    };
  }

  private async amounts(range: AdminStatisticRange, types: readonly string[], gainsOnly: boolean) {
    return this.container.db.select({
      type: userBill.type,
      amount: sql<string>`COALESCE(SUM(${userBill.number}), 0)::text`,
    }).from(userBill).where(and(
      this.window(range),
      inArray(userBill.type, [...new Set(types)]),
      gainsOnly ? eq(userBill.pm, 1) : undefined,
    )).groupBy(userBill.type);
  }

  async channel(range: AdminStatisticRange): Promise<StatisticDistribution> {
    return distribution(sourceBuckets, await this.amounts(range, sourceBuckets.map((bucket) => bucket.type), true));
  }

  async type(range: AdminStatisticRange): Promise<StatisticDistribution> {
    return distribution(spendBuckets, await this.amounts(range, spendBuckets.map((bucket) => bucket.type), false));
  }
}
