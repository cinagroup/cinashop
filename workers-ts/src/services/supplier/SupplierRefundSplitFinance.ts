import { and, asc, eq, inArray } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, storeOrderRefund, supplierFlowingWater, supplierTransactions } from '@/models/schema';
import type { RefundLineCompensation } from '@/services/order/OrderSplitFinance';
import { ValidateException } from '@/utils/errors';
import { lockSupplierFinance } from './SupplierFinanceLock';

type Order = typeof storeOrder.$inferSelect;
const invalid = (): never => { throw new ValidateException('供应商退款拆单账本归属不一致，请先核对'); };
function minor(value: string): bigint {
  if (!/^\d{1,10}\.\d{2}$/.test(value)) return invalid();
  return BigInt(value.replace('.', ''));
}
function decimal(value: bigint): string {
  if (value < 0n || value > 999999999999n) return invalid();
  return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}

/** Candidate materializer only, inside its root/order/cart transaction.
 * Retire the original accounting representation, not its amounts or identities;
 * derive separate child entitlements and the completed child's refund expense.
 * This never rewrites supplierTransactions or pays/refunds customer funds.
 * Original rows plus the returned snapshot preserve the complete lineage. */
export async function splitSupplierRefundPayment(tx: DbClient, source: Order,
  refund: typeof storeOrderRefund.$inferSelect, plan: RefundLineCompensation,
  selectedOrderId: number, remainingOrderId: number | null, now: number) {
  if (source.supplierId === 0) return null;
  const basis = plan.supplierSettlement;
  if (!basis) return invalid();
  if ([basis.total, basis.refunded].some(value => !Number.isSafeInteger(value) || value < 0 || value > 999999999999)
    || basis.refunded > basis.total || source.paid !== 1 || ![0, 1, 2, 3].includes(source.status)
    || refund.storeOrderId !== source.id || refund.supplierId !== source.supplierId || refund.uid !== source.uid
    || refund.refundType !== 6 || refund.isCancel || refund.isDel
    || minor(refund.refundedPrice) !== minor(refund.refundPrice) || minor(source.refundPrice) !== minor(refund.refundedPrice)) invalid();
  await lockSupplierFinance(tx, source.supplierId);
  const rows = await tx.select().from(supplierFlowingWater).where(and(
    eq(supplierFlowingWater.supplierId, source.supplierId), eq(supplierFlowingWater.linkId, source.orderId),
    eq(supplierFlowingWater.isDel, 0), inArray(supplierFlowingWater.status, [0, 1]),
  )).orderBy(asc(supplierFlowingWater.id)).limit(3).for('update');
  const income = rows.find(row => row.pm === 1 && row.type === 1), expense = rows.find(row => row.pm === 0 && row.type === 2);
  if (rows.length !== 2 || !income || !expense || rows.some(row => row.uid !== source.uid || row.payType !== source.payType)
    || income.status !== expense.status || minor(income.number) !== BigInt(basis.total)
    || minor(expense.number) !== BigInt(basis.refunded)
    || expense.orderId !== `R${refund.id}-${source.orderId}` || minor(expense.payPrice) !== minor(refund.refundedPrice)
    || minor(expense.totalPrice) !== minor(source.totalPrice) || minor(expense.payPostage) !== 0n
    || ['payPrice', 'totalPrice', 'payPostage'].some(field => {
      const key = field as 'payPrice' | 'totalPrice' | 'payPostage';
      return minor(income[key]) !== minor(source[key]);
    })) return invalid();
  const transactions = await tx.select().from(supplierTransactions).where(eq(supplierTransactions.orderId, expense.orderId)).limit(2).for('update');
  const transaction = transactions[0];
  if (transactions.length !== 1 || !transaction || transaction.supplierId !== source.supplierId || transaction.uid !== source.uid
    || transaction.linkId !== source.orderId || transaction.payType !== source.payType || transaction.pm !== 0 || transaction.type !== 2
    || transaction.isDel || minor(transaction.payPrice) !== minor(refund.refundedPrice)
    || minor(transaction.totalPrice) !== minor(source.totalPrice) || minor(transaction.payPostage) !== 0n) invalid();
  const evidence = { version: 'supplier-refund-ledger-v1' as const, income, expense, transaction, derivedFlowIds: [] as number[] };
  if (remainingOrderId === null) {
    if (selectedOrderId !== source.id || !basis.fullyRefunded || basis.refunded !== basis.total || income.status !== 1) invalid();
    return evidence;
  }
  if (basis.fullyRefunded || selectedOrderId === source.id || selectedOrderId === remainingOrderId
    || income.status !== (source.status < 2 ? 0 : 1)) invalid();
  const childIds = [selectedOrderId, remainingOrderId];
  const children = await tx.select().from(storeOrder).where(inArray(storeOrder.id, childIds)).orderBy(asc(storeOrder.id));
  const selected = children.find(row => row.id === selectedOrderId), remaining = children.find(row => row.id === remainingOrderId);
  if (children.length !== 2 || !selected || !remaining || children.some(child => child.supplierId !== source.supplierId
    || child.uid !== source.uid || child.paid !== 1 || child.payType !== source.payType || child.shippingType !== source.shippingType
    || child.status !== source.status || child.pid !== (source.pid || source.id))
    || selected.refundStatus !== 2 || minor(selected.refundPrice) !== minor(refund.refundedPrice)
    || remaining.refundStatus !== 0 || minor(remaining.refundPrice) !== 0n) return invalid();
  for (const field of ['payPrice', 'totalPrice', 'payPostage'] as const) {
    if (children.reduce((sum, child) => sum + minor(child[field]), 0n) !== minor(source[field])) invalid();
  }
  const existingChildFlows = await tx.select({ id: supplierFlowingWater.id }).from(supplierFlowingWater).where(and(
    eq(supplierFlowingWater.supplierId, source.supplierId), inArray(supplierFlowingWater.linkId, children.map(child => child.orderId)),
    eq(supplierFlowingWater.isDel, 0), inArray(supplierFlowingWater.status, [0, 1]),
  )).orderBy(asc(supplierFlowingWater.id)).limit(3).for('update');
  // A retained remainder may still own the source pair, but a new child must
  // never inherit an unexplained active income/expense merely sharing its link.
  if (existingChildFlows.some(row => row.id !== income.id && row.id !== expense.id)) invalid();
  const carts = await tx.select().from(storeOrderCartInfo).where(inArray(storeOrderCartInfo.oid, childIds))
    .orderBy(asc(storeOrderCartInfo.id)).limit(401);
  if (!carts.length || carts.length > 400) invalid();
  const amounts = new Map<number, bigint>();
  for (const child of children) {
    const lines = carts.filter(row => row.oid === child.id);
    let total = [2, 4].includes(child.shippingType) ? 0n : minor(child.payPostage), quantity = 0;
    for (const line of lines) {
      if (line.uid !== source.uid || !Number.isSafeInteger(line.cartNum) || line.cartNum <= 0
        || line.refundNum !== (child.id === selectedOrderId ? line.cartNum : 0)) invalid();
      total += minor(line.settlePrice) * BigInt(line.cartNum); quantity += line.cartNum;
    }
    if (!lines.length || quantity !== child.totalNum) invalid();
    decimal(total); amounts.set(child.id, total);
  }
  if (amounts.get(selectedOrderId) !== BigInt(basis.refunded)
    || [...amounts.values()].reduce((sum, value) => sum + value, 0n) !== BigInt(basis.total)) invalid();
  // Keep original financial fields/timestamps intact. status=-1 retires only
  // this representation, while the immutable materialization records its state.
  await tx.update(supplierFlowingWater).set({ status: -1 }).where(inArray(supplierFlowingWater.id, [income.id, expense.id]));
  const { id: _incomeId, ...incomeFields } = income, { id: _expenseId, ...expenseFields } = expense;
  const lineage = (flowId: number, role: 'selected' | 'remaining') => JSON.stringify({
    version: 'supplier-refund-split-v1', refundId: refund.id, sourceFlowId: flowId, sourceOrderId: source.id, role,
  });
  const derived = await tx.insert(supplierFlowingWater).values([
    ...children.map(child => {
      const closed = child.id === selectedOrderId, status = closed ? 1 : income.status;
      return { ...incomeFields, orderId: `S${income.id}-${child.id}`, linkId: child.orderId,
        number: decimal(amounts.get(child.id)!), payPrice: child.payPrice, totalPrice: child.totalPrice, payPostage: child.payPostage,
        status, finishTime: status === 1 ? income.status === 1 ? income.finishTime : now : 0,
        remark: lineage(income.id, closed ? 'selected' : 'remaining') };
    }),
    { ...expenseFields, orderId: `D${expense.id}-${selectedOrderId}`, linkId: selected.orderId,
      totalPrice: selected.totalPrice, status: 1, finishTime: expense.status === 1 ? expense.finishTime : now,
      remark: lineage(expense.id, 'selected') },
  ]).returning({ id: supplierFlowingWater.id });
  evidence.derivedFlowIds = derived.map(row => row.id);
  return evidence;
}
