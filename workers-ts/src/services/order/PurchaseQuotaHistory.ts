import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { ValidateException } from '@/utils/errors';
import { readPurchaseOriginEvidence, verifyPurchaseOriginEvidence, type PurchaseOriginEvidence } from './PurchaseOriginEvidence';
import { readPurchaseCancellationEvidence, type PurchaseCancellationEvidence } from './PurchaseCancellationEvidence';
import { readPurchaseQuotaPaymentLedger, verifyPurchaseQuotaRootOrigin,
  type PurchaseQuotaPaymentLedger } from './PurchaseQuotaPaymentLedger';

type Query = Pick<DbClient, 'execute'>;
export interface PurchaseQuotaRoot {
  id: number; uid: number; pid: number; type: number; paid: number;
  status: number; isDel: number; totalNum: number;
}
export interface PurchaseQuotaHistoryEntry {
  root: PurchaseQuotaRoot;
  origin: PurchaseOriginEvidence;
  cancellation: PurchaseCancellationEvidence | null;
  payment: PurchaseQuotaPaymentLedger | null;
}
export interface PurchaseQuotaHistoryProduct {
  productId: number;
  activeUnpaid: number;
  cancelledUnpaid: number;
  paidPurchased: number;
  completedRefund: number;
  pendingRefund: number;
}
export type PurchaseQuotaHistory =
  | { version: 'purchase-quota-history-v1'; buyerId: number; status: 'incomplete'; incomplete: true;
      reason: 'missing_origin_or_order' | 'too_many_roots' | 'too_many_evidence_rows' | 'unsupported_root_state'; products: null }
  | { version: 'purchase-quota-history-v1'; buyerId: number; status: 'verified_retained_roots'; incomplete: true;
      reason: 'preactivation_history_unproven'; verifiedRootCount: number; products: PurchaseQuotaHistoryProduct[] };

const invalid = (): never => { throw new ValidateException('累计限购历史凭据不一致，请核对订单'); };
function integer(value: unknown, min = 0, max = 2147483647): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : invalid();
}
function incomplete(buyerId: number, reason: Extract<PurchaseQuotaHistory, { status: 'incomplete' }>['reason']): PurchaseQuotaHistory {
  return { version: 'purchase-quota-history-v1', buyerId, status: 'incomplete', incomplete: true, reason, products: null };
}
function sameOrigin(a: PurchaseOriginEvidence, b: PurchaseOriginEvidence): boolean {
  return a.orderId === b.orderId && a.buyerId === b.buyerId && a.orderType === b.orderType
    && a.totalNum === b.totalNum && a.usedPoints === b.usedPoints && a.lines.length === b.lines.length
    && a.lines.every((line, index) => {
      const other = b.lines[index];
      return line.rowId === other.rowId && line.cartId === other.cartId && line.productId === other.productId
        && line.skuId === other.skuId && line.skuUnique === other.skuUnique
        && line.quantity === other.quantity && line.usedPoints === other.usedPoints;
    });
}

/** Classifies only already verified roots. Every successful result is still
 * incomplete for purchase authorization: there is no pre-activation history
 * coverage proof, quota policy, lock or reservation in this projection. */
export function projectPurchaseQuotaHistory(entries: readonly PurchaseQuotaHistoryEntry[], buyerId: number): PurchaseQuotaHistory {
  integer(buyerId, 1); if (entries.length > 200) return incomplete(buyerId, 'too_many_roots');
  const roots = new Set<number>(), products = new Map<number, PurchaseQuotaHistoryProduct>();
  const add = (productId: number, field: keyof Omit<PurchaseQuotaHistoryProduct, 'productId'>, count: number) => {
    integer(productId, 1); integer(count);
    const row = products.get(productId) ?? { productId, activeUnpaid: 0, cancelledUnpaid: 0,
      paidPurchased: 0, completedRefund: 0, pendingRefund: 0 };
    row[field] = integer(row[field] + count); products.set(productId, row);
  };
  for (const entry of entries) {
    const { root, cancellation, payment } = entry;
    integer(root.id, 1); integer(root.uid, 1); integer(root.type, 0, 8); integer(root.totalNum, 1);
    if (roots.has(root.id) || root.uid !== buyerId || ![-1, 0].includes(root.pid)) return invalid();
    roots.add(root.id);
    const origin = verifyPurchaseOriginEvidence(entry.origin, { orderId: root.id, buyerId });
    if (root.type !== origin.orderType || root.totalNum !== origin.totalNum) return invalid();
    const original = new Map<number, number>();
    for (const line of origin.lines) original.set(line.productId, (original.get(line.productId) ?? 0) + line.quantity);
    if (root.paid === 0 && root.pid === 0 && root.status === 0 && root.isDel === 0 && !cancellation && !payment) {
      for (const [productId, count] of original) add(productId, 'activeUnpaid', count);
    } else if (root.paid === 0 && root.pid === 0 && root.status === -2 && root.isDel === 1 && cancellation && !payment) {
      if (!sameOrigin(origin, cancellation.origin)) return invalid();
      for (const [productId, count] of original) add(productId, 'cancelledUnpaid', count);
    } else if (root.paid === 1 && !cancellation && payment) {
      if (payment.buyerId !== buyerId || payment.paymentOrderId !== root.id
        || payment.products.length !== original.size) return invalid();
      const seen = new Set<number>();
      for (const line of payment.products) {
        if (seen.has(line.productId) || original.get(line.productId) !== line.purchased
          || line.refunded + line.remaining !== line.purchased || line.pending > line.remaining) return invalid();
        seen.add(line.productId);
        add(line.productId, 'paidPurchased', line.purchased);
        add(line.productId, 'completedRefund', line.refunded);
        add(line.productId, 'pendingRefund', line.pending);
      }
    } else return incomplete(buyerId, 'unsupported_root_state');
  }
  return { version: 'purchase-quota-history-v1', buyerId, status: 'verified_retained_roots', incomplete: true,
    reason: 'preactivation_history_unproven', verifiedRootCount: roots.size,
    products: [...products.values()].sort((a, b) => a.productId - b.productId) };
}

async function readUnpaidRootLines(tx: Query, orderId: number) {
  return tx.execute(sql`WITH candidates AS MATERIALIZED (
    SELECT id, oid, uid, product_id AS "productId", cart_id AS "cartId", old_cart_id AS "oldCartId",
      sku_unique AS "skuUnique", cart_num AS "cartNum", cart_info
    FROM store_order_cart_info WHERE oid=${orderId} ORDER BY id LIMIT 201
  ), parsed AS MATERIALIZED (
    SELECT *, CASE WHEN octet_length(cart_info)<=65536 AND SUM(octet_length(cart_info)::bigint) OVER ()<=8388608
      THEN cart_info::jsonb ELSE NULL END AS info FROM candidates
  ) SELECT id, oid, uid, "productId", "cartId", "oldCartId", "skuUnique", "cartNum",
    jsonb_build_object('valid', jsonb_typeof(info)='object', 'version', info->'financial_version',
      'id', info->'id', 'cartNum', info->'cart_num', 'skuId', info#>'{sku,id}') AS snapshot FROM parsed`);
}

/** Caller-owned REPEATABLE READ or SERIALIZABLE transaction only. No locks,
 * writes, quota availability or purchase authority. Rows without provenance
 * never become zero-history. Even fully matched retained roots cannot certify
 * deleted or pre-activation orders, so incomplete is always true. */
export async function readPurchaseQuotaHistory(tx: Query, buyerId: number): Promise<PurchaseQuotaHistory> {
  integer(buyerId, 1);
  if (Object.hasOwn(tx, '$client')) return invalid();
  const [mode] = await tx.execute(sql`SELECT current_setting('transaction_isolation') AS isolation`);
  if (!['repeatable read', 'serializable'].includes(String(mode?.isolation))) return invalid();
  const roots = await tx.execute(sql`SELECT id, uid, pid, type, paid, status, is_del AS "isDel", total_num AS "totalNum"
    FROM store_order WHERE uid=${buyerId} AND pid IN (0,-1) ORDER BY id LIMIT 201`);
  const origins = await tx.execute(sql`SELECT order_id AS id FROM public.store_order_purchase_origin
    WHERE buyer_id=${buyerId} ORDER BY order_id LIMIT 201`);
  if (roots.length > 200 || origins.length > 200) return incomplete(buyerId, 'too_many_roots');
  // The existing buyer index makes this a bounded probe even when a customer
  // has far more fulfillment rows than original orders. Do not perform up to
  // 200 large per-root lineage reads after the global budget is exhausted.
  const cartRows = await tx.execute(sql`SELECT id FROM store_order_cart_info WHERE uid=${buyerId} LIMIT 4001`);
  if (cartRows.length > 4000) return incomplete(buyerId, 'too_many_evidence_rows');
  const rootIds = new Set(roots.map(row => integer(row.id, 1)));
  const originIds = new Set(origins.map(row => integer(row.id, 1)));
  if (rootIds.size !== roots.length || originIds.size !== origins.length || rootIds.size !== originIds.size
    || [...rootIds].some(id => !originIds.has(id))) return incomplete(buyerId, 'missing_origin_or_order');
  const entries: PurchaseQuotaHistoryEntry[] = [];
  let evidenceRows = roots.length + origins.length + cartRows.length;
  for (const raw of roots) {
    const root = raw as unknown as PurchaseQuotaRoot;
    const expected = { orderId: root.id, buyerId };
    const origin = await readPurchaseOriginEvidence(tx, expected);
    if (!origin) return incomplete(buyerId, 'missing_origin_or_order');
    const cancellation = await readPurchaseCancellationEvidence(tx, expected);
    let payment: PurchaseQuotaPaymentLedger | null = null;
    if (root.paid === 1) {
      payment = await readPurchaseQuotaPaymentLedger(tx, { paymentOrderId: root.id, buyerId });
      evidenceRows += integer(payment.evidenceRows, 1);
    }
    else if (root.paid === 0) {
      const lines = await readUnpaidRootLines(tx, root.id);
      verifyPurchaseQuotaRootOrigin({ orders: [root], carts: lines }, origin,
        { paymentOrderId: root.id, buyerId }, 0);
      const [child] = await tx.execute(sql`SELECT id FROM store_order WHERE pid=${root.id} LIMIT 1`);
      if (child) return incomplete(buyerId, 'unsupported_root_state');
    }
    if (cancellation) evidenceRows++;
    if (evidenceRows > 10000) return incomplete(buyerId, 'too_many_evidence_rows');
    entries.push({ root, origin, cancellation, payment });
  }
  return projectPurchaseQuotaHistory(entries, buyerId);
}
