import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { ValidateException } from '@/utils/errors';

type Query = Pick<DbClient, 'execute'>;
export interface PurchaseOriginScope { orderId: number; buyerId: number }
export interface PurchaseOriginEvidence extends PurchaseOriginScope {
  version: 'purchase-origin-v1'; orderType: number; totalNum: number; usedPoints: number;
  lines: Array<{ rowId: number; cartId: string; productId: number; skuId: number; skuUnique: string;
    quantity: number; usedPoints: number }>;
}
const invalid = (): never => { throw new ValidateException('原始购买数量凭据不一致，请核对订单'); };
function integer(value: unknown, min = 0, max = 2147483647): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : invalid();
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
}
function scope(expected: PurchaseOriginScope) { integer(expected.orderId, 1); integer(expected.buyerId); }

/** Only a projection from the append-only database relation, never HTTP input.
 * Counts original products once. This is NOT a payment/cancellation/refund
 * receipt, remaining allowance, quota reservation, or proof of legacy history. */
export function verifyPurchaseOriginEvidence(value: unknown, expected: PurchaseOriginScope): PurchaseOriginEvidence {
  scope(expected);
  const row = object(value);
  if (row.version !== 'purchase-origin-v1' || row.orderId !== expected.orderId || row.buyerId !== expected.buyerId
    || !Array.isArray(row.lines) || !row.lines.length || row.lines.length > 200) return invalid();
  const rows = new Set<number>(), carts = new Set<string>();
  const lines = row.lines.map(value => {
    const item = object(value), rowId = integer(item.rowId, 1), productId = integer(item.productId, 1), skuId = integer(item.skuId, 1);
    if (Object.keys(item).length !== 7 || typeof item.cartId !== 'string' || !/^[1-9]\d{0,9}$/.test(item.cartId)
      || rows.has(rowId) || carts.has(item.cartId) || typeof item.skuUnique !== 'string' || item.skuUnique.length > 255) return invalid();
    integer(Number(item.cartId), 1); rows.add(rowId); carts.add(item.cartId);
    return { rowId, productId, skuId, cartId: item.cartId, skuUnique: item.skuUnique,
      quantity: integer(item.quantity, 1, 32767), usedPoints: integer(item.usedPoints, 0, 9999999999) };
  }).sort((a, b) => a.rowId - b.rowId);
  const totalNum = integer(row.totalNum, 1), usedPoints = integer(row.usedPoints, 0, 9999999999);
  if (lines.reduce((sum, item) => sum + item.quantity, 0) !== totalNum
    || lines.reduce((sum, item) => sum + item.usedPoints, 0) !== usedPoints) return invalid();
  return { version: 'purchase-origin-v1', ...expected, orderType: integer(row.orderType, 0, 8), totalNum, usedPoints, lines };
}

export async function readPurchaseOriginEvidence(tx: Query, expected: PurchaseOriginScope): Promise<PurchaseOriginEvidence | null> {
  scope(expected);
  if (Object.hasOwn(tx, '$client')) throw new Error('Purchase origin requires a caller-owned transaction');
  const rows = await tx.execute(sql`SELECT order_id AS "orderId", buyer_id AS "buyerId", version,
    order_type AS "orderType", total_num AS "totalNum", used_points::double precision AS "usedPoints",
    CASE WHEN octet_length(lines::text)<=131072 THEN lines ELSE NULL END AS lines
    FROM public.store_order_purchase_origin WHERE order_id=${expected.orderId}`);
  return rows.length ? verifyPurchaseOriginEvidence(rows[0], expected) : null;
}

/** Checkout writer: called for a newly inserted root in the actual checkout
 * transaction, after resource claims and before final admission guards/commit.
 * SQL re-reads and locks the original order/lines; callers cannot supply a
 * snapshot. A saved receipt is replayed, not recomputed from later live rows.
 * The SQL proves a consistent active-unpaid snapshot, not that its caller is
 * currently creating the order. StoreOrderCreateService enforces that call
 * site; existing orders must NOT be backfilled without separate provenance.
 * Runtime business writers and DB owners remain trusted, as with existing
 * refund evidence. This does not certify history before capture. */
export async function recordPurchaseOriginEvidence(tx: Query, expected: PurchaseOriginScope): Promise<PurchaseOriginEvidence> {
  const previous = await readPurchaseOriginEvidence(tx, expected);
  if (previous) return previous;
  await tx.execute(sql`INSERT INTO public.store_order_purchase_origin(order_id,buyer_id)
    VALUES (${expected.orderId},${expected.buyerId}) ON CONFLICT(order_id) DO NOTHING`);
  return await readPurchaseOriginEvidence(tx, expected) ?? invalid();
}
