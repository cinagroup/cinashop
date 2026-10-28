import { ValidateException } from '@/utils/errors';

export interface AdminWithdrawalDirectoryQuery {
  page: number;
  limit: 20;
  status: -1 | 0 | 1 | null;
  extract_type: '' | 'bank' | 'balance' | 'weixin' | 'alipay';
  keyword: string;
  start: number;
  stop: number;
}
export interface AdminWithdrawalDirectoryPeriod {
  start: number;
  stop: number;
  effective_stop: number;
  rule: 'none' | 'closed' | 'equal-plus-day' | 'midnight-plus-day';
}
const MAX_INT = 2_147_483_647;
const KEYS = ['page', 'limit', 'status', 'extract_type', 'keyword', 'start', 'stop'] as const;
const shanghaiClock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

/** Keep the accepted raw endpoints. PHP's equal/midnight rule is closed and
 * can exceed int4 after expansion; its SQL comparison must use bigint. */
export function withdrawalDirectoryPeriod(query: Pick<AdminWithdrawalDirectoryQuery, 'start' | 'stop'>): AdminWithdrawalDirectoryPeriod {
  const { start, stop } = query;
  if (start === 0 && stop === 0) return { start, stop, effective_stop: 0, rule: 'none' };
  if (start === stop) return { start, stop, effective_stop: stop + 86_400, rule: 'equal-plus-day' };
  // PHP compares the endpoint with strtotime(date('Y-m-d', endpoint)) in
  // Asia/Shanghai. Positive query timestamps include the 1986–1991 DST years;
  // fixed UTC+8 would miss their midnight and falsely expand their 01:00.
  const clock = Object.fromEntries(shanghaiClock.formatToParts(new Date(stop * 1000)).map(part => [part.type, part.value]));
  if (clock.hour === '00' && clock.minute === '00' && clock.second === '00') return { start, stop, effective_stop: stop + 86_400, rule: 'midnight-plus-day' };
  return { start, stop, effective_stop: stop, rule: 'closed' };
}

/** URL scalar strings only. No trimming: PHP keyword "0" is false, but
 * "0 " is true. Pattern wildcards are intentionally retained downstream. */
export function parseAdminWithdrawalDirectoryQuery(parameters: URLSearchParams): AdminWithdrawalDirectoryQuery {
  for (const key of parameters.keys()) {
    if (!(KEYS as readonly string[]).includes(key) || parameters.getAll(key).length !== 1) {
      throw new ValidateException('提现目录查询字段未知或重复');
    }
  }
  const integer = (key: string, fallback: number, min: number, max: number): number => {
    const value = parameters.get(key);
    if (value === null) return fallback;
    if (!/^(?:0|[1-9]\d{0,9})$/.test(value)) throw new ValidateException('提现目录查询整数须为规范十进制');
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < min || result > max) throw new ValidateException('提现目录查询整数超出范围');
    return result;
  };
  const page = integer('page', 1, 1, 1000);
  const limit = integer('limit', 20, 20, 20) as 20;
  const rawStatus = parameters.get('status') ?? '';
  if (!['', 'all', '-1', '0', '1'].includes(rawStatus)) throw new ValidateException('提现目录状态无效');
  const status = rawStatus === '' || rawStatus === 'all' ? null : Number(rawStatus) as -1 | 0 | 1;
  const rawType = parameters.get('extract_type') ?? '';
  if (!['', 'all', 'bank', 'balance', 'weixin', 'wx', 'alipay'].includes(rawType)) throw new ValidateException('提现目录方式无效');
  const extract_type = (rawType === 'all' ? '' : rawType === 'wx' ? 'weixin' : rawType) as AdminWithdrawalDirectoryQuery['extract_type'];
  const keyword = parameters.get('keyword') ?? '';
  if ([...keyword].length > 64 || /[\u0000-\u001f\u007f]/u.test(keyword)
    || [...keyword].some(char => { const value = char.codePointAt(0)!; return value >= 0xd800 && value <= 0xdfff; })) {
    throw new ValidateException('提现目录关键词格式或长度无效');
  }
  const start = integer('start', 0, 0, MAX_INT), stop = integer('stop', 0, 0, MAX_INT);
  if (start !== 0 || stop !== 0) {
    if (start === 0 || stop === 0 || start > stop || start % 60 !== 0 || stop % 60 !== 0) {
      throw new ValidateException('提现目录时间须成对、按上海分钟精度且开始不晚于结束');
    }
  }
  return { page, limit, status, extract_type, keyword, start, stop };
}

/** URLSearchParams alone repairs malformed UTF8 to U+FFFD. Reject malformed
 * encoded fields first; a correctly encoded literal U+FFFD remains valid. */
function readParameters(request: Request): URLSearchParams {
  const length = request.headers.get('content-length');
  if (!['GET', 'HEAD'].includes(request.method) || request.body !== null || request.headers.has('transfer-encoding')
    || (length !== null && length !== '0')) throw new ValidateException('提现目录仅接受无请求体的只读查询');
  const search = new URL(request.url).search;
  if (new TextEncoder().encode(search).length > 2048) throw new ValidateException('提现目录查询过长');
  try {
    for (const pair of search.slice(1).split('&')) {
      if (!pair) continue;
      const equals = pair.indexOf('=');
      for (const field of equals < 0 ? [pair] : [pair.slice(0, equals), pair.slice(equals + 1)]) decodeURIComponent(field.replaceAll('+', ' '));
    }
  } catch { throw new ValidateException('提现目录查询编码无效'); }
  return new URL(request.url).searchParams;
}

export function readAdminWithdrawalDirectoryQuery(request: Request): AdminWithdrawalDirectoryQuery {
  return parseAdminWithdrawalDirectoryQuery(readParameters(request));
}

export function parseAdminWithdrawalMediaId(value: string): number {
  if (!/^[1-9]\d{0,9}$/.test(value) || Number(value) > MAX_INT) throw new ValidateException('提现媒体记录须为规范正整数ID');
  return Number(value);
}

export function parseAdminWithdrawalMediaRevision(parameters: URLSearchParams): string {
  if ([...parameters.keys()].length !== 1 || parameters.getAll('revision').length !== 1
    || !/^[a-f0-9]{64}$/.test(parameters.get('revision') ?? '')) throw new ValidateException('提现媒体查询须携带唯一有效版本');
  return parameters.get('revision')!;
}

export function readAdminWithdrawalMediaQuery(request: Request, id: string): { id: number; revision: string } {
  if (new URL(request.url).pathname.split('/').at(-2) !== id) throw new ValidateException('提现媒体记录路径须使用规范ID');
  return { id: parseAdminWithdrawalMediaId(id), revision: parseAdminWithdrawalMediaRevision(readParameters(request)) };
}
