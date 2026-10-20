import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { ValidateException } from '@/utils/errors';
import { verifyPurchaseOriginEvidence, type PurchaseOriginEvidence, type PurchaseOriginScope } from './PurchaseOriginEvidence';

type Query = Pick<DbClient, 'execute'>;
export interface PurchasePhysicalOriginEvidence extends PurchaseOriginScope {
  version: 'purchase-physical-origin-v1'; orderType: number; totalNum: number;
  lines: Array<PurchaseOriginEvidence['lines'][number] & {
    kind: 'charged' | 'gift'; gift: { rootId: number; tierId: number; auxId: number } | null;
  }>;
}
const invalid = (): never => { throw new ValidateException('原始实物购买数量凭据不一致，请核对订单'); };
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
}
function integer(value: unknown, min = 0, max = 2147483647): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : invalid();
}

/** Protected final physical quantities, including promotion gifts. The older
 * origin remains the charged/points contract. Neither receipt certifies old or
 * deleted history, grants allowance or reserves a cumulative purchase quota. */
export function verifyPurchasePhysicalOriginEvidence(value: unknown, charged: PurchaseOriginEvidence): PurchasePhysicalOriginEvidence {
  const origin = verifyPurchaseOriginEvidence(charged, charged), row = object(value);
  if (row.version !== 'purchase-physical-origin-v1' || row.orderId !== origin.orderId || row.buyerId !== origin.buyerId
    || row.orderType !== origin.orderType || !Array.isArray(row.lines) || !row.lines.length || row.lines.length > 200) return invalid();
  const rows = new Set<number>(), carts = new Set<string>();
  const lines = row.lines.map(value => {
    const item = object(value), rowId = integer(item.rowId, 1), productId = integer(item.productId, 1), skuId = integer(item.skuId, 1);
    if (Object.keys(item).length !== 9 || typeof item.cartId !== 'string' || !/^[1-9]\d{0,9}$/.test(item.cartId)
      || rows.has(rowId) || carts.has(item.cartId) || typeof item.skuUnique !== 'string' || item.skuUnique.length > 255
      || !['charged', 'gift'].includes(String(item.kind))) return invalid();
    integer(Number(item.cartId), 1); rows.add(rowId); carts.add(item.cartId);
    const kind = item.kind as 'charged' | 'gift', usedPoints = integer(item.usedPoints, 0, 9999999999);
    let gift: PurchasePhysicalOriginEvidence['lines'][number]['gift'] = null;
    if (kind === 'gift') {
      const marker = object(item.gift);
      if (Object.keys(marker).length !== 3 || usedPoints !== 0) return invalid();
      gift = { rootId: integer(marker.rootId, 1), tierId: integer(marker.tierId, 1), auxId: integer(marker.auxId, 1) };
    } else if (item.gift !== null) return invalid();
    return { rowId, productId, skuId, cartId: item.cartId, skuUnique: item.skuUnique,
      quantity: integer(item.quantity, 1, 32767), usedPoints, kind, gift };
  }).sort((a, b) => a.rowId - b.rowId);
  const totalNum = integer(row.totalNum, 1), paidLines = lines.filter(line => line.kind === 'charged');
  if (lines.reduce((sum, line) => sum + line.quantity, 0) !== totalNum || paidLines.length !== origin.lines.length
    || !paidLines.every((line, index) => {
      const before = origin.lines[index];
      return line.rowId === before.rowId && line.cartId === before.cartId && line.productId === before.productId
        && line.skuId === before.skuId && line.skuUnique === before.skuUnique
        && line.quantity === before.quantity && line.usedPoints === before.usedPoints;
    })) return invalid();
  return { version: 'purchase-physical-origin-v1', orderId: origin.orderId, buyerId: origin.buyerId,
    orderType: origin.orderType, totalNum, lines };
}

export async function readPurchasePhysicalOriginEvidence(tx: Query, charged: PurchaseOriginEvidence): Promise<PurchasePhysicalOriginEvidence | null> {
  const origin = verifyPurchaseOriginEvidence(charged, charged);
  if (Object.hasOwn(tx, '$client')) throw Error('Purchase physical origin requires a caller-owned transaction');
  const rows = await tx.execute(sql`SELECT order_id AS "orderId", buyer_id AS "buyerId", version,
    order_type AS "orderType", total_num AS "totalNum",
    CASE WHEN octet_length(lines::text)<=131072 THEN lines ELSE NULL END AS lines
    FROM public.store_order_purchase_physical_origin WHERE order_id=${origin.orderId}`);
  return rows.length ? verifyPurchasePhysicalOriginEvidence(rows[0], origin) : null;
}

/** New roots only, after gifts and final root quantity are saved, in the same
 * checkout transaction. SQL derives every field from locked rows plus the
 * existing charged origin; callers cannot submit physical purchase snapshots.
 * Replay returns the original receipt. Existing orders are never backfilled. */
export async function recordPurchasePhysicalOriginEvidence(tx: Query, charged: PurchaseOriginEvidence): Promise<PurchasePhysicalOriginEvidence> {
  const previous = await readPurchasePhysicalOriginEvidence(tx, charged);
  if (previous) return previous;
  await tx.execute(sql`INSERT INTO public.store_order_purchase_physical_origin(order_id,buyer_id)
    VALUES (${charged.orderId},${charged.buyerId}) ON CONFLICT(order_id) DO NOTHING`);
  return await readPurchasePhysicalOriginEvidence(tx, charged) ?? invalid();
}
