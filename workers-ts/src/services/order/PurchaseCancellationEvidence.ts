import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { ValidateException } from '@/utils/errors';
import { verifyPurchaseOriginEvidence, type PurchaseOriginEvidence, type PurchaseOriginScope } from './PurchaseOriginEvidence';

export interface PurchaseCancellationEvidence {
  version: 'purchase-cancellation-v1';
  origin: PurchaseOriginEvidence;
  /** The cancellation transition's database wall-clock time, not a quota release decision. */
  cancelledAtMillis: number;
}
const invalid = (): never => { throw new ValidateException('取消购买凭据不一致，请核对订单'); };

/** Only consume the protected database projection. Never accept this as an HTTP
 * claim, infer it from live order status, or use it as available quota. The
 * candidate schema is not registered/commissioned in production yet. */
export function verifyPurchaseCancellationEvidence(value: unknown, expected: PurchaseOriginScope): PurchaseCancellationEvidence {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const row = value as Record<string, unknown>;
  if (row.version !== 'purchase-cancellation-v1' || typeof row.cancelledAtMillis !== 'number'
    || !Number.isSafeInteger(row.cancelledAtMillis) || row.cancelledAtMillis <= 0) return invalid();
  const origin = verifyPurchaseOriginEvidence({ version: 'purchase-origin-v1', orderId: row.orderId,
    buyerId: row.buyerId, orderType: row.orderType, totalNum: row.totalNum, usedPoints: row.restoredPoints,
    lines: row.lines }, expected);
  return { version: 'purchase-cancellation-v1', origin, cancelledAtMillis: row.cancelledAtMillis };
}

export async function readPurchaseCancellationEvidence(tx: Pick<DbClient, 'execute'>,
  expected: PurchaseOriginScope): Promise<PurchaseCancellationEvidence | null> {
  if (!Number.isSafeInteger(expected.orderId) || expected.orderId <= 0 || expected.orderId > 2147483647
    || !Number.isSafeInteger(expected.buyerId) || expected.buyerId < 0 || expected.buyerId > 2147483647) return invalid();
  if (Object.hasOwn(tx, '$client')) throw new Error('Purchase cancellation requires a caller-owned transaction');
  const rows = await tx.execute(sql`SELECT order_id AS "orderId", buyer_id AS "buyerId", version,
    order_type AS "orderType", total_num AS "totalNum", restored_points::double precision AS "restoredPoints",
    CASE WHEN octet_length(lines::text)<=131072 THEN lines ELSE NULL END AS lines,
    floor(extract(epoch FROM cancelled_at)*1000)::double precision AS "cancelledAtMillis"
    FROM public.store_order_purchase_cancellation WHERE order_id=${expected.orderId}`);
  return rows.length ? verifyPurchaseCancellationEvidence(rows[0], expected) : null;
}
