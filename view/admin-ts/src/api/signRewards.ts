import request, { getData } from "@/utils/request";

export type SignRewardType = 0 | 1;

export interface SignRewardRow {
  id: number;
  type: SignRewardType;
  days: number;
  point: number;
  exp: number;
}

export interface SignRewardPage {
  list: SignRewardRow[];
  count: number;
  page: number;
  limit: number;
}

export interface SignRewardForm {
  info: SignRewardRow;
  maxDays: number;
}

export type SignRewardInput = Pick<SignRewardRow, "type" | "days" | "point" | "exp">;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("签到奖励响应格式错误");
  return value as Record<string, unknown>;
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function row(value: unknown, allowEmpty = false): SignRewardRow {
  const data = object(value);
  if (!integer(data.id, allowEmpty ? 0 : 1, Number.MAX_SAFE_INTEGER) ||
      !integer(data.type, 0, 1) || !integer(data.days, allowEmpty ? 0 : 1, 3650) ||
      !integer(data.point, 0, 999) || !integer(data.exp, 0, 999)) {
    throw new Error("签到奖励响应格式错误");
  }
  return { id: data.id, type: data.type as SignRewardType, days: data.days,
    point: data.point, exp: data.exp };
}

export function parseSignRewardPage(value: unknown): SignRewardPage {
  const data = object(value);
  if (!Array.isArray(data.list) || !integer(data.count, 0, Number.MAX_SAFE_INTEGER) ||
      !integer(data.page, 1, 1_000_000) || !integer(data.limit, 1, 100) ||
      data.list.length > data.limit || data.list.length > data.count) {
    throw new Error("签到奖励响应格式错误");
  }
  return { list: data.list.map((entry) => row(entry)), count: data.count,
    page: data.page, limit: data.limit };
}

export function parseSignRewardForm(value: unknown): SignRewardForm {
  const data = object(value);
  if (!Array.isArray(data.rules)) throw new Error("签到奖励表单格式错误");
  const daysRule = data.rules.find((entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry) &&
    (entry as Record<string, unknown>).field === "days") as Record<string, unknown> | undefined;
  const props = daysRule?.props;
  const maxDays = props && typeof props === "object" && !Array.isArray(props)
    ? (props as Record<string, unknown>).max : undefined;
  if (!integer(maxDays, 1, 3650)) throw new Error("签到奖励表单格式错误");
  const info = row(data.info, true);
  return { info, maxDays };
}

export async function apiSignRewardList(type: SignRewardType, page: number, signal?: AbortSignal): Promise<SignRewardPage> {
  return parseSignRewardPage(await getData<unknown>(request.get("/setting/sign/rewards", {
    params: { type, page, limit: 15 }, signal,
  })));
}

export async function apiSignRewardForm(id: number, type: SignRewardType, signal?: AbortSignal): Promise<SignRewardForm> {
  const response = id === 0
    ? request.get("/setting/sign/add_rewards", { params: { type }, signal })
    : request.get(`/setting/sign/edit_rewards/${id}`, { signal });
  return parseSignRewardForm(await getData<unknown>(response));
}

export async function apiSaveSignReward(id: number, input: SignRewardInput): Promise<{ id: number }> {
  return getData<{ id: number }>(request.post(`/setting/sign/save_rewards/${id}`, input));
}

export async function apiDeleteSignReward(id: number): Promise<null> {
  return getData<null>(request.delete(`/setting/sign/del_rewards/${id}`));
}
