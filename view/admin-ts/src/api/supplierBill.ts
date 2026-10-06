import request, { getData } from "@/utils/request";

export type SupplierBillTimeType = "day" | "week" | "month";
export type SupplierBillStatus = "" | "0" | "1" | "-1";

export interface SupplierBillSupplier {
  id: number;
  supplier_name: string;
}

export interface SupplierBillScope {
  timeType: SupplierBillTimeType;
  /** Shanghai wall time; the server applies this range to add_time, even for completed bills. */
  data: string;
  supplier_id: number | "";
  status: SupplierBillStatus;
}

export interface SupplierBillGroup {
  id: number;
  period: string;
  day: string;
  title: string;
  add_time: string;
  income_num: string;
  exp_num: string;
  entry_num: string;
}

export interface SupplierBillDetail {
  id: number;
  order_id: string;
  link_id: string;
  trade_time: string;
  finish_time?: string;
  number: string;
  pm: 0 | 1;
  user_nickname: string;
  type_name: string;
  pay_type_name: string;
  remark: string;
}

export interface SupplierBillPage<T> {
  list: T[];
  count: number;
  page: number;
  limit: number;
}

export interface SupplierBillExport {
  filename: string;
  header: string[];
  filekey: string[];
  export: Array<Record<string, unknown>>;
  count: number;
}

export interface SupplierBillGroupScope extends SupplierBillScope {
  period: string;
}

const base = "/supplier/bill-screen";
const dateTimePattern = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/u;

function validShanghaiTime(value: string): number {
  const match = dateTimePattern.exec(value);
  if (!match) throw new Error("请选择有效的北京时间范围");
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const [year, month, day, hour, minute, second] =
    [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const utc = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(utc);
  if (year < 1970 || year > 2038 || check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day ||
    check.getUTCHours() !== hour || check.getUTCMinutes() !== minute ||
    check.getUTCSeconds() !== second) throw new Error("请选择有效的北京时间范围");
  const epoch = (utc - 8 * 3_600_000) / 1000;
  if (epoch < 0 || epoch > 2_147_483_647) throw new Error("创建时间超出账单可查询范围");
  return utc;
}

/** Element Plus emits wall-clock strings; do not reinterpret them in the browser's timezone. */
export function supplierBillDataRange(value: string[] | null): string {
  if (!value || value.length === 0) return "";
  if (value.length !== 2) throw new Error("请选择完整的创建时间范围");
  const start = validShanghaiTime(value[0]);
  const end = validShanghaiTime(value[1]);
  if (end < start || end - start > 366 * 86_400_000) {
    throw new Error("创建时间范围最多 366 天，结束时间不得早于开始时间");
  }
  const midnight = value[1].endsWith(" 00:00:00");
  if ((midnight || end === start) && (end - 8 * 3_600_000) / 1000 + 86_400 > 2_147_483_647) {
    throw new Error("创建时间超出账单可查询范围");
  }
  return `${value[0]}-${value[1]}`;
}

function validScope(scope: SupplierBillScope): void {
  if (!["day", "week", "month"].includes(scope.timeType) ||
    !["", "0", "1", "-1"].includes(scope.status) ||
    (scope.supplier_id !== "" && (!Number.isSafeInteger(scope.supplier_id) || scope.supplier_id <= 0)) ||
    (scope.data && !/^(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2})-(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2})$/u.test(scope.data))) {
    throw new Error("供应商账单筛选条件无效");
  }
}

function validGroupScope(scope: SupplierBillGroupScope): void {
  validScope(scope);
  if (!scope.period || scope.period.length > 40 || /[\u0000-\u001f\u007f]/u.test(scope.period)) {
    throw new Error("账单分组标识无效");
  }
}

export function apiSupplierBillSuppliers(signal?: AbortSignal): Promise<SupplierBillSupplier[]> {
  return getData(request.get(`${base}/suppliers`, { signal }));
}

export function apiSupplierBillGroups(
  scope: SupplierBillScope & { page: number; limit: number }, signal?: AbortSignal,
): Promise<SupplierBillPage<SupplierBillGroup>> {
  validScope(scope);
  return getData(request.get(`${base}/groups`, { params: scope, signal }));
}

export function apiSupplierBillDetails(
  scope: SupplierBillGroupScope & { keyword: string; page: number; limit: number }, signal?: AbortSignal,
): Promise<SupplierBillPage<SupplierBillDetail>> {
  validGroupScope(scope);
  if (scope.keyword.length > 80 || /[\u0000-\u001f\u007f]/u.test(scope.keyword)) {
    return Promise.reject(new Error("详情搜索不能超过 80 字且不能含控制字符"));
  }
  return getData(request.get(`${base}/details`, { params: scope, signal }));
}

export function apiSupplierBillExport(scope: SupplierBillGroupScope, signal?: AbortSignal): Promise<SupplierBillExport> {
  validGroupScope(scope);
  return getData(request.get(`${base}/export`, { params: scope, signal }));
}

/** Escape both CSV syntax and spreadsheet formula prefixes in untrusted ledger text. */
export function supplierBillCsv(data: SupplierBillExport): string {
  if (!Array.isArray(data.header) || !Array.isArray(data.filekey) ||
    data.header.length !== data.filekey.length || data.header.length !== 8 ||
    !Array.isArray(data.export) || data.export.length > 5000 || data.count !== data.export.length ||
    data.header.some((value) => typeof value !== "string") ||
    data.filekey.some((value) => typeof value !== "string")) {
    throw new Error("账单导出响应格式错误");
  }
  const cell = (value: unknown): string => {
    const raw = value == null ? "" : String(value);
    const safe = /^[\s\u0000-\u001f]*[=+\-@]/u.test(raw) ? `'${raw}` : raw;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  return `\uFEFF${[data.header.map(cell).join(","),
    ...data.export.map((row) => data.filekey.map((key) => cell(row[key])).join(","))].join("\r\n")}\r\n`;
}
