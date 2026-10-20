import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { ValidateException } from '@/utils/errors';

type Query = Pick<DbClient, 'execute'>;
export function integralPurchaseLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= -1 && value <= 2147483647;
}
function quantity(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 32767) throw new ValidateException('兑换数量须为1至32767的整数');
}
function scope(buyerId: number, activityId: number): void {
  if (![buyerId, activityId].every(value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647))
    throw new ValidateException('积分购买归属无效');
}
export function assertIntegralOnceLimit(limit: unknown, requested: number): void {
  quantity(requested);
  if (!integralPurchaseLimit(limit)) throw new ValidateException('积分购买上限配置无效');
  if (limit !== -1 && requested > limit) throw new ValidateException(`每个订单限购 ${limit} 件`);
}
export function assertIntegralTotalLimit(limit: unknown, requested: number, purchased: bigint): void {
  quantity(requested);
  if (!integralPurchaseLimit(limit) || purchased < 0n) throw new ValidateException('积分购买上限配置无效');
  if (limit !== -1 && purchased + BigInt(requested) > BigInt(limit)) throw new ValidateException(`每人累计限购 ${limit} 件`);
}

/** The PHP activity count is retained paid roots plus undeleted unpaid roots.
 * It includes hidden paid/refunded roots, excludes fulfillment children, and
 * does not release units on refund. This is not product lifetime coverage or
 * the separate original-unit/refund-lineage quota projection. */
export async function readIntegralPurchasedQuantity(db: Query, buyerId: number, activityId: number): Promise<bigint> {
  scope(buyerId, activityId);
  const [row] = await db.execute(sql`SELECT COALESCE(SUM(total_num),0)::text AS purchased
    FROM store_order WHERE uid=${buyerId} AND type=4 AND activity_id=${activityId}
      AND pid IN (0,-1) AND (paid=1 OR (paid=0 AND is_del=0))`);
  if (!row || typeof row.purchased !== 'string' || !/^(0|[1-9]\d{0,18})$/.test(row.purchased))
    throw new ValidateException('积分累计购买数量无法核对');
  return BigInt(row.purchased);
}

/** Both actual order authors acquire this before user/cart/inventory locks.
 * READ COMMITTED is necessary: after waiting, a later count statement must
 * see the preceding author's committed order, rather than an older snapshot.
 * Callers still lock/compare current activity rules and write in this same tx. */
export async function lockIntegralPurchaseScope(tx: Query, buyerId: number, activityId: number): Promise<void> {
  scope(buyerId, activityId);
  if (Object.hasOwn(tx, '$client')) throw Error('Integral admission requires a caller-owned transaction');
  const [mode] = await tx.execute(sql`SELECT current_setting('transaction_isolation') AS isolation`);
  if (mode?.isolation !== 'read committed') throw new ValidateException('积分购买须在独立事务中重新核对');
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`cinashop:integral-order:${buyerId}:${activityId}`},0::bigint))`);
}
