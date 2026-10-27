import { ValidateException } from '@/utils/errors';
import { readBoundedUtf8Text } from '@/utils/request-body';
import { parseLevelActivationJson } from '@/services/admin/AdminLevelActivationInput';

export interface DistributionLedgerQuery { page: number; limit: 20; start: number; stop: number; keyword: string }
export type DistributionLedgerMode = 'commission' | 'withdrawal';
export const DISTRIBUTION_LEDGER_KEYWORD_LIMIT = 64;

/** The explicit view opts into scalar JSON and complete Shanghai calendar days. */
export async function readDistributionLedgerInput(request: Request, type: string | undefined): Promise<{ mode: DistributionLedgerMode; query: DistributionLedgerQuery }> {
  if (type !== '3' && type !== '4') throw new ValidateException('分销流水仅支持规范类型3或4');
  if (new URL(request.url).pathname !== `/api/v2/user/money_list/${type}`) throw new ValidateException('分销流水路径须为规范类型3或4');
  const mode: DistributionLedgerMode = type === '3' ? 'commission' : 'withdrawal';
  const query = new URL(request.url).searchParams;
  if ([...query.keys()].some(key => key !== 'view') || query.getAll('view').length !== 1 || query.get('view') !== 'distribution_ledger') {
    throw new ValidateException('分销流水查询参数无效');
  }
  if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers.get('content-type') ?? '')) throw new ValidateException('分销流水查询须为JSON');
  const text = await readBoundedUtf8Text(request, 4096);
  let value: unknown;
  try { value = parseLevelActivationJson(text); } catch { throw new ValidateException('分销流水查询JSON无效或字段重复'); }
  const normalized = distributionLedgerQuery(value);
  if (mode === 'withdrawal' && (normalized.keyword !== '' || ((value as Record<string, unknown>).keyword !== undefined && (value as Record<string, unknown>).keyword !== ''))) throw new ValidateException('提现流水不支持关键词');
  return { mode, query: normalized };
}

export function distributionLedgerQuery(value: unknown): DistributionLedgerQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidateException('分销流水查询须为对象');
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !['page', 'limit', 'start', 'stop', 'keyword'].includes(key))) throw new ValidateException('分销流水查询包含不支持的字段');
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const next = body[name] === undefined ? fallback : body[name];
    if (typeof next !== 'number' || !Number.isSafeInteger(next) || next < min || next > max || Object.is(next, -0)) throw new ValidateException('分销流水查询整数无效');
    return next;
  };
  const page = integer('page', 1, 1, 500), limit = integer('limit', 20, 20, 20) as 20;
  const start = integer('start', 0, 0, 2147483647), stop = integer('stop', 0, 0, 2147483647);
  if ((start !== 0 || stop !== 0) && (start === 0 || stop === 0 || start > stop || (start + 28800) % 86400 !== 0 || (stop + 28801) % 86400 !== 0)) {
    throw new ValidateException('分销流水日期须为上海完整日闭区间');
  }
  const keyword = body.keyword === undefined ? '' : body.keyword;
  if (typeof keyword !== 'string' || [...keyword].length > DISTRIBUTION_LEDGER_KEYWORD_LIMIT || /[\u0000-\u001f\u007f]/u.test(keyword)
    || [...keyword].some(char => { const point = char.codePointAt(0)!; return point >= 0xd800 && point <= 0xdfff; })) throw new ValidateException('分销流水关键词格式或长度无效');
  return { page, limit, start, stop, keyword: keyword.trim() };
}
