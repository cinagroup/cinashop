import request, { getData } from "@/utils/request";

export type FeedbackPreset = "" | "today" | "yesterday" | "lately7" | "lately30" | "month" | "year";
export interface FeedbackQuery {
  page: number;
  limit: 15;
  title: string;
  time: string;
  status: "" | 0 | 1;
}
export interface FeedbackRow {
  id: number;
  uid: number;
  rela_name: string;
  phone: string;
  content: string;
  make: string;
  status: 0 | 1;
  add_time: number;
}
export interface FeedbackPage {
  data: FeedbackRow[];
  count: number;
  page: number;
  limit: number;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 2_147_483_647;
const presets: FeedbackPreset[] = ["", "today", "yesterday", "lately7", "lately30", "month", "year"];

function shanghaiDay(value: string): number {
  const match = /^(\d{4})\/(\d{2})\/(\d{2})$/u.exec(value);
  if (!match) throw new Error("留言日期格式错误");
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const utc = Date.UTC(year, month - 1, day);
  const actual = new Date(utc);
  if (year < 1970 || year > 2038 || actual.getUTCFullYear() !== year ||
    actual.getUTCMonth() + 1 !== month || actual.getUTCDate() !== day) throw new Error("留言日期无效");
  const seconds = Math.floor(utc / 1_000) - 8 * 3_600;
  if (seconds < 0 || seconds > 2_147_483_647) throw new Error("留言日期超出范围");
  return seconds;
}

export function normalizeFeedbackQuery(input: FeedbackQuery): FeedbackQuery {
  if (!Number.isSafeInteger(input.page) || input.page < 1 || (input.page - 1) * 15 > 10_000 ||
    input.limit !== 15 || typeof input.title !== "string" ||
    [...input.title.trim()].length > 100 || /[\u0000-\u001f\u007f]/u.test(input.title) ||
    !["", 0, 1].includes(input.status)) throw new Error("留言筛选条件无效");
  let time = input.time;
  if (!presets.includes(time as FeedbackPreset)) {
    const match = /^(\d{4}\/\d{2}\/\d{2})-(\d{4}\/\d{2}\/\d{2})$/u.exec(time);
    if (!match) throw new Error("留言日期筛选无效");
    const start = shanghaiDay(match[1]), end = shanghaiDay(match[2]) + 86_400;
    if (end <= start || end > 2_147_483_647 || end - start > 366 * 86_400)
      throw new Error("留言日期范围无效");
  }
  return { ...input, title: input.title.trim(), time };
}

export function parseFeedbackRow(value: unknown): FeedbackRow {
  if (!isObject(value) || !integer(value.id) || value.id === 0 || !integer(value.uid) ||
    !integer(value.add_time) || (value.status !== 0 && value.status !== 1) ||
    !["rela_name", "phone", "content", "make"].every(key => typeof value[key] === "string")) {
    throw new Error("留言响应格式错误");
  }
  return { id: value.id, uid: value.uid, rela_name: value.rela_name as string,
    phone: value.phone as string, content: value.content as string,
    make: value.make as string, status: value.status, add_time: value.add_time };
}

export function parseFeedbackPage(value: unknown, query: FeedbackQuery): FeedbackPage {
  if (!isObject(value) || !Array.isArray(value.data) || !integer(value.count) ||
    value.page !== query.page || value.limit !== 15 || value.data.length > 15 || value.data.length > value.count)
    throw new Error("留言分页响应格式错误");
  const data = value.data.map(parseFeedbackRow);
  if (new Set(data.map(row => row.id)).size !== data.length) throw new Error("留言分页含重复 ID");
  return { data, count: value.count, page: query.page, limit: 15 };
}

/** Display the PHP htmlspecialchars payload as text; never insert it as HTML. */
export function feedbackText(value: string): string {
  return value.replace(/&amp;|&lt;|&gt;|&quot;|&#0*39;/gu, entity => ({
    "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#039;": "'",
  })[entity.replace(/^&#0*39;$/u, "&#039;")] ?? entity);
}

export function feedbackTime(seconds: number): string {
  if (!seconds) return "—";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23" }).formatToParts(new Date(seconds * 1_000)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export async function apiFeedbackList(input: FeedbackQuery, signal?: AbortSignal): Promise<FeedbackPage> {
  const query = normalizeFeedbackQuery(input);
  return parseFeedbackPage(await getData<unknown>(request.get("/feedback", { params: query, signal })), query);
}
export async function apiFeedbackDetail(id: number, signal?: AbortSignal): Promise<FeedbackRow> {
  if (!integer(id) || id === 0) throw new Error("留言 ID 无效");
  const row = parseFeedbackRow(await getData<unknown>(request.get(`/feedback/${id}`, { signal })));
  if (row.id !== id) throw new Error("留言详情 ID 不一致");
  return row;
}
export async function apiFeedbackUpdate(id: number, make: string, markProcessed: boolean): Promise<void> {
  if (!integer(id) || id === 0 || typeof make !== "string" || make.trim().length > 255 ||
    /[\u0000-\u001f\u007f]/u.test(make)) throw new Error("留言处理内容无效");
  await getData<unknown>(request.put(`/feedback/${id}`, markProcessed
    ? { make: make.trim(), status: 1 } : { make: make.trim() }));
}
export async function apiFeedbackDelete(id: number): Promise<void> {
  if (!integer(id) || id === 0) throw new Error("留言 ID 无效");
  await getData<unknown>(request.delete(`/feedback/${id}`));
}
