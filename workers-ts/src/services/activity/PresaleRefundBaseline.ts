import { asc, eq, getTableColumns, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, storeOrderRefund, storeOrderRefundSplit } from '@/models/schema';
import { loadRefundOrderGeneration } from '@/services/order/RefundOrderGeneration';
import { refundOrderSplitFingerprint } from '@/services/order/RefundOrderSplitIdentity';
import { readRefundQuantityReservation } from '@/services/order/RefundQuantityReservation';
import type { PresaleDeliveryIntent, PresaleDeliveryLine } from './PresaleDeliveryIntent';

export interface PresaleRefundBaseline { refundId: number; historyDigest: string }
type Scope = Pick<PresaleDeliveryIntent, 'orderId' | 'paymentOrderId' | 'buyerId' | 'supplierId' | 'storeId'>;
const invalid = () => Error('预售已退款基线证据不一致');
function integer(value: unknown, min = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= 2147483647;
}

/** Compact append-only receipts only; never transfer the 16 MiB source snapshots.
 * The family lock is owned by the caller. Bound both each row and the whole read. */
export async function loadPresaleRefundHistory(tx: DbClient, paymentOrderId: number) {
  const history = await tx.select({ refundId: storeOrderRefundSplit.refundId, fingerprint: storeOrderRefundSplit.fingerprint,
    uid: storeOrderRefundSplit.uid, supplierId: storeOrderRefundSplit.supplierId, storeId: storeOrderRefundSplit.storeId,
    sourceOrderId: storeOrderRefundSplit.sourceOrderId, paymentOrderId: storeOrderRefundSplit.paymentOrderId,
    selectedOrderId: storeOrderRefundSplit.selectedOrderId, remainingOrderId: storeOrderRefundSplit.remainingOrderId,
    disposition: storeOrderRefundSplit.disposition, previousRefundId: storeOrderRefundSplit.previousRefundId,
    baseBranchId: storeOrderRefundSplit.baseBranchId,
    partitions: sql<unknown>`CASE WHEN octet_length(${storeOrderRefundSplit.partitions}) <= 131072
      AND SUM(octet_length(${storeOrderRefundSplit.partitions})::bigint) OVER () <= 8388608
      THEN ${storeOrderRefundSplit.partitions}::jsonb ELSE NULL END`,
  }).from(storeOrderRefundSplit).where(eq(storeOrderRefundSplit.paymentOrderId, paymentOrderId))
    .orderBy(asc(storeOrderRefundSplit.refundId)).limit(202);
  if (history.length > 201) throw invalid();
  return history;
}
type History = Awaited<ReturnType<typeof loadPresaleRefundHistory>>;

/** Follow explicit predecessor links, not an ID/time cutoff. Every consumed
 * refund still has to match its committed immutable business identity. */
async function inspectBaseline(tx: DbClient, scope: Scope, refundId: number,
  lines: readonly PresaleDeliveryLine[], history: History) {
  if (Object.hasOwn(tx, '$client') || !integer(refundId, 1) || history.length > 201) throw invalid();
  const byId = new Map(history.map(row => [row.refundId, row]));
  if (byId.size !== history.length) throw invalid();
  const backwards: History = [], consumed = new Set<number>(), sources = new Set<number>([scope.orderId]);
  let cursor = refundId;
  while (cursor) {
    const row = byId.get(cursor);
    if (!row || consumed.has(cursor) || row.remainingOrderId !== scope.orderId || row.disposition !== 'split'
      || row.baseBranchId !== null || row.uid !== scope.buyerId || row.supplierId !== scope.supplierId
      || row.storeId !== scope.storeId || row.paymentOrderId !== scope.paymentOrderId
      || !integer(row.selectedOrderId, 1) || row.selectedOrderId === row.sourceOrderId || row.selectedOrderId === scope.orderId
      || !integer(row.previousRefundId) || row.previousRefundId >= cursor
      || (row.sourceOrderId !== scope.orderId && (row.sourceOrderId !== scope.paymentOrderId || row.previousRefundId !== 0))) throw invalid();
    backwards.push(row); consumed.add(cursor); sources.add(row.sourceOrderId); cursor = row.previousRefundId;
  }
  const chain = backwards.reverse(), canonical = [];
  let previousRemainder: Map<number, number> | undefined;
  for (const row of chain) {
    if (!Array.isArray(row.partitions) || !row.partitions.length || row.partitions.length > 200) throw invalid();
    const sourceIds = new Set<number>(), cartIds = new Set<string>(), selectedIds = new Set<number>();
    const remaining = new Map<number, number>(), selected = new Map<number, number>();
    const parts = row.partitions.map((value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
      const part = value as Record<string, unknown>;
      if (Object.keys(part).length !== 6 || !integer(part.sourceRowId, 1) || sourceIds.has(part.sourceRowId)
        || typeof part.sourceCartId !== 'string' || !/^[1-9]\d{0,9}$/.test(part.sourceCartId)
        || !integer(Number(part.sourceCartId), 1) || cartIds.has(part.sourceCartId)
        || !integer(part.selectedNum) || !integer(part.remainingNum)
        || part.selectedNum + part.remainingNum < 1 || part.selectedNum + part.remainingNum > 32767
        || (previousRemainder && previousRemainder.get(part.sourceRowId) !== part.selectedNum + part.remainingNum)) throw invalid();
      sourceIds.add(part.sourceRowId); cartIds.add(part.sourceCartId);
      if (part.selectedNum) {
        if (!integer(part.selectedRowId, 1) || selectedIds.has(part.selectedRowId)) throw invalid();
        selectedIds.add(part.selectedRowId); selected.set(Number(part.sourceCartId), part.selectedNum);
      } else if (part.selectedRowId !== null) throw invalid();
      if (part.remainingNum) {
        if (!integer(part.remainingRowId, 1) || remaining.has(part.remainingRowId)) throw invalid();
        if (row.sourceOrderId === scope.orderId && part.remainingRowId !== part.sourceRowId) throw invalid();
        remaining.set(part.remainingRowId, part.remainingNum);
      } else if (part.remainingRowId !== null) throw invalid();
      return { sourceRowId: part.sourceRowId, sourceCartId: part.sourceCartId, selectedRowId: part.selectedRowId,
        remainingRowId: part.remainingRowId, selectedNum: part.selectedNum, remainingNum: part.remainingNum };
    }).sort((a, b) => a.sourceRowId - b.sourceRowId);
    if (!selected.size || !remaining.size || (previousRemainder && previousRemainder.size !== sourceIds.size)
      || [...selectedIds].some(id => remaining.has(id) || sourceIds.has(id))
      || (row.sourceOrderId !== scope.orderId && [...remaining.keys()].some(id => sourceIds.has(id)))) throw invalid();
    const [refund] = await tx.select({ ...getTableColumns(storeOrderRefund),
      cartInfo: sql<string | null>`CASE WHEN octet_length(${storeOrderRefund.cartInfo}) <= 131072 THEN ${storeOrderRefund.cartInfo} ELSE NULL END`,
    }).from(storeOrderRefund).where(eq(storeOrderRefund.id, row.refundId)).limit(1);
    if (!refund || refund.storeOrderId !== row.sourceOrderId || refund.uid !== scope.buyerId || refund.supplierId !== scope.supplierId
      || refund.storeId !== scope.storeId || refund.refundType !== 6 || refund.isCancel
      || refund.refundedPrice !== refund.refundPrice || await refundOrderSplitFingerprint(refund) !== row.fingerprint) throw invalid();
    const claim = readRefundQuantityReservation(refund);
    if (!claim || claim.items.length !== selected.size || claim.items.some(item => {
      const part = parts.find(part => part.sourceCartId === String(item.cartId));
      return !part || part.sourceRowId !== item.rowId || item.beforeRefundNum !== 0
        || part.selectedNum + part.remainingNum !== item.totalNum || selected.get(item.cartId) !== item.cartNum;
    })
      || refund.refundNum !== [...selected.values()].reduce((sum, n) => sum + n, 0)) throw invalid();
    previousRemainder = remaining;
    canonical.push({ ...row, partitions: parts });
  }
  if (!previousRemainder || previousRemainder.size !== lines.length
    || lines.some(line => previousRemainder.get(line.cartInfoId) !== line.quantity)) throw invalid();
  const bytes = new TextEncoder().encode(JSON.stringify(canonical));
  if (bytes.length > 8388608) throw invalid();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const historyDigest = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return { historyDigest, consumed, sources };
}

/** Capture only after root/order/cart locks and current-generation validation.
 * Manual fulfillment branches require their own baseline protocol; no fallback. */
export async function capturePresaleRefundBaseline(tx: DbClient, order: typeof storeOrder.$inferSelect,
  carts: Array<typeof storeOrderCartInfo.$inferSelect>, lines: readonly PresaleDeliveryLine[]): Promise<PresaleRefundBaseline | null> {
  if (Object.hasOwn(tx, '$client')) throw invalid();
  const generation = await loadRefundOrderGeneration(tx, order, carts);
  if (!generation) {
    // A stripped marker must not turn a retained refund child into generation 0.
    // Initial unsplit orders have no possible materialized remainder parent.
    if (order.pid > 0 && (await loadPresaleRefundHistory(tx, order.pid)).some(row =>
      row.remainingOrderId === order.id || row.sourceOrderId === order.id)) throw invalid();
    return null;
  }
  if (!generation.refundId || generation.baseBranchId) throw invalid();
  const history = await loadPresaleRefundHistory(tx, order.pid || order.id);
  const checked = await inspectBaseline(tx, { orderId: order.id, paymentOrderId: order.pid || order.id,
    buyerId: order.uid, supplierId: order.supplierId, storeId: order.storeId }, generation.refundId, lines, history);
  if (generation.covered.size !== checked.consumed.size || [...generation.covered].some(([id, fingerprint]) =>
    !checked.consumed.has(id) || history.find(row => row.refundId === id)?.fingerprint !== fingerprint)
    || history.some(row => checked.sources.has(row.sourceOrderId) && !checked.consumed.has(row.refundId))) throw invalid();
  return { refundId: generation.refundId, historyDigest: checked.historyDigest };
}

export async function verifyPresaleRefundBaseline(tx: DbClient, intent: Scope & { lines: PresaleDeliveryLine[] },
  baseline: PresaleRefundBaseline, history: History) {
  const checked = await inspectBaseline(tx, intent, baseline.refundId, intent.lines, history);
  if (checked.historyDigest !== baseline.historyDigest) throw invalid();
  return checked;
}
