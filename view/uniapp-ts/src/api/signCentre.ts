import { createUserCenterRequests } from '@/api/userCenter';

export interface SignCell { day: string; is_sign: boolean; sign_day: boolean; type: number; point: number; days: number; sign_type: number }
export interface SignSummary { signList: SignCell[]; continuousSignDays: number; cumulativeSignDays: number; nextContinuousDays: number; nextCumulativeDays: number; checkSign: boolean }
export interface SignConfig extends SignSummary { signMode: number; signRemindStatus: number; signRemindSwitch: number; signStatus: number; signData: { sign_point: number; sign_exp: number } }
export interface SignCalendar extends SignSummary { today: string; w: string; month: string }
export interface SignStatus { signedToday: boolean; enabled: boolean; integral: number; exp: number; cumulativeDays: number }
export interface SignRecord { id: number; uid: number; title: string; number: number; exp_num: number; add_time: string }
export interface SignMonth { month: string; list: SignRecord[] }
export interface SignAward { point: number; exp: number; continuousDays: number; cumulativeDays: number }
const invalid = (): never => { throw Error('签到数据不完整，请重新加载'); };
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : invalid();
const integer = (v: unknown, min = 0, max = 2_147_483_647): number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max ? v : invalid();
const bool = (v: unknown): boolean => typeof v === 'boolean' ? v : invalid();
const text = (v: unknown): string => typeof v === 'string' ? v : invalid();
export function signDate(v: unknown): string {
  const value = text(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return invalid();
  const date = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return invalid();
  return value;
}
export function signMonth(v: unknown): string {
  const value = text(v);
  if (!/^(?:197\d|19[89]\d|20[0-2]\d|203[0-7])-(?:0[1-9]|1[0-2])$/.test(value)) return invalid();
  return value;
}
export function moveSignMonth(value: string, delta: number): string {
  signMonth(value); integer(delta, -1, 1);
  const [year, month] = value.split('-').map(Number), date = new Date(Date.UTC(year!, month! - 1 + delta, 1));
  return signMonth(date.toISOString().slice(0, 7));
}
function summary(value: unknown): SignSummary {
  const v = record(value);
  if (!Array.isArray(v.signList) || ![7, 28, 29, 30, 31].includes(v.signList.length)) return invalid();
  const signList = v.signList.map(item => {
    const c = record(item), day = text(c.day);
    if (!/^(?:[1-9]|1[0-2])\/(?:0[1-9]|[12]\d|3[01])$/.test(day)) return invalid();
    const type = integer(c.type, 1, 2), sign_type = integer(c.sign_type, 0, 4);
    if (![0, 3, 4].includes(sign_type)) return invalid();
    return { day, is_sign: bool(c.is_sign), sign_day: bool(c.sign_day), type, point: integer(c.point), days: integer(c.days), sign_type };
  });
  if (new Set(signList.map(c => c.day)).size !== signList.length) return invalid();
  return { signList, continuousSignDays: integer(v.continuousSignDays), cumulativeSignDays: integer(v.cumulativeSignDays),
    nextContinuousDays: integer(v.nextContinuousDays), nextCumulativeDays: integer(v.nextCumulativeDays), checkSign: bool(v.checkSign) };
}
export function decodeSignConfig(value: unknown): SignConfig {
  const v = record(value), data = record(v.signData), result = summary(v), signMode = integer(v.signMode, 0, 1);
  if ((signMode === 1) !== (result.signList.length === 7)) return invalid();
  const today = result.signList.filter(cell => cell.sign_day);
  if (today.length !== 1 || today[0]!.is_sign !== result.checkSign) return invalid();
  return { ...result, signMode, signRemindStatus: integer(v.signRemindStatus, 0, 1), signRemindSwitch: integer(v.signRemindSwitch, -2_147_483_648),
    signStatus: integer(v.signStatus, -2_147_483_648), signData: { sign_point: integer(data.sign_point), sign_exp: integer(data.sign_exp) } };
}
export function decodeSignStatus(value: unknown): SignStatus {
  const v = record(value);
  return { signedToday: bool(v.signedToday), enabled: bool(v.enabled), integral: integer(v.integral), exp: integer(v.exp), cumulativeDays: integer(v.cumulativeDays) };
}
export function decodeSignCalendar(value: unknown, selected?: string): SignCalendar {
  const v = record(value), result = summary(v), today = signDate(v.today), month = signMonth(selected ?? today.slice(0, 7));
  const [year, m] = month.split('-').map(Number), length = new Date(Date.UTC(year!, m!, 0)).getUTCDate();
  if (result.signList.length !== length || v.w !== String(new Date(month + '-01T00:00:00Z').getUTCDay())) return invalid();
  result.signList.forEach((cell, index) => {
    const date = month + '-' + String(index + 1).padStart(2, '0');
    if (cell.day !== `${m}/${String(index + 1).padStart(2, '0')}` || cell.sign_day !== (date === today)) invalid();
  });
  const todayCell = result.signList.find(cell => cell.sign_day);
  if (todayCell && todayCell.is_sign !== result.checkSign) return invalid();
  return { ...result, today, w: String(v.w), month };
}
export function decodeSignRecords(value: unknown, uid: number, limit?: number): SignRecord[] {
  if (!Array.isArray(value) || (limit !== undefined && value.length > limit)) return invalid();
  const rows = value.map(item => {
    const v = record(item);
    if (integer(v.uid, 1) !== uid) return invalid();
    return { id: integer(v.id, 1), uid, title: text(v.title), number: integer(v.number, -2_147_483_648), exp_num: integer(v.exp_num, -2_147_483_648),
      add_time: v.add_time === '' ? '' : signDate(v.add_time) };
  });
  if (new Set(rows.map(r => r.id)).size !== rows.length) return invalid();
  return rows;
}
export function decodeSignMonths(value: unknown, uid: number, limit = 8): SignMonth[] {
  if (!Array.isArray(value) || value.length > limit) return invalid();
  const groups = value.map(item => {
    const v = record(item), month = signMonth(v.month), list = decodeSignRecords(v.list, uid);
    if (!list.length || list.some(row => !row.add_time.startsWith(month + '-'))) return invalid();
    return { month, list };
  });
  if (new Set(groups.map(g => g.month)).size !== groups.length || groups.some((g, i) => i > 0 && g.month >= groups[i - 1]!.month)) return invalid();
  const ids = groups.flatMap(g => g.list.map(row => row.id));
  if (new Set(ids).size !== ids.length) return invalid();
  return groups;
}
export function decodeSignAward(value: unknown): SignAward {
  const v = record(value), point = integer(v.point), exp = integer(v.exp);
  if (v.sign_point !== point || v.sign_exp !== exp) return invalid();
  return { point, exp, continuousDays: integer(v.continuousDays), cumulativeDays: integer(v.cumulativeDays) };
}
export function createSignRequests(current: () => boolean) {
  const scope = createUserCenterRequests(current);
  return {
    ...scope,
    config: async () => decodeSignConfig(await scope.request('sign/config', 'GET', {}, true)),
    status: async () => decodeSignStatus(await scope.request('sign/status', 'GET', {}, true)),
    calendar: async (month?: string) => decodeSignCalendar(await scope.request('sign/calendar', 'GET', month ? { time: signMonth(month) } : {}, true), month),
    recent: async () => decodeSignRecords(await scope.request('sign/list', 'GET', { page: 1, limit: 10 }, true), scope.owner.uid, 10),
    months: async (page: number) => decodeSignMonths(await scope.request('sign/month', 'GET', { page: integer(page, 1, 1_000_000), limit: 8 }, true), scope.owner.uid),
    points: async () => {
      const v = record(await scope.request('sign/user', 'POST', { sign: 1 }, true));
      if (integer(v.uid, 1) !== scope.owner.uid) return invalid();
      return integer(v.integral, -2_147_483_648);
    },
    sign: async () => decodeSignAward(await scope.request('sign/integral', 'POST', {}, true)),
    remind: async (enabled: boolean) => { if (typeof enabled !== 'boolean') return invalid(); if (await scope.request(`sign/remind/${enabled ? 1 : 0}`, 'GET', {}, true) !== null) invalid(); },
  };
}
export type SignRequests = ReturnType<typeof createSignRequests>;
