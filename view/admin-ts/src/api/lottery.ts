import request, { getData } from "@/utils/request";

export interface LotteryPrize {
  id?: number;
  type: number;
  name: string;
  prompt: string;
  image: string;
  chance: number;
  total: number;
  couponId?: number;
  productId?: number;
  unique?: string;
  num: string;
  sort: number;
  status: number;
}

export interface LotteryActivity {
  id: number;
  type: number;
  name: string;
  desc: string;
  image: string;
  factor: number;
  factorNum: number;
  attendsUser: number;
  userLevel: number[] | string;
  userLabel: number[] | string;
  isSvip: number;
  startTime: number;
  endTime: number;
  lotteryNumTerm: number;
  lotteryNum: number;
  totalLotteryNum: number;
  spreadNum: number;
  isAllRecord: number;
  isPersonalRecord: number;
  isContent: number;
  content: string;
  status: number;
  sort: number;
  time_status?: number;
  lottery_all?: number;
  lottery_people?: number;
  lottery_win?: number;
  lottery_type?: string;
  lottery_status?: string;
  prize?: LotteryPrize[];
}

export interface LotteryRecord {
  id: number;
  uid: number;
  lotteryId: number;
  type: number;
  isReceive: number;
  isDeliver: number;
  receiveTime: number;
  deliverTime: number;
  addTime: number;
  prize?: { type?: number; type_name?: string; name?: string; image?: string };
  lottery?: { id: number; name: string; factor: number } | null;
  user?: { uid: number; nickname: string; is_deleted: boolean };
  deliver_info: { mark: string };
}

export interface LotteryFulfillmentDetail {
  id: number;
  type: number;
  deliver_info: { deliver_name: string; deliver_number: string; mark: string };
}

export interface LotteryListQuery {
  page: number;
  limit: 15;
  name?: string;
  factor?: number;
  status?: 0 | 1;
  start_status?: -1 | 0 | 1;
}

export interface LotteryActivityPage { list: LotteryActivity[]; count: number; page: number; limit: 15 }

export interface LotteryRecordQuery {
  page: number;
  limit: 15;
  lottery_id?: number;
  factor?: number;
  type?: number;
  keyword?: string;
  start_time?: number;
  end_time?: number;
  is_receive?: 0 | 1;
  is_deliver?: 0 | 1;
}

export interface LotteryRecordPage { list: LotteryRecord[]; count: number; page: number; limit: 15 }

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function positiveId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 2_147_483_647;
}

function safeText(value: unknown): string { return typeof value === "string" ? value : ""; }

export function shanghaiLotteryDay(date: string, end = false): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
  if (!match) throw new Error("请选择有效的抽奖日期");
  const [year, month, day] = match.slice(1).map(Number);
  const utc = Date.UTC(year, month - 1, day);
  const actual = new Date(utc);
  if (year < 1970 || year > 2038 || actual.getUTCFullYear() !== year || actual.getUTCMonth() + 1 !== month || actual.getUTCDate() !== day) {
    throw new Error("抽奖日期无效");
  }
  const seconds = Math.floor(utc / 1000) - 8 * 3600 + (end ? 86_399 : 0);
  if (seconds < 0 || seconds > 2_147_483_647) throw new Error("抽奖日期超出可查询范围");
  return seconds;
}

export function normalizeLotteryRecordQuery(input: LotteryRecordQuery): LotteryRecordQuery {
  if (!Number.isSafeInteger(input.page) || input.page < 1 || input.page > 10_000 || input.limit !== 15 ||
    (input.lottery_id !== undefined && !positiveId(input.lottery_id)) ||
    (input.factor !== undefined && (![1, 2, 3, 4, 5].includes(input.factor))) ||
    (input.type !== undefined && (![2, 3, 4, 5, 6, 7, 9].includes(input.type))) ||
    (input.is_receive !== undefined && input.is_receive !== 0 && input.is_receive !== 1) ||
    (input.is_deliver !== undefined && input.is_deliver !== 0 && input.is_deliver !== 1) ||
    (input.start_time !== undefined && (!Number.isSafeInteger(input.start_time) || input.start_time < 0)) ||
    (input.end_time !== undefined && (!Number.isSafeInteger(input.end_time) || input.end_time < 0)) ||
    ((input.start_time === undefined) !== (input.end_time === undefined)) ||
    (input.start_time !== undefined && input.end_time !== undefined && (input.end_time < input.start_time || input.end_time - input.start_time > 366 * 86_400)) ||
    (input.keyword !== undefined && (typeof input.keyword !== "string" || [...input.keyword.trim()].length > 100 || /[\u0000-\u001f\u007f]/u.test(input.keyword)))) {
    throw new Error("中奖记录查询条件无效");
  }
  return { ...input, keyword: input.keyword?.trim() };
}

export function parseLotteryRecordPage(value: unknown, query: LotteryRecordQuery): LotteryRecordPage {
  if (!object(value) || !Array.isArray(value.list) || !Number.isSafeInteger(value.count) || Number(value.count) < 0 ||
    value.page !== query.page || value.limit !== 15 || value.list.length > 15 || value.list.length > Number(value.count)) {
    throw new Error("中奖记录分页响应无效");
  }
  const list = value.list.map((candidate: unknown) => {
    if (!object(candidate) || !positiveId(candidate.id) || !Number.isSafeInteger(candidate.uid) ||
      !Number.isSafeInteger(candidate.lotteryId) || !Number.isSafeInteger(candidate.type) ||
      !Number.isSafeInteger(candidate.addTime) || ![0, 1].includes(Number(candidate.isReceive)) ||
      ![0, 1].includes(Number(candidate.isDeliver))) throw new Error("中奖记录数据无效");
    const prize = object(candidate.prize) ? candidate.prize : {};
    const user = object(candidate.user) ? candidate.user : {};
    const lottery = object(candidate.lottery) ? candidate.lottery : null;
    const info = object(candidate.deliver_info) ? candidate.deliver_info : {};
    return {
      id: candidate.id as number, uid: candidate.uid as number, lotteryId: candidate.lotteryId as number,
      type: candidate.type as number, isReceive: candidate.isReceive as number, isDeliver: candidate.isDeliver as number,
      receiveTime: Number(candidate.receiveTime) || 0, deliverTime: Number(candidate.deliverTime) || 0,
      addTime: candidate.addTime as number,
      prize: { type: Number(prize.type) || undefined, type_name: safeText(prize.type_name),
        name: safeText(prize.name), image: safeText(prize.image) },
      user: { uid: Number(user.uid) || 0, nickname: safeText(user.nickname), is_deleted: user.is_deleted === true },
      lottery: lottery ? { id: Number(lottery.id) || 0, name: safeText(lottery.name), factor: Number(lottery.factor) || 0 } : null,
      deliver_info: { mark: safeText(info.mark) },
    } satisfies LotteryRecord;
  });
  if (new Set(list.map(row => row.id)).size !== list.length) throw new Error("中奖记录分页包含重复记录");
  return { list, count: value.count as number, page: query.page, limit: 15 };
}

export async function apiLotteryList(params: LotteryListQuery, signal?: AbortSignal): Promise<LotteryActivityPage> {
  if (!Number.isSafeInteger(params.page) || params.page < 1 || params.page > 10_000 || params.limit !== 15 ||
    (params.name !== undefined && (typeof params.name !== "string" || [...params.name].length > 100)) ||
    (params.factor !== undefined && ![1, 2, 3, 4, 5].includes(params.factor)) ||
    (params.status !== undefined && ![0, 1].includes(params.status)) ||
    (params.start_status !== undefined && ![-1, 0, 1].includes(params.start_status))) throw new Error("抽奖活动查询条件无效");
  const value: unknown = await getData<unknown>(request.get("/lottery/list", { params, signal }));
  if (!object(value) || !Array.isArray(value.list) || !Number.isSafeInteger(value.count) || Number(value.count) < 0 ||
    value.page !== params.page || value.limit !== 15 || value.list.length > 15 || value.list.length > Number(value.count) ||
    value.list.some(row => !object(row) || !positiveId(row.id))) throw new Error("抽奖活动分页响应无效");
  return value as unknown as LotteryActivityPage;
}

export function apiLotteryDetail(id: number, signal?: AbortSignal): Promise<LotteryActivity> {
  return getData(request.get<LotteryActivity>(`/lottery/detail/${id}`, { signal }));
}

export function apiLotteryAdd(data: Record<string, unknown>): Promise<{ id: number }> {
  return getData(request.post<{ id: number }>("/lottery/add", data));
}

export function apiLotteryEdit(id: number, data: Record<string, unknown>): Promise<{ id: number }> {
  return getData(request.put<{ id: number }>(`/lottery/edit/${id}`, data));
}

export function apiLotteryDelete(id: number): Promise<null> {
  return getData(request.delete<null>(`/lottery/del/${id}`));
}

export function apiLotteryStatus(id: number, status: number): Promise<null> {
  return getData(request.post<null>(`/lottery/set_status/${id}/${status}`));
}

export async function apiLotteryRecords(input: LotteryRecordQuery, activityId?: number, signal?: AbortSignal): Promise<LotteryRecordPage> {
  const query = normalizeLotteryRecordQuery(input);
  if (activityId !== undefined && (!positiveId(activityId) || (query.lottery_id !== undefined && query.lottery_id !== activityId))) {
    throw new Error("中奖记录活动 ID 无效");
  }
  const suffix = activityId ? `/${activityId}` : "";
  return parseLotteryRecordPage(await getData<unknown>(request.get(`/lottery/record/list${suffix}`, { params: query, signal })), query);
}

export async function apiLotteryRecordFulfillment(id: number, signal?: AbortSignal): Promise<LotteryFulfillmentDetail> {
  if (!positiveId(id)) throw new Error("中奖记录 ID 无效");
  const value: unknown = await getData<unknown>(request.get(`/lottery/record/detail/${id}`, { signal }));
  if (!object(value) || value.id !== id || !Number.isSafeInteger(value.type) || !object(value.deliver_info)) {
    throw new Error("中奖记录管理详情无效");
  }
  return { id, type: value.type as number, deliver_info: {
    deliver_name: safeText(value.deliver_info.deliver_name),
    deliver_number: safeText(value.deliver_info.deliver_number),
    mark: safeText(value.deliver_info.mark),
  } };
}

export function apiLotteryDeliver(data: Record<string, unknown>): Promise<null> {
  return getData(request.post<null>("/lottery/record/deliver", data));
}
