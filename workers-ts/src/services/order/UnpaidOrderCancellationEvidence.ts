import type { storeOrder, storeOrderCartInfo } from '@/models/schema';
import { ValidateException } from '@/utils/errors';
import { readOrderPromotionGiftIntent } from '@/services/activity/OrderPromotionGiftSnapshot';

type Order = Pick<typeof storeOrder.$inferSelect, 'id' | 'uid' | 'type' | 'cartId' | 'totalNum' | 'refundStatus' | 'refundType' | 'useIntegral'>
  & Partial<Pick<typeof storeOrder.$inferSelect, 'promotionsGive'>>;
type Line = Pick<typeof storeOrderCartInfo.$inferSelect, 'id' | 'oid' | 'uid' | 'cartId' | 'oldCartId' | 'productId'
  | 'skuUnique' | 'cartNum' | 'refundNum' | 'splitStatus' | 'splitSurplusNum' | 'surplusNum' | 'isWriteoff' | 'cartInfo'>
  & Partial<Pick<typeof storeOrderCartInfo.$inferSelect, 'isGift'>>;
export interface UnpaidCancellationLines {
  /** Structural validation only: neither a durable cancellation receipt nor quota release authority. */
  version: 'unpaid-cancellation-lines-v1';
  modern: boolean;
  products: Array<{ productId: number; quantity: number }>;
  cartIds: number[];
}
const invalid = (): never => { throw new ValidateException('取消订单数量或归属凭据不一致，请核对订单'); };
function positive(value: number): number {
  return Number.isSafeInteger(value) && value > 0 && value <= 2147483647 ? value : invalid();
}
function cartId(value: string): number {
  return /^[1-9]\d{0,9}$/.test(value) ? positive(Number(value)) : invalid();
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
}

/** Called while holding the unpaid order and its original line locks, BEFORE
 * resource compensation. Never recompute purchase quantities from mutable live
 * product/SKU/cart rows. Valid legacy snapshots remain cancellable, but are not
 * promoted to modern proof for a future quota ledger. Unknown versions fail. */
export function verifyUnpaidCancellationLines(order: Order, lines: readonly Line[]): UnpaidCancellationLines {
  positive(order.id); positive(order.totalNum);
  // Guest assisted orders use uid=0 and can be closed by scheduled maintenance.
  if (!Number.isSafeInteger(order.uid) || order.uid < 0 || order.uid > 2147483647
    || !Number.isSafeInteger(order.type) || order.type < 0 || order.type > 8
    || order.refundStatus !== 0 || order.refundType !== 0 || !lines.length || lines.length > 200
    || typeof order.cartId !== 'string' || order.cartId.length > 2199) return invalid();
  const claimed = order.cartId.split(',').map(cartId), claims = new Set(claimed);
  const intent = readOrderPromotionGiftIntent(order.promotionsGive ?? null);
  const giftProducts = intent?.promotions.flatMap(campaign => campaign.products.map(product => ({ campaign, product }))) ?? [];
  const expectedGifts = new Map(giftProducts.map(gift => [gift.product.cart_id, gift]));
  const purchasedClaims = claimed.filter(id => !expectedGifts.has(String(id)));
  if (expectedGifts.size !== giftProducts.length || claimed.length !== lines.length
    || claims.size !== claimed.length || (expectedGifts.size && order.type !== 0)
    || giftProducts.some(gift => !claims.has(cartId(gift.product.cart_id)))) return invalid();
  const seen = new Set<number>(), rows = new Set<number>(), products = new Map<number, number>();
  let total = 0, modernCount = 0, points = 0, bytes = 0;
  for (const line of lines) {
    positive(line.id); positive(line.productId); positive(line.cartNum);
    const gift = line.isGift === 1 ? expectedGifts.get(line.cartId) : undefined;
    if ((line.isGift === 1 && (!gift || !claims.has(cartId(line.cartId))))
      || (line.isGift !== 1 && (!claims.has(cartId(line.cartId)) || expectedGifts.has(line.cartId)))) return invalid();
    const id = line.isGift === 1 ? null : cartId(line.cartId);
    if (line.oid !== order.id || line.uid !== order.uid || line.oldCartId !== '' || line.cartNum > 32767
      || rows.has(line.id) || (id !== null && seen.has(id)) || line.refundNum !== 0 || line.splitStatus !== 0
      || line.splitSurplusNum !== line.cartNum || line.surplusNum !== line.cartNum || line.isWriteoff !== 0
      || typeof line.cartInfo !== 'string' || line.cartInfo.length > 65536) return invalid();
    const lineBytes = new TextEncoder().encode(line.cartInfo).byteLength;
    if (lineBytes > 65536) return invalid();
    bytes += lineBytes;
    if (bytes > 8388608) return invalid();
    let parsed: unknown;
    try { parsed = JSON.parse(line.cartInfo); } catch { return invalid(); }
    const info = object(parsed), modern = Object.hasOwn(info, 'financial_version');
    if (modern) {
      if (info.financial_version !== 'checkout-line-finance-v1') return invalid();
      modernCount++;
      const sku = object(info.sku);
      // Older activity clients retain the ACTIVITY unique in the cart while the
      // frozen sku is the BASE SKU. Either exact frozen identity is legitimate.
      const activityUnique = [1, 2, 3].includes(order.type) && info.activitySku !== null && info.activitySku !== undefined
        ? object(info.activitySku).unique : undefined;
      if (info.id !== line.cartId || info.cart_num !== line.cartNum || object(info.product).id !== line.productId
        || (sku.unique !== line.skuUnique && activityUnique !== line.skuUnique) || typeof sku.id !== 'number'
        || Object.hasOwn(info, 'refund_order_generation')
        || typeof info.use_integral !== 'string' || !/^(0|[1-9]\d{0,9})$/.test(info.use_integral)) return invalid();
      positive(sku.id as number);
      if (gift) {
        const marker = object(info.promotion_gift);
        const zeroMoney = ['sum_price', 'vip_truePrice', 'member_postage_price',
          'member_coupon_price', 'raw_postage_price', 'postage_price',
          'coupon_price', 'integral_price', 'first_order_price', 'sum_true_price',
          'promotions_true_price', 'one_brokerage', 'two_brokerage',
          'division_staff_brokerage', 'division_agent_brokerage',
          'division_brokerage'];
        if (gift.product.product_id !== line.productId || gift.product.unique !== line.skuUnique
          || gift.product.sku_id !== sku.id || gift.product.quantity !== line.cartNum
          || Object.keys(marker).sort().join(',') !== 'aux_id,root_id,tier_id,version'
          || marker.version !== 'order-promotion-gifts-v1' || marker.root_id !== gift.campaign.id
          || marker.tier_id !== gift.campaign.tier_id || marker.aux_id !== gift.product.aux_id
          || info.use_integral !== '0' || info.sum_true_price !== '0.00'
          || info.gain_integral !== '0'
          || zeroMoney.some(field => info[field] !== '0.00')) return invalid();
      } else if (Object.hasOwn(info, 'promotion_gift')) return invalid();
      points += Number(info.use_integral);
    } else {
      if (gift) return invalid();
      // Legacy evidence may omit these fields; if present it must still agree.
      if ((Object.hasOwn(info, 'id') && info.id !== line.cartId)
        || (Object.hasOwn(info, 'cart_num') && info.cart_num !== line.cartNum)
        || (Object.hasOwn(info, 'product') && object(info.product).id !== line.productId)
        || Object.hasOwn(info, 'refund_order_generation')) return invalid();
    }
    rows.add(line.id); if (id !== null) seen.add(id); total += line.cartNum;
    if (!gift) products.set(line.productId, (products.get(line.productId) ?? 0) + line.cartNum);
  }
  if (total !== order.totalNum || seen.size !== purchasedClaims.length
    || (modernCount !== 0 && modernCount !== lines.length)) return invalid();
  if (modernCount && (!/^(0|[1-9]\d{0,9})\.00$/.test(order.useIntegral) || Number(order.useIntegral) !== points)) return invalid();
  return { version: 'unpaid-cancellation-lines-v1', modern: modernCount === lines.length,
    products: [...products].sort(([a], [b]) => a - b).map(([productId, quantity]) => ({ productId, quantity })),
    cartIds: [...seen].sort((a, b) => a - b) };
}
