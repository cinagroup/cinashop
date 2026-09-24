import { and, asc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, storeOrderRefund, storeOrderRefundSplit, user } from '@/models/schema';
import type { SupplierAllocationResult } from '@/services/order/OrderSupplierAllocationService';
import { refundOrderSplitFingerprint } from '@/services/order/RefundOrderSplitIdentity';
import { readRefundQuantityReservation } from '@/services/order/RefundQuantityReservation';
import { readRefundGenerationMarker } from '@/services/order/RefundGenerationMarker';
import { parseSecondCardValiditySnapshot } from '@/services/order/SecondCardValidityService';
import { presaleDispatchBoundary } from './PresaleFulfillmentSnapshot';
import { presaleDeliveryContractDigest } from './PresaleDeliveryIntent';
import { loadPresaleRefundHistory } from './PresaleRefundBaseline';

const MAX_ORDERS = 202, MAX_LINES = 200, MAX_BYTES = 8388608;
const invalid = () => Error('预售付款恢复的数量或子单凭据不一致');
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function integer(value: unknown, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > 2147483647) throw invalid();
  return value;
}
function cartId(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value) || Number(value) > 2147483647) throw invalid();
  return value;
}
interface Line {
  id: number; cartId: string; oldCartId: string; productId: number; skuUnique: string;
  quantity: number; contract: string;
}
type Order = typeof storeOrder.$inferSelect;
type Marker = { refundId: number; role: 'remaining' | 'selected' } | null;
interface Node { order: Order; lines: Map<number, Line>; marker: Marker; previous: number }
export interface PresalePaidRecovery {
  allocation: SupplierAllocationResult;
  activeOrderIds: ReadonlySet<number>;
  coveredOrderIds: ReadonlySet<number>;
  refundIds: ReadonlySet<number>;
}

async function line(value: unknown, order: Order): Promise<Line> {
  const row = object(value), raw = row.cartInfo;
  const quantity = integer(row.cartNum, 1), productId = integer(row.productId, 1);
  if (quantity > 32767 || row.oid !== order.id || row.uid !== order.uid || row.productType !== order.productType
    || typeof raw !== 'string' || typeof row.skuUnique !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(row.skuUnique)
    || typeof row.oldCartId !== 'string') throw invalid();
  if (row.oldCartId) cartId(row.oldCartId);
  const end = presaleDispatchBoundary(raw, productId);
  const validity = order.productType === 4 ? parseSecondCardValiditySnapshot(raw) : null;
  if (order.productType === 4 && !validity) throw invalid();
  const contract = order.productType === 1 ? await presaleDeliveryContractDigest(raw, productId, row.skuUnique)
    : JSON.stringify([productId, row.skuUnique, order.productType, end, validity]);
  return { id: integer(row.id, 1), cartId: cartId(row.cartId), oldCartId: row.oldCartId,
    productId, skuUnique: row.skuUnique, quantity, contract };
}
async function lines(values: unknown, order: Order): Promise<Map<number, Line>> {
  if (!Array.isArray(values) || !values.length || values.length > MAX_LINES) throw invalid();
  const parsed = await Promise.all(values.map(value => line(value, order)));
  if (new Set(parsed.map(row => row.id)).size !== parsed.length || new Set(parsed.map(row => row.cartId)).size !== parsed.length) throw invalid();
  return new Map(parsed.map(row => [row.id, row]));
}
function quantity(rows: Map<number, Line>) { return [...rows.values()].reduce((sum, row) => sum + row.quantity, 0); }

/** Returns only a proven structural plan. Supplier financial proof is still
 * mandatory before completing paid effects or skipping existing income.
 * Outbox -> family advisory -> root -> children -> carts -> buyer. All queries
 * are bounded and all contention is NOWAIT/try-lock; no supplier mutex yet.
 * A refund reservation is not a completed quantity partition. No DDL or I/O.
 */
export async function preparePresalePaidRecovery(tx: DbClient, paymentOrderId: number, orderNo: string): Promise<PresalePaidRecovery | null> {
  if (Object.hasOwn(tx, '$client')) throw invalid();
  integer(paymentOrderId, 1);
  const [kind] = await tx.select({ type: storeOrder.type }).from(storeOrder).where(eq(storeOrder.id, paymentOrderId)).limit(1);
  if (kind?.type !== 6) return null;
  await tx.execute(sql`SELECT set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
    set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1000)::text || 'ms',true),
    set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true)`);
  const [lock] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${paymentOrderId}::bigint) AS acquired`);
  if (lock.acquired !== true) throw Error('预售付款订单正在处理，请重试');
  const [root] = await tx.select().from(storeOrder).where(eq(storeOrder.id, paymentOrderId)).limit(1).for('update', { noWait: true });
  if (!root || root.orderId !== orderNo || root.type !== 6 || root.paid !== 1 || ![0,-1].includes(root.pid)
    || ![0,1,2,3,4].includes(root.productType) || root.isDel || root.isSystemDel) throw invalid();
  const history = await loadPresaleRefundHistory(tx, root.id);
  const children = await tx.select().from(storeOrder).where(eq(storeOrder.pid, root.id)).orderBy(asc(storeOrder.id))
    .limit(MAX_ORDERS + 1).for('update', { noWait: true });
  if (children.length > MAX_ORDERS || (root.pid === 0 ? children.length !== 0 : children.length === 0)) throw invalid();
  const family = [root, ...children], orders = new Map(family.map(order => [order.id, order]));
  if (!history.length) {
    const [completed] = await tx.select({ id: storeOrderRefund.id }).from(storeOrderRefund)
      .where(and(inArray(storeOrderRefund.storeOrderId, family.map(order => order.id)), eq(storeOrderRefund.refundType, 6))).limit(1);
    if (completed || family.some(order => order.refundStatus === 2 || order.refundStatus === 3)) throw invalid();
    return null;
  }
  if (new Set(family.map(order => order.orderId)).size !== family.length || family.some(order => order.uid !== root.uid
    || order.type !== 6 || order.productType !== root.productType || order.paid !== 1 || order.payType !== root.payType
    || order.payTime !== root.payTime || order.supplierAllocationStatus !== 2 || order.isDel || order.isSystemDel)) throw invalid();
  const ids = family.map(order => order.id);
  const totalBytes = sql`(SELECT COALESCE(SUM(octet_length(cart_info)::bigint),0) FROM ${storeOrderCartInfo}
    WHERE oid IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)}))`;
  const carts = await tx.select({ ...getTableColumns(storeOrderCartInfo),
    cartInfo: sql<string | null>`CASE WHEN octet_length(${storeOrderCartInfo.cartInfo}) <= 65536 AND ${totalBytes} <= ${MAX_BYTES}
      THEN ${storeOrderCartInfo.cartInfo} END`,
  }).from(storeOrderCartInfo).where(inArray(storeOrderCartInfo.oid, ids)).orderBy(asc(storeOrderCartInfo.id))
    .limit((MAX_ORDERS + 1) * MAX_LINES + 1).for('update', { noWait: true });
  if (carts.length > (MAX_ORDERS + 1) * MAX_LINES || carts.some(row => row.cartInfo === null)) throw invalid();
  const currentLines = new Map<number, Map<number, Line>>();
  for (const order of family) currentLines.set(order.id, await lines(carts.filter(row => row.oid === order.id), order));
  const rootLines = currentLines.get(root.id)!;
  if (quantity(rootLines) !== root.totalNum) throw invalid();
  const [buyer] = await tx.select({ uid: user.uid }).from(user).where(eq(user.uid, root.uid)).limit(1).for('update', { noWait: true });
  if (!buyer) throw invalid();

  const first = history.filter(row => row.previousRefundId === 0);
  if (!first.length || new Set(first.map(row => row.sourceOrderId)).size !== first.length) throw invalid();
  const projected = sql`jsonb_build_object('version',${storeOrderRefundSplit.sourceSnapshot}::jsonb->'version',
    'source',${storeOrderRefundSplit.sourceSnapshot}::jsonb->'source','carts',${storeOrderRefundSplit.sourceSnapshot}::jsonb->'carts')`;
  const snapshots = await tx.select({ refundId: storeOrderRefundSplit.refundId,
    value: sql<unknown>`CASE WHEN octet_length(${storeOrderRefundSplit.sourceSnapshot}) <= 16777216
      AND SUM(octet_length((${projected})::text)::bigint) OVER () <= ${MAX_BYTES} THEN ${projected} END`,
  }).from(storeOrderRefundSplit).where(inArray(storeOrderRefundSplit.refundId, first.map(row => row.refundId)));
  const selectedIds = new Set(history.filter(row => row.selectedOrderId !== row.sourceOrderId).map(row => row.selectedOrderId));
  const fromRoot = first.some(row => row.sourceOrderId === root.id);
  if (fromRoot && first.length !== 1) throw invalid();
  const initial = fromRoot ? [root] : children.filter(order => !selectedIds.has(order.id));
  const nodes = new Map<number, Node>(), terminal = new Map<number, Node>(), coveredOrderIds = new Set<number>();
  for (const order of initial) {
    const receipt = first.find(row => row.sourceOrderId === order.id);
    let initialLines = currentLines.get(order.id)!;
    if (receipt) {
      const snapshot = object(snapshots.find(row => row.refundId === receipt.refundId)?.value), source = object(snapshot.source);
      if (snapshot.version !== 'refund-order-materialization-v1' || ['id','orderId','uid','supplierId','storeId','type','productType','paid','payType','payTime']
        .some(key => source[key] !== object(order)[key])) throw invalid();
      initialLines = await lines(snapshot.carts, order);
      if (quantity(initialLines) !== source.totalNum) throw invalid();
    }
    nodes.set(order.id, { order, lines: initialLines, marker: null, previous: 0 });
  }
  if (first.some(row => !nodes.has(row.sourceOrderId))) throw invalid();
  // Bind every initial allocation to the retained payment-root quantities and
  // fulfillment contract, including untouched allocations alongside refunds.
  const usedRoot = new Map<string, number>();
  for (const node of nodes.values()) for (const value of node.lines.values()) {
    const origin = fromRoot ? value.cartId : value.oldCartId || value.cartId;
    const rootLine = [...rootLines.values()].find(row => row.cartId === origin);
    if (!rootLine || rootLine.productId !== value.productId || rootLine.skuUnique !== value.skuUnique || rootLine.contract !== value.contract) throw invalid();
    usedRoot.set(origin, (usedRoot.get(origin) ?? 0) + value.quantity);
  }
  if (usedRoot.size !== rootLines.size || [...rootLines.values()].some(row => usedRoot.get(row.cartId) !== row.quantity)) throw invalid();
  const refundBytes = sql`(SELECT COALESCE(SUM(octet_length(cart_info)::bigint),0) FROM ${storeOrderRefund}
    WHERE store_order_id IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)}))`;
  const refunds = await tx.select({ ...getTableColumns(storeOrderRefund),
    cartInfo: sql<string | null>`CASE WHEN octet_length(${storeOrderRefund.cartInfo}) <= 65536
      AND ${refundBytes} <= ${MAX_BYTES} THEN ${storeOrderRefund.cartInfo} END`,
  }).from(storeOrderRefund).where(inArray(storeOrderRefund.storeOrderId, ids)).orderBy(asc(storeOrderRefund.id))
    .limit(202).for('share', { noWait: true });
  if (refunds.length > 201) throw invalid();
  const consumed = new Set<number>(), wholeOrders = new Set<number>();
  for (const receipt of history) {
    const node = nodes.get(receipt.sourceOrderId), refund = refunds.find(row => row.id === receipt.refundId);
    if (!node || receipt.previousRefundId !== node.previous || receipt.baseBranchId !== null || receipt.paymentOrderId !== root.id
      || receipt.uid !== root.uid || receipt.supplierId !== node.order.supplierId || receipt.storeId !== node.order.storeId
      || !refund || refund.storeOrderId !== node.order.id || refund.uid !== root.uid || refund.supplierId !== receipt.supplierId
      || refund.storeId !== receipt.storeId || refund.refundType !== 6 || refund.isCancel || refund.refundedPrice !== refund.refundPrice
      || await refundOrderSplitFingerprint(refund) !== receipt.fingerprint || !Array.isArray(receipt.partitions)
      || receipt.partitions.length !== node.lines.size) throw invalid();
    const whole = receipt.disposition === 'whole', selected = new Map<number, Line>(), remaining = new Map<number, Line>();
    const seen = new Set<number>(), claims = new Map<number, { cartId: number; quantity: number; total: number }>();
    for (const raw of receipt.partitions) {
      const part = object(raw), sourceId = integer(part.sourceRowId, 1), source = node.lines.get(sourceId);
      const take = integer(part.selectedNum), leave = integer(part.remainingNum);
      if (Object.keys(part).length !== 6 || !source || seen.has(sourceId) || part.sourceCartId !== source.cartId || take + leave !== source.quantity) throw invalid();
      seen.add(sourceId);
      if (take) {
        const id = integer(part.selectedRowId, 1);
        if (selected.has(id) || (whole ? id !== sourceId : node.lines.has(id))) throw invalid();
        selected.set(id, { ...source, id, quantity: take, cartId: whole ? source.cartId : String(id),
          oldCartId: whole ? source.oldCartId : source.oldCartId || source.cartId });
        claims.set(sourceId, { cartId: Number(source.cartId), quantity: take, total: source.quantity });
      } else if (part.selectedRowId !== null) throw invalid();
      if (leave) {
        const id = integer(part.remainingRowId, 1), reused = receipt.remainingOrderId === node.order.id;
        if (remaining.has(id) || (reused ? id !== sourceId : node.lines.has(id))) throw invalid();
        remaining.set(id, { ...source, id, quantity: leave, cartId: reused ? source.cartId : String(id),
          oldCartId: reused ? source.oldCartId : source.oldCartId || source.cartId });
      } else if (part.remainingRowId !== null) throw invalid();
    }
    const claim = readRefundQuantityReservation(refund);
    if (!selected.size || [...selected.keys()].some(id => remaining.has(id)) || !claim || claim.items.length !== claims.size
      || refund.refundNum !== quantity(selected) || claim.items.some(item => {
        const expected = claims.get(item.rowId);
        return !expected || item.beforeRefundNum !== 0 || item.cartId !== expected.cartId || item.cartNum !== expected.quantity || item.totalNum !== expected.total;
      })) throw invalid();
    const selectedOrder = orders.get(receipt.selectedOrderId);
    if (!selectedOrder || selectedOrder.refundStatus !== 2 || selectedOrder.refundType !== 6 || selectedOrder.refundPrice !== refund.refundedPrice
      || selectedOrder.supplierId !== receipt.supplierId || selectedOrder.storeId !== receipt.storeId || terminal.has(selectedOrder.id)) throw invalid();
    nodes.delete(node.order.id); coveredOrderIds.add(node.order.id); coveredOrderIds.add(selectedOrder.id);
    if (whole) {
      if (remaining.size || receipt.remainingOrderId !== null || selectedOrder.id !== node.order.id) throw invalid();
      wholeOrders.add(selectedOrder.id);
    } else {
      const remainder = receipt.remainingOrderId === null ? undefined : orders.get(receipt.remainingOrderId);
      if (receipt.disposition !== 'split' || !remaining.size || !remainder || selectedOrder.id === node.order.id || selectedOrder.id === remainder.id
        || selectedOrder.pid !== root.id || remainder.pid !== root.id || remainder.supplierId !== receipt.supplierId
        || remainder.storeId !== receipt.storeId || nodes.has(remainder.id) || terminal.has(remainder.id)) throw invalid();
      nodes.set(remainder.id, { order: remainder, lines: remaining, marker: { refundId: receipt.refundId, role: 'remaining' }, previous: receipt.refundId });
      coveredOrderIds.add(remainder.id);
    }
    terminal.set(selectedOrder.id, { order: selectedOrder, lines: selected, marker: whole ? node.marker : { refundId: receipt.refundId, role: 'selected' }, previous: node.previous });
    consumed.add(receipt.refundId);
  }
  if (refunds.some(refund => refund.refundType === 6 && !consumed.has(refund.id))) throw invalid();
  const expected = new Map([...terminal, ...nodes]);
  if ([...nodes.values()].some(node => ![0, 1].includes(node.order.refundStatus))) throw invalid();
  const fulfillment = root.pid === -1 ? children : [root];
  if (expected.size !== fulfillment.length || fulfillment.some(order => !expected.has(order.id))) throw invalid();
  for (const node of expected.values()) {
    const actual = currentLines.get(node.order.id)!;
    if (actual.size !== node.lines.size || quantity(actual) !== node.order.totalNum
      || [...node.lines].some(([id,value]) => JSON.stringify(actual.get(id)) !== JSON.stringify(value))) throw invalid();
    const pending = refunds.filter(refund => refund.storeOrderId === node.order.id && !refund.isCancel && !refund.isDel
      && [0, 1, 2, 4, 5].includes(refund.refundType));
    if (pending.length > 1 || (terminal.has(node.order.id) && pending.length)) throw invalid();
    const reserved = new Map<number, number>();
    if (pending.length) {
      const claim = readRefundQuantityReservation(pending[0]);
      if (!claim) throw invalid();
      for (const item of claim.items) {
        const row = actual.get(item.rowId);
        if (!row || item.beforeRefundNum !== 0 || item.totalNum !== row.quantity || String(item.cartId) !== row.cartId) throw invalid();
        reserved.set(item.rowId, item.cartNum);
      }
    }
    for (const row of carts.filter(row => row.oid === node.order.id)) {
      if (terminal.has(node.order.id)) {
        if (row.refundNum !== (wholeOrders.has(node.order.id) ? 0 : row.cartNum)
          || row.splitStatus !== 2 || row.splitSurplusNum !== 0) throw invalid();
      } else if (row.refundNum !== (reserved.get(row.id) ?? 0)) throw invalid();
      const info = object(JSON.parse(row.cartInfo!));
      const marker = Object.hasOwn(info, 'refund_order_generation') ? readRefundGenerationMarker(info.refund_order_generation) : null;
      if (JSON.stringify(marker) !== JSON.stringify(node.marker)) throw invalid();
      if (node.marker && (info.financial_version !== 'refund-order-line-finance-v1' || info.id !== row.cartId
        || Number(info.cart_num) !== row.cartNum)) throw invalid();
    }
  }
  return { allocation: { paymentOrder: root, fulfillmentOrders: fulfillment, split: root.pid === -1 },
    activeOrderIds: new Set(nodes.keys()), coveredOrderIds, refundIds: consumed };
}
