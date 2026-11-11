import type { OutGoodsListParams } from '@/services/product/StoreProductService';
import { ValidateException } from '@/utils/errors';

const MAX_ID = 2_147_483_647;

function number(value: unknown, label: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^-?\d+$/.test(String(value).trim()))
    throw new ValidateException(`${label}参数错误`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new ValidateException(`${label}参数错误`);
  return result;
}

function ids(value: unknown, label: string): number[] | undefined {
  if (value === undefined || value === null || value === '' || value === '0' || value === 0) return undefined;
  if (typeof value !== 'string' && !Array.isArray(value)) throw new ValidateException(`${label}参数错误`);
  const parts = Array.isArray(value) ? value : value.split(',');
  if (!parts.length || parts.length > 100) throw new ValidateException(`${label}数量超限`);
  return [...new Set(parts.map(part => {
    const parsed = number(part, label, 1, MAX_ID);
    if (parsed === undefined) throw new ValidateException(`${label}参数错误`);
    return parsed;
  }))];
}

export function normalizeOutProductListFilters(query: Record<string, unknown>): OutGoodsListParams {
  const name = query.store_name === undefined ? '' : String(query.store_name).trim();
  if (name.length > 100) throw new ValidateException('商品搜索词过长');
  const status = query.type === undefined ? 1 : number(query.type, '商品状态', -2, 7);
  const category = number(query.cate_id, '分类', 0, MAX_ID);
  const vip = number(query.is_vip_product, '会员商品', -1, 1) as -1 | 0 | 1 | undefined;
  const presale = number(query.is_presale_product, '预售商品', 0, 1) as 0 | 1 | undefined;
  const isNew = number(query.is_new, '新品', 0, 1);
  const isLive = number(query.is_live, '直播商品', 0, 1);
  const page = number(query.page, '页码', 1, MAX_ID) ?? 1;
  const limit = Math.min(number(query.limit, '每页数量', 1, MAX_ID) ?? 20, 100);
  const brands = ids(query.brand_id, '品牌');
  return { store_name: name || undefined, outStatus: status, outCategoryId: category || undefined,
    outVip: vip, outPresale: presale, outNew: isNew === 1, outNotLive: isLive === 1,
    outStoreLabelIds: ids(query.store_label_id, '商品标签'), brand_id: brands?.join(','), page, limit };
}
