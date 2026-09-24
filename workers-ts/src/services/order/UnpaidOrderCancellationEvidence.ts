import type { storeOrder, storeOrderCartInfo } from '@/models/schema';
import { ValidateException } from '@/utils/errors';

type Order = Pick<typeof storeOrder.$inferSelect, 'id' | 'uid' | 'type' | 'cartId' | 'totalNum' | 'refundStatus' | 'refundType' | 'useIntegral'>;
type Line = Pick<typeof storeOrderCartInfo.$inferSelect, 'id' | 'oid' | 'uid' | 'cartId' | 'oldCartId' | 'productId'
  | 'skuUnique' | 'cartNum' | 'refundNum' | 'splitStatus' | 'splitSurplusNum' | 'surplusNum' | 'isWriteoff' | 'cartInfo'>;
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
  if (claimed.length !== lines.length || claims.size !== claimed.length) return invalid();
  const seen = new Set<number>(), rows = new Set<number>(), products = new Map<number, number>();
  let total = 0, modernCount = 0, points = 0, bytes = 0;
  for (const line of lines) {
    positive(line.id); positive(line.productId); positive(line.cartNum);
    const id = cartId(line.cartId);
    if (line.oid !== order.id || line.uid !== order.uid || line.oldCartId !== '' || line.cartNum > 32767
      || rows.has(line.id) || seen.has(id) || !claims.has(id) || line.refundNum !== 0 || line.splitStatus !== 0
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
      points += Number(info.use_integral);
    } else {
      // Legacy evidence may omit these fields; if present it must still agree.
      if ((Object.hasOwn(info, 'id') && info.id !== line.cartId)
        || (Object.hasOwn(info, 'cart_num') && info.cart_num !== line.cartNum)
        || (Object.hasOwn(info, 'product') && object(info.product).id !== line.productId)
        || Object.hasOwn(info, 'refund_order_generation')) return invalid();
    }
    rows.add(line.id); seen.add(id); total += line.cartNum;
    products.set(line.productId, (products.get(line.productId) ?? 0) + line.cartNum);
  }
  if (total !== order.totalNum || (modernCount !== 0 && modernCount !== lines.length)) return invalid();
  if (modernCount && (!/^(0|[1-9]\d{0,9})\.00$/.test(order.useIntegral) || Number(order.useIntegral) !== points)) return invalid();
  return { version: 'unpaid-cancellation-lines-v1', modern: modernCount === lines.length,
    products: [...products].sort(([a], [b]) => a - b).map(([productId, quantity]) => ({ productId, quantity })),
    cartIds: [...seen].sort((a, b) => a - b) };
}
