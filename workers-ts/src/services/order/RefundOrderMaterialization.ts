import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, storeOrderRefund, storeOrderRefundPayment, storeOrderStatus } from '@/models/schema';
import { storeOrderRefundSplit } from '@/models/schema/order_refund_split';
import { ValidateException } from '@/utils/errors';
import { amountToCents } from '@/services/payment/RefundGateway';
import { lockOrderSettlement } from './OrderBrokerageService';
import { readRefundQuantityReservation } from './RefundQuantityReservation';
import { planCompletedRefundLineCompensation, planOrderFinancialSplit } from './OrderSplitFinance';
import { refundSplitDisposition, type RefundWriteoffState } from './RefundSplitAllocation';
import { reserveOrderCartRowIds } from './OrderCartIdentity';
import { reserveChildOrderIds } from '@/services/supplier/SupplierFulfillmentService';
import { generatePickupVerifyCode } from './StoreOrderWriteoffService';
import { refundOrderSplitFingerprint as fingerprint, type RefundMaterializationIdentity } from './RefundOrderSplitIdentity';
import { captureReturnedPointBills, loadRefundOrderGeneration } from './RefundOrderGeneration';
import { captureRefundEarnedIncomeScope } from './RefundEarnedIncome';
import { splitSupplierRefundPayment } from '@/services/supplier/SupplierRefundSplitFinance';
import { materializeRefundInvoice, type RefundInvoiceSnapshot } from './RefundInvoiceAllocation';
export type { RefundMaterializationIdentity } from './RefundOrderSplitIdentity';

type Cart = typeof storeOrderCartInfo.$inferSelect;
type RecordRow = typeof storeOrderRefundSplit.$inferSelect;
const invalid = () => new ValidateException('退款实体拆单证据不一致，请先核对订单');
const key = () => crypto.randomUUID().replaceAll('-', '');
function integer(value: number, zero = false) {
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1) || value > 2147483647) throw invalid();
}
function boundedJson(value: unknown, maximum: number): string {
  const result = JSON.stringify(value);
  if (result === undefined || new TextEncoder().encode(result).length > maximum) throw invalid();
  return result;
}
function cents(value: string): number {
  const result = amountToCents(value); if (result === null || result < 0) throw invalid(); return result;
}
function result(record: RecordRow, replayed: boolean) {
  return { disposition: record.disposition, sourceOrderId: record.sourceOrderId, paymentOrderId: record.paymentOrderId,
    selectedOrderId: record.selectedOrderId, remainingOrderId: record.remainingOrderId, replayed };
}
function cartSnapshot(value: string, id: string, refundId: number, selected: boolean): string {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid();
  return boundedJson({ ...parsed, id, financial_version: 'refund-order-line-finance-v1',
    refund_order_generation: { refundId, role: selected ? 'selected' : 'remaining' } }, 65536);
}
function cloneCart(source: Cart, id: number, oid: number, quantity: number, snapshot: string,
  writeoff: RefundWriteoffState, selected: boolean, firstSplit: boolean, delivered: boolean, refundId: number): typeof storeOrderCartInfo.$inferInsert {
  return { ...source, ...writeoff, id, oid, cartId: firstSplit || selected ? String(id) : source.cartId,
    oldCartId: firstSplit || selected ? source.oldCartId || source.cartId : source.oldCartId,
    cartNum: quantity, refundNum: selected ? quantity : 0, surplusNum: quantity,
    splitStatus: selected || delivered ? 2 : 0, splitSurplusNum: selected || delivered ? 0 : quantity,
    cartInfo: cartSnapshot(snapshot, firstSplit || selected ? String(id) : source.cartId, refundId, selected),
    unique: firstSplit || selected ? key() : source.unique };
}

/** Physical order/ledger persistence. Durable v2 refunds compose this with the
 * actual financial finalizer; legacy candidate fixtures may call it separately.
 * Server-only admission/DDL/invoice/promotion/read rollout remains gated.
 * A completed refund is required; this function never pays, restores stock,
 * settles users, calls a provider, or changes the original refund/payment row.
 * Lock order is refund -> payment root -> application order -> all carts. A
 * finalizer calling after users MUST already own those locks in this same tx;
 * reacquisition here is reentrant, never a late unowned parent/cart lock. */
export async function materializeCompletedRefundOrder(tx: DbClient, expected: RefundMaterializationIdentity, now: number,
  invoiceSnapshot?: RefundInvoiceSnapshot | null) {
  if (Object.hasOwn(tx, '$client')) throw Error('Refund materialization requires a caller-owned transaction');
  integer(now);
  const expectedFingerprint = await fingerprint(expected);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(63841, ${expected.id})`);
  const [previous] = await tx.select().from(storeOrderRefundSplit).where(eq(storeOrderRefundSplit.refundId, expected.id)).limit(1);
  if (previous) {
    if (previous.fingerprint !== expectedFingerprint) throw invalid();
    return result(previous, true);
  }
  const [refund] = await tx.select().from(storeOrderRefund).where(eq(storeOrderRefund.id, expected.id)).limit(1).for('update');
  if (!refund || await fingerprint(refund) !== expectedFingerprint || refund.refundType !== 6 || refund.isCancel || refund.isDel
    || cents(refund.refundedPrice) !== cents(refund.refundPrice)) throw invalid();
  const [preliminary] = await tx.select().from(storeOrder).where(eq(storeOrder.id, refund.storeOrderId)).limit(1);
  if (!preliminary || preliminary.pid < 0) throw invalid();
  const paymentId = preliminary.pid || preliminary.id;
  await lockOrderSettlement(tx, paymentId);
  const [root] = await tx.select().from(storeOrder).where(eq(storeOrder.id, paymentId)).limit(1).for('update');
  if (!root) throw invalid();
  if (paymentId !== preliminary.id) await lockOrderSettlement(tx, preliminary.id);
  const [source] = paymentId === preliminary.id ? [root] : await tx.select().from(storeOrder)
    .where(eq(storeOrder.id, preliminary.id)).limit(1).for('update');
  if (!source || source.pid !== preliminary.pid || source.paid !== 1 || root.paid !== 1 || source.isDel || source.isSystemDel
    || source.uid !== refund.uid || source.supplierId !== refund.supplierId || source.storeId !== refund.storeId
    || root.uid !== source.uid || source.payType !== root.payType || source.supplierAllocationStatus === 1
    || ![2, 3].includes(source.refundStatus) || source.refundType !== 6 || (source.pid > 0 && root.pid !== -1)
    || (root.supplierId !== source.supplierId && !(root.supplierId === 0 && root.supplierAllocationStatus === 2))
    || (root.storeId !== source.storeId && root.supplierAllocationStatus !== 2)) throw invalid();
  const carts = await tx.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, source.id))
    .orderBy(asc(storeOrderCartInfo.id)).limit(201).for('update');
  const priorGeneration = await loadRefundOrderGeneration(tx, source, carts);
  const other = await tx.select({ id: storeOrderRefund.id }).from(storeOrderRefund)
    .leftJoin(storeOrderRefundSplit, eq(storeOrderRefundSplit.refundId, storeOrderRefund.id)).where(and(
      eq(storeOrderRefund.storeOrderId, source.id), ne(storeOrderRefund.id, refund.id), eq(storeOrderRefund.isCancel, 0), eq(storeOrderRefund.isDel, 0),
      inArray(storeOrderRefund.refundType, [0, 1, 2, 4, 5, 6]), sql`${storeOrderRefundSplit.refundId} IS NULL`,
    )).limit(1);
  if (other.length) throw new ValidateException('其他售后尚未完成实体归属核对');
  const compensation = planCompletedRefundLineCompensation(source, carts, [refund]);
  if (!compensation || cents(source.backIntegral) !== compensation.usedIntegral * 100) throw invalid();
  const claim = readRefundQuantityReservation(refund)!;
  const selected = new Map(claim.items.map(item => [String(item.cartId), item.cartNum]));
  // Only the proven current claim may be removed from the planning view. This
  // is not a repair of arbitrary counters or a fallback for legacy evidence.
  if (carts.some(row => row.refundNum !== (selected.get(row.cartId) ?? 0)
    || ![0, 1, 2].includes(row.splitStatus) || (source.status === 0
      ? row.splitStatus === 2 || row.splitSurplusNum !== row.cartNum
      : !((row.splitStatus < 2 && row.splitSurplusNum === row.cartNum) || (row.splitStatus === 2 && row.splitSurplusNum === 0))))) throw invalid();
  const plan = planOrderFinancialSplit({ ...source, refundPrice: '0.00', backIntegral: '0.00' },
    carts.map(row => ({ ...row, refundNum: 0, splitStatus: 0, splitSurplusNum: row.cartNum })), selected);
  if (!plan) throw invalid();
  const disposition = refundSplitDisposition(source.status, carts, [...selected].map(([cartId, cartNum]) => ({ cartId, cartNum })));
  if (disposition === 'whole-order-gift-remainder') throw new ValidateException('未发货仅剩赠品，需要连同赠品库存与权益完成整单结算');
  if (disposition === 'split' && cents(source.freightPrice) !== 0) {
    throw new ValidateException('商家运费需要独立账本分摊证据，不能按顾客运费推断');
  }
  const payments = await tx.select().from(storeOrderRefundPayment).where(eq(storeOrderRefundPayment.refundId, refund.id)).limit(2);
  if (payments.length > 1 || (source.payType !== 'yue' && cents(refund.refundPrice) > 0 && payments.length !== 1)) throw invalid();
  if (payments.some(payment => payment.storeOrderId !== source.id || payment.providerStatus !== 'SUCCESS'
    || payment.requestAmount !== cents(refund.refundPrice) || payment.totalAmount !== cents(root.payPrice))) throw invalid();
  const previousRefundId = priorGeneration?.refundId ?? 0;
  const earnedIncomeScope = boundedJson(captureRefundEarnedIncomeScope(source, refund.id, priorGeneration?.earnedIncomeScope ?? null), 2048);
  const returnedPoints = [...new Set([...(priorGeneration?.returnedPointBillIds ?? []), ...await captureReturnedPointBills(tx, source)])];
  if (returnedPoints.length > 1024) throw invalid();
  const returnedPointBillIds = boundedJson(returnedPoints, 16384);
  const firstSplit = source.pid === 0;
  const mappings: Array<{ sourceRowId: number; sourceCartId: string; selectedRowId: number | null; remainingRowId: number | null;
    selectedNum: number; remainingNum: number }> = [];
  let selectedOrderId = source.id, remainingOrderId: number | null = null;
  if (disposition === 'whole-order') {
    await tx.update(storeOrder).set({ refundStatus: 2 }).where(eq(storeOrder.id, source.id));
    await tx.update(storeOrderCartInfo).set({ refundNum: 0, splitStatus: 2, splitSurplusNum: 0 }).where(eq(storeOrderCartInfo.oid, source.id));
    mappings.push(...carts.map(row => ({ sourceRowId: row.id, sourceCartId: row.cartId, selectedRowId: row.id,
      remainingRowId: null, selectedNum: row.cartNum, remainingNum: 0 })));
  } else {
    const children = await tx.select({ orderId: storeOrder.orderId }).from(storeOrder).where(eq(storeOrder.pid, root.id))
      .orderBy(asc(storeOrder.id)).limit(1001);
    if (children.length > 1000) throw invalid();
    const [selectedNo, remainingNo] = reserveChildOrderIds(root.orderId, children.map(row => row.orderId), firstSplit ? 2 : 1);
    const { id: _sourceId, ...base } = source;
    const selectedOrder = await tx.insert(storeOrder).values({ ...base, ...plan.selected, pid: root.id, orderId: selectedNo,
      unique: key(), cartId: '', refundStatus: 2, refundType: 6, refundPrice: refund.refundedPrice,
      backIntegral: source.backIntegral, verifyCode: '' }).returning({ id: storeOrder.id });
    selectedOrderId = selectedOrder[0]?.id ?? 0; if (!selectedOrderId) throw invalid();
    // Merchant freight is independently gated above. This structural candidate
    // must not invent expense ownership from customer postage or goods weights.
    const remainingData = { ...plan.remaining, refundStatus: 0, refundType: 0, refundPrice: '0.00', backIntegral: '0.00' };
    if (firstSplit) {
      const remaining = await tx.insert(storeOrder).values({ ...base, ...remainingData, pid: root.id, orderId: remainingNo,
        unique: key(), cartId: '', verifyCode: source.verifyCode ? await generatePickupVerifyCode(tx) : '' }).returning({ id: storeOrder.id });
      remainingOrderId = remaining[0]?.id ?? 0;
    } else {
      remainingOrderId = source.id;
      await tx.update(storeOrder).set(remainingData).where(eq(storeOrder.id, source.id));
    }
    if (!remainingOrderId) throw invalid();
    const count = carts.reduce((sum, row) => sum + ((selected.get(row.cartId) ?? 0) > 0 ? 1 : 0)
      + (firstSplit && (selected.get(row.cartId) ?? 0) < row.cartNum ? 1 : 0), 0);
    const ids = await reserveOrderCartRowIds(tx, count); let next = 0;
    const selectedRows: Array<typeof storeOrderCartInfo.$inferInsert> = [], remainingRows: Array<typeof storeOrderCartInfo.$inferInsert> = [];
    for (const row of carts) {
      const quantity = selected.get(row.cartId) ?? 0, parts = plan.carts.get(row.cartId)!;
      const selectedRowId = quantity ? ids[next++] : null;
      const remainingRowId = quantity < row.cartNum ? firstSplit ? ids[next++] : row.id : null;
      if (selectedRowId !== null) selectedRows.push(cloneCart(row, selectedRowId, selectedOrderId, quantity,
        parts.selected!, parts.selectedWriteoff!, true, firstSplit, source.status !== 0, refund.id));
      if (remainingRowId !== null) remainingRows.push(cloneCart(row, remainingRowId, remainingOrderId, row.cartNum - quantity,
        parts.remaining!, parts.remainingWriteoff!, false, firstSplit, source.status !== 0, refund.id));
      mappings.push({ sourceRowId: row.id, sourceCartId: row.cartId, selectedRowId, remainingRowId,
        selectedNum: quantity, remainingNum: row.cartNum - quantity });
    }
    await tx.insert(storeOrderCartInfo).values(selectedRows);
    if (firstSplit) {
      await tx.insert(storeOrderCartInfo).values(remainingRows);
      await tx.update(storeOrderCartInfo).set({ splitStatus: 2, splitSurplusNum: 0 }).where(eq(storeOrderCartInfo.oid, source.id));
      await tx.update(storeOrder).set({ pid: -1 }).where(eq(storeOrder.id, source.id));
    } else {
      const kept = new Set(remainingRows.map(row => row.id));
      const removedIds = carts.filter(row => !kept.has(row.id)).map(row => row.id);
      if (removedIds.length) await tx.delete(storeOrderCartInfo).where(and(eq(storeOrderCartInfo.oid, source.id), inArray(storeOrderCartInfo.id, removedIds)));
      for (const row of remainingRows) await tx.update(storeOrderCartInfo).set(row).where(and(eq(storeOrderCartInfo.id, row.id!), eq(storeOrderCartInfo.oid, source.id)));
    }
    await tx.update(storeOrder).set({ cartId: selectedRows.map(row => row.cartId).join(',') }).where(eq(storeOrder.id, selectedOrderId));
    await tx.update(storeOrder).set({ cartId: remainingRows.map(row => row.cartId).join(',') }).where(eq(storeOrder.id, remainingOrderId));
  }
  const supplierLedger = await splitSupplierRefundPayment(tx, source, refund, compensation, selectedOrderId, remainingOrderId, now);
  const invoiceAllocation = await materializeRefundInvoice(tx, source, refund, invoiceSnapshot, selectedOrderId, remainingOrderId);
  const sourceSnapshot = boundedJson({ version: 'refund-order-materialization-v1', source, carts, refund,
    payment: { id: root.id, orderId: root.orderId, tradeNo: root.tradeNo, payPrice: root.payPrice, payType: root.payType }, payments,
    supplierLedger }, 16777216);
  const [record] = await tx.insert(storeOrderRefundSplit).values({ refundId: refund.id, fingerprint: expectedFingerprint,
    uid: refund.uid, supplierId: refund.supplierId, storeId: refund.storeId, sourceOrderId: source.id, paymentOrderId: root.id,
    selectedOrderId, remainingOrderId, disposition: disposition === 'whole-order' ? 'whole' : 'split',
    previousRefundId, baseBranchId: priorGeneration?.baseBranchId ?? null, returnedPointBillIds, earnedIncomeScope, invoiceAllocation,
    sourceSnapshot, partitions: boundedJson(mappings, 131072), addTime: now }).returning();
  if (!record) throw invalid();
  await tx.insert(storeOrderStatus).values({ oid: source.id, changeType: 'refund_order_split',
    changeMessage: `退款 ${refund.id} 实体归属 ${selectedOrderId}，剩余订单 ${remainingOrderId ?? 0}`, changeTime: now });
  return result(record, false);
}
