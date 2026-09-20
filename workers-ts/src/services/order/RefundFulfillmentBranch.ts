import { and, asc, eq } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrder, storeOrderCartInfo } from '@/models/schema';
import { storeOrderFulfillmentBranch, storeOrderRefundSplit } from '@/models/schema/order_refund_split';
import { ValidateException } from '@/utils/errors';
import type { RefundOrderGeneration } from './RefundOrderGeneration';

type Order = typeof storeOrder.$inferSelect;
type Cart = typeof storeOrderCartInfo.$inferSelect;
const invalid = () => new ValidateException('退款履约分支证据不一致，请先核对订单');
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
function json(value: unknown, limit: number): string {
  const result = JSON.stringify(value);
  if (result === undefined || new TextEncoder().encode(result).length > limit) throw invalid();
  return result;
}
function parse(value: string, limit: number): unknown {
  if (new TextEncoder().encode(value).length > limit) throw invalid();
  try { return JSON.parse(value); } catch { throw invalid(); }
}
function history(value: unknown): Map<number, string> {
  if (!Array.isArray(value) || value.length > 201) throw invalid();
  const result = new Map<number, string>();
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || !integer(entry[0]) || typeof entry[1] !== 'string'
      || !/^[0-9a-f]{64}$/.test(entry[1]) || result.has(entry[0])) throw invalid();
    result.set(entry[0], entry[1]);
  }
  return result;
}
export interface FulfillmentBranchPartition { sourceRowId: number; rowId: number; cartId: string; quantity: number }
function partitions(value: unknown): FulfillmentBranchPartition[] {
  if (!Array.isArray(value) || !value.length || value.length > 200) throw invalid();
  const result = value.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw invalid();
    const part = entry as Record<string, unknown>;
    if (Object.keys(part).length !== 4 || !integer(part.sourceRowId) || !integer(part.rowId) || !integer(part.quantity)
      || typeof part.cartId !== 'string' || !/^[1-9]\d{0,9}$/.test(part.cartId)) throw invalid();
    return { sourceRowId: part.sourceRowId, rowId: part.rowId, cartId: part.cartId, quantity: part.quantity };
  });
  if (new Set(result.map(row => row.rowId)).size !== result.length || new Set(result.map(row => row.cartId)).size !== result.length) throw invalid();
  return result;
}
export function validateBranchCarts(expected: FulfillmentBranchPartition[], rows: Cart[]): void {
  const byId = new Map(expected.map(part => [part.rowId, part]));
  if (byId.size !== rows.length || rows.some(row => byId.get(row.id)?.quantity !== row.cartNum || byId.get(row.id)?.cartId !== row.cartId)) throw invalid();
}

/** No recursive full-snapshot reads: this baseline records the exact validated
 * refund identities at the fork, including prior retained-ID generations. */
export async function loadRefundFulfillmentBranch(tx: DbClient, order: Order, id: string) {
  if (!/^[0-9a-f]{32}$/.test(id)) throw invalid();
  const [record] = await tx.select().from(storeOrderFulfillmentBranch).where(eq(storeOrderFulfillmentBranch.id, id)).limit(1);
  if (!record || record.childOrderId !== order.id || record.uid !== order.uid || record.supplierId !== order.supplierId
    || record.storeId !== order.storeId || record.paymentOrderId !== order.pid || order.pid <= 0) throw invalid();
  if (record.sourceRefundId > 0) {
    const [anchor] = await tx.select({ remainingOrderId: storeOrderRefundSplit.remainingOrderId,
      uid: storeOrderRefundSplit.uid, supplierId: storeOrderRefundSplit.supplierId, storeId: storeOrderRefundSplit.storeId,
      paymentOrderId: storeOrderRefundSplit.paymentOrderId, baseBranchId: storeOrderRefundSplit.baseBranchId,
      earnedIncomeScope: storeOrderRefundSplit.earnedIncomeScope }).from(storeOrderRefundSplit)
      .where(eq(storeOrderRefundSplit.refundId, record.sourceRefundId)).limit(1);
    if (!anchor || anchor.remainingOrderId !== record.sourceOrderId || anchor.uid !== order.uid
      || anchor.supplierId !== order.supplierId || anchor.storeId !== order.storeId || anchor.paymentOrderId !== order.pid
      || anchor.baseBranchId !== record.sourceBranchId || anchor.earnedIncomeScope !== 'null') throw invalid();
  }
  if (record.sourceBranchId) {
    const [parent] = await tx.select({ id: storeOrderFulfillmentBranch.id, childOrderId: storeOrderFulfillmentBranch.childOrderId,
      uid: storeOrderFulfillmentBranch.uid, supplierId: storeOrderFulfillmentBranch.supplierId,
      storeId: storeOrderFulfillmentBranch.storeId, paymentOrderId: storeOrderFulfillmentBranch.paymentOrderId })
      .from(storeOrderFulfillmentBranch).where(eq(storeOrderFulfillmentBranch.id, record.sourceBranchId)).limit(1);
    if (!parent || parent.id === id || parent.childOrderId !== record.sourceOrderId || parent.uid !== order.uid
      || parent.supplierId !== order.supplierId || parent.storeId !== order.storeId || parent.paymentOrderId !== order.pid) throw invalid();
  } else if (!record.sourceRefundId) throw invalid();
  const covered = history(parse(record.coveredRefunds, 32768));
  const materialized = history(parse(record.materializedRefunds, 32768));
  if ([...materialized].some(([refundId, hash]) => covered.get(refundId) !== hash)) throw invalid();
  const bills = parse(record.returnedPointBillIds, 16384);
  if (!Array.isArray(bills) || bills.length > 1024 || !bills.every(integer) || new Set(bills).size !== bills.length) throw invalid();
  if (record.childOrderId !== record.sourceOrderId && (covered.size || materialized.size || bills.length)) throw invalid();
  return { covered, materialized, returnedPointBillIds: bills, partitions: partitions(parse(record.partitions, 32768)) };
}

/** Caller has locked root -> source -> carts and validated financial partition.
 * Called in the SAME fulfillment transaction as the child/ledger writes. Never
 * install candidate DDL here. Null generation leaves ordinary orders untouched. */
export async function persistRefundFulfillmentBranches(tx: DbClient, source: Order, sourceCarts: Cart[],
  generation: RefundOrderGeneration | null, returnedBills: readonly number[],
  children: readonly { orderId: number; partitions: FulfillmentBranchPartition[] }[], now: number): Promise<void> {
  if (!generation) return;
  if (Object.hasOwn(tx, '$client') || source.status !== 0 || source.pid <= 0 || generation.earnedIncomeScope
    || source.refundPrice !== '0.00' || source.backIntegral !== '0.00' || children.length !== 2
    || new Set(children.map(child => child.orderId)).size !== 2 || !children.some(child => child.orderId === source.id)) throw invalid();
  const totals = new Map<number, number>();
  const allRows = new Set<number>();
  for (const child of children) for (const part of partitions(child.partitions)) {
    if (allRows.has(part.rowId)) throw invalid(); allRows.add(part.rowId);
    totals.set(part.sourceRowId, (totals.get(part.sourceRowId) ?? 0) + part.quantity);
  }
  if (totals.size !== sourceCarts.length || sourceCarts.some(row => totals.get(row.id) !== row.cartNum)) throw invalid();
  const bills = [...new Set([...generation.returnedPointBillIds, ...returnedBills])];
  if (bills.length > 1024 || !bills.every(integer)) throw invalid();
  for (const child of children) {
    const [order] = await tx.select().from(storeOrder).where(eq(storeOrder.id, child.orderId)).limit(1);
    if (!order || order.uid !== source.uid || order.supplierId !== source.supplierId || order.storeId !== source.storeId
      || order.pid !== source.pid || order.payType !== source.payType || order.paid !== 1
      || order.status !== (child.orderId === source.id ? 0 : 1)) throw invalid();
    const rows = await tx.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, child.orderId))
      .orderBy(asc(storeOrderCartInfo.id)).limit(201);
    validateBranchCarts(child.partitions, rows);
    const id = crypto.randomUUID().replaceAll('-', ''), retained = child.orderId === source.id;
    await tx.insert(storeOrderFulfillmentBranch).values({ id, sourceBranchId: generation.baseBranchId,
      sourceRefundId: generation.refundId, sourceOrderId: source.id, paymentOrderId: source.pid,
      childOrderId: child.orderId, uid: source.uid, supplierId: source.supplierId, storeId: source.storeId,
      coveredRefunds: json(retained ? [...generation.covered] : [], 32768),
      materializedRefunds: json(retained ? [...generation.materialized] : [], 32768),
      returnedPointBillIds: json(retained ? bills : [], 16384), partitions: json(child.partitions, 32768), addTime: now });
    for (const row of rows) {
      const parsed = parse(row.cartInfo ?? '', 65536);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || row.uid !== source.uid) throw invalid();
      const cartInfo = json({ ...parsed, financial_version: 'refund-order-line-finance-v1',
        refund_order_generation: { branchId: id, role: 'remaining' } }, 65536);
      await tx.update(storeOrderCartInfo).set({ cartInfo }).where(and(eq(storeOrderCartInfo.id, row.id), eq(storeOrderCartInfo.oid, child.orderId)));
    }
  }
}
