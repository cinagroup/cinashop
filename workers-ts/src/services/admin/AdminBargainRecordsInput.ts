import { ValidateException } from '@/utils/errors';

export function bargainRecordId(value: unknown, label = '砍价活动ID'): number {
  const id = typeof value === 'number' ? value : typeof value === 'string' && /^[1-9]\d*$/u.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(id) || id < 1 || id > 2_147_483_647) throw new ValidateException(`${label}无效`);
  return id;
}
function parameters(raw: URLSearchParams, allowed: readonly string[]) {
  for (const key of raw.keys()) {
    if (!allowed.includes(key) || raw.getAll(key).length !== 1) throw new ValidateException(`查询参数不支持或重复：${key}`);
  }
}
function integer(value: string | null, fallback: number, max: number) {
  if (value === null) return fallback;
  if (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) throw new ValidateException('分页参数无效');
  return Number(value);
}
function pagination(raw: URLSearchParams) {
  const page = integer(raw.get('page'), 1, 10_001), limit = integer(raw.get('limit'), 15, 100), offset = (page - 1) * limit;
  if (offset > 10_000) throw new ValidateException('分页范围过大');
  return { page, limit, offset };
}
function keyword(raw: URLSearchParams) {
  const value = raw.get('keyword') ?? '';
  if (value.length > 400 || [...value].length > 100 || /[\u0000-\u001f\u007f]/u.test(value)) throw new ValidateException('搜索词无效');
  return value.trim();
}
function status(raw: URLSearchParams, allowed: string[]) {
  const value = raw.get('status');
  if (value === null || value === '' || value === 'all') return undefined;
  if (!allowed.includes(value)) throw new ValidateException('状态参数无效');
  return Number(value);
}
/** Inclusive calendar days in the original shop's China time zone. */
function day(value: string | null) {
  if (value === null || value === '') return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) throw new ValidateException('日期参数无效');
  const [year, month, date] = match.slice(1).map(Number), ms = Date.UTC(year, month - 1, date), parsed = new Date(ms);
  if (year < 1970 || parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== date) throw new ValidateException('日期参数无效');
  return ms / 1000 - 8 * 3600;
}
export function bargainRecordsQuery(raw: URLSearchParams, fixedId?: unknown) {
  parameters(raw, ['page', 'limit', 'keyword', 'status', 'start_day', 'end_day', ...(fixedId === undefined ? ['bargain_id'] : [])]);
  const start = day(raw.get('start_day')), end = day(raw.get('end_day'));
  if (start !== undefined && end !== undefined && start > end) throw new ValidateException('结束日期不能早于开始日期');
  return { ...pagination(raw), keyword: keyword(raw), status: status(raw, ['1', '2', '3', '4']), start,
    stop: end === undefined ? undefined : end + 86400,
    bargainId: fixedId === undefined ? raw.has('bargain_id') ? bargainRecordId(raw.get('bargain_id')) : undefined : bargainRecordId(fixedId) };
}
export function bargainHelpersQuery(raw: URLSearchParams) { parameters(raw, ['page', 'limit']); return pagination(raw); }
export function bargainOrdersQuery(raw: URLSearchParams) {
  parameters(raw, ['page', 'limit', 'keyword', 'status']);
  return { ...pagination(raw), keyword: keyword(raw), status: status(raw, ['0', '1', '2', '3', '4', '5']) };
}
export const bargainRecordsLike = (value: string) => `%${value.replace(/[\\%_]/gu, '\\$&')}%`;
