import { http } from "@/utils/request";

export interface DistributionLevel { id: number; name: string; grade: number; image: string; color: string; one_brokerage: number; two_brokerage: number; status: number; sum_task: number }
export interface DistributionSnapshot {
  enabled: boolean;
  user: null | { uid: number; nickname: string; avatar: string; brokerage_price: string; agent_level: number; spread_count: number };
  level_list: DistributionLevel[]; level_info: DistributionLevel | null; current_grade: number; next_level: DistributionLevel | null;
}
export interface DistributionTask { id: number; level_id: number; name: string; type: number; number: number; desc: string; sort: number; status: number; is_must: number; finish: 0 | 1; task_type_title: string; speed: number; new_number: number; image: string }
export interface DistributionTasks { enabled: boolean; list: DistributionTask[]; speedAll: number }
const integer = (value: unknown, minimum = 0): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= 2147483647;
const string = (value: unknown, maximum = 8192): value is string => typeof value === "string" && [...value].length <= maximum;
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("分销等级响应不完整"); return value as Record<string, unknown>; }
export function distributionImage(value: unknown): string {
  if (!string(value) || !value) return ""; let layer = value;
  for (let depth = 0; depth <= 3; depth++) {
    if (depth === 0 && /\s/u.test(layer) || /[\u0000-\u001f\u007f\\]/u.test(layer)) return "";
    try { if (/^\/(?!\/)/u.test(layer)) { if (new URL(layer, "https://image.invalid").pathname.startsWith("//")) return ""; }
      else { const parsed = new URL(layer); if (!/^https:\/\//iu.test(layer) || parsed.protocol !== "https:" || parsed.username || parsed.password) return ""; }
    } catch { return ""; }
    if (!/%[a-f0-9]{2}/iu.test(layer)) return value; if (depth === 3) return "";
    try { layer = decodeURIComponent(layer); } catch { return ""; }
  } return "";
}
export function distributionColor(value: unknown): string {
  if (!string(value, 32) || /[\u0000-\u001f\u007f]/u.test(value)) return ""; const color = value.trim();
  if (/^#(?:[a-f0-9]{3}|[a-f0-9]{4}|[a-f0-9]{6}|[a-f0-9]{8})$/iu.test(color)) return color;
  const match = /^(rgb|rgba)\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(0(?:\.\d{1,3})?|1(?:\.0{1,3})?)\s*)?\)$/iu.exec(color);
  return match && [match[2], match[3], match[4]].every(item => Number(item) <= 255) && (match[1].toLowerCase() === "rgba") === (match[5] !== undefined) ? color : "";
}
function level(value: unknown): DistributionLevel {
  const row = object(value);
  if (!integer(row.id, 1) || !string(row.name, 50) || !integer(row.grade, -2147483648) || !string(row.image) || !string(row.color, 32)
    || !integer(row.one_brokerage, -2147483648) || !integer(row.two_brokerage, -2147483648) || !integer(row.status, -2147483648) || !integer(row.sum_task)) throw Error("分销等级信息不完整");
  return { id: row.id, name: row.name, grade: row.grade, image: distributionImage(row.image), color: distributionColor(row.color), one_brokerage: row.one_brokerage, two_brokerage: row.two_brokerage, status: row.status, sum_task: row.sum_task };
}
export function parseDistributionSnapshot(value: unknown, owner: number): DistributionSnapshot {
  if (Array.isArray(value) && !value.length) return { enabled: false, user: null, level_list: [], level_info: null, current_grade: 0, next_level: null };
  const row = object(value), user = object(row.user), current = object(row.level_info);
  if (!integer(owner, 1) || user.uid !== owner || !string(user.nickname, 255) || !string(user.avatar) || !string(user.brokerage_price, 64)
    || !integer(user.agent_level) || !integer(user.spread_count) || !integer(row.current_grade, -2147483648) || !Array.isArray(row.level_list) || row.level_list.length > 100000) throw Error("分销等级不属于当前账号或响应不完整");
  const list = row.level_list.map(level), info = current.id === undefined ? null : level(current), next = row.next_level === null ? null : level(row.next_level);
  if (new Set(list.map(item => item.id)).size !== list.length || list.some(item => item.status !== 1) || info && info.id !== user.agent_level
    || next && (!list.some(item => item.id === next.id) || next.grade <= row.current_grade || next.sum_task <= 0)) throw Error("分销等级、授予等级或下一等级不一致");
  return { enabled: true, user: { uid: owner, nickname: user.nickname, avatar: distributionImage(user.avatar), brokerage_price: user.brokerage_price, agent_level: user.agent_level, spread_count: user.spread_count }, level_list: list, level_info: info, current_grade: row.current_grade, next_level: next };
}
export function distributionTaskUnit(type: number): string { return type === 1 ? "人" : type === 2 || type === 4 ? "元" : type === 3 || type === 5 ? "单" : "未知单位"; }
export function distributionTaskName(type: number): string { return ({ 1: "邀请好友成为下级", 2: "自身消费金额", 3: "自身消费单数", 4: "下级消费金额", 5: "下级消费单数" } as Record<number, string>)[type] || `历史未知类型 ${type}`; }
export function distributionTaskAction(type: number): { label: string; url: string } | null {
  return type === 1 || type === 4 || type === 5 ? { label: "去邀请好友", url: "/pages/user/spread" } : type === 2 || type === 3 ? { label: "去浏览商品", url: "/pages/goods/list" } : null;
}
export function parseDistributionTasks(value: unknown, levelId: number): DistributionTasks {
  if (Array.isArray(value) && !value.length) return { enabled: false, list: [], speedAll: 0 };
  const row = object(value);
  if (!integer(levelId, 1) || !Array.isArray(row.list) || row.list.length > 100000 || typeof row.speedAll !== "number" || !Number.isFinite(row.speedAll) || row.speedAll < 0 || row.speedAll > 100) throw Error("任务进度响应不完整");
  const list = row.list.map(value => {
    const task = object(value);
    if (!integer(task.id, 1) || task.level_id !== levelId || !string(task.name, 50) || !integer(task.type, -2147483648) || !integer(task.number, -2147483648)
      || !string(task.desc, 255) || !integer(task.sort, -2147483648) || !integer(task.status, -2147483648) || !integer(task.is_must, -2147483648)
      || task.finish !== 0 && task.finish !== 1 || !string(task.task_type_title, 1000) || typeof task.speed !== "number" || !Number.isFinite(task.speed) || task.speed < 0 || task.speed > 100
      || typeof task.new_number !== "number" || !Number.isFinite(task.new_number) || task.new_number < 0 || !string(task.image)) throw Error("任务与所选等级不一致或进度无效");
    return { id: task.id, level_id: levelId, name: task.name, type: task.type, number: task.number, desc: task.desc, sort: task.sort, status: task.status, is_must: task.is_must,
      finish: task.finish, task_type_title: task.task_type_title, speed: task.speed, new_number: task.new_number, image: distributionImage(task.image) } as DistributionTask;
  });
  if (new Set(list.map(task => task.id)).size !== list.length || list.some(task => task.status !== 1)) throw Error("任务响应重复或包含未开启任务");
  return { enabled: true, list, speedAll: row.speedAll };
}
export async function apiDistributionLevels(owner: number): Promise<DistributionSnapshot> { return parseDistributionSnapshot(await http.get<unknown>("v2/agent/level_list"), owner); }
export async function apiDistributionTasks(levelId: number): Promise<DistributionTasks> { if (!integer(levelId, 1)) throw Error("请选择有效等级"); return parseDistributionTasks(await http.get<unknown>("v2/agent/level_task_list", { id: levelId }), levelId); }
