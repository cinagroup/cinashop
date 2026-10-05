import request, { getData } from "@/utils/request";

export interface SupplierOrderStatisticsScope {
  time: string;
  supplier_id: number | "";
}

export interface SupplierOrderStatisticsSupplier {
  id: number;
  supplierName: string;
}

export interface SupplierOrderStatisticsSummary {
  payPrice: string;
  payCount: number;
  refundPrice: string;
  refundCount: number;
}

export interface SupplierOrderStatisticsTrend {
  xAxis: string[];
  series: Array<{ name: "订单金额" | "订单量" | "退款金额" | "退款订单量"; type: "line"; data: number[] }>;
}

export interface SupplierOrderStatisticsChannel {
  items: Array<{ key: number; name: string; value: number; percent: number }>;
  totalCount: number;
}

export interface SupplierOrderStatisticsType {
  items: Array<{ key: number; name: string; value: string; percent: number }>;
  totalPrice: string;
}

export interface SupplierOrderStatisticsRow {
  id: number;
  supplierName: string;
  orderPrice: string;
  orderCount: number;
  refundOrderPrice: string;
  refundOrderCount: number;
}

export interface SupplierOrderStatisticsPage {
  list: SupplierOrderStatisticsRow[];
  count: number;
  page: number;
  limit: number;
}

const base = "/supplier/order-statistics-screen";
const dayPattern = /^(\d{4})\/(\d{2})\/(\d{2})$/u;
const amountPattern = /^-?\d+\.\d{2}$/u;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}响应格式错误`);
  return value as Record<string, unknown>;
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function money(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && amountPattern.test(value);
}

function day(value: string): number {
  const match = dayPattern.exec(value);
  if (!match) throw new Error("请选择有效的统计日期");
  const year = Number(match[1]), month = Number(match[2]), date = Number(match[3]);
  const stamp = Date.UTC(year, month - 1, date);
  const check = new Date(stamp);
  if (year < 1970 || year > 2037 || check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) throw new Error("请选择有效的统计日期");
  return stamp;
}

/** Element Plus emits calendar dates; preserve Shanghai wall dates regardless of browser timezone. */
export function supplierOrderStatisticsTime(range: string[]): string {
  if (!Array.isArray(range) || range.length !== 2) throw new Error("请选择完整日期范围");
  const [start, end] = range;
  const first = day(start), last = day(end);
  if (last < first || (last - first) / 86_400_000 >= 366) {
    throw new Error("统计日期最多 366 天，结束日期不得早于开始日期");
  }
  return `${start}-${end}`;
}

function validateScope(scope: SupplierOrderStatisticsScope): void {
  const range = scope.time.split("-");
  if (range.length !== 2 || supplierOrderStatisticsTime(range) !== scope.time ||
    (scope.supplier_id !== "" && (!Number.isSafeInteger(scope.supplier_id) || scope.supplier_id <= 0))) {
    throw new Error("供应商订单统计筛选条件无效");
  }
}

export function parseSupplierOrderStatisticsSuppliers(value: unknown): SupplierOrderStatisticsSupplier[] {
  const body = object(value, "供应商选项");
  if (!Array.isArray(body.list) || body.list.length > 10_000) throw new Error("供应商选项响应格式错误");
  const seen = new Set<number>();
  return body.list.map((raw: unknown) => {
    const row = object(raw, "供应商选项");
    if (!count(row.id) || row.id === 0 || seen.has(row.id) ||
      typeof row.supplierName !== "string" || row.supplierName.length > 255) {
      throw new Error("供应商选项响应格式错误");
    }
    seen.add(row.id);
    return { id: row.id, supplierName: row.supplierName };
  });
}

export function parseSupplierOrderStatisticsSummary(value: unknown): SupplierOrderStatisticsSummary {
  const row = object(value, "供应商订单概览");
  if (!money(row.payPrice) || !money(row.refundPrice) || !count(row.payCount) || !count(row.refundCount)) {
    throw new Error("供应商订单概览响应格式错误");
  }
  return { payPrice: row.payPrice, payCount: row.payCount,
    refundPrice: row.refundPrice, refundCount: row.refundCount };
}

export function parseSupplierOrderStatisticsTrend(value: unknown): SupplierOrderStatisticsTrend {
  const body = object(value, "供应商订单趋势");
  if (!Array.isArray(body.xAxis) || body.xAxis.length > 366 ||
    !body.xAxis.every((point: unknown) => typeof point === "string" && point.length > 0 && point.length <= 20) ||
    !Array.isArray(body.series) || body.series.length !== 4) throw new Error("供应商订单趋势响应格式错误");
  const names = ["订单金额", "订单量", "退款金额", "退款订单量"] as const;
  const series = body.series.map((raw: unknown, index: number) => {
    const line = object(raw, "供应商订单趋势");
    if (line.name !== names[index] || line.type !== "line" || !Array.isArray(line.data) ||
      line.data.length !== (body.xAxis as unknown[]).length ||
      !line.data.every((point: unknown) => typeof point === "number" && Number.isFinite(point) &&
        (index % 2 === 0 || (Number.isSafeInteger(point) && point >= 0)))) throw new Error("供应商订单趋势响应格式错误");
    return { name: names[index], type: "line" as const, data: line.data as number[] };
  });
  return { xAxis: body.xAxis as string[], series };
}

export function parseSupplierOrderStatisticsChannel(value: unknown): SupplierOrderStatisticsChannel {
  const body = object(value, "订单来源");
  if (!Array.isArray(body.items) || body.items.length !== 5 || !count(body.totalCount)) {
    throw new Error("订单来源响应格式错误");
  }
  const seen = new Set<number>();
  const items = body.items.map((raw: unknown) => {
    const row = object(raw, "订单来源");
    if (!count(row.key) || row.key > 4 || seen.has(row.key) || typeof row.name !== "string" || row.name.length > 80 ||
      !count(row.value) || typeof row.percent !== "number" || !Number.isFinite(row.percent) ||
      row.percent < 0 || row.percent > 100) throw new Error("订单来源响应格式错误");
    seen.add(row.key);
    return { key: row.key, name: row.name, value: row.value, percent: row.percent };
  });
  return { items, totalCount: body.totalCount };
}

export function parseSupplierOrderStatisticsType(value: unknown): SupplierOrderStatisticsType {
  const body = object(value, "订单类型");
  if (!Array.isArray(body.items) || body.items.length !== 9 || !money(body.totalPrice)) {
    throw new Error("订单类型响应格式错误");
  }
  const seen = new Set<number>();
  const items = body.items.map((raw: unknown) => {
    const row = object(raw, "订单类型");
    if (!count(row.key) || row.key > 8 || seen.has(row.key) ||
      typeof row.name !== "string" || row.name.length > 80 || !money(row.value) ||
      typeof row.percent !== "number" || !Number.isFinite(row.percent)) throw new Error("订单类型响应格式错误");
    seen.add(row.key);
    return { key: row.key, name: row.name, value: row.value, percent: row.percent };
  });
  return { items, totalPrice: body.totalPrice };
}

export function parseSupplierOrderStatisticsPage(value: unknown): SupplierOrderStatisticsPage {
  const body = object(value, "供应商订单统计表");
  if (!Array.isArray(body.list) || !count(body.count) || !count(body.page) || body.page === 0 ||
    !count(body.limit) || body.limit === 0 || body.limit > 100 || body.list.length > body.limit) {
    throw new Error("供应商订单统计表响应格式错误");
  }
  const seen = new Set<number>();
  const list = body.list.map((raw: unknown) => {
    const row = object(raw, "供应商订单统计表");
    if (!count(row.id) || row.id === 0 || seen.has(row.id) ||
      typeof row.supplierName !== "string" || row.supplierName.length > 255 ||
      !money(row.orderPrice) || !count(row.orderCount) ||
      !money(row.refundOrderPrice) || !count(row.refundOrderCount)) {
      throw new Error("供应商订单统计表响应格式错误");
    }
    seen.add(row.id);
    return { id: row.id, supplierName: row.supplierName, orderPrice: row.orderPrice,
      orderCount: row.orderCount, refundOrderPrice: row.refundOrderPrice,
      refundOrderCount: row.refundOrderCount };
  });
  return { list, count: body.count, page: body.page, limit: body.limit };
}

export async function apiSupplierOrderStatisticsSuppliers(signal?: AbortSignal): Promise<SupplierOrderStatisticsSupplier[]> {
  return parseSupplierOrderStatisticsSuppliers(await getData<unknown>(request.get(`${base}/suppliers`, { signal })));
}

export async function apiSupplierOrderStatisticsSummary(scope: SupplierOrderStatisticsScope, signal?: AbortSignal): Promise<SupplierOrderStatisticsSummary> {
  validateScope(scope);
  return parseSupplierOrderStatisticsSummary(await getData<unknown>(request.get(`${base}/summary`, { params: scope, signal })));
}

export async function apiSupplierOrderStatisticsTrend(scope: SupplierOrderStatisticsScope, signal?: AbortSignal): Promise<SupplierOrderStatisticsTrend> {
  validateScope(scope);
  return parseSupplierOrderStatisticsTrend(await getData<unknown>(request.get(`${base}/trend`, { params: scope, signal })));
}

export async function apiSupplierOrderStatisticsChannel(scope: SupplierOrderStatisticsScope, signal?: AbortSignal): Promise<SupplierOrderStatisticsChannel> {
  validateScope(scope);
  return parseSupplierOrderStatisticsChannel(await getData<unknown>(request.get(`${base}/channel`, { params: scope, signal })));
}

export async function apiSupplierOrderStatisticsType(scope: SupplierOrderStatisticsScope, signal?: AbortSignal): Promise<SupplierOrderStatisticsType> {
  validateScope(scope);
  return parseSupplierOrderStatisticsType(await getData<unknown>(request.get(`${base}/type`, { params: scope, signal })));
}

export async function apiSupplierOrderStatisticsTable(scope: SupplierOrderStatisticsScope & { page: number; limit: number }, signal?: AbortSignal): Promise<SupplierOrderStatisticsPage> {
  validateScope(scope);
  if (!Number.isSafeInteger(scope.page) || scope.page < 1 || !Number.isSafeInteger(scope.limit) ||
    scope.limit < 1 || scope.limit > 100) throw new Error("供应商订单统计分页条件无效");
  const result = parseSupplierOrderStatisticsPage(await getData<unknown>(request.get(`${base}/supplier-table`, { params: scope, signal })));
  if (result.page !== scope.page || result.limit !== scope.limit) throw new Error("供应商订单统计表分页响应与请求不一致");
  return result;
}
