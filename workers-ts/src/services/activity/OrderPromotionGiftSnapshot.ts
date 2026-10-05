import { ValidateException } from '@/utils/errors';

export const ORDER_PROMOTION_GIFT_VERSION = 'order-promotion-gifts-v1' as const;

export interface PromotionGiftLabel {
  id: number;
  label_id: number[];
  name: string;
}

export interface PromotionGiftCoupon {
  aux_id: number;
  issue_id: number;
  title: string;
  price: string;
  min_price: string;
  type: 1 | 2;
  day: number;
  use_start_time: number | null;
  use_end_time: number | null;
}

export interface PromotionGiftProduct {
  aux_id: number;
  product_id: number;
  sku_id: number;
  unique: string;
  quantity: number;
  cart_id: string;
}

export interface PromotionGiftCampaign extends PromotionGiftLabel {
  tier_id: number;
  eligible_cart_ids: string[];
  threshold_type: 1 | 2;
  threshold: string;
  repetitions: number;
  give_integral: number;
  coupons: PromotionGiftCoupon[];
  products: PromotionGiftProduct[];
}

export interface OrderPromotionGiftIntent {
  version: typeof ORDER_PROMOTION_GIFT_VERSION;
  price_promotions: PromotionGiftLabel[];
  promotions: PromotionGiftCampaign[];
}

const fail = () => new ValidateException('满送订单权益快照无效');
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail();
  return value as Record<string, unknown>;
};
const shape = (value: Record<string, unknown>, keys: readonly string[]) => {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw fail();
};
const integer = (value: unknown, min = 1, max = 2_147_483_647): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw fail();
  return value;
};
const string = (value: unknown, max: number): string => {
  if (typeof value !== 'string' || !value || value.length > max) throw fail();
  return value;
};
const money = (value: unknown): string => {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,9})\.\d{2}$/.test(value)) throw fail();
  return value;
};
const array = (value: unknown, max: number): unknown[] => {
  if (!Array.isArray(value) || value.length > max) throw fail();
  return value;
};
const unique = (values: readonly (number | string)[]) => {
  if (new Set(values).size !== values.length) throw fail();
};

function label(value: unknown): PromotionGiftLabel {
  const row = object(value);
  shape(row, ['id', 'label_id', 'name']);
  const labels = array(row.label_id, 100).map(id => integer(id));
  unique(labels);
  return { id: integer(row.id), label_id: labels, name: string(row.name, 255) };
}

function coupon(value: unknown): PromotionGiftCoupon {
  const row = object(value);
  shape(row, ['aux_id', 'issue_id', 'title', 'price', 'min_price', 'type', 'day', 'use_start_time', 'use_end_time']);
  const type = integer(row.type);
  if (type !== 1 && type !== 2) throw fail();
  const day = integer(row.day, 0, 36500);
  const start = row.use_start_time === null ? null : integer(row.use_start_time, 0);
  const end = row.use_end_time === null ? null : integer(row.use_end_time, 0);
  if ((day === 0 && (start === null || end === null || start > end))
    || (day > 0 && (start !== null || end !== null))) throw fail();
  return { aux_id: integer(row.aux_id), issue_id: integer(row.issue_id), title: string(row.title, 64),
    price: money(row.price), min_price: money(row.min_price), type, day,
    use_start_time: start, use_end_time: end };
}

function product(value: unknown): PromotionGiftProduct {
  const row = object(value);
  shape(row, ['aux_id', 'product_id', 'sku_id', 'unique', 'quantity', 'cart_id']);
  if (typeof row.cart_id !== 'string' || !/^[1-9]\d{0,9}$/.test(row.cart_id)
    || Number(row.cart_id) > 2_147_483_647) throw fail();
  return { aux_id: integer(row.aux_id), product_id: integer(row.product_id), sku_id: integer(row.sku_id),
    unique: string(row.unique, 8), quantity: integer(row.quantity), cart_id: string(row.cart_id, 50) };
}

function campaign(value: unknown): PromotionGiftCampaign {
  const row = object(value);
  shape(row, ['id', 'tier_id', 'name', 'label_id', 'eligible_cart_ids', 'threshold_type', 'threshold',
    'repetitions', 'give_integral', 'coupons', 'products']);
  const labels = array(row.label_id, 100).map(id => integer(id));
  const eligible = array(row.eligible_cart_ids, 200).map(id => string(id, 50));
  const coupons = array(row.coupons, 100).map(coupon);
  const products = array(row.products, 100).map(product);
  const thresholdType = integer(row.threshold_type);
  if ((thresholdType !== 1 && thresholdType !== 2) || !eligible.length
    || !/^(?:0|[1-9]\d{0,9})(?:\.\d{2})?$/.test(String(row.threshold))
    || Number(row.threshold) <= 0) throw fail();
  unique(labels); unique(eligible);
  unique(coupons.map(item => item.aux_id));
  unique(products.map(item => item.aux_id));
  unique(products.map(item => item.cart_id));
  const points = integer(row.give_integral, 0);
  if (!points && !coupons.length && !products.length) throw fail();
  return { id: integer(row.id), tier_id: integer(row.tier_id), name: string(row.name, 255), label_id: labels,
    eligible_cart_ids: eligible, threshold_type: thresholdType as 1 | 2, threshold: string(row.threshold, 32),
    repetitions: integer(row.repetitions), give_integral: points, coupons, products };
}

/** Strictly read a new gift contract. Other known snapshot versions return null
 * so legacy evidence cannot accidentally inherit this refund/payment policy. */
export function readOrderPromotionGiftIntent(value: string | null): OrderPromotionGiftIntent | null {
  if (value === null || value === '' || value === 'null') return null;
  if (new TextEncoder().encode(value).length > 65536) throw fail();
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw fail(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  if (row.version !== ORDER_PROMOTION_GIFT_VERSION) return null;
  shape(row, ['version', 'price_promotions', 'promotions']);
  const price = array(row.price_promotions, 600).map(label);
  const promotions = array(row.promotions, 100).map(campaign);
  if (!promotions.length) throw fail();
  unique(price.map(item => item.id));
  unique(promotions.map(item => item.id));
  unique(promotions.flatMap(item => item.coupons.map(coupon => coupon.issue_id)));
  unique(promotions.flatMap(item => item.products.map(product => product.cart_id)));
  const paidIds = new Set(promotions.flatMap(item => item.eligible_cart_ids));
  if (promotions.some(item => item.products.some(product => paidIds.has(product.cart_id)))) throw fail();
  return { version: ORDER_PROMOTION_GIFT_VERSION, price_promotions: price, promotions };
}
