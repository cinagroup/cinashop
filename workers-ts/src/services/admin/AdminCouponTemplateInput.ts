import { ValidateException } from '@/utils/errors';

export const COUPON_TEMPLATE_MAX_PRODUCTS = 100;
export const COUPON_TEMPLATE_MAX_IDS_LENGTH = 500;
export type CouponTemplateOperation = 'create' | 'invalidate' | 'delete' | 'publish';
export type CouponTemplateInput = { title: string; scopeType: 0 | 1 | 2; categoryId: number; productIds: string;
  couponPrice: string; useMinPrice: string; validDays: number; sort: number; status: 0 | 1 };
export type CouponTemplatePublication = { receiveType: 1 | 2 | 3; status: 0 | 1; isPermanent: 0 | 1; count: number;
  startTime: Date | null; endTime: Date | null; fullReduction: string };

export function couponTemplateId(value: unknown, label = '优惠券模板ID') {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^[1-9]\d{0,9}$/.test(String(value))) throw new ValidateException(`${label}无效`);
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id > 2147483647) throw new ValidateException(`${label}无效`);
  return id;
}
function integer(value: unknown, label: string, minimum: number, maximum = 2147483647) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new ValidateException(`${label}无效`);
  return value;
}
function flag(value: unknown) { return integer(value, '状态', 0, 1) as 0 | 1; }
export function couponTemplateMoney(value: unknown, positive = false) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/.test(value)) throw new ValidateException('优惠券金额必须为decimal(12,2)十进制字符串');
  const [whole, fraction = ''] = value.split('.'), cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (positive && cents === 0n) throw new ValidateException('优惠券面额必须大于0');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}
export function couponTemplateWhitelist(body: Record<string, unknown>, fields: readonly string[]) {
  if (Object.keys(body).some(field => !fields.includes(field))) throw new ValidateException('不支持的优惠券模板字段');
}
export function couponTemplateRequest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) throw new ValidateException('请求标识必须为UUID');
  return value;
}
export function couponTemplateRevision(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new ValidateException('优惠券模板版本无效，请刷新');
  return value;
}
export function couponTemplateCreate(body: Record<string, unknown>): CouponTemplateInput {
  if (typeof body.title !== 'string' || /[\u0000-\u001f\u007f]/u.test(body.title) || body.title.length > 128) throw new ValidateException('优惠券模板标题无效');
  const title = body.title.trim().normalize('NFC');
  if (!title || [...title].length > 64) throw new ValidateException('优惠券模板标题须为1至64个字符');
  const scopeType = integer(body.scope_type, '适用范围', 0, 2) as 0 | 1 | 2, categoryId = integer(body.category_id, '分类ID', 0);
  if (!Array.isArray(body.product_ids) || body.product_ids.length > COUPON_TEMPLATE_MAX_PRODUCTS) throw new ValidateException('适用商品须为至多100个ID的数组');
  const productIds = body.product_ids.map(value => integer(value, '商品ID', 1)).sort((a, b) => a - b);
  if (new Set(productIds).size !== productIds.length) throw new ValidateException('适用商品不能重复');
  const csv = productIds.join(',');
  if (csv.length > COUPON_TEMPLATE_MAX_IDS_LENGTH) throw new ValidateException('适用商品ID超过500字符');
  if ((scopeType === 0 && (categoryId || csv)) || (scopeType === 1 && (!categoryId || csv)) || (scopeType === 2 && (categoryId || !csv))) throw new ValidateException('适用范围与分类/商品不一致');
  return { title, scopeType, categoryId, productIds: csv, couponPrice: couponTemplateMoney(body.coupon_price, true),
    useMinPrice: couponTemplateMoney(body.use_min_price), validDays: integer(body.valid_days, '有效天数', 1, 3650),
    sort: integer(body.sort, '排序', 0), status: flag(body.status) };
}
function utcDate(value: unknown): Date | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) throw new ValidateException('领取时间须为精确UTC时间或null');
  const date = new Date(value), normalized = value.replace(/(?:\.(\d{1,3}))?Z$/, (_match, milliseconds: string | undefined) => `.${(milliseconds ?? '').padEnd(3, '0')}Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== normalized) throw new ValidateException('领取日期无效');
  return date;
}
export function couponTemplatePublish(body: Record<string, unknown>): CouponTemplatePublication {
  const receiveType = integer(body.receive_type, '领取方式', 1, 3) as 1 | 2 | 3, isPermanent = flag(body.is_permanent);
  const count = integer(body.count, '发行数量', 0), startTime = utcDate(body.start_time), endTime = utcDate(body.end_time);
  if ((isPermanent === 1 && count !== 0) || (isPermanent === 0 && count === 0)) throw new ValidateException('不限量发行数量须为0，限量发行数量须大于0');
  if (Boolean(startTime) !== Boolean(endTime) || (startTime && endTime && startTime.getTime() >= endTime.getTime())) throw new ValidateException('领取起止时间须成对填写且结束晚于开始');
  const fullReduction = couponTemplateMoney(body.full_reduction);
  if (receiveType !== 3 && fullReduction !== '0.00') throw new ValidateException('满赠门槛仅可用于赠送券元数据');
  return { receiveType, isPermanent, count, startTime, endTime, fullReduction, status: flag(body.status) };
}
export function couponTemplateQuery(parameters: URLSearchParams, mode: 'templates' | 'products' | 'issues' = 'templates') {
  const allowed = mode === 'issues' ? ['page', 'limit'] : ['page', 'limit', 'keyword', ...(mode === 'templates' ? ['status'] : [])];
  for (const key of new Set(parameters.keys())) {
    if (!allowed.includes(key)) throw new ValidateException('不支持的优惠券模板查询字段');
    if (parameters.getAll(key).length !== 1) throw new ValidateException('优惠券模板查询字段重复');
  }
  const number = (key: string, fallback: number, maximum: number) => {
    const raw = parameters.get(key);
    if (raw === null) return fallback;
    if (!/^[1-9]\d*$/.test(raw)) throw new ValidateException('分页参数无效');
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value > maximum) throw new ValidateException('分页参数无效');
    return value;
  };
  const page = number('page', 1, 10001), limit = number('limit', 15, 100), offset = (page - 1) * limit;
  if (offset > 10000) throw new ValidateException('分页偏移不能超过10000');
  const keyword = parameters.get('keyword') ?? '';
  if ([...keyword].length > 100 || /[\u0000-\u001f\u007f]/u.test(keyword)) throw new ValidateException('搜索词无效');
  const status = parameters.get('status') ?? '1';
  if (mode === 'templates' && !['', '0', '1'].includes(status)) throw new ValidateException('模板状态无效');
  return { page, limit, offset, keyword: keyword.trim(), status: status === '' ? undefined : Number(status) as 0 | 1 };
}
export async function couponTemplateHash(value: unknown) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
