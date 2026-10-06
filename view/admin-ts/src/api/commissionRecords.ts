import request, { getData } from "@/utils/request";

export interface CommissionListQuery {
  page: number;
  limit: 20;
  keyword: string;
  price_min: string;
  price_max: string;
  start_time: string;
  end_time: string;
}
export interface CommissionRecordsQuery { page: number; limit: 20; start_time: string; end_time: string }
export interface CommissionRow {
  uid: number; nickname: string; phone: string; display_name: string;
  now_money: string; brokerage_price: string; extract_price: string; sum_number: string;
  time: number; user_deleted: boolean; issues: string[];
}
export interface CommissionDetail {
  uid: number; nickname: string; spread_name: string; number: string; now_money: string;
  brokerage_price: string; add_time: number; user_deleted: boolean; issues: string[];
}
export interface CommissionRecord {
  id: number; number: string; add_time: number; mark: string; pm: number; type: string;
  status: number; issues: string[];
}
export interface CommissionPage<T> { list: T[]; count: number; page: number; limit: number }

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const signedInteger = (value: unknown): value is number => Number.isSafeInteger(value);
const text = (value: unknown): value is string => typeof value === "string";
const issues = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);

function shanghaiTime(value: string, day: boolean): number {
  const match = day ? /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
    : /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/u.exec(value);
  if (!match) throw new Error("佣金日期格式错误");
  const [year, month, date, hour = 0, minute = 0] = match.slice(1).map(Number);
  const utc = Date.UTC(year, month - 1, date, hour, minute);
  const parsed = new Date(utc);
  if (year < 1970 || year > 2038 || parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== date || parsed.getUTCHours() !== hour || parsed.getUTCMinutes() !== minute) {
    throw new Error("佣金日期无效");
  }
  const seconds = Math.floor((utc - 8 * 3_600_000) / 1000);
  if (seconds < 0 || seconds > 2_147_483_647) throw new Error("佣金日期超出范围");
  return seconds;
}
function timeRange(start: string, end: string, dayAllowed: boolean): void {
  if (!!start !== !!end) throw new Error("佣金时间须成对填写");
  if (!start) return;
  const day = dayAllowed && /^\d{4}-\d{2}-\d{2}$/u.test(start);
  if (day !== (dayAllowed && /^\d{4}-\d{2}-\d{2}$/u.test(end))) throw new Error("佣金时间精度不一致");
  const first = shanghaiTime(start, day), last = shanghaiTime(end, day);
  if (last < first || last - first > 366 * 86_400 || last + (day ? 86_399 : 59) > 2_147_483_647)
    throw new Error("佣金时间范围无效");
}
function page(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 501) throw new Error("佣金页码超出范围");
}
const money = /^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/u;
export function normalizeCommissionQuery(value: CommissionListQuery): CommissionListQuery {
  page(value.page);
  if (value.limit !== 20 || typeof value.keyword !== "string" || [...value.keyword.trim()].length > 80 ||
    /[\u0000-\u001f\u007f]/u.test(value.keyword) ||
    (value.price_min !== "" && !money.test(value.price_min)) ||
    (value.price_max !== "" && !money.test(value.price_max)) ||
    (value.price_min !== "" && value.price_max !== "" && Number(value.price_min) > Number(value.price_max))) {
    throw new Error("佣金查询条件无效");
  }
  timeRange(value.start_time, value.end_time, false);
  return { ...value, keyword: value.keyword.trim() };
}
export function normalizeCommissionRecordsQuery(value: CommissionRecordsQuery): CommissionRecordsQuery {
  page(value.page);
  if (value.limit !== 20) throw new Error("佣金明细分页无效");
  timeRange(value.start_time, value.end_time, true);
  return value;
}
function parseRow(value: unknown): CommissionRow {
  if (!object(value) || !integer(value.uid) || value.uid === 0 || !integer(value.time) ||
    !["nickname", "phone", "display_name", "now_money", "brokerage_price", "extract_price", "sum_number"].every(key => text(value[key])) ||
    typeof value.user_deleted !== "boolean" || !issues(value.issues)) throw new Error("佣金列表响应格式错误");
  return value as unknown as CommissionRow;
}
function parsePage<T>(value: unknown, query: { page: number; limit: 20 }, parse: (item: unknown) => T, id: (row: T) => number): CommissionPage<T> {
  if (!object(value) || !Array.isArray(value.list) || !integer(value.count) || value.page !== query.page ||
    value.limit !== query.limit || value.list.length > 20 || value.list.length > value.count) throw new Error("佣金分页响应格式错误");
  const list = value.list.map(parse);
  if (new Set(list.map(id)).size !== list.length) throw new Error("佣金分页重复");
  return { list, count: value.count, page: query.page, limit: query.limit };
}
function parseDetail(value: unknown, uid: number): CommissionDetail {
  if (!object(value) || value.uid !== uid || !integer(value.add_time) ||
    !["nickname", "spread_name", "number", "now_money", "brokerage_price"].every(key => text(value[key])) ||
    typeof value.user_deleted !== "boolean" || !issues(value.issues)) throw new Error("佣金详情响应格式错误");
  return value as unknown as CommissionDetail;
}
function parseRecord(value: unknown): CommissionRecord {
  if (!object(value) || !integer(value.id) || value.id === 0 || !integer(value.add_time) ||
    !text(value.number) || !text(value.mark) || !text(value.type) || !signedInteger(value.pm) || !signedInteger(value.status) ||
    !issues(value.issues)) throw new Error("佣金明细响应格式错误");
  return value as unknown as CommissionRecord;
}
function positiveUid(uid: number): void {
  if (!integer(uid) || uid === 0 || uid > 2_147_483_647) throw new Error("佣金用户 ID 无效");
}
export async function apiCommissionList(input: CommissionListQuery, signal?: AbortSignal): Promise<CommissionPage<CommissionRow>> {
  const query = normalizeCommissionQuery(input);
  return parsePage(await getData<unknown>(request.get("/finance/commissions", { params: query, signal })), query, parseRow, row => row.uid);
}
export async function apiCommissionDetail(uid: number, signal?: AbortSignal): Promise<CommissionDetail> {
  positiveUid(uid);
  return parseDetail(await getData<unknown>(request.get(`/finance/commissions/${uid}`, { signal })), uid);
}
export async function apiCommissionRecords(uid: number, input: CommissionRecordsQuery, signal?: AbortSignal): Promise<CommissionPage<CommissionRecord>> {
  positiveUid(uid);
  const query = normalizeCommissionRecordsQuery(input);
  return parsePage(await getData<unknown>(request.get(`/finance/commissions/${uid}/records`, { params: query, signal })), query, parseRecord, row => row.id);
}
export function commissionTime(seconds: number): string {
  if (!seconds) return "—";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(seconds * 1000));
}
