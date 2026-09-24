/** Read-only projections for the old Admin integral statistics screen. */
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { Container } from "@/lib/di";
import { user, userBill } from "@/models/schema";
import {
  parseAdminStatisticRange,
  seriesValues,
  type AdminStatisticRange,
  type StatisticDistribution,
} from "@/services/admin/AdminStatisticService";
import { ValidateException } from "@/utils/errors";

const colors = ["#64a1f4", "#3edeb5", "#70869f", "#ffc653", "#fc7d6a"];
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

/** Exact old date-only input, bounded before the shared Shanghai bucket parser. */
export function parsePointStatisticRange(raw?: string, nowSeconds?: number): AdminStatisticRange {
  const value = raw?.trim() ?? "";
  if (value && (value.length > 32 || !rangeShape.test(value))) throw new ValidateException("积分统计时间范围无效");
  return parseAdminStatisticRange(value, nowSeconds);
}

function finiteAmount(value: unknown): number {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount)) throw new Error("积分统计金额无效");
  return amount;
}

function distribution(
  buckets: readonly { name: string; type: string }[],
  rows: Array<{ type: string; amount: string }>,
): StatisticDistribution {
  const byType = new Map(rows.map((row) => [row.type, finiteAmount(row.amount)]));
  const bing_data = buckets.map((bucket, index) => ({
    name: bucket.name,
    value: byType.get(bucket.type) ?? 0,
    itemStyle: { color: colors[index] },
  }));
  // The old denominator includes both gain buckets. Percent is truncated to
  // one decimal place, matching PHP bcdiv(scale=4) then bcmul(scale=1).
  const total = bing_data.reduce((sum, row) => sum + row.value, 0);
  const list = bing_data.map((row, index) => ({
    name: row.name,
    value: row.value,
    percent: total === 0 ? 0 : Math.trunc((row.value / total) * 1000) / 10,
    index,
  })).sort((left, right) => right.value - left.value || left.index - right.index)
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
    }).from(userBill).where(this.window(range)).groupBy(userBill.pm, sql`2`);
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
