import { ValidateException } from '@/utils/errors';

export interface CartComputationInput { cartIds: number[]; shippingType?: 1 | 2 | 3 }
/** PHP's first-party caller sends a comma-separated cartId and omits shipping_type. */
export function parseCartComputationInput(body: unknown): CartComputationInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValidateException('购物车预算提交格式错误');
  const row = body as Record<string, unknown>;
  if (Object.keys(row).some(key => !['cartId', 'shipping_type'].includes(key))) throw new ValidateException('购物车预算包含未知字段');
  if (typeof row.cartId !== 'string' || !row.cartId || row.cartId.length > 1100) throw new ValidateException('请选择有效的购物车商品');
  const raw = row.cartId.split(',');
  if (!raw.length || raw.length > 100 || raw.some(id => !/^[1-9]\d{0,9}$/.test(id))) throw new ValidateException('单次预算请选择1至100项商品');
  const cartIds = raw.map(Number);
  if (cartIds.some(id => id > 2147483647) || new Set(cartIds).size !== cartIds.length) throw new ValidateException('购物车ID无效或重复');
  const shipping = row.shipping_type;
  if (shipping === undefined || shipping === -1 || shipping === '-1') return { cartIds };
  if (![1,2,3,'1','2','3'].includes(shipping as number | string)) throw new ValidateException('购物车配送类型无效');
  return { cartIds, shippingType: Number(shipping) as 1 | 2 | 3 };
}
