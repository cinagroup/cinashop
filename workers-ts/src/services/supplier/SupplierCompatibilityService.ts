import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Container } from "@/lib/di";
import {
  cityArea,
  storeOrder,
  storeOrderRefund,
  systemMenus,
} from "@/models/schema";
import { ValidateException } from "@/utils/errors";

const UTC8_OFFSET_SECONDS = 8 * 60 * 60;
const DAY_SECONDS = 86_400;
const MAX_REPORT_DAYS = 366;
const MAX_CITY_CHILDREN = 1_000;
const MAX_SEARCH_MENUS = 1_000;

export interface SupplierReportRange {
  start: number;
  end: number;
}

interface SupplierMenuRow {
  id: number;
  pid: number;
  menu_name: string;
  menu_path: string;
  unique_auth: string;
  sort: number;
  type: 0 | 1;
}

function shiftedNow(nowMs: number): Date {
  return new Date(nowMs + UTC8_OFFSET_SECONDS * 1_000);
}

function localDayStart(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month, day) / 1_000) - UTC8_OFFSET_SECONDS;
}

function dayRange(offsetDays: number, nowMs: number): SupplierReportRange {
  const now = shiftedNow(nowMs);
  const start = localDayStart(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offsetDays);
  return { start, end: start + DAY_SECONDS - 1 };
}

function calendarDay(value: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})[/-](\d{2})[/-](\d{2})$/.exec(value);
  if (!match) throw new ValidateException("时间范围格式错误");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    throw new ValidateException("时间范围格式错误");
  }
  return { year, month: month - 1, day };
}

function validateReportRange(range: SupplierReportRange): SupplierReportRange {
  if (range.end < range.start) throw new ValidateException("结束时间不能早于开始时间");
  if (range.end - range.start + 1 > MAX_REPORT_DAYS * DAY_SECONDS) {
    throw new ValidateException(`统计时间范围不能超过${MAX_REPORT_DAYS}天`);
  }
  return range;
}

/** Parse the legacy Supplier time selector while keeping every aggregate bounded. */
export function parseSupplierReportRange(value: string | undefined, nowMs = Date.now()): SupplierReportRange {
  const normalized = value?.trim().toLowerCase() ?? "";
  const today = dayRange(0, nowMs);
  if (!normalized) {
    return { start: dayRange(-30, nowMs).start, end: today.end };
  }
  if (normalized === "today") return today;
  if (normalized === "yesterday") return dayRange(-1, nowMs);
  if (normalized === "sevenday") {
    return { start: dayRange(-6, nowMs).start, end: today.end };
  }
  if (normalized === "thirtyday") {
    return { start: dayRange(-29, nowMs).start, end: today.end };
  }

  const now = shiftedNow(nowMs);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  if (normalized === "month") {
    return validateReportRange({
      start: localDayStart(year, month, 1),
      end: localDayStart(year, month + 1, 1) - 1,
    });
  }
  if (normalized === "last month") {
    return validateReportRange({
      start: localDayStart(year, month - 1, 1),
      end: localDayStart(year, month, 1) - 1,
    });
  }
  if (normalized === "year") {
    return validateReportRange({
      start: localDayStart(year, 0, 1),
      end: localDayStart(year + 1, 0, 1) - 1,
    });
  }

  const custom = /^(\d{4}[/-]\d{2}[/-]\d{2})-(\d{4}[/-]\d{2}[/-]\d{2})$/.exec(normalized);
  if (!custom) throw new ValidateException("时间范围格式错误");
  const startDate = calendarDay(custom[1]);
  const endDate = calendarDay(custom[2]);
  return validateReportRange({
    start: localDayStart(startDate.year, startDate.month, startDate.day),
    end: localDayStart(endDate.year, endDate.month, endDate.day) + DAY_SECONDS - 1,
  });
}

function percent(value: number, total: number): number {
  return total > 0 ? Number(((value / total) * 100).toFixed(2)) : 0;
}

function validSupplierId(supplierId: number): number {
  if (!Number.isSafeInteger(supplierId) || supplierId <= 0) {
    throw new ValidateException("供应商ID错误");
  }
  return supplierId;
}

export function orderSupplierMenuRows(rows: readonly SupplierMenuRow[]): SupplierMenuRow[] {
  const byId = new Set(rows.map((row) => row.id));
  const byParent = new Map<number, SupplierMenuRow[]>();
  for (const row of rows) {
    const children = byParent.get(row.pid) ?? [];
    children.push(row);
    byParent.set(row.pid, children);
  }
  const ordered: SupplierMenuRow[] = [];
  const visited = new Set<number>();
  const visit = (row: SupplierMenuRow) => {
    if (visited.has(row.id)) return;
    visited.add(row.id);
    ordered.push(row);
    for (const child of byParent.get(row.id) ?? []) visit(child);
  };
  for (const row of rows) {
    if (row.pid === row.id || !byId.has(row.pid)) visit(row);
  }
  for (const row of rows) visit(row);
  return ordered;
}

function chartLabels(range: SupplierReportRange): { labels: string[]; bucket: "hour" | "day" | "month" } {
  const days = Math.floor((range.end - range.start) / DAY_SECONDS) + 1;
  if (days === 1) {
    return {
      labels: Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, "0")),
      bucket: "hour",
    };
  }
  const bucket = days > 92 ? "month" : "day";
  const stepDays = days <= 31 ? 1 : 3;
  const labels: string[] = [];
  let localMs = (range.start + UTC8_OFFSET_SECONDS) * 1_000;
  const localEndMs = (range.end + UTC8_OFFSET_SECONDS) * 1_000;
  while (localMs <= localEndMs) {
    const date = new Date(localMs);
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    if (bucket === "month") {
      labels.push(`${date.getUTCFullYear()}-${month}`);
      localMs = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    } else {
      labels.push(`${month}-${String(date.getUTCDate()).padStart(2, "0")}`);
      localMs += stepDays * DAY_SECONDS * 1_000;
    }
  }
  return { labels, bucket };
}

export class SupplierCompatibilityService {
  constructor(private readonly container: Container) {}

  async notices(supplierId: number) {
    validSupplierId(supplierId);
    const [orders, refunds] = await Promise.all([
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(storeOrder)
        .where(and(
          eq(storeOrder.supplierId, supplierId),
          eq(storeOrder.pid, 0),
          eq(storeOrder.paid, 1),
          eq(storeOrder.status, 1),
          eq(storeOrder.isDel, 0),
          eq(storeOrder.isSystemDel, 0),
        )),
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(storeOrderRefund)
        .where(and(
          eq(storeOrderRefund.supplierId, supplierId),
          eq(storeOrderRefund.isCancel, 0),
          eq(storeOrderRefund.isDel, 0),
          inArray(storeOrderRefund.refundType, [0, 1, 2, 4, 5]),
        )),
    ]);
    const result: Array<Record<string, string | number>> = [];
    const orderCount = orders[0]?.count ?? 0;
    const refundCount = refunds[0]?.count ?? 0;
    if (orderCount > 0) {
      result.push({
        title: `您有${orderCount}个待发货的订单`, type: "bulb", url: "/supplier/order/list?type=7&status=1",
        icon: "md-bulb", iconColor: "#87d068", read: 0, time: 0,
      });
    }
    if (refundCount > 0) {
      result.push({
        title: `您有${refundCount}个售后订单待处理`, type: "bulb", url: "/supplier/order/refund",
        icon: "md-bulb", iconColor: "#87d068", read: 0, time: 0,
      });
    }
    return result;
  }

  async cityChildren(parentId: number) {
    if (!Number.isSafeInteger(parentId) || parentId < 0) throw new ValidateException("城市ID错误");
    const [parentRows, rows] = await Promise.all([
      parentId === 0
        ? Promise.resolve([])
        : this.container.db.select({ name: cityArea.name }).from(cityArea)
          .where(eq(cityArea.id, parentId)).limit(1),
      this.container.db
        .select({
          id: cityArea.id,
          name: cityArea.name,
          parentId: cityArea.parentId,
          level: cityArea.level,
        })
        .from(cityArea)
        .where(eq(cityArea.parentId, parentId))
        .orderBy(asc(cityArea.id))
        .limit(MAX_CITY_CHILDREN + 1),
    ]);
    if (rows.length > MAX_CITY_CHILDREN) throw new ValidateException("城市子节点数量异常");
    const childParentIds = rows.length === 0
      ? []
      : await this.container.db
        .select({ parentId: cityArea.parentId })
        .from(cityArea)
        .where(inArray(cityArea.parentId, rows.map((row) => row.id)))
        .groupBy(cityArea.parentId);
    const expandable = new Set(childParentIds.map((row) => row.parentId));
    const parentName = parentId === 0 ? "中国" : parentRows[0]?.name ?? "";
    return rows.map((row) => ({
      value: row.id,
      id: row.id,
      name: row.name,
      label: row.name,
      pid: row.parentId,
      level: row.level,
      parent_name: parentName,
      ...(expandable.has(row.id) ? { children: [], loading: false, _loading: false } : {}),
    }));
  }

  async menuSearch() {
    const rows = await this.container.db
      .select({
        id: systemMenus.id,
        pid: systemMenus.pid,
        menuName: systemMenus.menuName,
        menuPath: systemMenus.menuPath,
        uniqueAuth: systemMenus.uniqueAuth,
        sort: systemMenus.sort,
      })
      .from(systemMenus)
      .where(and(
        eq(systemMenus.type, 3),
        eq(systemMenus.isShow, 1),
        eq(systemMenus.authType, 1),
        eq(systemMenus.isDel, 0),
        eq(systemMenus.isShowPath, 0),
      ))
      .orderBy(desc(systemMenus.sort), asc(systemMenus.id))
      .limit(MAX_SEARCH_MENUS + 1);
    if (rows.length > MAX_SEARCH_MENUS) throw new ValidateException("菜单数量异常");
    const parentIds = new Set(rows.map((row) => row.pid));
    return orderSupplierMenuRows(rows.map((row) => ({
      id: row.id,
      pid: row.pid,
      menu_name: row.menuName,
      menu_path: row.menuPath,
      unique_auth: row.uniqueAuth,
      sort: row.sort,
      type: parentIds.has(row.id) ? 1 : 0,
    })));
  }

  async homeSummary(supplierId: number, rangeValue?: string) {
    validSupplierId(supplierId);
    const range = parseSupplierReportRange(rangeValue);
    const [orders, refunds] = await Promise.all([
      this.container.db
        .select({
          payPrice: sql<string>`COALESCE(SUM(${storeOrder.payPrice}), 0)::text`,
          payCount: sql<number>`COUNT(*)::int`,
        })
        .from(storeOrder)
        .where(and(
          eq(storeOrder.supplierId, supplierId),
          eq(storeOrder.paid, 1),
          eq(storeOrder.refundStatus, 0),
          eq(storeOrder.isDel, 0),
          eq(storeOrder.isSystemDel, 0),
          sql`${storeOrder.addTime} BETWEEN ${range.start} AND ${range.end}`,
        )),
      this.container.db
        .select({
          refundPrice: sql<string>`COALESCE(SUM(${storeOrderRefund.refundPrice}), 0)::text`,
          refundCount: sql<number>`COUNT(*)::int`,
        })
        .from(storeOrderRefund)
        .where(and(
          eq(storeOrderRefund.supplierId, supplierId),
          eq(storeOrderRefund.refundType, 6),
          eq(storeOrderRefund.isCancel, 0),
          eq(storeOrderRefund.isDel, 0),
          sql`${storeOrderRefund.addTime} BETWEEN ${range.start} AND ${range.end}`,
        )),
    ]);
    return {
      pay_price: orders[0]?.payPrice ?? "0.00",
      pay_count: orders[0]?.payCount ?? 0,
      refund_price: refunds[0]?.refundPrice ?? "0.00",
      refund_count: refunds[0]?.refundCount ?? 0,
    };
  }

  async orderChart(supplierId: number, rangeValue?: string) {
    validSupplierId(supplierId);
    const range = parseSupplierReportRange(rangeValue);
    const { labels, bucket } = chartLabels(range);
    const bucketExpression = bucket === "hour"
      ? sql<string>`TO_CHAR(TO_TIMESTAMP(${storeOrder.addTime}) AT TIME ZONE 'Asia/Shanghai', 'HH24')`
      : bucket === "month"
        ? sql<string>`TO_CHAR(TO_TIMESTAMP(${storeOrder.addTime}) AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM')`
        : sql<string>`TO_CHAR(TO_TIMESTAMP(${storeOrder.addTime}) AT TIME ZONE 'Asia/Shanghai', 'MM-DD')`;
    const rows = await this.container.db
      .select({
        bucket: bucketExpression,
        payPrice: sql<string>`COALESCE(SUM(${storeOrder.payPrice}) FILTER (WHERE ${storeOrder.refundStatus} IN (0, 3)), 0)::text`,
        payCount: sql<number>`COUNT(*) FILTER (WHERE ${storeOrder.refundStatus} IN (0, 3))::int`,
        refundPrice: sql<string>`COALESCE(SUM(${storeOrder.refundPrice}) FILTER (WHERE ${storeOrder.refundType} = 6), 0)::text`,
        refundCount: sql<number>`COUNT(*) FILTER (WHERE ${storeOrder.refundType} = 6)::int`,
      })
      .from(storeOrder)
      .where(and(
        eq(storeOrder.supplierId, supplierId),
        eq(storeOrder.paid, 1),
        eq(storeOrder.isDel, 0),
        eq(storeOrder.isSystemDel, 0),
        sql`${storeOrder.pid} >= 0`,
        sql`${storeOrder.addTime} BETWEEN ${range.start} AND ${range.end}`,
      ))
      .groupBy(bucketExpression);
    const byBucket = new Map(rows.map((row) => [row.bucket, row]));
    const series = [
      { name: "订单金额", data: labels.map((label) => Number(byBucket.get(label)?.payPrice ?? 0)), type: "line" },
      { name: "订单量", data: labels.map((label) => byBucket.get(label)?.payCount ?? 0), type: "line" },
      { name: "退款金额", data: labels.map((label) => Number(byBucket.get(label)?.refundPrice ?? 0)), type: "line" },
      { name: "退款订单量", data: labels.map((label) => byBucket.get(label)?.refundCount ?? 0), type: "line" },
    ];
    return { xAxis: labels, series };
  }

  async orderChannel(supplierId: number, rangeValue?: string) {
    validSupplierId(supplierId);
    const range = parseSupplierReportRange(rangeValue);
    const rows = await this.container.db
      .select({ channel: storeOrder.isChannel, count: sql<number>`COUNT(*)::int` })
      .from(storeOrder)
      .where(and(
        eq(storeOrder.supplierId, supplierId),
        eq(storeOrder.paid, 1),
        eq(storeOrder.pid, 0),
        eq(storeOrder.isDel, 0),
        eq(storeOrder.isSystemDel, 0),
        sql`${storeOrder.addTime} BETWEEN ${range.start} AND ${range.end}`,
      ))
      .groupBy(storeOrder.isChannel);
    const counts = new Map(rows.map((row) => [row.channel, row.count]));
    const names = ["公众号", "小程序", "H5", "PC", "APP"];
    const colors = ["#6DD230", "#FFAB2B", "#4BCAD5", "#1890FF", "#B37FEB"];
    const bing_data = names.map((name, channel) => ({
      name,
      value: counts.get(channel) ?? 0,
      itemStyle: { color: colors[channel] },
    }));
    const total = bing_data.reduce((sum, item) => sum + item.value, 0);
    const list = bing_data.map(({ name, value }) => ({ name, value, percent: percent(value, total) }))
      .sort((left, right) => right.value - left.value);
    return { bing_xdata: names, bing_data, list };
  }

  async orderType(supplierId: number, rangeValue?: string) {
    validSupplierId(supplierId);
    const range = parseSupplierReportRange(rangeValue);
    const rows = await this.container.db
      .select({ type: storeOrder.type, value: sql<string>`COALESCE(SUM(${storeOrder.payPrice}), 0)::text` })
      .from(storeOrder)
      .where(and(
        eq(storeOrder.supplierId, supplierId),
        eq(storeOrder.paid, 1),
        eq(storeOrder.pid, 0),
        eq(storeOrder.isDel, 0),
        eq(storeOrder.isSystemDel, 0),
        sql`${storeOrder.addTime} BETWEEN ${range.start} AND ${range.end}`,
      ))
      .groupBy(storeOrder.type);
    const values = new Map(rows.map((row) => [row.type, Number(row.value)]));
    const names = ["普通订单", "秒杀订单", "砍价订单", "拼团订单", "积分订单", "套餐订单", "预售订单", "新人专享", "抽奖订单"];
    const colors = ["#64a1f4", "#3edeb5", "#70869f", "#ffc653", "#ffc653", "#fc7d6a", "#fc7d2a", "#ffc653", "#ffc653"];
    const bing_data = names.map((name, type) => ({
      name,
      value: values.get(type) ?? 0,
      itemStyle: { color: colors[type] },
    }));
    const total = bing_data.reduce((sum, item) => sum + item.value, 0);
    const list = bing_data.map(({ name, value }) => ({ name, value, percent: percent(value, total) }))
      .sort((left, right) => right.value - left.value);
    return { bing_xdata: names.filter((_, type) => type !== 4), bing_data, list };
  }
}
