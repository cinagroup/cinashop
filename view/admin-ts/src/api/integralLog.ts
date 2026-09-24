import request, { getData } from "@/utils/request";

export interface IntegralLogRow {
  id: number;
  uid: number;
  title: string;
  type: string;
  pm: 0 | 1;
  number: string;
  balance: string;
  mark: string;
  nickname: string;
  add_time: number;
}

export interface IntegralLogPage {
  list: IntegralLogRow[];
  count: number;
  page: number;
  limit: number;
}

export interface IntegralLogStats {
  total_integral: string;
  sign_count: string;
  sign_integral: string;
  used_integral: string;
}

export interface IntegralLogQuery {
  page: number;
  limit: number;
  keyword?: string;
  type?: string;
  start?: number;
  stop?: number;
}

function integer(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function wholeNumberText(value: unknown): value is string {
  return typeof value === "string" && /^-?\d+$/u.test(value);
}

export function parseIntegralLogPage(value: unknown): IntegralLogPage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("积分日志格式错误");
  const page = value as Record<string, unknown>;
  if (!Array.isArray(page.list) || !integer(page.count, 0) || !integer(page.page, 1) ||
    !integer(page.limit, 1) || page.list.length > page.limit || page.list.length > page.count) {
    throw new Error("积分日志格式错误");
  }
  const ids = new Set<number>();
  const list = page.list.map((item): IntegralLogRow => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("积分日志记录格式错误");
    const row = item as Record<string, unknown>;
    if (!integer(row.id, 1) || !integer(row.uid, 0) || ids.has(row.id) ||
      typeof row.title !== "string" || typeof row.type !== "string" ||
      (row.pm !== 0 && row.pm !== 1) || !wholeNumberText(row.number) || !wholeNumberText(row.balance) ||
      typeof row.mark !== "string" || typeof row.nickname !== "string" ||
      !integer(row.add_time, 0)) throw new Error("积分日志记录格式错误");
    ids.add(row.id);
    return row as unknown as IntegralLogRow;
  });
  return { list, count: page.count, page: page.page, limit: page.limit };
}

export function parseIntegralLogStats(value: unknown): IntegralLogStats {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("积分统计格式错误");
  const stats = value as Record<string, unknown>;
  for (const field of ["total_integral", "sign_count", "sign_integral", "used_integral"] as const) {
    if (!wholeNumberText(stats[field])) throw new Error("积分统计格式错误");
  }
  return stats as unknown as IntegralLogStats;
}

export async function apiAdminIntegralLogs(query: IntegralLogQuery, signal?: AbortSignal): Promise<IntegralLogPage> {
  return parseIntegralLogPage(await getData<unknown>(request.get("/marketing/user-point/logs", { params: query, signal })));
}

export async function apiAdminIntegralStatistics(query: Omit<IntegralLogQuery, "page" | "limit">, signal?: AbortSignal): Promise<IntegralLogStats> {
  return parseIntegralLogStats(await getData<unknown>(request.get("/marketing/user-point/statistics", { params: query, signal })));
}
