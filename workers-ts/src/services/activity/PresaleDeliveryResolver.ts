import { asc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, storeOrderRefund } from '@/models/schema';
import { refundOrderSplitFingerprint } from '@/services/order/RefundOrderSplitIdentity';
import { loadRefundOrderGeneration } from '@/services/order/RefundOrderGeneration';
import { readRefundQuantityReservation } from '@/services/order/RefundQuantityReservation';
import { deliverPaidVirtualOrders } from '@/services/order/VirtualProductDeliveryService';
import { presaleDeliveryContractDigest, type PresaleDeliveryIntent, type PresaleDeliveryLine } from './PresaleDeliveryIntent';
import { loadPresaleRefundHistory, verifyPresaleRefundBaseline } from './PresaleRefundBaseline';

const invalid = () => Error('预售自动交付的退款或履约证据不一致');
function integer(value: unknown, min = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= 2_147_483_647;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}

/** The outbox lease is held by the caller. Root -> active order -> cart locks
 * serialize refunds with delivery. NOWAIT avoids reverse waits against refund
 * workers which already hold their refund row. No live SKU or clock override
 * can authorize delivery. A refund reservation alone never reduces entitlement.
 */
export async function deliverDuePresale(tx: DbClient, intent: PresaleDeliveryIntent): Promise<'completed' | 'waiting'> {
  if (Object.hasOwn(tx, '$client')) throw Error('Presale delivery requires a caller-owned transaction');
  await tx.execute(sql`SELECT set_config('statement_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
    set_config('lock_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1000)::text || 'ms',true),
    set_config('idle_in_transaction_session_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true)`);
  const [clock] = await tx.select({ now: sql<number>`floor(extract(epoch FROM clock_timestamp()))::integer` })
    .from(sql`(VALUES(1)) AS presale_delivery_clock(n)`);
  if (!integer(clock?.now)) throw invalid();
  if (clock.now < intent.dueAt) return 'waiting';
  const lockOrder = async (id: number) => {
    const [order] = await tx.select().from(storeOrder).where(eq(storeOrder.id, id)).limit(1).for('update', { noWait: true });
    if (!order || order.uid !== intent.buyerId || order.type !== 6 || order.productType !== 1 || order.paid !== 1 ||
      order.isDel || order.isSystemDel || order.supplierAllocationStatus !== 2) throw invalid();
    return order;
  };
  const root = await lockOrder(intent.paymentOrderId);
  if (![0, -1].includes(root.pid)) throw invalid();
  const original = root.id === intent.orderId ? root : await lockOrder(intent.orderId);
  if (original.orderId !== intent.orderNo || original.supplierId !== intent.supplierId || original.storeId !== intent.storeId ||
    (original.id !== root.id && (original.pid !== root.id || root.pid !== -1))) throw invalid();

  // Read compact append-only receipts only (never their 16 MiB source snapshots).
  const history = await loadPresaleRefundHistory(tx, root.id);
  const baseline = intent.version === 'presale-virtual-delivery-v2'
    ? await verifyPresaleRefundBaseline(tx, intent, intent.baseline, history) : null;
  let orderId: number | null = original.id, previous = intent.version === 'presale-virtual-delivery-v2' ? intent.baseline.refundId : 0;
  let lines = new Map(intent.lines.map(line => [line.cartInfoId, line]));
  const sources = baseline?.sources ?? new Set<number>([original.id]), consumed = baseline?.consumed ?? new Set<number>();
  for (const receipt of history) {
    if (consumed.has(receipt.refundId)) continue;
    if (receipt.sourceOrderId !== orderId) continue;
    if (receipt.previousRefundId !== previous || receipt.baseBranchId !== null || receipt.uid !== intent.buyerId ||
      receipt.supplierId !== intent.supplierId || receipt.storeId !== intent.storeId ||
      receipt.paymentOrderId !== root.id || !/^[0-9a-f]{64}$/.test(receipt.fingerprint)) throw invalid();
    if (!Array.isArray(receipt.partitions) || receipt.partitions.length !== lines.size) throw invalid();
    const next = new Map<number, PresaleDeliveryLine>(), seen = new Set<number>(), selectedIds = new Set<number>();
    const cartIds = new Set<string>(), claims = new Map<number, { cartId: number; quantity: number; total: number }>();
    let selectedQuantity = 0;
    for (const value of receipt.partitions) {
      const part = object(value);
      if (Object.keys(part).length !== 6 || ['sourceRowId', 'sourceCartId', 'selectedRowId', 'remainingRowId', 'selectedNum', 'remainingNum']
        .some(key => !Object.hasOwn(part, key))) throw invalid();
      if (!integer(part.sourceRowId, 1) || seen.has(part.sourceRowId) || !integer(part.selectedNum) || !integer(part.remainingNum)
        || typeof part.sourceCartId !== 'string' || !/^[1-9]\d{0,9}$/.test(part.sourceCartId)
        || !integer(Number(part.sourceCartId), 1) || cartIds.has(part.sourceCartId)) throw invalid();
      const line = lines.get(part.sourceRowId);
      if (!line || line.quantity !== part.selectedNum + part.remainingNum ||
        (part.selectedNum ? !integer(part.selectedRowId, 1) : part.selectedRowId !== null)) throw invalid();
      seen.add(part.sourceRowId); selectedQuantity += part.selectedNum;
      cartIds.add(part.sourceCartId);
      if (part.selectedNum) {
        if (!integer(part.selectedRowId, 1) || selectedIds.has(part.selectedRowId)
          || (receipt.disposition === 'whole' && part.selectedRowId !== part.sourceRowId)) throw invalid();
        selectedIds.add(part.selectedRowId);
        claims.set(part.sourceRowId, { cartId: Number(part.sourceCartId), quantity: part.selectedNum, total: line.quantity });
      }
      if (!part.remainingNum) { if (part.remainingRowId !== null) throw invalid(); continue; }
      if (!integer(part.remainingRowId, 1) || next.has(part.remainingRowId)
        || (receipt.remainingOrderId === orderId && part.remainingRowId !== part.sourceRowId)) throw invalid();
      next.set(part.remainingRowId, { ...line, cartInfoId: part.remainingRowId, quantity: part.remainingNum });
    }
    if (!selectedQuantity || seen.size !== lines.size) throw invalid();
    if (receipt.disposition === 'split' && ([...selectedIds].some(id => seen.has(id) || next.has(id))
      || (receipt.remainingOrderId !== orderId && [...next.keys()].some(id => seen.has(id))))) throw invalid();
    const [refund] = await tx.select({ ...getTableColumns(storeOrderRefund),
      cartInfo: sql<string | null>`CASE WHEN octet_length(${storeOrderRefund.cartInfo}) <= 131072
        THEN ${storeOrderRefund.cartInfo} ELSE NULL END`,
    }).from(storeOrderRefund).where(eq(storeOrderRefund.id, receipt.refundId)).limit(1);
    if (!refund || refund.storeOrderId !== orderId || refund.uid !== intent.buyerId || refund.supplierId !== intent.supplierId
      || refund.storeId !== intent.storeId || refund.refundType !== 6 || refund.isCancel ||
      refund.refundedPrice !== refund.refundPrice || refund.refundNum !== selectedQuantity ||
      await refundOrderSplitFingerprint(refund) !== receipt.fingerprint) throw invalid();
    // A matching cash fingerprint alone does not bind a quantity partition to
    // the actual claimed rows, particularly when a whole refund has no remainder.
    const claim = readRefundQuantityReservation(refund);
    if (!claim || claim.items.length !== claims.size || claim.items.some(item => {
      const expected = claims.get(item.rowId);
      return !expected || item.beforeRefundNum !== 0 || item.cartId !== expected.cartId
        || item.cartNum !== expected.quantity || item.totalNum !== expected.total;
    })) throw invalid();
    if (receipt.disposition === 'whole') {
      if (next.size || receipt.remainingOrderId !== null || receipt.selectedOrderId !== orderId) throw invalid();
      const selected = await lockOrder(orderId);
      if (selected.refundStatus !== 2) throw invalid();
      orderId = null;
    } else if (receipt.disposition === 'split') {
      if (!next.size || !integer(receipt.remainingOrderId, 1) || !integer(receipt.selectedOrderId, 1) || receipt.selectedOrderId === orderId ||
        receipt.selectedOrderId === receipt.remainingOrderId) throw invalid();
      orderId = receipt.remainingOrderId; sources.add(orderId);
    } else throw invalid();
    consumed.add(receipt.refundId); previous = receipt.refundId; lines = next;
  }
  if (history.some(receipt => sources.has(receipt.sourceOrderId) && !consumed.has(receipt.refundId))) throw invalid();
  const refunds = await tx.select({ id: storeOrderRefund.id, refundType: storeOrderRefund.refundType,
    isCancel: storeOrderRefund.isCancel, isDel: storeOrderRefund.isDel,
  }).from(storeOrderRefund).where(inArray(storeOrderRefund.storeOrderId, [...sources])).limit(202);
  if (refunds.length > 201 || refunds.some(refund => refund.refundType === 6 && !consumed.has(refund.id))) throw invalid();
  if (refunds.some(refund => !refund.isCancel && !refund.isDel && [0, 1, 2, 4, 5].includes(refund.refundType))) return 'waiting';
  if (orderId === null) return 'completed'; // Proven fully refunded: no secret assignment.
  const current = orderId === original.id ? original : await lockOrder(orderId);
  if (current.pid < 0 || (current.pid || current.id) !== root.id || current.supplierId !== intent.supplierId ||
    current.storeId !== intent.storeId || current.refundStatus !== 0 || current.status !== 0) throw invalid();
  const carts = await tx.select({ ...getTableColumns(storeOrderCartInfo),
    cartInfo: sql<string | null>`CASE WHEN octet_length(${storeOrderCartInfo.cartInfo}) <= 65536
      THEN ${storeOrderCartInfo.cartInfo} ELSE NULL END`,
  }).from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, orderId))
    .orderBy(asc(storeOrderCartInfo.id)).limit(201).for('update', { noWait: true });
  if (carts.length !== lines.size || carts.reduce((sum, row) => sum + row.cartNum, 0) !== current.totalNum) throw invalid();
  for (const cart of carts) {
    const line = lines.get(cart.id);
    if (!line || cart.uid !== intent.buyerId || cart.productType !== 1 || cart.refundNum !== 0 ||
      cart.productId !== line.productId || cart.skuUnique !== line.skuUnique || cart.cartNum !== line.quantity ||
      await presaleDeliveryContractDigest(cart.cartInfo, cart.productId, cart.skuUnique) !== line.contractDigest) throw invalid();
  }
  const generation = await loadRefundOrderGeneration(tx, current, carts);
  if ((generation?.refundId ?? 0) !== previous || generation?.baseBranchId) throw invalid();
  const result = await deliverPaidVirtualOrders(tx, [current], clock.now);
  if (result.deliveredOrders !== 1) throw invalid();
  return 'completed';
}
