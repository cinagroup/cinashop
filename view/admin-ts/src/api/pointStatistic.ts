import request, { getData } from "@/utils/request";
import type { StatisticDistribution, StatisticTrend } from "@/api/statistic";

export interface PointStatisticBasic {
  now_point: string;
  all_point: string;
  pay_point: string;
}

type Projection = "get_basic" | "get_trend" | "get_channel" | "get_type";
const decimal = /^-?\d+(?:\.\d{1,2})?$/u;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("积分统计响应格式错误");
  return value as Record<string, unknown>;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function parsePointBasic(value: unknown): PointStatisticBasic {
  const row = object(value);
  for (const key of ["now_point", "all_point", "pay_point"] as const) {
    if (typeof row[key] !== "string" || !decimal.test(row[key])) throw new Error("积分统计响应格式错误");
  }
  return row as unknown as PointStatisticBasic;
}

export function parsePointTrend(value: unknown): StatisticTrend {
  const row = object(value);
  // At most 3660 inclusive days and at least 28 days per PHP monthly step
  // yield at most 131 labels; 132 allows that bound without accepting an
  // unbounded chart payload.
  if (!Array.isArray(row.xAxis) || row.xAxis.length > 132 ||
    !row.xAxis.every((label) => typeof label === "string" && label.length <= 10) ||
    !Array.isArray(row.series) || row.series.length !== 2) throw new Error("积分趋势响应格式错误");
  const expected = ["积分积累", "积分消耗"];
  for (const [index, value] of row.series.entries()) {
    const series = object(value);
    if (series.name !== expected[index] || series.type !== "line" || !Array.isArray(series.data) ||
      series.data.length !== row.xAxis.length || !series.data.every(finite)) throw new Error("积分趋势响应格式错误");
  }
  return row as unknown as StatisticTrend;
}

export function parsePointDistribution(value: unknown): StatisticDistribution {
  const row = object(value);
  if (!Array.isArray(row.bing_xdata) || row.bing_xdata.length !== 5 ||
    !row.bing_xdata.every((name) => typeof name === "string" && name.length <= 20) ||
    !Array.isArray(row.bing_data) || row.bing_data.length !== 5 ||
    !Array.isArray(row.list) || row.list.length !== 5) throw new Error("积分分布响应格式错误");
  const labels = new Set(row.bing_xdata);
  for (const entry of row.bing_data) {
    const item = object(entry);
    const style = object(item.itemStyle);
    if (typeof item.name !== "string" || !labels.has(item.name) || !finite(item.value) ||
      typeof style.color !== "string" || !/^#[0-9a-f]{6}$/iu.test(style.color)) throw new Error("积分分布响应格式错误");
  }
  for (const entry of row.list) {
    const item = object(entry);
    if (typeof item.name !== "string" || !labels.has(item.name) || !finite(item.value) ||
      !finite(item.percent)) throw new Error("积分分布响应格式错误");
  }
  return row as unknown as StatisticDistribution;
}

async function read(projection: Projection, time: string, signal?: AbortSignal): Promise<unknown> {
  return getData<unknown>(request.get(`/marketing/point/${projection}`, { params: { time }, signal }));
}

export async function apiPointBasic(time: string, signal?: AbortSignal): Promise<PointStatisticBasic> {
  return parsePointBasic(await read("get_basic", time, signal));
}
export async function apiPointTrend(time: string, signal?: AbortSignal): Promise<StatisticTrend> {
  return parsePointTrend(await read("get_trend", time, signal));
}
export async function apiPointChannel(time: string, signal?: AbortSignal): Promise<StatisticDistribution> {
  return parsePointDistribution(await read("get_channel", time, signal));
}
export async function apiPointType(time: string, signal?: AbortSignal): Promise<StatisticDistribution> {
  return parsePointDistribution(await read("get_type", time, signal));
}
