import request, { getData } from "@/utils/request";

export interface SpeechcraftRow {
  id: number;
  kefu_id: 0;
  cate_id: number;
  title: string;
  message: string;
  sort: number;
  add_time: number;
}

export interface SpeechcraftCategory { id: number; name: string; sort: number }
export interface SpeechcraftQuery {
  page: number;
  limit: 10;
  cate_id: "" | number;
  title: string;
  message: string;
}
export interface SpeechcraftPage { list: SpeechcraftRow[]; count: number; page: number; limit: 10 }
export interface SpeechcraftInput { cate_id: number; title: string; message: string; sort: number }
export interface SpeechcraftCategoryInput { name: string; sort: number }

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function uint(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647;
}
function int32(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= -2_147_483_648 && value <= 2_147_483_647;
}
function positive(value: unknown): value is number { return uint(value) && value > 0; }

export function normalizeSpeechcraftQuery(query: SpeechcraftQuery): SpeechcraftQuery {
  if (!positive(query.page) || query.limit !== 10 ||
      (query.cate_id !== "" && !uint(query.cate_id)) ||
      typeof query.title !== "string" || [...query.title.trim()].length > 100 ||
      typeof query.message !== "string" || [...query.message.trim()].length > 255 ||
      /[\u0000-\u001f\u007f]/u.test(query.title) || /[\u0000-\u001f\u007f]/u.test(query.message)) {
    throw new Error("话术筛选条件无效");
  }
  return { ...query, title: query.title.trim(), message: query.message.trim() };
}

export function parseSpeechcraftRow(value: unknown): SpeechcraftRow {
  if (!object(value) || !positive(value.id) || value.kefu_id !== 0 || !uint(value.cate_id) ||
      typeof value.title !== "string" || typeof value.message !== "string" ||
      !int32(value.sort) || !uint(value.add_time)) throw new Error("话术响应格式错误");
  return value as unknown as SpeechcraftRow;
}
export function parseSpeechcraftCategories(value: unknown): SpeechcraftCategory[] {
  if (!Array.isArray(value)) throw new Error("话术分类响应格式错误");
  const rows = value.map((item) => {
    if (!object(item) || !positive(item.id) || typeof item.name !== "string" || !int32(item.sort)) {
      throw new Error("话术分类响应格式错误");
    }
    return { id: item.id, name: item.name, sort: item.sort };
  });
  if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error("话术分类包含重复 ID");
  return rows;
}
export function parseSpeechcraftPage(value: unknown, query: SpeechcraftQuery): SpeechcraftPage {
  if (!object(value) || !Array.isArray(value.list) || !uint(value.count) ||
      value.page !== query.page || value.limit !== 10 || value.list.length > 10 ||
      value.list.length > value.count) throw new Error("话术分页响应格式错误");
  const list = value.list.map(parseSpeechcraftRow);
  if (new Set(list.map((row) => row.id)).size !== list.length) throw new Error("话术分页含重复 ID");
  return { list, count: value.count, page: query.page, limit: 10 };
}
export function normalizeSpeechcraftInput(input: SpeechcraftInput): SpeechcraftInput {
  if (!uint(input.cate_id) || typeof input.title !== "string" || typeof input.message !== "string" ||
      !uint(input.sort)) throw new Error("话术内容无效");
  const title = input.title.trim(), message = input.message.trim();
  if (title.length > 100 || !message || message.length > 255 || /\u0000/u.test(title + message)) {
    throw new Error("话术标题最多100字，内容必填且最多255字");
  }
  return { cate_id: input.cate_id, title, message, sort: input.sort };
}
export function normalizeSpeechcraftCategoryInput(input: SpeechcraftCategoryInput): SpeechcraftCategoryInput {
  if (typeof input.name !== "string" || !uint(input.sort)) throw new Error("分类内容无效");
  const name = input.name.trim();
  if (!name || name.length > 255 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new Error("分类名称必填且最多255字");
  }
  return { name, sort: input.sort };
}
function parseId(value: unknown): number {
  if (!object(value) || !positive(value.id)) throw new Error("写入响应缺少 ID");
  return value.id;
}

export async function apiSpeechcraftList(input: SpeechcraftQuery, signal?: AbortSignal): Promise<SpeechcraftPage> {
  const query = normalizeSpeechcraftQuery(input);
  const data = await getData<unknown>(request.get("/wechat/speechcraft", { params: query, signal }));
  return parseSpeechcraftPage(data, query);
}
export async function apiSpeechcraftCategories(signal?: AbortSignal): Promise<SpeechcraftCategory[]> {
  return parseSpeechcraftCategories(await getData<unknown>(request.get("/wechat/speechcraft/categories", { signal })));
}
export async function apiSpeechcraftDetail(id: number, signal?: AbortSignal): Promise<SpeechcraftRow> {
  if (!positive(id)) throw new Error("话术 ID 无效");
  const row = parseSpeechcraftRow(await getData<unknown>(request.get(`/wechat/speechcraft/${id}`, { signal })));
  if (row.id !== id) throw new Error("话术详情 ID 不一致");
  return row;
}
export async function apiSpeechcraftCreate(input: SpeechcraftInput): Promise<number> {
  return parseId(await getData<unknown>(request.post("/wechat/speechcraft", normalizeSpeechcraftInput(input))));
}
export async function apiSpeechcraftUpdate(id: number, input: SpeechcraftInput): Promise<void> {
  if (!positive(id)) throw new Error("话术 ID 无效");
  const result = parseId(await getData<unknown>(request.put(`/wechat/speechcraft/${id}`, normalizeSpeechcraftInput(input))));
  if (result !== id) throw new Error("话术修改响应 ID 不一致");
}
export async function apiSpeechcraftDelete(id: number): Promise<void> {
  if (!positive(id)) throw new Error("话术 ID 无效");
  await getData<unknown>(request.delete(`/wechat/speechcraft/${id}`));
}
export async function apiSpeechcraftCategoryCreate(input: SpeechcraftCategoryInput): Promise<number> {
  return parseId(await getData<unknown>(request.post("/wechat/speechcraft/categories", normalizeSpeechcraftCategoryInput(input))));
}
export async function apiSpeechcraftCategoryUpdate(id: number, input: SpeechcraftCategoryInput): Promise<void> {
  if (!positive(id)) throw new Error("分类 ID 无效");
  const result = parseId(await getData<unknown>(request.put(`/wechat/speechcraft/categories/${id}`,
    normalizeSpeechcraftCategoryInput(input))));
  if (result !== id) throw new Error("分类修改响应 ID 不一致");
}
export async function apiSpeechcraftCategoryDelete(id: number): Promise<void> {
  if (!positive(id)) throw new Error("分类 ID 无效");
  await getData<unknown>(request.delete(`/wechat/speechcraft/categories/${id}`));
}
export function speechcraftTime(seconds: number): string {
  if (!seconds) return "—";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23" }).formatToParts(new Date(seconds * 1_000)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}
