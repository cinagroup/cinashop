import { createUserCenterRequests } from '@/api/userCenter';

export interface GrowthRecord {
  id: number; title: string; number: string; pm: number;
  add_time: string; time_key: string; time: string;
}
export interface GrowthRecordPage { list: GrowthRecord[]; count: number; time: string[] }
export interface GrowthMonth { month: string; list: GrowthRecord[] }
const invalid = (): never => { throw Error('经验记录不完整，请重新加载'); };
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : invalid();
const integer = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max ? v : invalid();
const text = (v: unknown): string => typeof v === 'string' ? v : invalid();
function date(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
export function decodeGrowthRecords(value: unknown): GrowthRecordPage {
  const v = object(value), count = integer(v.count, 0);
  if (!Array.isArray(v.list) || v.list.length > 20 || !Array.isArray(v.time)) return invalid();
  const list = v.list.map(value => {
    const r = object(value), id = integer(r.id, 1, 2_147_483_647), pm = integer(r.pm, -32768, 32767);
    const number = text(r.number), title = text(r.title), add_time = text(r.add_time), time_key = text(r.time_key), time = text(r.time);
    if (!/^-?\d{1,10}\.\d{2}$/.test(number)) return invalid();
    if (add_time === '') { if (time_key !== '' || time !== '') return invalid(); }
    else if (!/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(add_time)
      || !date(add_time.slice(0, 10)) || !Number.isFinite(Date.parse(add_time.replace(' ', 'T') + '+08:00'))
      || time_key !== add_time.slice(0, 7) || time !== time_key) return invalid();
    return { id, title, number, pm, add_time, time_key, time };
  });
  if (list.length > count || list.some((row, i) => i > 0 && row.id >= list[i - 1]!.id)) return invalid();
  const time = [...new Set(list.map(row => row.time_key))];
  if (v.time.length !== time.length || v.time.some((month, i) => month !== time[i])) return invalid();
  return { list, count, time };
}
/** Keep exact decimal digits; a legacy negative value reverses its stored direction. */
export function growthRecordAmount(row: Pick<GrowthRecord, 'number' | 'pm'>): string {
  const negative = row.number.startsWith('-'), digits = negative ? row.number.slice(1) : row.number;
  return ((row.pm !== 0) !== negative ? '+' : '-') + digits;
}
export function groupGrowthRecords(rows: GrowthRecord[]): GrowthMonth[] {
  const groups = new Map<string, GrowthRecord[]>();
  for (const row of rows) { const list = groups.get(row.time_key) ?? []; list.push(row); groups.set(row.time_key, list); }
  return [...groups].map(([month, list]) => ({ month, list }));
}
export function createGrowthRecordRequests(current: () => boolean) {
  const scope = createUserCenterRequests(current);
  return { ...scope, ledger: async (page: number) => {
    if (page > 1000) throw Error('经验记录较多，已到当前浏览范围');
    return decodeGrowthRecords(await scope.request('user/level/expList', 'GET', { page: integer(page, 1, 1000), limit: 20 }, true));
  } };
}
export type GrowthRecordRequests = ReturnType<typeof createGrowthRecordRequests>;
