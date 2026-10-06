import { ValidateException } from '@/utils/errors';

const MAX_ID = 2_147_483_647;
export function combinationStatisticsId(value: unknown, label = '拼团活动ID'): number {
  const id = typeof value === 'number' ? value : typeof value === 'string' && /^[1-9]\d*$/u.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(id) || id < 1 || id > MAX_ID) throw new ValidateException(`${label}无效`);
  return id;
}

function parameters(raw: URLSearchParams, allowed: readonly string[]) {
  const seen = new Set<string>();
  for (const [key] of raw) {
    if (!allowed.includes(key)) throw new ValidateException(`不支持的查询参数：${key}`);
    if (seen.has(key)) throw new ValidateException(`查询参数不能重复：${key}`);
    seen.add(key);
  }
}
function integer(raw: string | null, fallback: number, max: number, label: string) {
  if (raw === null) return fallback;
  if (!/^[1-9]\d*$/u.test(raw)) throw new ValidateException(`${label}无效`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > max) throw new ValidateException(`${label}无效`);
  return value;
}
function pagination(raw: URLSearchParams) {
  const page = integer(raw.get('page'), 1, 10_001, '页码'), limit = integer(raw.get('limit'), 15, 100, '每页数量');
  const offset = (page - 1) * limit;
  if (offset > 10_000) throw new ValidateException('分页范围过大');
  return { page, limit, offset };
}
function keyword(raw: URLSearchParams) {
  const value = (raw.get('keyword') ?? '').trim();
  if ([...value].length > 100 || /[\u0000-\u001f\u007f]/u.test(value)) throw new ValidateException('搜索词无效');
  return value;
}
function status(raw: URLSearchParams, values: readonly string[], label: string) {
  const value = raw.get('status');
  if (value === null || value === '' || value === 'all') return undefined;
  if (!values.includes(value)) throw new ValidateException(`${label}无效`);
  return Number(value);
}
function day(value: string | null, label: string) {
  if (value === null || value === '') return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) throw new ValidateException(`${label}无效`);
  const year = Number(match[1]), month = Number(match[2]), date = Number(match[3]);
  const milliseconds = Date.UTC(year, month - 1, date), parsed = new Date(milliseconds);
  if (year < 1970 || parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== date)
    throw new ValidateException(`${label}无效`);
  return milliseconds / 1000 - 8 * 3600;
}
export function combinationGroupsQuery(raw: URLSearchParams, fixedCombinationId?: unknown) {
  parameters(raw, ['page', 'limit', 'keyword', 'status', 'start_day', 'end_day', ...(fixedCombinationId === undefined ? ['combination_id'] : [])]);
  const start = day(raw.get('start_day'), '开始日期'), end = day(raw.get('end_day'), '结束日期');
  if (start !== undefined && end !== undefined && end < start) throw new ValidateException('结束日期不能早于开始日期');
  const combinationId = fixedCombinationId === undefined
    ? raw.has('combination_id') ? combinationStatisticsId(raw.get('combination_id')) : undefined
    : combinationStatisticsId(fixedCombinationId);
  return { ...pagination(raw), keyword: keyword(raw), status: status(raw, ['1', '2', '3'], '拼团状态'),
    start, stop: end === undefined ? undefined : end + 86400, combinationId };
}
export function combinationMembersQuery(raw: URLSearchParams) {
  parameters(raw, ['page', 'limit']); return pagination(raw);
}
export function combinationOrdersQuery(raw: URLSearchParams) {
  parameters(raw, ['page', 'limit', 'keyword', 'status']);
  return { ...pagination(raw), keyword: keyword(raw), status: status(raw, ['0', '1', '2', '3', '4', '5'], '订单状态') };
}
export function combinationStatisticsLike(value: string) { return `%${value.replace(/[\\%_]/gu, '\\$&')}%`; }

/** Avatar snapshots are public URLs, not catalogue attachment authority. Never
 * sign an unknown private asset or normalize a copied private URL into access. */
export function combinationStatisticsAvatar(value: string) {
  const text = value.trim();
  if (!text || text.length > 4096 || /[\u0000-\u0020\u007f\\]/u.test(text)) return '';
  try {
    const relative = text.startsWith('/') && !text.startsWith('//');
    const url = relative ? new URL(text, 'https://avatar-static.invalid') : new URL(text);
    if (url.protocol !== 'https:' || url.username || url.password || /(?:^|\.)r2\.cloudflarestorage\.com$/iu.test(url.hostname)) return '';
    let path = url.pathname;
    for (let depth = 0; depth < 3; depth++) {
      const decoded = decodeURIComponent(path);
      if (decoded === path) break;
      if (depth === 2) return '';
      path = decoded;
    }
    if (path.startsWith('//') || /[\u0000-\u0020\u007f\\]/u.test(path)) return '';
    const normalized = new URL(path, 'https://avatar-static.invalid').pathname;
    if (/^\/(?:api\/assets|r2|attachments)(?:\/|$)/iu.test(normalized)) return '';
    return text;
  } catch { return ''; }
}
