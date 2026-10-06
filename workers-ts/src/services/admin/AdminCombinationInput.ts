import { ValidateException } from '@/utils/errors';
import { seckillTimePicture } from '@/services/activity/SeckillTimeAssetPolicy';
import { sanitizePublishedArticleHtml } from '@/services/content/ArticleContentPolicy';
import { activityFlag, activityId, activityInteger, activityObject, activityText } from './AdminSeckillActivityInput';

export const COMBINATION_MAX_SKUS = 500;
export const COMBINATION_MAX_IMAGES = 10;
export type CombinationOperation = 'create' | 'update' | 'status' | 'delete';
export type CombinationSkuInput = { id: number | null; baseUnique: string; enabled: boolean; price: string | null; total: number | null; image: string | null };
export type CombinationShipping = { deliveryType: number[]; freight: 1 | 2 | 3; postage: string; tempId: number };
export type CombinationInput = { productId: number; title: string; info: string; unitName: string; images: string[]; description: string;
  startTime: Date; endTime: Date; effectiveTime: number; people: number; num: number; onceNum: number; virtual: number;
  sort: number; status: 0 | 1; isHost: 0 | 1; isSupportRefund: 0 | 1; shipping: CombinationShipping; skus: CombinationSkuInput[] };
export function combinationWhitelist(raw: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(raw).some(key => !keys.includes(key))) throw new ValidateException('不支持的拼团管理字段');
}
export function combinationMoney(value: unknown, wholeDigits = 10) {
  if (typeof value !== 'string' || !new RegExp(`^(0|[1-9]\\d{0,${wholeDigits - 1}})(\\.\\d{1,2})?$`).test(value)) throw new ValidateException('拼团金额须为有效十进制金额');
  const [whole, fraction = ''] = value.split('.');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}
export function combinationDate(value: unknown): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) throw new ValidateException('拼团时间须为精确UTC时间');
  const date = new Date(value), normalized = value.replace(/(?:\.(\d{1,3}))?Z$/, (_match, milliseconds: string | undefined) => `.${(milliseconds ?? '').padEnd(3, '0')}Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== normalized) throw new ValidateException('拼团日期无效');
  return date;
}
export function combinationImage(value: unknown, maximum = 255) {
  const image = seckillTimePicture(value);
  if ([...image].length > maximum) throw new ValidateException(`拼团图片稳定引用不能超过${maximum}个字符`);
  return image;
}
export function parseCombinationInput(raw: Record<string, unknown>): CombinationInput {
  const startTime = combinationDate(raw.start_time), endTime = combinationDate(raw.end_time);
  if (startTime > endTime) throw new ValidateException('拼团结束时间不能早于开始时间');
  const num = activityInteger(raw.num, '累计限购', 1), onceNum = activityInteger(raw.once_num, '单订单限购', 1);
  if (onceNum > num) throw new ValidateException('单订单限购不能大于累计限购');
  if (!Array.isArray(raw.images) || !raw.images.length || raw.images.length > COMBINATION_MAX_IMAGES) throw new ValidateException('请选择1至10张拼团相册图片');
  const images = raw.images.map(value => combinationImage(value));
  if (JSON.stringify(images).length > 2000) throw new ValidateException('拼团相册超过完整存储容量');
  const description = sanitizePublishedArticleHtml(raw.description);
  if (!description.trim()) throw new ValidateException('请填写拼团商品详情');
  const shipping = activityObject(raw.shipping, '配送配置'); combinationWhitelist(shipping, ['delivery_type', 'freight', 'postage', 'temp_id']);
  if (!Array.isArray(shipping.delivery_type) || !shipping.delivery_type.length || shipping.delivery_type.length > 3 ||
    shipping.delivery_type.some(value => ![1, 2, 3].includes(value as number)) || new Set(shipping.delivery_type).size !== shipping.delivery_type.length) throw new ValidateException('请选择有效且不重复的配送方式');
  const freight = activityInteger(shipping.freight, '运费方式', 1);
  if (freight > 3) throw new ValidateException('运费方式无效');
  const postage = combinationMoney(shipping.postage, 8), tempId = activityInteger(shipping.temp_id, '运费模板ID');
  if (freight === 3 && !tempId) throw new ValidateException('请选择运费模板');
  if (!Array.isArray(raw.skus) || raw.skus.length > COMBINATION_MAX_SKUS) throw new ValidateException('拼团最多500个规格，不能截断保存');
  const skus = raw.skus.map(value => {
    const sku = activityObject(value, '拼团规格'); combinationWhitelist(sku, ['id', 'base_unique', 'enabled', 'price', 'quota_total', 'image']);
    if (typeof sku.enabled !== 'boolean') throw new ValidateException('规格参与标记无效');
    const id = sku.id == null ? null : activityId(sku.id, '拼团规格ID'), baseUnique = typeof sku.base_unique === 'string' ? sku.base_unique : '';
    if (sku.enabled && (!baseUnique || baseUnique !== baseUnique.trim() || baseUnique.length > 8 || /[\u0000-\u0020\u007f]/u.test(baseUnique))) throw new ValidateException('基础规格标识无效');
    return { id, baseUnique, enabled: sku.enabled, price: sku.enabled ? combinationMoney(sku.price) : null,
      total: sku.enabled ? activityInteger(sku.quota_total, '配置总额度') : null, image: sku.enabled ? combinationImage(sku.image, 128) : null };
  });
  const ids = skus.filter(row => row.id !== null).map(row => row.id), sources = skus.filter(row => row.enabled).map(row => row.baseUnique);
  if (new Set(ids).size !== ids.length || new Set(sources).size !== sources.length) throw new ValidateException('拼团规格身份或组合重复');
  const status = activityFlag(raw.status);
  if (status === 1 && !skus.some(row => row.enabled)) throw new ValidateException('启用拼团必须有参与规格');
  const virtual = activityInteger(raw.virtual, '虚拟成团百分比', 1);
  if (virtual > 100) throw new ValidateException('虚拟成团百分比须为1至100');
  const people = activityInteger(raw.people, '成团人数', 2);
  if (people > 500) throw new ValidateException('成团人数不能超过500');
  return { productId: activityId(raw.product_id, '基础商品ID'), title: activityText(raw.title, '拼团标题', 256), info: activityText(raw.info, '拼团简介', 255),
    unitName: activityText(raw.unit_name, '商品单位', 32), images, description, startTime, endTime,
    effectiveTime: activityInteger(raw.effective_time, '成团有效期', 1), people, num, onceNum, virtual,
    sort: activityInteger(raw.sort, '排序'), status, isHost: activityFlag(raw.is_host), isSupportRefund: activityFlag(raw.is_support_refund),
    shipping: { deliveryType: [...shipping.delivery_type] as number[], freight: freight as 1 | 2 | 3, postage: freight === 2 ? postage : '0.00', tempId: freight === 3 ? tempId : 0 }, skus };
}
