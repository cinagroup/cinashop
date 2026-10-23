import request, { getData } from '@/utils/request';
import { normalizeFabLinkQuery, parseFabLinkCategories, parseFabLinkTargets, type FabLinkCategory, type FabLinkQuery, type FabLinkTarget } from './fabSettings';
export type DiyTabKind = 'micro' | 'category';
export interface DiyTabSelection { kind: DiyTabKind; id: number; name: string }
export interface DiyAuthorTarget extends FabLinkTarget { selection?: DiyTabSelection | null }
export interface DiyAuthorChoice { url: string; label: string; selection?: DiyTabSelection }
const record = (v: unknown): Record<string, unknown> => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('装修选项格式错误'); return v as Record<string, unknown>; };
export async function apiDiyAuthorCategories(typed: boolean, signal?: AbortSignal) {
  const data = await getData(request.get(`/dise/author-options/${typed ? 'tab' : 'link'}-categories`, { signal }));
  if (!typed) return parseFabLinkCategories(data);
  const row = record(data), kinds = ['special', 'product_category'];
  if (!Array.isArray(row.list) || row.list.length !== 2 || new Set(row.list.map(item => record(item).kind)).size !== 2
    || row.list.some(item => { const r = record(item); return !kinds.includes(String(r.kind)) || typeof r.name !== 'string' || !r.name || typeof r.group !== 'string'; })
    || !Array.isArray(row.issues) || row.issues.some(item => typeof item !== 'string')) throw Error('选项卡目录不完整');
  return row as unknown as { list: FabLinkCategory[]; issues: string[] };
}
export async function apiDiyAuthorTargets(query: FabLinkQuery, typed: boolean, signal?: AbortSignal) {
  const expected = normalizeFabLinkQuery(query);
  if (typed && !['special', 'product_category'].includes(expected.kind)) throw Error('选项卡目标类型无效');
  const raw = await getData(request.get(`/dise/author-options/${typed ? 'tab' : 'link'}-targets`, { params: expected, signal }));
  const parsed = parseFabLinkTargets(raw, expected);
  if (!typed) return parsed as typeof parsed & { list: DiyAuthorTarget[] };
  const list = parsed.list.map(value => {
    const item = value as DiyAuthorTarget, s = item.selection;
    if (!item.selectable) { if (s !== null) throw Error('不可选目标包含错误身份'); return item; }
    if (!s || s.kind !== (expected.kind === 'special' ? 'micro' : 'category') || !Number.isSafeInteger(s.id) || s.id <= 0 || s.id > 2147483647 || s.id !== item.id || s.name !== item.name) throw Error('选项卡目标身份不匹配');
    return item;
  });
  return { ...parsed, list };
}
export async function apiDiyAuthorHotWords(signal?: AbortSignal): Promise<Array<{ id: number; name: string }>> {
  const row = record(await getData(request.get('/dise/author-options/hot-words', { signal })));
  if (!Array.isArray(row.list) || row.list.length > 100000) throw Error('完整热词列表超出可读取容量');
  const list = row.list.map(value => { const r = record(value); if (!Number.isSafeInteger(r.id) || Number(r.id) <= 0 || Number(r.id) > 2147483647 || typeof r.name !== 'string' || !r.name || r.name.length > 4096 || /[\u0000-\u001f\u007f]/u.test(r.name)) throw Error('热词信息不完整'); return { id: r.id as number, name: r.name }; });
  if (new Set(list.map(item => item.id)).size !== list.length) throw Error('热词身份重复');
  return list;
}
