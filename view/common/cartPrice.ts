import type { CheckoutCartItem } from './checkoutSelection';
import { quoteMoney } from './checkoutQuote';
import { normalizeSkuMembershipPrice } from './skuMembershipPrice';

/** Server-calculated goods subtotal, before shipping and checkout-only discounts. */
export interface CartPrice {
  truePrice?: string;
  trueSumPrice?: string;
  priceType?: '' | 'level' | 'member' | 'promotions';
  levelName?: string;
  promotion?: CartPromotion | null;
}
export interface CartPromotionSegment {
  quantity: number;
  totalPriceCents: number;
  unitPriceCents: number | null;
  promotionIds: number[];
}
export interface CartPromotion {
  unitPriceCents: number | null;
  totalPriceCents: number;
  promotionSavingsCents: number;
  segments: CartPromotionSegment[];
}
export type CartDisplayItem = CheckoutCartItem & CartPrice & { activityId?: number; bargainUserId?: number };
const cents = (value: unknown) => BigInt(quoteMoney(value).replace('.', ''));
const format = (value: bigint) => `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
const integer = (value: unknown, min: number, max = 2147483647): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const moneyCents = (value: number) => format(BigInt(value));
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('购物车商品响应无效');
  return value as Record<string, unknown>;
}
function normalizePromotion(value: unknown, row: Record<string, unknown>, totalPrice: string): CartPromotion {
  const quote = record(value), quantity = row.cartNum as number, totalPriceCents = Number(cents(totalPrice));
  if (quote.key !== row.id && String(quote.key) !== String(row.id) || quote.productId !== row.productId
    || quote.quantity !== quantity || !integer(quote.totalPriceCents, 0, Number.MAX_SAFE_INTEGER)
    || quote.totalPriceCents !== totalPriceCents || !integer(quote.promotionSavingsCents, 0, Number.MAX_SAFE_INTEGER)
    || !Array.isArray(quote.segments) || !quote.segments.length || quote.segments.length > 100) throw Error('购物车活动报价不完整');
  const unitPriceCents = quote.unitPriceCents;
  if (unitPriceCents !== null && !integer(unitPriceCents, 0, Number.MAX_SAFE_INTEGER)) throw Error('购物车活动单价无效');
  const segments = quote.segments.map(value => {
    const segment = record(value);
    if (!integer(segment.quantity, 1, quantity) || !integer(segment.totalPriceCents, 0, Number.MAX_SAFE_INTEGER)
      || segment.unitPriceCents !== null && !integer(segment.unitPriceCents, 0, Number.MAX_SAFE_INTEGER)
      || !Array.isArray(segment.promotionIds) || segment.promotionIds.some(id => !integer(id, 1))) throw Error('购物车活动分段无效');
    if (segment.unitPriceCents !== null && BigInt(segment.unitPriceCents) * BigInt(segment.quantity) !== BigInt(segment.totalPriceCents)) throw Error('购物车活动分段金额不一致');
    return { quantity: segment.quantity, totalPriceCents: segment.totalPriceCents,
      unitPriceCents: segment.unitPriceCents, promotionIds: [...segment.promotionIds] } as CartPromotionSegment;
  });
  if (segments.reduce((sum, segment) => sum + segment.quantity, 0) !== quantity
    || segments.reduce((sum, segment) => sum + BigInt(segment.totalPriceCents), 0n) !== BigInt(totalPriceCents)
    || unitPriceCents !== null && BigInt(unitPriceCents) * BigInt(quantity) !== BigInt(totalPriceCents)) throw Error('购物车活动合计不一致');
  const displayCents = Number(cents(row.truePrice));
  if (displayCents !== (unitPriceCents ?? Math.floor(totalPriceCents / quantity))) throw Error('购物车展示单价与活动报价不一致');
  return { unitPriceCents, totalPriceCents, promotionSavingsCents: quote.promotionSavingsCents, segments };
}

/** Validate reusable owner-scoped list; direct-buy remains the checkout adapter's responsibility. */
export function normalizeCartList(value: unknown): CartDisplayItem[] {
  if (!Array.isArray(value)) throw Error('购物车列表响应无效');
  const seen = new Set<number>(); let total = 0n;
  return value.map(entry => {
    const row = record(entry);
    if (!integer(row.id, 1) || seen.has(row.id) || !integer(row.productId, 1)
      || !integer(row.cartNum, 0, 32767) || !integer(row.type, 0, 8) || row.isNew !== 0 || typeof row.isValid !== 'boolean') throw Error('购物车商品或购买模式无效');
    seen.add(row.id);
    const identity: { activityId?: number; bargainUserId?: number } = {};
    for (const key of ['activityId', 'bargainUserId'] as const) {
      if (row[key] !== undefined) {
        if (!integer(row[key], 0)) throw Error('购物车活动标识无效');
        identity[key] = row[key];
      }
    }
    const base = { id: row.id, productId: row.productId, cartNum: row.cartNum, type: row.type, isNew: 0,
      unique: typeof row.unique === 'string' ? row.unique : '', ...identity, checked: false };
    if (!row.isValid) return { ...base, isValid: false, productInfo: null, sumPrice: '' };
    const p = record(row.productInfo);
    if (!base.unique || !row.cartNum || typeof p.storeName !== 'string' || typeof p.image !== 'string'
      || typeof p.suk !== 'string' || !integer(p.stock, row.cartNum) || !integer(p.systemFormId, 0) || !integer(p.productType, 0)) throw Error('购物车商品详情无效');
    const price = quoteMoney(p.price), sumPrice = quoteMoney(row.sumPrice);
    if (cents(sumPrice) !== cents(price) * BigInt(row.cartNum)) throw Error('购物车原价小计不一致');
    const supplied = ['truePrice', 'trueSumPrice', 'priceType', 'levelName', 'promotion'].some(key => row[key] !== undefined);
    let quote: CartPrice = {};
    if (supplied) {
      if (typeof row.truePrice !== 'string' || typeof row.trueSumPrice !== 'string') throw Error('购物车报价不完整');
      const truePrice = quoteMoney(row.truePrice), trueSumPrice = quoteMoney(row.trueSumPrice);
      if (cents(trueSumPrice) > cents(sumPrice)) throw Error('购物车报价高于原价');
      if (row.promotion !== undefined && row.promotion !== null) {
        const promotion = normalizePromotion(row.promotion, row, trueSumPrice);
        if (row.priceType === 'promotions') {
          if (!promotion.promotionSavingsCents) throw Error('购物车活动优惠标识不一致');
          quote = { truePrice, trueSumPrice, priceType: 'promotions', levelName: '', promotion };
        } else {
          const normalized = normalizeSkuMembershipPrice({ price, member_price: truePrice, price_type: row.priceType, level_name: row.levelName });
          if (promotion.promotionSavingsCents) throw Error('购物车活动优惠标识不一致');
          quote = { truePrice: normalized.member_price, trueSumPrice, priceType: normalized.price_type, levelName: normalized.level_name, promotion };
        }
      } else {
        const normalized = normalizeSkuMembershipPrice({ price, member_price: truePrice, price_type: row.priceType, level_name: row.levelName });
        const unit = normalized.member_price;
        if (!unit || cents(trueSumPrice) !== cents(unit) * BigInt(row.cartNum)) throw Error('购物车小计不一致');
        quote = { truePrice: unit, trueSumPrice, priceType: normalized.price_type, levelName: normalized.level_name };
      }
    }
    total += cents(quote.trueSumPrice ?? sumPrice);
    if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('购物车合计超出安全范围');
    return { ...base, ...quote, isValid: true, sumPrice,
      productInfo: { storeName: p.storeName, image: p.image, price, stock: p.stock, otPrice: quoteMoney(p.otPrice), suk: p.suk,
        systemFormId: p.systemFormId, productType: p.productType, ...(integer(p.integral, 0) ? { integral: p.integral } : {}) } };
  });
}
export function cartUnitPrice(item: CartDisplayItem): string { return item.truePrice ?? item.productInfo?.price ?? ''; }
export function cartLinePrice(item: CartDisplayItem): string { return item.trueSumPrice ?? item.sumPrice; }
export function cartPriceLabel(item: CartPrice): string {
  return item.priceType === 'promotions' ? item.promotion?.unitPriceCents === null ? '活动分段计价' : '活动价'
    : item.priceType === 'level' ? `${item.levelName || '会员'}价` : item.priceType === 'member' ? 'SVIP价' : '';
}
export function cartPromotionSummary(item: CartPrice): string {
  const parts = item.promotion?.segments;
  if (!parts || parts.length < 2 || !item.promotion?.promotionSavingsCents) return '';
  return parts.map(part => `${part.promotionIds.length ? '活动' : '其余'} ${part.quantity} 件 ¥${moneyCents(part.totalPriceCents)}`).join('，');
}
export function cartTotal(items: readonly CartDisplayItem[]): string {
  const sum = items.filter(row => row.checked && row.isValid).reduce((sum, row) => sum + cents(cartLinePrice(row)), 0n);
  if (sum > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('购物车合计超出安全范围');
  return format(sum);
}
