import { ValidateException } from '@/utils/errors';

export const COUPON_ISSUE_MAX_PRODUCTS = 100;
export const COUPON_ISSUE_MAX_IDS_LENGTH = 500;
export type CouponIssueOperation = 'create' | 'status' | 'delete';
export type CouponIssueInput = {
  title: string; discountType: 1 | 2; scopeType: 0 | 1 | 2 | 3; category: 0 | 2;
  categoryId: number; brandId: number; productIds: string; couponPrice: string; useMinPrice: string;
  validDays: number; useStartTime: Date | null; useEndTime: Date | null; startTime: Date | null; endTime: Date | null;
  receiveType: 1 | 2 | 3 | 4; isPermanent: 0 | 1; totalCount: number; rule: string; status: 0 | 1; sort: number;
};
export const couponIssueFields = ['title', 'discount_type', 'scope_type', 'category', 'category_id', 'brand_id', 'product_ids',
  'coupon_price', 'use_min_price', 'valid_days', 'use_start_time', 'use_end_time', 'start_time', 'end_time',
  'receive_type', 'is_permanent', 'total_count', 'rule', 'status', 'sort'] as const;

export function couponIssueId(value: unknown, label = '发行ID') {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^[1-9]\d{0,9}$/.test(String(value))) {
    throw new ValidateException(`${label}无效`);
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id > 2147483647) throw new ValidateException(`${label}无效`);
  return id;
}
export function couponIssueInteger(value: unknown, label: string, min: number, max = 2147483647) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new ValidateException(`${label}无效`);
  return value;
}
export function couponIssueWhitelist(body: Record<string, unknown>, fields: readonly string[]) {
  if (Object.keys(body).some(field => !fields.includes(field))) throw new ValidateException('不支持的优惠券发行字段');
}
export function couponIssueRequest(value: unknown) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) {
    throw new ValidateException('请求标识必须为UUID');
  }
  return value;
}
export function couponIssueRevision(value: unknown) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new ValidateException('优惠券发行版本无效，请刷新');
  return value;
}
export async function couponIssueHash(value: unknown) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function money(value: unknown, positive = false) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/.test(value)) throw new ValidateException('金额须为decimal(12,2)十进制字符串');
  const [whole, fraction = ''] = value.split('.');
  if (positive && BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')) === 0n) throw new ValidateException('面额或折扣须大于0');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}
export function couponIssueDate(value: unknown): Date | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) throw new ValidateException('时间须为精确UTC时间或null');
  const date = new Date(value);
  const normalized = value.replace(/(?:\.(\d{1,3}))?Z$/, (_match, fraction: string | undefined) => `.${(fraction ?? '').padEnd(3, '0')}Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== normalized) throw new ValidateException('日期无效');
  return date;
}
function range(start: Date | null, end: Date | null, label: string) {
  if (Boolean(start) !== Boolean(end) || (start && end && start.getTime() >= end.getTime())) throw new ValidateException(`${label}起止须成对填写且结束晚于开始`);
}
/** Explicit definition for a new independent issuer. A copy is another create,
 * never an update of the source's financial definition or provenance. */
export function couponIssueCreate(body: Record<string, unknown>): CouponIssueInput {
  if (typeof body.title !== 'string' || body.title.length > 128 || /[\u0000-\u001f\u007f]/u.test(body.title)) throw new ValidateException('优惠券标题无效');
  const title = body.title.trim().normalize('NFC');
  if (!title || [...title].length > 64) throw new ValidateException('标题须为1至64个字符');
  const discountType = couponIssueInteger(body.discount_type, '优惠类型', 1, 2) as 1 | 2;
  const scopeType = couponIssueInteger(body.scope_type, '适用范围', 0, 3) as 0 | 1 | 2 | 3;
  const category = couponIssueInteger(body.category, '普通/会员券', 0, 2);
  if (![0, 2].includes(category)) throw new ValidateException('普通券须为0，会员券须为2');
  const categoryId = couponIssueInteger(body.category_id, '分类ID', 0);
  const brandId = couponIssueInteger(body.brand_id, '品牌ID', 0);
  if (!Array.isArray(body.product_ids) || body.product_ids.length > COUPON_ISSUE_MAX_PRODUCTS) throw new ValidateException('商品须为至多100个ID的数组');
  const ids = body.product_ids.map(value => couponIssueInteger(value, '商品ID', 1)).sort((a, b) => a - b);
  if (new Set(ids).size !== ids.length) throw new ValidateException('商品不能重复');
  const productIds = ids.join(',');
  if (productIds.length > COUPON_ISSUE_MAX_IDS_LENGTH) throw new ValidateException('商品ID不能超过500字符');
  if ((scopeType === 0 && (categoryId || brandId || productIds)) || (scopeType === 1 && (!categoryId || brandId || productIds))
    || (scopeType === 2 && (categoryId || brandId || !productIds)) || (scopeType === 3 && (categoryId || !brandId || productIds))) {
    throw new ValidateException('适用范围与分类/品牌/商品不一致');
  }
  const couponPrice = money(body.coupon_price, true), useMinPrice = money(body.use_min_price);
  if (discountType === 2 && Number(couponPrice) > 100) throw new ValidateException('折扣百分数须大于0且不超过100');
  const validDays = couponIssueInteger(body.valid_days, '有效天数', 0, 3650);
  const useStartTime = couponIssueDate(body.use_start_time), useEndTime = couponIssueDate(body.use_end_time);
  const startTime = couponIssueDate(body.start_time), endTime = couponIssueDate(body.end_time);
  range(startTime, endTime, '领取时间'); range(useStartTime, useEndTime, '使用时间');
  if ((validDays > 0 && (useStartTime || useEndTime)) || (validDays === 0 && (!useStartTime || !useEndTime))) throw new ValidateException('领后天数或固定使用区间须二选一');
  if (useStartTime && startTime && useStartTime < startTime) throw new ValidateException('使用开始不能早于领取开始');
  if (useEndTime && endTime && useEndTime < endTime) throw new ValidateException('使用结束不能早于领取结束');
  const receiveType = couponIssueInteger(body.receive_type, '领取方式', 1, 4) as 1 | 2 | 3 | 4;
  if (category === 2 && ![1, 4].includes(receiveType)) throw new ValidateException('会员券只能手动领取或使用既有会员发放方式');
  const isPermanent = couponIssueInteger(body.is_permanent, '是否不限量', 0, 1) as 0 | 1;
  const totalCount = couponIssueInteger(body.total_count, '发行量', 0);
  if ((isPermanent === 1 && totalCount !== 0) || (isPermanent === 0 && totalCount === 0)) throw new ValidateException('不限量发行量须为0，限量发行量须大于0');
  if (receiveType === 2 && (isPermanent !== 1 || totalCount !== 0)) throw new ValidateException('新人券须不限量');
  if (typeof body.rule !== 'string' || [...body.rule].length > 4096 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(body.rule)) throw new ValidateException('规则须为至多4096字符的纯文本');
  return { title, discountType, scopeType, category: category as 0 | 2, categoryId, brandId, productIds, couponPrice, useMinPrice,
    validDays, useStartTime, useEndTime, startTime, endTime, receiveType, isPermanent, totalCount, rule: body.rule,
    status: couponIssueInteger(body.status, '状态', 0, 1) as 0 | 1, sort: couponIssueInteger(body.sort, '排序', 0) };
}
export function couponIssueQuery(parameters: URLSearchParams, kind: 'issues' | 'products' | 'claims' = 'issues') {
  const allowed = kind === 'claims' ? ['page', 'limit'] : ['page', 'limit', 'keyword', ...(kind === 'issues' ? ['status', 'discount_type', 'receive_type'] : [])];
  for (const key of new Set(parameters.keys())) {
    if (!allowed.includes(key) || parameters.getAll(key).length !== 1) throw new ValidateException('查询参数未知或重复');
  }
  const integer = (key: string, fallback: number, max: number) => {
    const raw = parameters.get(key); if (raw === null) return fallback;
    if (!/^[1-9]\d*$/.test(raw)) throw new ValidateException('分页无效');
    const value = Number(raw); if (!Number.isSafeInteger(value) || value > max) throw new ValidateException('分页无效'); return value;
  };
  const page = integer('page', 1, 10001), limit = integer('limit', 15, 100), offset = (page - 1) * limit;
  if (offset > 10000) throw new ValidateException('分页偏移不能超过10000');
  const keyword = parameters.get('keyword') ?? '';
  if ([...keyword].length > 100 || /[\u0000-\u001f\u007f]/u.test(keyword)) throw new ValidateException('搜索词无效');
  const filter = (key: string, options: string[], fallback = '') => {
    const raw = parameters.get(key) ?? fallback; if (!options.includes(raw)) throw new ValidateException(`${key}无效`);
    return raw === '' ? undefined : Number(raw);
  };
  return { page, limit, offset, keyword: keyword.trim(), status: kind === 'issues' ? filter('status', ['', '-1', '0', '1'], '1') : undefined,
    discountType: kind === 'issues' ? filter('discount_type', ['', '1', '2']) : undefined,
    receiveType: kind === 'issues' ? filter('receive_type', ['', '1', '2', '3', '4']) : undefined };
}
