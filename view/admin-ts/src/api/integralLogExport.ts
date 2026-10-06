import request, { getData } from "@/utils/request";
import type { IntegralLogQuery } from "./integralLog";

export const integralLogExportHeaders = ["编号", "标题", "变动后积分", "积分变动", "备注", "用户微信昵称", "添加时间"] as const;
export const integralLogExportKeys = ["id", "title", "balance", "number", "mark", "nickname", "add_time"] as const;
type Key = (typeof integralLogExportKeys)[number];
export type IntegralLogExportRow = Record<Key, string>;
export interface IntegralLogExportManifest {
  header: string[];
  filekey: string[];
  export: IntegralLogExportRow[];
  filename: string;
  count: number;
  page: number;
  limit: number;
  has_more: boolean;
  snapshot: string;
  csv_bytes: number;
  max_rows: number;
  max_bytes: number;
  timezone: string;
}
export type IntegralLogExportFilters = Omit<IntegralLogQuery, "page" | "limit">;
const MAX_ROWS = 100_000;
const MAX_BYTES = 16 * 1024 * 1024;
const PAGE_ROWS = 1_000;
const encoder = new TextEncoder();

function validInteger(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function unsafeText(value: string): boolean {
  return /^[\s\u200b\ufeff]*[=+@-]/u.test(value) || /^[\t\r\n]/u.test(value);
}

function validateManifest(value: unknown, page: number, snapshot?: string): IntegralLogExportManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("积分导出清单格式错误");
  const data = value as Record<string, unknown>;
  const offset = (page - 1) * PAGE_ROWS;
  if (JSON.stringify(data.header) !== JSON.stringify(integralLogExportHeaders) ||
    JSON.stringify(data.filekey) !== JSON.stringify(integralLogExportKeys) ||
    !Array.isArray(data.export) || data.filename !== "积分日志" ||
    !validInteger(data.count, 0) || data.count > MAX_ROWS || data.page !== page || data.limit !== PAGE_ROWS ||
    data.export.length !== Math.min(PAGE_ROWS, Math.max(0, data.count - offset)) ||
    data.has_more !== (offset + data.export.length < data.count) ||
    typeof data.snapshot !== "string" || !/^[a-f0-9]{64}$/u.test(data.snapshot) ||
    (snapshot !== undefined && data.snapshot !== snapshot) ||
    !validInteger(data.csv_bytes, 0) || data.csv_bytes > MAX_BYTES ||
    data.max_rows !== MAX_ROWS || data.max_bytes !== MAX_BYTES || data.timezone !== "Asia/Shanghai") {
    throw new Error("积分导出清单不完整或快照已变化，请重试");
  }
  const ids = new Set<string>();
  for (const item of data.export) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("积分导出字段无效");
    const row = item as Record<string, unknown>;
    if (integralLogExportKeys.some(key => typeof row[key] !== "string") ||
      typeof row.id !== "string" || !/^[1-9]\d*$/u.test(row.id) || ids.has(row.id) ||
      !/^-?\d+$/u.test(row.balance as string) || !/^-?\d+$/u.test(row.number as string) ||
      (row.add_time !== "" && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(row.add_time as string)) ||
      [row.title, row.mark, row.nickname].some(cell => unsafeText(cell as string))) {
      throw new Error("积分导出字段无效或存在未保护的表格公式");
    }
    ids.add(row.id);
  }
  return data as unknown as IntegralLogExportManifest;
}

export async function apiAdminIntegralLogExport(
  filters: IntegralLogExportFilters, page: number, signal?: AbortSignal, snapshot?: string,
): Promise<IntegralLogExportManifest> {
  if (!validInteger(page, 1) || (page - 1) * PAGE_ROWS >= MAX_ROWS ||
    (page > 1 && !/^[a-f0-9]{64}$/u.test(snapshot ?? ""))) throw new Error("积分导出分页或快照无效");
  const params = { ...filters, page, limit: PAGE_ROWS, ...(snapshot ? { snapshot } : {}) };
  return validateManifest(await getData<unknown>(request.get("/marketing/user-point/export", { params, signal })), page, snapshot);
}

function csvLine(cells: readonly string[]): string {
  return cells.map(cell => `"${cell.replace(/"/gu, '""')}"`).join(",") + "\r\n";
}

export function buildIntegralLogCsv(rows: readonly IntegralLogExportRow[]): string {
  const csv = "\ufeff" + csvLine(integralLogExportHeaders) +
    rows.map(row => csvLine(integralLogExportKeys.map(key => row[key]))).join("");
  if (encoder.encode(csv).byteLength > MAX_BYTES) throw new Error("积分导出文件超限，请缩小筛选范围");
  return csv;
}

export async function collectIntegralLogExport(
  filters: IntegralLogExportFilters, signal: AbortSignal, progress: (read: number, total: number) => void,
): Promise<{ csv: string; filename: string }> {
  const rows: IntegralLogExportRow[] = [];
  const ids = new Set<string>();
  let first: IntegralLogExportManifest | null = null;
  for (let page = 1; page <= MAX_ROWS / PAGE_ROWS; page++) {
    if (signal.aborted) throw new DOMException("导出已取消", "AbortError");
    const current = await apiAdminIntegralLogExport(filters, page, signal, first?.snapshot);
    if (signal.aborted) throw new DOMException("导出已取消", "AbortError");
    if (!first) first = current;
    if (current.count !== first.count || current.csv_bytes !== first.csv_bytes || current.snapshot !== first.snapshot) {
      throw new Error("导出期间积分流水发生变化，请重试");
    }
    for (const row of current.export) {
      if (ids.has(row.id)) throw new Error("积分导出记录重复，请重试");
      ids.add(row.id);
      rows.push(row);
    }
    progress(rows.length, first.count);
    if (!current.has_more) {
      if (rows.length !== first.count) throw new Error("积分导出结果不完整，请重试");
      const csv = buildIntegralLogCsv(rows);
      if (encoder.encode(csv).byteLength !== first.csv_bytes) throw new Error("积分导出文件字节数不符，请重试");
      return { csv, filename: first.filename };
    }
  }
  throw new Error("积分导出超过完整容量，请缩小筛选范围");
}

export function downloadIntegralLogCsv(csv: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  try {
    link.href = url;
    link.download = `${filename.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/gu, "_").slice(0, 100) || "积分日志"}_${Date.now()}.csv`;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
  } finally {
    link.remove();
    URL.revokeObjectURL(url);
  }
}
