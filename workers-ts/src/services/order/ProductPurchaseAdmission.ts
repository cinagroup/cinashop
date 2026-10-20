import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeProduct } from '@/models/schema';
import { ValidateException } from '@/utils/errors';

type Query = Pick<DbClient, 'execute'>;
export type ProductLimitConfig = Pick<typeof storeProduct.$inferSelect, 'isLimit' | 'limitType' | 'limitNum'>;
export type ProductPurchaseLimits = { mode: 'none'; quantity: null }
  | { mode: 'per_order' | 'cumulative'; quantity: number };

/** Configuration is not a user's remaining allowance. In particular, retained
 * roots without historical coverage cannot authorize cumulative purchases. */
export function productPurchaseLimits(product: ProductLimitConfig): ProductPurchaseLimits {
  if (product.isLimit === 0) return { mode: 'none', quantity: null };
  if (product.isLimit !== 1 || ![1, 2].includes(product.limitType)
    || !Number.isSafeInteger(product.limitNum) || product.limitNum < 1 || product.limitNum > 2147483647) {
    throw new ValidateException('商品限购配置无效');
  }
  return { mode: product.limitType === 1 ? 'per_order' : 'cumulative', quantity: product.limitNum };
}

export function assertProductPurchaseQuantity(product: ProductLimitConfig, quantity: number): void {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 2147483647)
    throw new ValidateException('商品购买件数无法核对');
  const limits = productPurchaseLimits(product);
  if (limits.mode === 'cumulative')
    throw new ValidateException('累计限购历史尚无法完整核验，请重新选择商品');
  if (limits.mode === 'per_order' && quantity > limits.quantity)
    throw new ValidateException(`该商品单次购买不能超过${limits.quantity}件`);
}

/** All selected SKU rows for one base product belong to the same purchase. */
export function assertProductPurchaseBatch(lines: readonly {
  product: ProductLimitConfig & { id: number }; quantity: number;
}[]): void {
  const totals = new Map<number, { product: ProductLimitConfig; quantity: number }>();
  for (const line of lines) {
    if (!Number.isSafeInteger(line.product.id) || line.product.id < 1
      || !Number.isSafeInteger(line.quantity) || line.quantity < 1)
      throw new ValidateException('商品购买件数无法核对');
    const previous = totals.get(line.product.id);
    if (previous && JSON.stringify(productPurchaseLimits(previous.product)) !== JSON.stringify(productPurchaseLimits(line.product)))
      throw new ValidateException('商品限购配置已变化，请重新确认');
    totals.set(line.product.id, { product: line.product, quantity: (previous?.quantity ?? 0) + line.quantity });
  }
  for (const row of totals.values()) assertProductPurchaseQuantity(row.product, row.quantity);
}

/** Pin only active rules. Disabled legacy limit_type/limit_num do not price or
 * authorize the purchase and need not invalidate an otherwise current quote. */
export function productPurchaseQuoteGuard(product: ProductLimitConfig): SQL {
  productPurchaseLimits(product);
  return and(eq(storeProduct.isLimit, product.isLimit), product.isLimit === 1
    ? and(eq(storeProduct.limitType, product.limitType), eq(storeProduct.limitNum, product.limitNum)) : undefined)!;
}

export interface ProductCartScope {
  uid: number; productId: number; type: number;
  staffId?: number; touristUid?: string; excludeCartId?: number;
}

/** Reusable baskets are scoped to their actual actor/target and purchase type.
 * Paid rows and old direct-buy intents are not this purchase's selected units. */
export async function readReusableProductQuantity(db: Query, scope: ProductCartScope): Promise<number> {
  const [row] = await db.execute(sql`SELECT COALESCE(SUM(cart_num),0)::text AS quantity,
    COALESCE(bool_and(cart_num BETWEEN 1 AND 32767),true) AS valid
    FROM store_cart WHERE uid=${scope.uid} AND product_id=${scope.productId} AND type=${scope.type}
      AND staff_id=${scope.staffId ?? 0} AND tourist_uid=${scope.touristUid ?? ''} AND store_id=0
      AND is_new=0 AND is_pay=0 AND is_del=0 AND status=1
      ${scope.excludeCartId === undefined ? sql`` : sql`AND id<>${scope.excludeCartId}`}`);
  if (!row || row.valid !== true || typeof row.quantity !== 'string' || !/^(0|[1-9]\d{0,9})$/.test(row.quantity)
    || Number(row.quantity) > 2147483647) throw new ValidateException('购物车商品件数无法核对');
  return Number(row.quantity);
}

export async function assertProductCartQuantity(db: Query, product: ProductLimitConfig & { id: number },
  quantity: number, scope: Omit<ProductCartScope, 'productId'> & { isNew: number }): Promise<void> {
  const limits = productPurchaseLimits(product);
  if (limits.mode === 'none') return;
  const existing = scope.isNew === 0
    ? await readReusableProductQuantity(db, { ...scope, productId: product.id }) : 0;
  assertProductPurchaseQuantity(product, existing + quantity);
}

/** Used before normal reusable-cart reads/writes; checkout still independently
 * aggregates selected rows and pins the product rules at its inventory write. */
export async function lockProductCartScope(tx: Query, scope: ProductCartScope): Promise<void> {
  if (![scope.uid, scope.staffId ?? 0].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 2147483647)
    || !Number.isSafeInteger(scope.productId) || scope.productId < 1 || scope.productId > 2147483647
    || !Number.isSafeInteger(scope.type) || scope.type < 0 || scope.type > 8)
    throw new ValidateException('购物车归属无效');
  if (Object.hasOwn(tx, '$client')) throw Error('Product cart admission requires a caller-owned transaction');
  const [mode] = await tx.execute(sql`SELECT current_setting('transaction_isolation') AS isolation`);
  if (mode?.isolation !== 'read committed') throw new ValidateException('购物车限购须在独立事务中重新核对');
  const key = `cinashop:product-cart:${scope.uid}:${scope.staffId ?? 0}:${scope.touristUid ?? ''}:${scope.productId}:${scope.type}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key},0::bigint))`);
}
