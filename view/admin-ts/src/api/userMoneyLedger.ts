import request, { getData } from "@/utils/request";

export const USER_MONEY_PAGE_SIZE = 20;
const EXPORT_PAGE_SIZE = 1_000;
const MAX_EXPORT_ROWS = 100_000;
const MAX_EXPORT_BYTES = 16 * 1024 * 1024;
const encoder = new TextEncoder();

export interface UserMoneyLedgerFilters {
  keyword: string;
  type: string;
  start: number;
  stop: number;
}
export interface UserMoneyLedgerQuery extends UserMoneyLedgerFilters {
  page: number;
  limit: 20;
}
export interface UserMoneyLedgerRow {
  id: number;
  uid: number;
  nickname: string;
  pm: 0 | 1;
  number: string;
  title: string;
  type: string;
  mark: string;
  add_time: string;
}
export interface UserMoneyLedgerPage {
  list: UserMoneyLedgerRow[];
  count: number;
  page: number;
  limit: 20;
}
export interface UserMoneyLedgerType { type: string; title: string }

export const userMoneyExportHeaders = ["会员ID", "昵称", "金额", "类型", "备注", "创建时间"] as const;
export const userMoneyExportKeys = ["uid", "nickname", "pm", "title", "mark", "add_time"] as const;
type ExportKey = (typeof userMoneyExportKeys)[number];
export type UserMoneyExportRow = Record<ExportKey, string>;
export interface UserMoneyExportManifest {
  header: string[];
  filekey: string[];
  export: UserMoneyExportRow[];
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

function integer(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function money(value: unknown): value is string {
  return typeof value === "string" && /^-?\d+(?:\.\d+)?$/u.test(value);
}
function shanghaiTime(value: unknown): value is string {
  return typeof value === "string" && (value === "" || /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(value));
}
function safeSpreadsheetText(value: unknown): value is string {
  return typeof value === "string" && !/^[\s\u200b\ufeff]*[=+@-]/u.test(value) && !/^[\t\r\n]/u.test(value);
}

export function normalizeUserMoneyFilters(input: Partial<UserMoneyLedgerFilters> = {}): UserMoneyLedgerFilters {
  const keyword = (input.keyword ?? "").trim();
  const type = (input.type ?? "").trim();
  const start = input.start ?? 0, stop = input.stop ?? 0;
  if (keyword.length > 100 || /[\u0000-\u001f\u007f]/u.test(keyword) ||
    type.length > 64 || /[\u0000-\u001f\u007f]/u.test(type) ||
    !integer(start, 0, 2_147_483_647) || !integer(stop, 0, 2_147_483_647) ||
    (start === 0) !== (stop === 0) || start > stop) {
    throw new Error("资金流水筛选条件无效");
  }
  return { keyword, type, start, stop };
}

export function normalizeUserMoneyQuery(input: UserMoneyLedgerQuery): UserMoneyLedgerQuery {
  if (!integer(input.page, 1, 2_147_483_647) || input.limit !== USER_MONEY_PAGE_SIZE) {
    throw new Error("资金流水分页参数无效");
  }
  return { ...normalizeUserMoneyFilters(input), page: input.page, limit: USER_MONEY_PAGE_SIZE };
}

export function parseUserMoneyPage(value: unknown, query: UserMoneyLedgerQuery): UserMoneyLedgerPage {
  if (!record(value) || !Array.isArray(value.list) || !integer(value.count, 0) ||
    value.page !== query.page || value.limit !== USER_MONEY_PAGE_SIZE ||
    value.list.length > USER_MONEY_PAGE_SIZE ||
    value.list.length > Math.max(0, value.count - (query.page - 1) * USER_MONEY_PAGE_SIZE)) {
    throw new Error("资金流水分页结果无效");
  }
  const ids = new Set<number>();
  const list = value.list.map((item): UserMoneyLedgerRow => {
    if (!record(item) || !integer(item.id, 1) || ids.has(item.id) ||
      !integer(item.uid, 0) || typeof item.nickname !== "string" ||
      (item.pm !== 0 && item.pm !== 1) || !money(item.number) ||
      typeof item.title !== "string" || typeof item.type !== "string" ||
      typeof item.mark !== "string" || !shanghaiTime(item.add_time)) {
      throw new Error("资金流水记录无效");
    }
    ids.add(item.id);
    return item as unknown as UserMoneyLedgerRow;
  });
  return { list, count: value.count, page: query.page, limit: USER_MONEY_PAGE_SIZE };
}

export function parseUserMoneyTypes(value: unknown): UserMoneyLedgerType[] {
  if (!record(value) || !Array.isArray(value.list)) throw new Error("资金流水类型目录无效");
  const seen = new Set<string>();
  const rows: UserMoneyLedgerType[] = [];
  for (const item of value.list) {
    if (!record(item) || typeof item.type !== "string" || item.type.length > 64 ||
      typeof item.title !== "string" || seen.has(item.type)) throw new Error("资金流水类型目录无效");
    // Legacy DISTINCT includes the empty default type; it is the "all types" filter, not an option.
    if (!item.type) continue;
    seen.add(item.type);
    rows.push({ type: item.type, title: item.title });
  }
  return rows;
}

export async function apiUserMoneyLedger(query: UserMoneyLedgerQuery, signal?: AbortSignal): Promise<UserMoneyLedgerPage> {
  const normalized = normalizeUserMoneyQuery(query);
  return parseUserMoneyPage(await getData<unknown>(request.get("/finance/user-money-ledger", {
    params: normalized, signal,
  })), normalized);
}
export async function apiUserMoneyLedgerTypes(signal?: AbortSignal): Promise<UserMoneyLedgerType[]> {
  return parseUserMoneyTypes(await getData<unknown>(request.get("/finance/user-money-ledger/types", { signal })));
}

function parseExportManifest(value: unknown, page: number, snapshot?: string): UserMoneyExportManifest {
  if (!record(value)) throw new Error("资金流水导出清单格式错误");
  const offset = (page - 1) * EXPORT_PAGE_SIZE;
  if (JSON.stringify(value.header) !== JSON.stringify(userMoneyExportHeaders) ||
    JSON.stringify(value.filekey) !== JSON.stringify(userMoneyExportKeys) ||
    !Array.isArray(value.export) || value.filename !== "资金监控" ||
    !integer(value.count, 0, MAX_EXPORT_ROWS) || value.page !== page || value.limit !== EXPORT_PAGE_SIZE ||
    value.export.length !== Math.min(EXPORT_PAGE_SIZE, Math.max(0, value.count - offset)) ||
    value.has_more !== (offset + value.export.length < value.count) ||
    typeof value.snapshot !== "string" || !/^[a-f0-9]{64}$/u.test(value.snapshot) ||
    (snapshot !== undefined && value.snapshot !== snapshot) ||
    !integer(value.csv_bytes, 0, MAX_EXPORT_BYTES) ||
    value.max_rows !== MAX_EXPORT_ROWS || value.max_bytes !== MAX_EXPORT_BYTES ||
    value.timezone !== "Asia/Shanghai") {
    throw new Error("资金流水导出清单不完整或快照已变化，请重试");
  }
  for (const item of value.export) {
    if (!record(item) || userMoneyExportKeys.some(key => typeof item[key] !== "string") ||
      typeof item.uid !== "string" || !/^\d+$/u.test(item.uid) ||
      typeof item.pm !== "string" || !/^-?\d+(?:\.\d+)?$/u.test(item.pm) ||
      !shanghaiTime(item.add_time) ||
      ![item.nickname, item.title, item.mark].every(safeSpreadsheetText)) {
      throw new Error("资金流水导出字段无效或存在未保护的表格公式");
    }
  }
  return value as unknown as UserMoneyExportManifest;
}

export async function apiUserMoneyLedgerExport(
  filters: UserMoneyLedgerFilters, page: number, signal?: AbortSignal, snapshot?: string,
): Promise<UserMoneyExportManifest> {
  if (!integer(page, 1, MAX_EXPORT_ROWS / EXPORT_PAGE_SIZE) ||
    (page > 1 && !/^[a-f0-9]{64}$/u.test(snapshot ?? ""))) throw new Error("资金流水导出分页或快照无效");
  const params = { ...normalizeUserMoneyFilters(filters), page, limit: EXPORT_PAGE_SIZE,
    ...(snapshot ? { snapshot } : {}) };
  return parseExportManifest(await getData<unknown>(request.get("/finance/user-money-ledger/export", {
    params, signal,
  })), page, snapshot);
}

function csvLine(cells: readonly string[]): string {
  return cells.map(cell => `"${cell.replace(/"/gu, '""')}"`).join(",") + "\r\n";
}
export function buildUserMoneyCsv(rows: readonly UserMoneyExportRow[]): string {
  if (rows.length > MAX_EXPORT_ROWS) throw new Error("资金流水导出超过容量，请缩小筛选范围");
  const csv = "\ufeff" + csvLine(userMoneyExportHeaders) +
    rows.map(row => csvLine(userMoneyExportKeys.map(key => row[key]))).join("");
  if (encoder.encode(csv).byteLength > MAX_EXPORT_BYTES) throw new Error("资金流水导出文件超限，请缩小筛选范围");
  return csv;
}
export async function collectUserMoneyExport(
  filters: UserMoneyLedgerFilters, signal: AbortSignal, progress: (read: number, total: number) => void,
): Promise<{ csv: string; filename: string }> {
  const normalized = normalizeUserMoneyFilters(filters);
  const rows: UserMoneyExportRow[] = [];
  let first: UserMoneyExportManifest | null = null;
  for (let page = 1; page <= MAX_EXPORT_ROWS / EXPORT_PAGE_SIZE; page++) {
    if (signal.aborted) throw new DOMException("导出已取消", "AbortError");
    const current = await apiUserMoneyLedgerExport(normalized, page, signal, first?.snapshot);
    if (signal.aborted) throw new DOMException("导出已取消", "AbortError");
    if (!first) first = current;
    if (current.count !== first.count || current.csv_bytes !== first.csv_bytes || current.snapshot !== first.snapshot) {
      throw new Error("导出期间资金流水发生变化，请重试");
    }
    rows.push(...current.export);
    progress(rows.length, first.count);
    if (!current.has_more) {
      if (rows.length !== first.count) throw new Error("资金流水导出结果不完整，请重试");
      const csv = buildUserMoneyCsv(rows);
      if (encoder.encode(csv).byteLength !== first.csv_bytes) throw new Error("资金流水导出文件字节数不符，请重试");
      return { csv, filename: first.filename };
    }
  }
  throw new Error("资金流水导出超过完整容量，请缩小筛选范围");
}

export function downloadUserMoneyCsv(csv: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  try {
    link.href = url;
    link.download = `${filename.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/gu, "_").slice(0, 100) || "资金监控"}_${Date.now()}.csv`;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
  } finally {
    link.remove();
    URL.revokeObjectURL(url);
  }
}
