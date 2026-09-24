import { http } from '@/utils/request';
import { safeDiyImageUrl } from '@/utils/diy';

export interface NewcomerCoupon {
  id: number;
  benefit: string;
  minimum: string;
  scope: string;
}
export interface NewcomerInfo {
  coupons: NewcomerCoupon[];
  points: number;
  balance: string;
  firstOrderDiscount: string;
  agreement: string;
}
export interface NewcomerProduct {
  id: number;
  productId: number;
  title: string;
  image: string;
  price: string;
  originalPrice: string;
  stock: number;
}
export interface NewcomerProductDetail extends NewcomerProduct {
  description: string;
  skus: { unique: string; name: string; price: string; stock: number; image: string }[];
}

const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const id = (value: unknown): number => Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : 0;
const money = (value: unknown): string => {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('新人价格响应无效');
  const text = String(value);
  if (!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/.test(text)) throw new Error('新人价格响应无效');
  return Number(text).toFixed(2);
};
const nonnegative = (value: unknown): number => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
const scopeText = (value: unknown) => ({ 0: '通用券', 1: '品类券', 2: '商品券', 3: '品牌券' })[Number(value) as 0 | 1 | 2 | 3] ?? '适用范围以券详情为准';

export function parseNewcomerInfo(raw: unknown): NewcomerInfo | null {
  const value = object(raw);
  if (!value) throw new Error('新人礼信息响应无效');
  if (!Object.keys(value).length) return null; // PHP returns {} when disabled.
  if (!Array.isArray(value.register_give_coupon)) throw new Error('新人优惠券响应无效');
  const coupons = value.register_give_coupon.map((entry): NewcomerCoupon => {
    const row = object(entry);
    if (!row || !id(row.id)) throw new Error('新人优惠券响应无效');
    // PHP's old response is snake_case; the current Worker returns the
    // StoreCouponUser snapshot in camelCase. Do not invent a zero-value gift.
    const rawPrice = row.coupon_price ?? row.couponPrice;
    if (rawPrice === undefined) throw new Error('新人优惠券金额响应无效');
    const rawMinimum = row.use_min_price ?? row.useMinPrice;
    if (rawMinimum === undefined) throw new Error('新人优惠券门槛响应无效');
    const price = money(rawPrice);
    const couponType = Number(row.coupon_type ?? row.type);
    const discount = Number(price) > 0 && Number(price) <= 100
      ? `${String(Number((Number(price) / 10).toFixed(3)))}折` : '查看券详情';
    return {
      id: id(row.id),
      benefit: Number(price) <= 0 ? '查看券详情' : couponType === 1 ? `¥${price}` : couponType === 2 ? discount : '查看券详情',
      minimum: money(rawMinimum),
      scope: row.applicable_type === undefined ? '适用范围以券详情为准' : scopeText(row.applicable_type),
    };
  });
  const discount = nonnegative(value.first_order_discount);
  return {
    coupons,
    points: nonnegative(value.register_give_integral),
    balance: money(value.register_give_money ?? 0),
    firstOrderDiscount: Number(value.first_order_status) === 1 && discount > 0 && discount <= 100 ? `${(discount / 10).toFixed(1)}折` : '',
    agreement: typeof value.newcomer_agreement === 'string' ? value.newcomer_agreement.slice(0, 100_000) : '',
  };
}

export function parseNewcomerProducts(raw: unknown): NewcomerProduct[] {
  if (!Array.isArray(raw) || raw.length > 9) throw new Error('新人商品列表响应无效');
  const seen = new Set<number>();
  return raw.map((entry) => {
    const row = object(entry);
    if (!row || !id(row.id) || !id(row.product_id) || typeof row.store_name !== 'string' || seen.has(id(row.id))) throw new Error('新人商品列表响应无效');
    seen.add(id(row.id));
    return {
      id: id(row.id), productId: id(row.product_id), title: row.store_name.slice(0, 200),
      image: safeDiyImageUrl(row.image), price: money(row.price), originalPrice: money(row.ot_price ?? 0), stock: nonnegative(row.stock),
    };
  });
}

export function parseNewcomerDetail(raw: unknown, requestedId: number): NewcomerProductDetail {
  const data = object(raw), row = object(data?.storeInfo), values = object(data?.productValue);
  if (!row || !values || id(row.id) !== requestedId || !id(row.product_id) || typeof row.title !== 'string') throw new Error('新人商品详情响应无效');
  const skus = Object.entries(values).map(([key, value]) => {
    const sku = object(value);
    if (!sku || typeof sku.unique !== 'string' || !sku.unique || typeof sku.suk !== 'string' || (key !== sku.suk && !(key === '' && sku.suk === '默认'))) throw new Error('新人商品规格响应无效');
    return { unique: sku.unique, name: sku.suk, price: money(sku.price), stock: nonnegative(sku.stock), image: safeDiyImageUrl(sku.image) };
  });
  return {
    id: requestedId, productId: id(row.product_id), title: row.title.slice(0, 200),
    image: safeDiyImageUrl(row.image), price: money(row.price), originalPrice: money(row.ot_price ?? 0),
    stock: nonnegative(row.stock), description: typeof row.info === 'string' ? row.info.slice(0, 1000) : '', skus,
  };
}

export async function apiNewcomerInfo() { return parseNewcomerInfo(await http.get<unknown>('/marketing/newcomer/info')); }
export async function apiNewcomerProducts(page: number) {
  if (!Number.isSafeInteger(page) || page < 1 || page > 10_000) throw new Error('新人商品页码无效');
  return parseNewcomerProducts(await http.get<unknown>('/marketing/newcomer/product_list', { page, limit: 9 }));
}
export async function apiNewcomerProductDetail(productId: number) {
  if (!Number.isSafeInteger(productId) || productId < 1 || productId > 2_147_483_647) throw new Error('新人商品链接无效');
  return parseNewcomerDetail(await http.get<unknown>(`/marketing/newcomer/product_detail/${productId}`), productId);
}
