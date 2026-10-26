import { createUserCenterRequests } from '@/api/userCenter';
import { API_BASE } from '@/utils/request';

export interface MemberLevel {
  id: number; name: string; grade: number; discount: string; exp_num: number;
  lack_exp_num: string; color: string; icon: string; image: string; is_forever: number;
}
export interface MemberOverview {
  actor_uid: number; enabled: boolean; level_active: boolean; preview_only: boolean;
  current_level_id: number; current_grade: number | null; exp: string; levels: MemberLevel[];
  task: { sign_count: number; sign: string; order: string; invite: string; sign_enabled: boolean };
}
const invalid = (): never => { throw Error('会员等级信息不完整，请重新加载'); };
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : invalid();
const text = (v: unknown, max = 8192): string => typeof v === 'string' && [...v].length <= max ? v : invalid();
const integer = (v: unknown, min = 0, max = 2147483647): number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max ? v : invalid();
const flag = (v: unknown): boolean => typeof v === 'boolean' ? v : invalid();
const decimal = (v: unknown): string => { const s = text(v, 32); return /^-?\d{1,10}\.\d{2}$/.test(s) ? s : invalid(); };
/** Accept raster URLs already resolved by the server; never evaluate a CSS URL. */
export function memberLevelImage(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 8192) return '';
  let layer = value;
  for (let depth = 0; depth <= 3; depth++) {
    if (depth === 0 && /\s/u.test(layer) || /[\u0000-\u001f\u007f\\]/u.test(layer)) return '';
    try {
      if (/^\/(?!\/)/u.test(layer)) { if (new URL(layer, 'https://image.invalid').pathname.startsWith('//')) return ''; }
      else { const url = new URL(layer); if (!/^https:\/\//iu.test(layer) || url.protocol !== 'https:' || url.username || url.password) return ''; }
    } catch { return ''; }
    if (!/%[a-f0-9]{2}/iu.test(layer)) return value.startsWith('/') && !value.startsWith('/static/') ? API_BASE + value : value;
    if (depth === 3) return '';
    try { layer = decodeURIComponent(layer); } catch { return ''; }
  }
  return '';
}
export function memberLevelColor(value: string): string {
  const color = value.trim(); if (/^#(?:[a-f0-9]{3}|[a-f0-9]{4}|[a-f0-9]{6}|[a-f0-9]{8})$/iu.test(color)) return color;
  const m = /^(rgb|rgba)\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(0(?:\.\d{1,3})?|1(?:\.0{1,3})?)\s*)?\)$/iu.exec(color);
  return m && [m[2],m[3],m[4]].every(v => Number(v) <= 255) && (m[1]!.toLowerCase() === 'rgba') === (m[5] !== undefined) ? color : '';
}
/** Keep the PHP scale=0 gap and its progress algorithm; bound the zero divisor. */
export function memberLevelProgress(level: MemberLevel): number {
  if (level.exp_num <= 0) return level.lack_exp_num === '0' ? 100 : 0;
  return Math.min(100, Math.max(0, (level.exp_num - Number(level.lack_exp_num)) * 100 / level.exp_num));
}
export function memberLevelDiscount(level: Pick<MemberLevel,'discount'>): string {
  const value = Number(level.discount) / 10;
  return value.toFixed(3).replace(/\.?0+$/, '');
}
export function decodeMemberOverview(value: unknown, owner: number): MemberOverview {
  const envelope = object(value), v = object(envelope.overview);
  const actor_uid = integer(v.actor_uid,1), enabled = flag(v.enabled), level_active = flag(v.level_active), preview_only = flag(v.preview_only);
  if (actor_uid !== owner || !Array.isArray(v.levels) || v.levels.length > 1000) return invalid();
  const exp = decimal(v.exp), current_level_id = integer(v.current_level_id), current_grade = v.current_grade === null ? null : integer(v.current_grade,-2147483648);
  const levels = v.levels.map(value => {
    const r = object(value), lack = text(r.lack_exp_num,32);
    if (!/^\d{1,11}$/.test(lack)) return invalid();
    const row = { id:integer(r.id,1), name:text(r.name,255), grade:integer(r.grade,-2147483648), discount:decimal(r.discount),
      exp_num:integer(r.exp_num,-2147483648), lack_exp_num:lack, color:memberLevelColor(text(r.color,32)),
      icon:memberLevelImage(text(r.icon)), image:memberLevelImage(text(r.image)), is_forever:integer(r.is_forever,-32768,32767) };
    return row;
  });
  if (new Set(levels.map(r=>r.id)).size !== levels.length || levels.some((r,i) => i > 0 && (r.grade < levels[i-1]!.grade || r.grade === levels[i-1]!.grade && r.id <= levels[i-1]!.id))) return invalid();
  const current = levels.find(r=>r.id === current_level_id);
  if (current_level_id === 0 ? current_grade !== null : !current || current.grade !== current_grade || !level_active || !enabled || preview_only) return invalid();
  if (!enabled && (levels.length > 0 || current_level_id !== 0 || preview_only) || enabled && preview_only !== (levels.length > 0 && current_level_id === 0)) return invalid();
  const task = object(v.task), parsedTask = { sign_count:integer(task.sign_count,0,Number.MAX_SAFE_INTEGER), sign:text(task.sign,4096), order:text(task.order,4096), invite:text(task.invite,4096), sign_enabled:flag(task.sign_enabled) };
  if (!enabled && (parsedTask.sign_enabled || parsedTask.sign_count !== 0)) return invalid();
  return { actor_uid,enabled,level_active,preview_only,current_level_id,current_grade,exp,levels,task:parsedTask };
}
/** Refresh media capabilities with reads only, leaving sixty seconds of margin. */
export function memberLevelMediaDeadline(data: MemberOverview, now = Date.now()): number | null {
  let earliest: number | null = null;
  for (const row of data.levels) for (let src of [row.icon,row.image]) {
    if (API_BASE && src.startsWith(API_BASE + '/api/assets/')) src = src.slice(API_BASE.length);
    if (!/^\/api\/assets\/[1-9]\d*(?:\?|#|$)/u.test(src)) continue;
    const url = new URL(src,'https://image.invalid'), expires = url.searchParams.getAll('expires'), signatures = url.searchParams.getAll('signature');
    if (expires.length !== 1 || signatures.length !== 1 || !/^[1-9]\d{0,10}$/.test(expires[0]!) || !/^[A-Za-z0-9_-]{43}$/.test(signatures[0]!)) return now;
    const deadline = Number(expires[0]) * 1000 - 60000;
    if (!Number.isSafeInteger(deadline)) return now;
    earliest = earliest === null ? deadline : Math.min(earliest,deadline);
  }
  return earliest;
}
export function createMemberLevelRequests(current: () => boolean) {
  const scope = createUserCenterRequests(current);
  return { ...scope,
    check: async () => { if (await scope.request('user/level/detection','GET',{},true) !== true) throw Error('等级检查未确认'); },
    overview: async () => decodeMemberOverview(await scope.request('user/level/info','GET',{overview:1},true),scope.owner.uid),
  };
}
export type MemberLevelRequests = ReturnType<typeof createMemberLevelRequests>;
