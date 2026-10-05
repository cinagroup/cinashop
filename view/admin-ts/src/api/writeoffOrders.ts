import request, { getData } from "@/utils/request";

export type WriteoffField = "all" | "order_id" | "uid" | "real_name" | "user_phone" | "title";
export type WriteoffPreset = "" | "today" | "yesterday" | "lately7" | "lately30" | "month" | "year";
export interface WriteoffOrderQuery {
  page: number;
  limit: 15;
  data: string;
  real_name: string;
  field_key: WriteoffField;
  store_id: number | "";
}
export interface WriteoffGood {
  name: string;
  spec: string;
  image: string;
  true_price: string;
  cart_num: number;
}
export interface WriteoffOrder {
  id: number;
  order_id: string;
  uid: number;
  nickname: string;
  spread_nickname: string;
  pay_price: string;
  clerk_name: string;
  store_name: string;
  pay_type_name: string;
  status_name: string;
  add_time: number;
  pay_time: number;
  goods: WriteoffGood[];
  issues: string[];
}
export interface WriteoffOrderPage {
  list: WriteoffOrder[];
  count: number;
  page: number;
  limit: 15;
  badge: [];
}
export interface WriteoffStore { id: number; name: string }
export interface WriteoffSpread {
  uid: number;
  nickname: string;
  avatar: string;
  now_money: string;
  brokerage_price: string;
  real_name: string;
  phone: string;
  integral: string;
  mark: string;
  birthday: number;
  last_time: number;
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const positive = (value: unknown): value is number => integer(value) && Number(value) > 0 && Number(value) <= 2_147_483_647;
const text = (value: unknown): value is string => typeof value === "string";
const money = (value: unknown): value is string => text(value) && /^-?\d+\.\d{2}$/u.test(value);
const fields: WriteoffField[] = ["all", "order_id", "uid", "real_name", "user_phone", "title"];
const presets: WriteoffPreset[] = ["", "today", "yesterday", "lately7", "lately30", "month", "year"];

function day(value: string): number {
  const match = /^(\d{4})\/(\d{2})\/(\d{2})$/u.exec(value);
  if (!match) throw new Error("订单创建日期格式错误");
  const year = Number(match[1]), month = Number(match[2]), date = Number(match[3]);
  const utc = Date.UTC(year, month - 1, date);
  const parsed = new Date(utc);
  if (year < 1970 || year > 2038 || parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== date) throw new Error("订单创建日期无效");
  const second = Math.floor((utc - 8 * 3_600_000) / 1000);
  if (second < 0 || second > 2_147_483_647) throw new Error("订单创建日期超出范围");
  return second;
}

function normalizeDate(value: string): string {
  if (presets.includes(value as WriteoffPreset)) return value;
  const match = /^(\d{4}\/\d{2}\/\d{2})-(\d{4}\/\d{2}\/\d{2})$/u.exec(value);
  if (!match) throw new Error("订单创建日期筛选无效");
  const start = day(match[1]), end = day(match[2]);
  if (end < start || end - start + 86_400 > 366 * 86_400 || end + 86_400 > 2_147_483_648)
    throw new Error("订单创建日期范围无效");
  return value;
}

export function normalizeWriteoffOrderQuery(value: WriteoffOrderQuery): WriteoffOrderQuery {
  if (!Number.isSafeInteger(value.page) || value.page < 1 || value.page > 667 || value.limit !== 15 ||
    !text(value.real_name) || [...value.real_name.trim()].length > 80 ||
    /[\u0000-\u001f\u007f]/u.test(value.real_name) || !fields.includes(value.field_key) ||
    (value.store_id !== "" && !positive(value.store_id)) ||
    (value.field_key === "uid" && value.real_name.trim() !== "" &&
      !/^[1-9]\d{0,9}$/u.test(value.real_name.trim())) ||
    (value.field_key === "uid" && value.real_name.trim() !== "" &&
      Number(value.real_name.trim()) > 2_147_483_647)) throw new Error("核销订单查询条件无效");
  return { ...value, data: normalizeDate(value.data), real_name: value.real_name.trim() };
}

function parseGood(value: unknown): WriteoffGood {
  if (!object(value) || !["name", "spec", "image"].every(key => text(value[key])) ||
    !money(value.true_price) || !integer(value.cart_num)) throw new Error("核销商品快照格式错误");
  return { name: value.name as string, spec: value.spec as string, image: value.image as string,
    true_price: value.true_price as string, cart_num: value.cart_num as number };
}

export function parseWriteoffOrder(value: unknown): WriteoffOrder {
  if (!object(value) || !positive(value.id) || !integer(value.uid) ||
    !["order_id", "nickname", "spread_nickname", "clerk_name", "store_name", "pay_type_name", "status_name"].every(key => text(value[key])) ||
    !money(value.pay_price) || !integer(value.add_time) || !integer(value.pay_time) ||
    !Array.isArray(value.goods) || !Array.isArray(value.issues) || !value.issues.every(text))
    throw new Error("核销订单响应格式错误");
  return { id: value.id, order_id: value.order_id as string, uid: value.uid, nickname: value.nickname as string,
    spread_nickname: value.spread_nickname as string, pay_price: value.pay_price as string,
    clerk_name: value.clerk_name as string, store_name: value.store_name as string,
    pay_type_name: value.pay_type_name as string, status_name: value.status_name as string,
    add_time: value.add_time, pay_time: value.pay_time,
    goods: value.goods.map(parseGood), issues: value.issues as string[] };
}

export function parseWriteoffOrderPage(value: unknown, query: WriteoffOrderQuery): WriteoffOrderPage {
  if (!object(value) || !Array.isArray(value.list) || !integer(value.count) || value.page !== query.page ||
    value.limit !== 15 || value.list.length > 15 || value.list.length > value.count ||
    !Array.isArray(value.badge) || value.badge.length !== 0) throw new Error("核销订单分页格式错误");
  const list = value.list.map(parseWriteoffOrder);
  if (new Set(list.map(row => row.id)).size !== list.length) throw new Error("核销订单分页重复");
  return { list, count: value.count, page: query.page, limit: 15, badge: [] };
}

export function parseWriteoffStores(value: unknown): WriteoffStore[] {
  if (!object(value) || !Array.isArray(value.list)) throw new Error("核销门店响应格式错误");
  const stores = value.list.map((item: unknown) => {
    if (!object(item) || !positive(item.id) || !text(item.name)) throw new Error("核销门店响应格式错误");
    return { id: item.id, name: item.name };
  });
  if (new Set(stores.map(item => item.id)).size !== stores.length) throw new Error("核销门店重复");
  return stores;
}

export function parseWriteoffSpread(value: unknown): WriteoffSpread | null {
  if (!object(value)) throw new Error("推荐人响应格式错误");
  const spread = value.spread;
  if (spread === null) return null;
  const integral = typeof spread === "object" && spread !== null && "integral" in spread
    ? (spread as { integral: unknown }).integral : undefined;
  const safeIntegral = (integer(integral) && Number(integral) <= 2_147_483_647) ||
    (text(integral) && /^(?:0|[1-9]\d{0,9})$/u.test(integral) && Number(integral) <= 2_147_483_647);
  if (!object(spread) || !positive(spread.uid) ||
    !["nickname", "avatar", "real_name", "phone", "mark"].every(key => text(spread[key])) ||
    !money(spread.now_money) || !money(spread.brokerage_price) || !safeIntegral ||
    !integer(spread.birthday) || !integer(spread.last_time)) throw new Error("推荐人响应格式错误");
  return { uid: spread.uid, nickname: spread.nickname as string, avatar: spread.avatar as string,
    now_money: spread.now_money as string, brokerage_price: spread.brokerage_price as string,
    real_name: spread.real_name as string, phone: spread.phone as string, integral: String(integral),
    mark: spread.mark as string, birthday: spread.birthday, last_time: spread.last_time };
}

export async function apiWriteoffOrders(input: WriteoffOrderQuery, signal?: AbortSignal): Promise<WriteoffOrderPage> {
  const query = normalizeWriteoffOrderQuery(input);
  return parseWriteoffOrderPage(await getData<unknown>(request.get("/merchant/verify_order", { params: query, signal })), query);
}
export async function apiWriteoffStores(signal?: AbortSignal): Promise<WriteoffStore[]> {
  return parseWriteoffStores(await getData<unknown>(request.get("/merchant/verify_order/stores", { signal })));
}
export async function apiWriteoffSpread(uid: number, signal?: AbortSignal): Promise<WriteoffSpread | null> {
  if (!positive(uid)) throw new Error("核销用户 UID 无效");
  return parseWriteoffSpread(await getData<unknown>(request.get(`/merchant/verify/spread_info/${uid}`, { signal })));
}

export function writeoffTime(seconds: number, dateOnly = false): string {
  if (!seconds) return "—";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23" }).formatToParts(new Date(seconds * 1000)).map(part => [part.type, part.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return dateOnly ? date : `${date} ${parts.hour}:${parts.minute}:${parts.second}`;
}
