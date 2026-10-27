import { ValidateException } from '@/utils/errors';
import { readBoundedUtf8Text } from '@/utils/request-body';
import { parseLevelActivationJson } from '@/services/admin/AdminLevelActivationInput';

export interface PromoterOrdersQuery { page: number; limit: 10; start: number; stop: number; keyword: string }
export const PROMOTER_ORDERS_KEYWORD_LIMIT = 64;

/** The explicit view opts into scalar JSON and complete Shanghai calendar days. */
export async function readPromoterOrdersInput(request: Request): Promise<PromoterOrdersQuery> {
  const query = new URL(request.url).searchParams;
  if ([...query.keys()].some(key => key !== 'view') || query.getAll('view').length !== 1 || query.get('view') !== 'promoter_orders') {
    throw new ValidateException('推广订单查询参数无效');
  }
  if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers.get('content-type') ?? '')) throw new ValidateException('推广订单查询须为JSON');
  const text = await readBoundedUtf8Text(request, 4096);
  let value: unknown;
  try { value = parseLevelActivationJson(text); } catch { throw new ValidateException('推广订单查询JSON无效或字段重复'); }
  return promoterOrdersQuery(value);
}

export function promoterOrdersQuery(value: unknown): PromoterOrdersQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidateException('推广订单查询须为对象');
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !['page', 'limit', 'start', 'stop', 'keyword'].includes(key))) throw new ValidateException('推广订单查询包含不支持的字段');
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const next = body[name] === undefined ? fallback : body[name];
    if (typeof next !== 'number' || !Number.isSafeInteger(next) || next < min || next > max || Object.is(next, -0)) throw new ValidateException('推广订单查询整数无效');
    return next;
  };
  const page = integer('page', 1, 1, 1000), limit = integer('limit', 10, 10, 10) as 10;
  const start = integer('start', 0, 0, 2147483647), stop = integer('stop', 0, 0, 2147483647);
  if ((start !== 0 || stop !== 0) && (start === 0 || stop === 0 || start > stop || (start + 28800) % 86400 !== 0 || (stop + 28801) % 86400 !== 0)) {
    throw new ValidateException('推广订单日期须为上海完整日闭区间');
  }
  const keyword = body.keyword === undefined ? '' : body.keyword;
  if (typeof keyword !== 'string' || [...keyword].length > PROMOTER_ORDERS_KEYWORD_LIMIT || /[\u0000-\u001f\u007f]/u.test(keyword)
    || [...keyword].some(char => { const point = char.codePointAt(0)!; return point >= 0xd800 && point <= 0xdfff; })) throw new ValidateException('推广订单关键词格式或长度无效');
  return { page, limit, start, stop, keyword: keyword.trim() };
}
