import request, { getData } from "@/utils/request";

export interface SupplierCapitalSupplier { id: number; supplier_name: string }
export interface SupplierCapitalScope { supplier_id: number | ""; data: string; keyword: string }
export interface SupplierCapitalRow {
  id: number;
  order_id: string;
  link_id: string;
  trade_time: string;
  number: string;
  pm: 0 | 1;
  uid: number;
  user_nickname: string;
  supplier_name: string;
  type_name: string;
  pay_type_name: string;
  remark: string;
  remark_editable: boolean;
}
export interface SupplierCapitalPage {
  list: SupplierCapitalRow[];
  count: number;
  page: number;
  limit: number;
}
export interface SupplierCapitalExport {
  filename: string;
  header: string[];
  filekey: string[];
  export: Array<Record<string, unknown>>;
  count: number;
}

const base = "/supplier/capital-screen";
const exportKeys = ["order_id", "link_id", "trade_time", "number", "pm", "user_nickname", "type_name", "pay_type_name"];

function shanghaiWallTime(value: string): number {
  const match = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/u.exec(value);
  if (!match) throw new Error("请选择有效的北京时间范围");
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const utc = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(utc);
  if (year < 1970 || year > 2038 || check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day ||
    check.getUTCHours() !== hour || check.getUTCMinutes() !== minute ||
    check.getUTCSeconds() !== second || (utc - 8 * 3_600_000) / 1000 < 0 ||
    (utc - 8 * 3_600_000) / 1000 > 2_147_483_647) {
    throw new Error("请选择有效的北京时间范围");
  }
  return utc;
}

/** Date picker strings are Shanghai wall time, independent of the operator's browser timezone. */
export function supplierCapitalDataRange(value: string[] | null): string {
  if (!value || value.length === 0) return "";
  if (value.length !== 2) throw new Error("请选择完整的创建时间范围");
  const start = shanghaiWallTime(value[0]);
  const end = shanghaiWallTime(value[1]);
  if (end < start || end - start > 366 * 86_400_000) {
    throw new Error("创建时间范围最多 366 天，结束时间不得早于开始时间");
  }
  const endEpoch = (end - 8 * 3_600_000) / 1000;
  if ((end === start || value[1].endsWith(" 00:00:00")) && endEpoch + 86_400 > 2_147_483_647) {
    throw new Error("创建时间超出可查询范围");
  }
  return `${value[0]}-${value[1]}`;
}

function validScope(scope: SupplierCapitalScope): void {
  if ((scope.supplier_id !== "" && (!Number.isSafeInteger(scope.supplier_id) || scope.supplier_id <= 0)) ||
    scope.keyword.length > 80 || /[\u0000-\u001f\u007f]/u.test(scope.keyword) ||
    (scope.data && !/^(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2})-(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2})$/u.test(scope.data))) {
    throw new Error("供应商流水筛选条件无效");
  }
}

export function apiSupplierCapitalSuppliers(signal?: AbortSignal): Promise<SupplierCapitalSupplier[]> {
  return getData(request.get(`${base}/suppliers`, { signal }));
}

export function apiSupplierCapitalList(scope: SupplierCapitalScope & { page: number; limit: number }, signal?: AbortSignal): Promise<SupplierCapitalPage> {
  validScope(scope);
  return getData(request.get(`${base}/list`, { params: scope, signal }));
}

export function apiSupplierCapitalExport(scope: SupplierCapitalScope, signal?: AbortSignal): Promise<SupplierCapitalExport> {
  validScope(scope);
  return getData(request.get(`${base}/export`, { params: scope, signal }));
}

export function apiSupplierCapitalRemark(
  id: number, remark: string, expectedRemark: string, signal?: AbortSignal,
): Promise<{ id: number; remark: string }> {
  if (!Number.isSafeInteger(id) || id <= 0 || !remark.trim() || [...remark].length > 200 ||
    typeof expectedRemark !== "string") {
    return Promise.reject(new Error("备注须填写且不能超过 200 字"));
  }
  return getData(request.put(`${base}/remark/${id}`, { remark, expected_remark: expectedRemark }, { signal }));
}

/** Keep the old eight export columns, while escaping CSV and spreadsheet formulas. */
export function supplierCapitalCsv(data: SupplierCapitalExport): string {
  if (!Array.isArray(data.header) || !Array.isArray(data.filekey) ||
    data.header.length !== exportKeys.length || data.filekey.length !== exportKeys.length ||
    data.filekey.some((key, index) => key !== exportKeys[index]) ||
    data.header.some((value) => typeof value !== "string") ||
    !Array.isArray(data.export) || data.export.length > 5000 || data.count !== data.export.length) {
    throw new Error("流水导出响应格式错误");
  }
  const cell = (value: unknown): string => {
    const raw = value == null ? "" : String(value);
    const safe = /^[\s\u0000-\u001f]*[=+\-@]/u.test(raw) ? `'${raw}` : raw;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  return `\uFEFF${[data.header.map(cell).join(","),
    ...data.export.map((row) => data.filekey.map((key) => cell(row[key])).join(","))].join("\r\n")}\r\n`;
}
