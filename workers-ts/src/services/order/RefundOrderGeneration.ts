import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, storeOrderRefund, userBill } from '@/models/schema';
import { storeOrderRefundSplit } from '@/models/schema/order_refund_split';
import { ValidateException } from '@/utils/errors';
import { refundOrderSplitFingerprint } from './RefundOrderSplitIdentity';
import { captureRefundEarnedIncomeScope, readRefundEarnedIncomeScope, type RefundEarnedIncomeScope } from './RefundEarnedIncome';
import { readRefundGenerationMarker } from './RefundGenerationMarker';
import { loadRefundFulfillmentBranch, validateBranchCarts } from './RefundFulfillmentBranch';

type Order = typeof storeOrder.$inferSelect;
type Cart = typeof storeOrderCartInfo.$inferSelect;
type Refund = typeof storeOrderRefund.$inferSelect;
const invalid = () => new ValidateException('退款拆分代次证据不一致，请先核对订单');
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function integer(value: unknown, zero = false): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (zero ? 0 : 1) || value > 2147483647) throw invalid();
  return value;
}
function ids(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > 1024) throw invalid();
  const result = value.map(value => integer(value));
  if (new Set(result).size !== result.length) throw invalid();
  return result;
}

export interface RefundOrderGeneration {
  readonly refundId: number;
  readonly baseBranchId: string | null;
  readonly covered: ReadonlyMap<number, string>;
  readonly materialized: ReadonlyMap<number, string>;
  readonly returnedPointBillIds: readonly number[];
  readonly earnedIncomeScope: RefundEarnedIncomeScope | null;
}

/** Read only after the caller's order/cart locks. Unmarked orders do not query
 * the candidate table, so ordinary deployed schema has no new prerequisite.
 * Marked rows MUST resolve durable evidence; never catch a missing table/record
 * or use an ID/time cutoff as authority to ignore another refund. */
export async function loadRefundOrderGeneration(tx: DbClient, order: Order, supplied?: Cart[]): Promise<RefundOrderGeneration | null> {
  const rows = supplied ?? await tx.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, order.id))
    .orderBy(asc(storeOrderCartInfo.id)).limit(201).for('update');
  const markers = rows.map(row => {
    if (!row.cartInfo || (!row.cartInfo.includes('refund_order_generation') && !row.cartInfo.includes('refund-order-line-finance-v1'))) return null;
    if (new TextEncoder().encode(row.cartInfo).length > 65536) throw invalid();
    let parsed: unknown; try { parsed = JSON.parse(row.cartInfo); } catch { throw invalid(); }
    const info = object(parsed);
    if (!Object.hasOwn(info, 'refund_order_generation') || info.financial_version !== 'refund-order-line-finance-v1') throw invalid();
    const marker = readRefundGenerationMarker(info.refund_order_generation);
    if (marker.role !== 'remaining') throw invalid();
    return marker;
  });
  if (markers.every(marker => marker === null)) return null;
  const marker = markers[0];
  if (!marker || rows.length > 200 || markers.some(value => JSON.stringify(value) !== JSON.stringify(marker))
    || rows.some(row => row.oid !== order.id || row.uid !== order.uid)) throw invalid();
  const refundId = 'refundId' in marker ? marker.refundId : 0;
  // Project compact generation metadata, never fetch 200 x 16 MiB full source
  // snapshots. Only the current generation needs its bounded cart partitions.
  const records = await tx.select({ refundId: storeOrderRefundSplit.refundId, fingerprint: storeOrderRefundSplit.fingerprint,
    uid: storeOrderRefundSplit.uid, supplierId: storeOrderRefundSplit.supplierId, storeId: storeOrderRefundSplit.storeId,
    sourceOrderId: storeOrderRefundSplit.sourceOrderId, paymentOrderId: storeOrderRefundSplit.paymentOrderId,
    disposition: storeOrderRefundSplit.disposition,
    previousRefundId: storeOrderRefundSplit.previousRefundId,
    baseBranchId: storeOrderRefundSplit.baseBranchId,
    returnedPointBillIds: sql<unknown>`${storeOrderRefundSplit.returnedPointBillIds}::jsonb`,
    earnedIncomeScope: sql<unknown>`${storeOrderRefundSplit.earnedIncomeScope}::jsonb`,
    partitions: sql<unknown>`CASE WHEN ${storeOrderRefundSplit.refundId} = ${refundId} THEN ${storeOrderRefundSplit.partitions}::jsonb ELSE NULL END`,
  }).from(storeOrderRefundSplit).where(eq(storeOrderRefundSplit.remainingOrderId, order.id))
    .orderBy(asc(storeOrderRefundSplit.refundId)).limit(202);
  if (records.length > 201) throw invalid();
  const latest = refundId ? records.at(-1) : undefined;
  if (refundId && (!latest || latest.refundId !== refundId)) throw invalid();
  const baseBranchId = 'branchId' in marker ? marker.branchId : latest?.baseBranchId ?? null;
  const baseline = baseBranchId ? await loadRefundFulfillmentBranch(tx, order, baseBranchId) : null;
  const prior = baseline?.covered ?? new Map<number, string>();
  for (const record of records) {
    if (record.uid !== order.uid || record.supplierId !== order.supplierId || record.storeId !== order.storeId
      || record.paymentOrderId !== (order.pid || order.id) || record.disposition !== 'split'
      || !/^[0-9a-f]{64}$/.test(record.fingerprint)) throw invalid();
    if (prior.has(record.refundId) && (prior.get(record.refundId) !== record.fingerprint
      || (record.sourceOrderId === order.id) !== baseline!.materialized.has(record.refundId))) throw invalid();
  }
  if ([...prior].some(([id, hash]) => !records.some(record => record.refundId === id && record.fingerprint === hash))) throw invalid();
  const chain = records.filter(record => !prior.has(record.refundId));
  if ((!refundId && chain.length) || (refundId && prior.has(refundId))) throw invalid();
  const byId = new Map(chain.map(record => [record.refundId, record]));
  const materialized = new Map(baseline?.materialized), visited = new Set<number>();
  let current = latest;
  while (current) {
    if (visited.has(current.refundId) || current.uid !== order.uid || current.supplierId !== order.supplierId
      || current.storeId !== order.storeId || current.paymentOrderId !== (order.pid || order.id)
      || current.disposition !== 'split' || !/^[0-9a-f]{64}$/.test(current.fingerprint)
      || current.baseBranchId !== baseBranchId) throw invalid();
    visited.add(current.refundId);
    const previous = integer(current.previousRefundId, true);
    ids(current.returnedPointBillIds);
    if (current.sourceOrderId === order.id) materialized.set(current.refundId, current.fingerprint);
    else if (baseBranchId || previous !== 0 || current.sourceOrderId !== current.paymentOrderId) throw invalid();
    if (!previous) break;
    if (previous >= current.refundId || !byId.has(previous)) throw invalid();
    current = byId.get(previous);
  }
  if (visited.size !== chain.length) throw invalid();
  let earnedIncomeScope: RefundEarnedIncomeScope | null = null;
  for (const record of chain) {
    const scope = readRefundEarnedIncomeScope(record.earnedIncomeScope);
    if (earnedIncomeScope) {
      if (JSON.stringify(scope) !== JSON.stringify(earnedIncomeScope)) throw invalid();
    } else if (scope && (scope.refundId !== record.refundId || scope.orderId !== record.sourceOrderId || scope.uid !== order.uid)) throw invalid();
    earnedIncomeScope = scope;
  }
  if (earnedIncomeScope) captureRefundEarnedIncomeScope(order, refundId, earnedIncomeScope);
  if (!latest) {
    if (!baseline) throw invalid();
    validateBranchCarts(baseline.partitions, rows);
  } else {
    if (!Array.isArray(latest.partitions) || latest.partitions.length > 200) throw invalid();
    const expected = new Map<number, { quantity: number; cartId: string }>();
    for (const value of latest.partitions) {
      const part = object(value), quantity = integer(part.remainingNum, true);
      if (quantity === 0) { if (part.remainingRowId !== null) throw invalid(); continue; }
      const rowId = integer(part.remainingRowId);
      if (expected.has(rowId)) throw invalid();
      const cartId = latest.sourceOrderId === order.id ? part.sourceCartId : String(rowId);
      if (typeof cartId !== 'string' || !/^[1-9]\d{0,9}$/.test(cartId)) throw invalid();
      expected.set(rowId, { quantity, cartId });
    }
    if (expected.size !== rows.length || rows.some(row => expected.get(row.id)?.quantity !== row.cartNum
      || expected.get(row.id)?.cartId !== row.cartId)) throw invalid();
  }
  const result = { refundId, baseBranchId, covered: new Map(records.map(record => [record.refundId, record.fingerprint])), materialized, earnedIncomeScope,
    returnedPointBillIds: latest?.sourceOrderId === order.id ? ids(latest.returnedPointBillIds) : baseline?.returnedPointBillIds ?? [] };
  if (materialized.size) {
    const history = await tx.select().from(storeOrderRefund).where(inArray(storeOrderRefund.id, [...materialized.keys()])).limit(202);
    await currentGenerationRefunds(history, result);
  }
  return result;
}

/** Validate every ignored business row against its immutable receipt. Deleted
 * history can remain absent; a changed surviving completed row is not ignored. */
export async function currentGenerationRefunds(refunds: Refund[], generation: RefundOrderGeneration | null): Promise<Refund[]> {
  if (!generation) return refunds;
  const current: Refund[] = [];
  for (const refund of refunds) {
    const expected = generation.materialized.get(refund.id);
    if (!expected) { current.push(refund); continue; }
    if (refund.refundType !== 6 || refund.isCancel || refund.refundedPrice !== refund.refundPrice
      || await refundOrderSplitFingerprint(refund) !== expected) throw invalid();
  }
  return current;
}

/** Exact pre-materialization return-bill identities, not a time/sequence cutoff
 * and not a rewritten ledger. The source order lock serializes its writers. */
export async function captureReturnedPointBills(tx: DbClient, order: Order): Promise<number[]> {
  const refunds = await tx.select({ orderId: storeOrderRefund.orderId }).from(storeOrderRefund)
    .where(and(eq(storeOrderRefund.storeOrderId, order.id), eq(storeOrderRefund.refundType, 6))).limit(202);
  if (refunds.length > 201) throw invalid();
  const bills = await tx.select({ id: userBill.id, number: userBill.number }).from(userBill).where(and(
    eq(userBill.uid, order.uid), inArray(userBill.linkId, [String(order.id), ...refunds.map(refund => refund.orderId)]),
    eq(userBill.pm, 1), eq(userBill.category, 'integral'), eq(userBill.status, 1),
    inArray(userBill.type, ['pay_product_integral_back', 'order_integral_refund']),
  )).orderBy(asc(userBill.id)).limit(1025);
  if (bills.some(bill => !/^\d{1,10}(?:\.0{1,2})?$/.test(bill.number))) throw invalid();
  return ids(bills.map(bill => bill.id));
}
