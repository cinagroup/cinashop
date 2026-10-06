import { ValidateException } from '@/utils/errors';
import { seckillTimePicture } from '@/services/activity/SeckillTimeAssetPolicy';

export const SECKILL_ACTIVITY_MAX_PRODUCTS = 100;
export const SECKILL_ACTIVITY_MAX_SKUS = 500;
export const SECKILL_ACTIVITY_MAX_TOTAL_SKUS = 5000;
export const SECKILL_ACTIVITY_MAX_SLOTS = 64;
export const SECKILL_ACTIVITY_MAX_PICKER_OPTIONS = 5000;
export const SECKILL_ACTIVITY_MAX_INTEGER = 2_147_483_647;
export type SeckillActivityOperation = 'create' | 'update' | 'status' | 'delete';
export type ActivitySkuInput = { id: number | null; baseUnique: string; enabled: boolean; price: string | null; total: number | null };
export type ActivityProductInput = { childId: number | null; productId: number; status: 0 | 1; skus: ActivitySkuInput[] };
export type ActivityInput = { name: string; startDay: number; endDay: number; timeIds: number[];
  num: number; onceNum: number; image: string; status: 0 | 1; products: ActivityProductInput[] };

export function activityId(value: unknown, label = '秒杀活动ID'): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^[1-9]\d{0,9}$/.test(String(value))) throw new ValidateException(`${label}无效`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result > SECKILL_ACTIVITY_MAX_INTEGER) throw new ValidateException(`${label}无效`);
  return result;
}
export function activityInteger(value: unknown, label: string, minimum = 0) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > SECKILL_ACTIVITY_MAX_INTEGER) throw new ValidateException(`${label}无效`);
  return value;
}
export function activityFlag(value: unknown): 0 | 1 {
  if (value !== 0 && value !== 1) throw new ValidateException('活动状态须为0或1');
  return value;
}
export function activityText(value: unknown, label: string, maximum: number, required = true) {
  if (typeof value !== 'string' || value.length > maximum * 2 || /[\u0000-\u001f\u007f]/u.test(value)) throw new ValidateException(`${label}格式错误`);
  const text = value.trim();
  if ((required && !text) || [...text].length > maximum) throw new ValidateException(`${label}长度错误`);
  return text;
}
export function activityDate(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ValidateException('活动日期须为YYYY-MM-DD');
  const date = new Date(`${value}T00:00:00+08:00`), stamp = date.getTime() / 1000;
  if (!Number.isSafeInteger(stamp) || stamp <= 0 || stamp > SECKILL_ACTIVITY_MAX_INTEGER ||
    new Date(date.getTime() + 28_800_000).toISOString().slice(0, 10) !== value) throw new ValidateException('活动日期无效或超出可存储范围');
  return stamp;
}
export function activityDateText(value: number): string {
  if (!Number.isSafeInteger(value) || value <= 0 || value > SECKILL_ACTIVITY_MAX_INTEGER || (value + 28800) % 86400) return '';
  return new Date(value * 1000 + 28_800_000).toISOString().slice(0, 10);
}
export function activityMoney(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/.test(value)) throw new ValidateException('活动价须为有效十进制金额');
  const [whole, fraction = ''] = value.split('.');
  if (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')) <= 0n) throw new ValidateException('活动价须大于0');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}
export function activityObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidateException(`${label}格式错误`);
  return value as Record<string, unknown>;
}
export function activityWhitelist(raw: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(raw).some(key => !allowed.includes(key))) throw new ValidateException('不支持的秒杀活动字段');
}
export function parseActivityInput(raw: Record<string, unknown>): ActivityInput {
  const startDay = activityDate(raw.start_day), endDay = activityDate(raw.end_day);
  if (startDay > endDay) throw new ValidateException('活动结束日不能早于开始日');
  const num = activityInteger(raw.num, '累计限购', 1), onceNum = activityInteger(raw.once_num, '单订单限购', 1);
  if (onceNum > num) throw new ValidateException('单订单限购不能大于累计限购');
  if (!Array.isArray(raw.time_ids) || !raw.time_ids.length || raw.time_ids.length > SECKILL_ACTIVITY_MAX_SLOTS) throw new ValidateException('请选择1至64个场次');
  const timeIds = raw.time_ids.map(value => activityId(value, '场次ID')).sort((a, b) => a - b);
  if (new Set(timeIds).size !== timeIds.length) throw new ValidateException('场次不能重复');
  let image = '';
  if (raw.image !== '') {
    image = seckillTimePicture(raw.image);
    if ([...image].length > 128) throw new ValidateException('活动氛围图不能超过128个字符');
  }
  if (!Array.isArray(raw.products) || !raw.products.length || raw.products.length > SECKILL_ACTIVITY_MAX_PRODUCTS) throw new ValidateException('请选择1至100个商品');
  let totalSkus = 0;
  const products = raw.products.map(value => {
    const product = activityObject(value, '活动商品'); activityWhitelist(product, ['child_id', 'product_id', 'status', 'skus']);
    const childId = product.child_id == null ? null : activityId(product.child_id, '子商品ID');
    const status = activityFlag(product.status);
    const productId = childId !== null && status === 0 && product.product_id === 0 ? 0 : activityId(product.product_id, '基础商品ID');
    if (!Array.isArray(product.skus) || product.skus.length > SECKILL_ACTIVITY_MAX_SKUS) throw new ValidateException('每商品最多500个规格');
    totalSkus += product.skus.length;
    const skus = product.skus.map(value => {
      const sku = activityObject(value, '活动规格'); activityWhitelist(sku, ['id', 'base_unique', 'price', 'quota_total', 'enabled']);
      if (typeof sku.enabled !== 'boolean') throw new ValidateException('规格参与标记无效');
      const id = sku.id == null ? null : activityId(sku.id, '活动规格ID');
      // A disabled existing identity can be retired even when its old source or
      // price is damaged. These values are never persisted on the retirement path.
      const baseUnique = typeof sku.base_unique === 'string' ? sku.base_unique : '';
      if (sku.enabled && (!baseUnique || baseUnique !== baseUnique.trim() || baseUnique.length > 8 || /[\u0000-\u0020\u007f]/u.test(baseUnique))) throw new ValidateException('基础规格标识无效');
      return { id, baseUnique, enabled: sku.enabled,
        price: sku.enabled ? activityMoney(sku.price) : null,
        total: sku.enabled ? activityInteger(sku.quota_total, '配置总额度') : null };
    });
    const ids = skus.filter(row => row.id !== null).map(row => row.id);
    const sources = skus.filter(row => row.enabled).map(row => row.baseUnique);
    if (new Set(ids).size !== ids.length || new Set(sources).size !== sources.length) throw new ValidateException('商品规格不能重复');
    if (status === 1 && !skus.some(row => row.enabled)) throw new ValidateException('启用商品必须选择参与规格');
    return { childId, productId, status, skus };
  });
  if (totalSkus > SECKILL_ACTIVITY_MAX_TOTAL_SKUS) throw new ValidateException('单活动最多5000个规格');
  if (new Set(products.map(row => row.productId)).size !== products.length ||
    new Set(products.filter(row => row.childId !== null).map(row => row.childId)).size !== products.filter(row => row.childId !== null).length) throw new ValidateException('活动商品不能重复');
  return { name: activityText(raw.name, '活动名称', 128), startDay, endDay, timeIds, num, onceNum, image,
    status: activityFlag(raw.status), products };
}

export async function activityHash(value: unknown) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function activityListQuery(query: URLSearchParams, candidates = false) {
  const allowed = candidates ? ['page', 'limit', 'keyword', 'category_id', 'label_id'] : ['page', 'limit', 'keyword', 'phase', 'status'];
  for (const key of query.keys()) if (!allowed.includes(key) || query.getAll(key).length !== 1) throw new ValidateException('不支持或重复的秒杀活动查询参数');
  const page = query.has('page') ? activityId(query.get('page'), '页码') : 1;
  const limit = query.has('limit') ? activityId(query.get('limit'), '每页数量') : 15;
  if (limit > 100 || (page - 1) * limit > 10000) throw new ValidateException('活动分页超出范围');
  const status = query.get('status') || 'all', phase = query.get('phase') || 'all';
  if (!['all', '0', '1'].includes(status) || !['all', 'future', 'active', 'ended', 'invalid'].includes(phase)) throw new ValidateException('活动筛选参数无效');
  const filterId = (key: string, label: string) => !query.has(key) || query.get(key) === '' || query.get(key) === '0' ? 0 : activityId(query.get(key), label);
  return { page, limit, offset: (page - 1) * limit, status, phase, keyword: activityText(query.get('keyword') ?? '', '查询名称', 100, false),
    categoryId: candidates ? filterId('category_id', '商品分类ID') : 0, labelId: candidates ? filterId('label_id', '商品标签ID') : 0 };
}
