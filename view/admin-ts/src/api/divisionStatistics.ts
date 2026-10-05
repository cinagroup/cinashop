import request, { getData } from "@/utils/request";

export interface DivisionStatisticsSummary {
  divisionNum: number;
  agentNum: number;
  staffNum: number;
  orderNum: number;
  orderPrice: string;
  brokeragePrice: string;
}

export interface DivisionStatisticsTrend {
  xAxis: string[];
  series: Array<{ name: "订单金额" | "订单量"; type: "line"; data: number[] }>;
}

export interface DivisionStatisticsRankingItem {
  uid: number;
  nickname: string;
  spreadAgent: number;
  spreadStaff: number;
  orderNum: number;
  orderPrice: string;
  brokeragePrice: string;
}

const base = "/agent/division/statistics-screen";
const amount = /^-?\d+\.\d{2}$/u;
const dayPattern = /^(\d{4})\/(\d{2})\/(\d{2})$/u;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("事业部统计响应格式错误");
  return value as Record<string, unknown>;
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function money(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && amount.test(value);
}

function date(value: string): number {
  const match = dayPattern.exec(value);
  if (!match) throw new Error("请选择有效的统计日期");
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const stamp = Date.UTC(year, month - 1, day);
  const check = new Date(stamp);
  if (year < 1970 || year > 2037 || check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) throw new Error("请选择有效的统计日期");
  return stamp;
}

export function divisionStatisticsTime(range: string[]): string {
  if (range.length !== 2) throw new Error("请选择完整日期范围");
  const [start, end] = range;
  const first = date(start), last = date(end);
  if (last < first || (last - first) / 86_400_000 >= 366) throw new Error("统计日期最多 366 天且结束日期不得早于开始日期");
  return `${start}-${end}`;
}

export function parseDivisionStatisticsSummary(value: unknown): DivisionStatisticsSummary {
  const row = record(value);
  if (!["divisionNum", "agentNum", "staffNum", "orderNum"].every((key) => count(row[key])) ||
    !money(row.orderPrice) || !money(row.brokeragePrice)) throw new Error("事业部概览响应格式错误");
  return {
    divisionNum: row.divisionNum as number, agentNum: row.agentNum as number,
    staffNum: row.staffNum as number, orderNum: row.orderNum as number,
    orderPrice: row.orderPrice, brokeragePrice: row.brokeragePrice,
  };
}

export function parseDivisionStatisticsTrend(value: unknown): DivisionStatisticsTrend {
  const row = record(value);
  if (!Array.isArray(row.xAxis) || row.xAxis.length > 366 ||
    !row.xAxis.every((item) => typeof item === "string" && item.length > 0 && item.length <= 10) ||
    !Array.isArray(row.series) || row.series.length !== 2) throw new Error("事业部趋势响应格式错误");
  const expected = ["订单金额", "订单量"];
  const series = row.series.map((item: unknown, index: number) => {
    const line = record(item);
    if (line.name !== expected[index] || line.type !== "line" || !Array.isArray(line.data) ||
      line.data.length !== (row.xAxis as unknown[]).length ||
      !line.data.every((point: unknown) => index === 0
        ? typeof point === "number" && Number.isFinite(point)
        : count(point))) {
      throw new Error("事业部趋势响应格式错误");
    }
    return { name: line.name, type: "line" as const, data: line.data };
  });
  return { xAxis: row.xAxis, series } as DivisionStatisticsTrend;
}

export function parseDivisionStatisticsRanking(value: unknown): DivisionStatisticsRankingItem[] {
  const row = record(value);
  if (!Array.isArray(row.list) || row.list.length > 500) throw new Error("事业部排行响应格式错误");
  const seen = new Set<number>();
  return row.list.map((value: unknown) => {
    const item = record(value);
    if (!count(item.uid) || item.uid === 0 || seen.has(item.uid) ||
      typeof item.nickname !== "string" || item.nickname.length > 255 ||
      !count(item.spreadAgent) || !count(item.spreadStaff) || !count(item.orderNum) ||
      !money(item.orderPrice) || !money(item.brokeragePrice)) throw new Error("事业部排行响应格式错误");
    seen.add(item.uid);
    return {
      uid: item.uid, nickname: item.nickname, spreadAgent: item.spreadAgent,
      spreadStaff: item.spreadStaff, orderNum: item.orderNum,
      orderPrice: item.orderPrice, brokeragePrice: item.brokeragePrice,
    };
  });
}

export async function apiDivisionStatisticsSummary(signal?: AbortSignal): Promise<DivisionStatisticsSummary> {
  return parseDivisionStatisticsSummary(await getData<unknown>(request.get(`${base}/summary`, { signal })));
}

export async function apiDivisionStatisticsTrend(time: string, signal?: AbortSignal): Promise<DivisionStatisticsTrend> {
  const range = time.split("-");
  divisionStatisticsTime(range);
  return parseDivisionStatisticsTrend(await getData<unknown>(request.get(`${base}/trend`, { params: { time }, signal })));
}

export async function apiDivisionStatisticsRanking(signal?: AbortSignal): Promise<DivisionStatisticsRankingItem[]> {
  return parseDivisionStatisticsRanking(await getData<unknown>(request.get(`${base}/ranking`, { signal })));
}
