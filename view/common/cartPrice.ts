import type { CheckoutCartItem } from './checkoutSelection';
import { quoteMoney } from './checkoutQuote';
import { normalizeSkuMembershipPrice } from './skuMembershipPrice';

/** Membership-only catalogue quote, never an order receipt or shipping/coupon total. */
export interface CartPrice {
  truePrice?: string;
  trueSumPrice?: string;
  priceType?: '' | 'level' | 'member';
  levelName?: string;
}
export type CartDisplayItem = CheckoutCartItem & CartPrice & { activityId?: number; bargainUserId?: number };
const cents = (value: unknown) => BigInt(quoteMoney(value).replace('.', ''));
const format = (value: bigint) => `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
const integer = (value: unknown, min: number, max = 2147483647): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('购物车商品响应无效');
  return value as Record<string, unknown>;
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
    const supplied = ['truePrice', 'trueSumPrice', 'priceType', 'levelName'].some(key => row[key] !== undefined);
    let quote: CartPrice = {};
    if (supplied) {
      if (typeof row.truePrice !== 'string' || typeof row.trueSumPrice !== 'string') throw Error('购物车会员报价不完整');
      const normalized = normalizeSkuMembershipPrice({ price, member_price: row.truePrice, price_type: row.priceType, level_name: row.levelName });
      const unit = normalized.member_price;
      if (!unit || cents(row.trueSumPrice) !== cents(unit) * BigInt(row.cartNum)) throw Error('购物车会员小计不一致');
      quote = { truePrice: unit, trueSumPrice: quoteMoney(row.trueSumPrice), priceType: normalized.price_type, levelName: normalized.level_name };
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
  return item.priceType === 'level' ? `${item.levelName || '会员'}价` : item.priceType === 'member' ? 'SVIP价' : '';
}
export function cartTotal(items: readonly CartDisplayItem[]): string {
  const sum = items.filter(row => row.checked && row.isValid).reduce((sum, row) => sum + cents(cartLinePrice(row)), 0n);
  if (sum > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('购物车合计超出安全范围');
  return format(sum);
}
