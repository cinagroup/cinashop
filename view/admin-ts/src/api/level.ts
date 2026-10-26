/** Ordinary membership-level definitions; default array callers remain compatible. */
import request, { getData } from '@/utils/request';
import { distributorColor, distributorImageReference, distributorImagePreview } from './distributorLevels';

export interface LevelItem {
  id: number; name: string; grade: number; discount: string; expNum: number; isShow: number;
  icon: string; image: string; color: string; explain: string | null; isDel: number;
  icon_preview?: string; image_preview?: string;
  merId?: number; money?: string; validDate?: number; isForever?: number; isPay?: number; addTime?: number;
}
export interface LevelQuery { page: number; limit: number; title?: string; is_show?: 0 | 1 }
export interface LevelPage { list: LevelItem[]; count: number; page: number; limit: number }
export interface LevelForm { id: number; name: string; grade: number; discount: string; exp_num: number;
  icon: string; image: string; color: string; is_show: number; explain: string }
export type LevelSave = Omit<LevelForm, 'id' | 'explain'> & { id?: number; explain?: string };
const integer = (v: unknown, min = 0, max = 2147483647): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const object = (v: unknown): Record<string, unknown> => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('会员等级响应格式错误'); return v as Record<string, unknown>; };
const text = (v: unknown, max: number): v is string => typeof v === 'string' && [...v].length <= max && !/[\u0000-\u001f\u007f]/u.test(v);
export function normalizeLevelQuery(query: LevelQuery): LevelQuery {
  if (!integer(query.page, 1, 10000) || !integer(query.limit, 1, 100) || (query.page - 1) * query.limit > 100000
    || query.is_show !== undefined && query.is_show !== 0 && query.is_show !== 1 || query.title !== undefined && !text(query.title, 255)) throw Error('等级查询条件无效');
  const title = query.title?.trim() ?? '';
  return { page: query.page, limit: query.limit, ...(title ? { title } : {}), ...(query.is_show === undefined ? {} : { is_show: query.is_show }) };
}
export function parseLevelPage(value: unknown, query: LevelQuery): LevelPage {
  const r = object(value), q = normalizeLevelQuery(query);
  if (r.page !== q.page || r.limit !== q.limit || !integer(r.count, 0, Number.MAX_SAFE_INTEGER) || !Array.isArray(r.list)
    || r.list.length !== Math.max(0, Math.min(q.limit, r.count - (q.page - 1) * q.limit))) throw Error('等级分页结果与请求不一致');
  const ids = new Set<number>(); let previous: LevelItem | undefined;
  const list = r.list.map(raw => {
    const row = object(raw);
    if (!integer(row.id, 1) || ids.has(row.id) || !text(row.name, 255) || !integer(row.grade, -2147483648)
      || typeof row.discount !== 'string' || !/^-?\d{1,10}\.\d{2}$/u.test(row.discount) || !integer(row.expNum, -2147483648)
      || !integer(row.isShow, -32768, 32767) || row.isDel !== 0 || !text(row.icon, 255) || !text(row.image, 255)
      || !text(row.color, 32) || row.explain !== null && typeof row.explain !== 'string'
      || typeof row.icon_preview !== 'string' || typeof row.image_preview !== 'string'
      || q.is_show !== undefined && row.isShow !== q.is_show) throw Error('等级数据格式错误');
    const result: LevelItem = { id: row.id, name: row.name, grade: row.grade, discount: row.discount, expNum: row.expNum,
      isShow: row.isShow, isDel: 0, icon: row.icon, image: row.image, color: row.color, explain: row.explain as string | null,
      icon_preview: row.icon_preview, image_preview: row.image_preview };
    if (previous && (previous.grade > result.grade || previous.grade === result.grade && previous.id >= result.id)) throw Error('等级排序结果错误');
    previous = result; ids.add(result.id); return result;
  });
  return { list, count: r.count, page: q.page, limit: q.limit };
}
export function levelImagePreview(reference: string, resolved = ''): string {
  if (!distributorImageReference(reference) || !distributorImagePreview(resolved)) return '';
  if (!reference.startsWith('/api/assets/')) return resolved === reference ? resolved : '';
  if (!resolved.startsWith('/') || resolved.startsWith('//')) return '';
  try {
    const url = new URL(resolved, 'https://level-image.invalid');
    if (url.origin !== 'https://level-image.invalid' || url.pathname !== reference || url.hash
      || [...url.searchParams.keys()].length !== 2 || url.searchParams.getAll('expires').length !== 1
      || url.searchParams.getAll('signature').length !== 1 || !/^[1-9]\d{0,11}$/u.test(url.searchParams.get('expires') ?? '')
      || !/^[A-Za-z0-9_-]{43}$/u.test(url.searchParams.get('signature') ?? '')
      || Number(url.searchParams.get('expires')) * 1000 <= Date.now()) return '';
    return resolved;
  } catch { return ''; }
}
export function normalizeLevelForm(form: LevelForm, base?: LevelItem): LevelSave {
  const unchanged = (field: keyof LevelForm, old: unknown) => !!base && form[field] === old;
  const required = (field: 'name' | 'explain', old: unknown, max: number) => {
    const v = form[field]; if (unchanged(field, old)) return v;
    const controls = field === 'explain' ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u : /[\u0000-\u001f\u007f]/u;
    if (typeof v !== 'string' || [...v].length > max || controls.test(v) || !v.trim()) throw Error(field === 'name' ? '请填写等级名称' : '请填写等级说明'); return field === 'name' ? v.trim() : v;
  };
  if (!integer(form.id, 0) || base && form.id !== base.id || !integer(form.grade, 1) && !unchanged('grade', base?.grade === 0 ? 0 : undefined)
    || !integer(form.exp_num, 1) && !unchanged('exp_num', base?.expNum === 0 ? 0 : undefined)) throw Error('等级和解锁经验须为正整数；导入的原有0值可原样保留');
  if (!/^(?:0|[1-9]\d{0,2})(?:\.\d{1,2})?$/u.test(form.discount)) throw Error('折扣须为0至100，最多两位小数');
  const [whole, fraction = ''] = form.discount.split('.'), units = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (units > 10000n || form.is_show !== 0 && form.is_show !== 1) throw Error('折扣或显示状态无效');
  for (const slot of ['icon', 'image'] as const) if (!unchanged(slot, base?.[slot]) && !distributorImageReference(form[slot])) throw Error('请选择两张稳定图片地址，不能保存签名预览链接');
  if (!unchanged('color', base?.color) && !distributorColor(form.color)) throw Error('请选择有效字体颜色');
  return { ...(form.id ? { id: form.id } : {}), name: required('name', base?.name, 255), grade: form.grade,
    discount: `${units / 100n}.${String(units % 100n).padStart(2, '0')}`, exp_num: form.exp_num,
    icon: form.icon, image: form.image, color: form.color, is_show: form.is_show, ...(base?.explain === null && form.explain === '' ? {} : { explain: required('explain', base?.explain ?? '', 10000) }) };
}
/** Established bare array response. */
export function apiAdminLevelList(): Promise<LevelItem[]> { return getData(request.get<LevelItem[]>('/level/list')); }
export async function apiAdminLevelPage(query: LevelQuery, signal?: AbortSignal): Promise<LevelPage> {
  const normalized = normalizeLevelQuery(query);
  return parseLevelPage(await getData(request.get('/level/list', { params: { paged: 1, ...normalized }, signal })), normalized);
}
export function apiAdminLevelSave(data: LevelSave | { id: number; is_show: 0 | 1 }, signal?: AbortSignal): Promise<{ id: number }> {
  return getData(request.post<{ id: number }>('/level/save', data, { signal }));
}
export function apiAdminLevelDel(id: number, signal?: AbortSignal): Promise<null> { return getData(request.delete<null>(`/level/del/${id}`, { signal })); }
