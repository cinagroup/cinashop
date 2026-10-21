import { http } from '@/utils/request';
import { asDiyRecord, safeDiyColor } from '@/utils/diy';
export interface DiyMemberLevel { id: number; name: string; grade: number; color: string }
const integer = (n: unknown, min = 0): n is number => Number.isSafeInteger(n) && Number(n) >= min && Number(n) <= 2147483647;
/** The legacy aliases are additive; existing camelCase member clients keep their contract. */
export async function apiDiyMemberLevel(expectedLevel: number): Promise<DiyMemberLevel | null> {
  const value = asDiyRecord(await http.get<unknown>('user/level/info'));
  if (!value || !Array.isArray(value.level_list) || value.level_list.length > 1000) throw Error('会员等级列表格式错误');
  const levels = value.level_list.map(raw => {
    const row = asDiyRecord(raw);
    if (!row || !integer(row.id, 1) || !integer(row.grade) || typeof row.name !== 'string' || typeof row.color !== 'string') throw Error('会员等级格式错误');
    return { id: row.id, name: row.name.slice(0, 100), grade: row.grade, color: safeDiyColor(row.color) };
  });
  if (Array.isArray(value.level_info) && !value.level_info.length) return null;
  const current = asDiyRecord(value.level_info);
  if (!current || !integer(current.id, 1) || current.id !== expectedLevel || !integer(current.grade)) throw Error('会员等级不属于当前会员');
  const matches = levels.filter(row => row.grade === current.grade);
  if (matches.length !== 1 || matches[0].id !== current.id) throw Error('会员等级目录不唯一或不可用');
  return matches[0];
}
export function diyLevelBadgeStyle(color: string): Record<string, string> {
  const safe = safeDiyColor(color); if (!safe) return {};
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/iu.exec(safe)?.[1];
  const expanded = hex?.length === 3 ? [...hex].map(c => c+c).join('') : hex;
  return { color: safe, background: expanded ? `rgba(${[0,2,4].map(i => parseInt(expanded.slice(i,i+2),16)).join(',')},0.2)` : '#f5f5f5' };
}
