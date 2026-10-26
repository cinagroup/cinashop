import { createUserCenterRequests } from '@/api/userCenter';

export interface PointsSummary {
  uid: number; integral: number; sum_integral: number; deduction_integral: number; frozen_integral: number;
  today_integral: number; clear_integral: number; clear_time: number; clear_end: string;
}
export interface PointsLedgerRow { id: number; uid: number; pm: 0 | 1; number: number; balance: number; title: string; mark: string; add_time: string; time_key: string; status: number }
export interface PointsLedgerPage { list: PointsLedgerRow[]; count: number; times: string[] }
export interface PointsMonth { month: string; list: PointsLedgerRow[] }
const invalid = (): never => { throw Error('积分数据不完整，请重新加载'); };
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
}
function integer(value: unknown, min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : invalid();
}
function text(value: unknown): string { return typeof value === 'string' ? value : invalid(); }
function date(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + 'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
export function decodePointsSummary(value: unknown, uid: number): PointsSummary {
  const v = record(value);
  if (integer(v.uid, 1, 2_147_483_647) !== uid) return invalid();
  const clear_time = integer(v.clear_time, 0, 2_147_483_647), clear_end = text(v.clear_end);
  if (clear_time === 0 ? clear_end !== '' : !date(clear_end) || new Date((clear_time + 28_800) * 1000).toISOString().slice(0, 10) !== clear_end) return invalid();
  return { uid, integral: integer(v.integral, -2_147_483_648, 2_147_483_647), sum_integral: integer(v.sum_integral),
    deduction_integral: integer(v.deduction_integral), frozen_integral: integer(v.frozen_integral), today_integral: integer(v.today_integral),
    clear_integral: integer(v.clear_integral), clear_time, clear_end };
}
export function decodePointsLedger(value: unknown, uid: number): PointsLedgerPage {
  const v = record(value), count = integer(v.count, 0);
  if (!Array.isArray(v.list) || v.list.length > 10 || !Array.isArray(v.times)) return invalid();
  const list = v.list.map(item => {
    const r = record(item), id = integer(r.id, 1, 2_147_483_647), pm = integer(r.pm, 0, 1) as 0 | 1;
    if (integer(r.uid, 1, 2_147_483_647) !== uid || r.category !== 'integral') return invalid();
    const add_time = text(r.add_time), time_key = text(r.time_key);
    if (add_time === '') { if (time_key !== '' || r.day !== '' || r.time !== '') return invalid(); }
    else if (!/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(add_time)
      || !date(add_time.slice(0, 10)) || Date.parse(add_time.replace(' ', 'T') + '+08:00') / 1000 < 1
      || Date.parse(add_time.replace(' ', 'T') + '+08:00') / 1000 > 2_147_483_647 || time_key !== add_time.slice(0, 7) || r.time !== time_key || r.day !== add_time.slice(0, 10)) return invalid();
    return { id, uid, pm, number: integer(r.number), balance: integer(r.balance), title: text(r.title), mark: text(r.mark),
      add_time, time_key, status: integer(r.status, -2_147_483_648, 2_147_483_647) };
  });
  if (count < list.length || list.some((row, i) => i > 0 && row.id >= list[i - 1]!.id)) return invalid();
  const times = [...new Set(list.map(row => row.time_key))];
  if (v.times.length !== times.length || v.times.some((month, i) => month !== times[i])) return invalid();
  return { list, count, times };
}
/** A ledger's pm gives the direction; legacy negative numbers keep their real reversal. */
export function pointsLedgerAmount(row: Pick<PointsLedgerRow, 'pm' | 'number'>): string {
  const amount = row.pm === 1 ? row.number : -row.number;
  return amount > 0 ? '+' + amount : amount < 0 ? String(amount) : (row.pm === 1 ? '+0' : '-0');
}
export function groupPointsRows(rows: PointsLedgerRow[]): PointsMonth[] {
  const groups = new Map<string, PointsLedgerRow[]>();
  for (const row of rows) { const group = groups.get(row.time_key) ?? []; group.push(row); groups.set(row.time_key, group); }
  return [...groups].map(([month, list]) => ({ month, list }));
}
export function createPointsRequests(current: () => boolean) {
  const scope = createUserCenterRequests(current);
  return { ...scope,
    summary: async () => decodePointsSummary(await scope.request('sign/user', 'POST', { sign: 1, integral: 1, all: 1 }, true), scope.owner.uid),
    signEnabled: async () => integer(record(await scope.request('sign/config', 'GET', {}, true)).signStatus, -2_147_483_648, 2_147_483_647) !== 0,
    ledger: async (page: number) => {
      if (page > 1000) throw Error('积分记录较多，已到当前浏览范围');
      return decodePointsLedger(await scope.request('integral/list', 'GET', { page: integer(page, 1, 1000), limit: 10 }, true), scope.owner.uid);
    },
  };
}
export type PointsRequests = ReturnType<typeof createPointsRequests>;
