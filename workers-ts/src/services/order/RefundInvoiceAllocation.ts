import { and, asc, eq, inArray } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrder, storeOrderInvoice } from '@/models/schema';
import { amountToCents } from '@/services/payment/RefundGateway';
import { ValidateException } from '@/utils/errors';
import type { RefundMaterializationIdentity } from './RefundOrderSplitIdentity';
import { assertUnissuedInvoiceHistory } from './InvoiceIssuanceEvidence';

type Order = typeof storeOrder.$inferSelect;
export type RefundInvoiceSnapshot = typeof storeOrderInvoice.$inferSelect;
const invalid = () => new ValidateException('退款发票归属或金额证据不一致，请先核对订单');
const invoiceOrders = (source: Order) => source.pid > 0 ? [source.pid, source.id] : [source.id];
function cents(value: string): number {
  const result = amountToCents(value); if (result === null || result < 0) throw invalid(); return result;
}
function bounded(value: unknown): string {
  const result = JSON.stringify(value);
  if (result === undefined || new TextEncoder().encode(result).length > 16384) throw invalid();
  return result;
}
function validateInvoice(source: Order, invoice: RefundInvoiceSnapshot, selectedPayment: string, refundAmount: string) {
  if (invoice.orderId !== source.id) throw new ValidateException('支付主单发票尚需履约子单归属适配');
  if (invoice.uid !== source.uid || invoice.category !== 'order' || invoice.isPay !== 1 || invoice.isRefund !== 0 || invoice.isDel !== 0
    || cents(invoice.invoiceAmount) !== cents(source.payPrice)) throw invalid();
  if (![0, -1].includes(invoice.isInvoice) || invoice.invoiceNumber !== '') {
    throw new ValidateException('已开票订单退款尚需原票与红冲处理，不能复制票号');
  }
  if (cents(selectedPayment) !== cents(refundAmount)) {
    throw new ValidateException('含发票的少退金额尚需保留对价归属，不能丢弃差额');
  }
  bounded(invoice);
}

/** Caller owns payment-root/source/cart locks. Lock existing invoices before
 * financial/user locks; coordinating other writers remains a rollout gate. Only
 * unissued applications can be partitioned, never actual issued documents. */
export async function prepareRefundInvoice(tx: DbClient, source: Order, selectedPayment: string,
  refundAmount: string): Promise<RefundInvoiceSnapshot | null> {
  if (Object.hasOwn(tx, '$client')) throw Error('Refund invoice requires a caller-owned transaction');
  const rows = await tx.select().from(storeOrderInvoice).where(and(
    inArray(storeOrderInvoice.orderId, invoiceOrders(source)), eq(storeOrderInvoice.isDel, 0),
  )).orderBy(asc(storeOrderInvoice.id)).limit(3).for('update');
  if (!rows.length) { await assertUnissuedInvoiceHistory(tx, source); return null; }
  if (rows.length !== 1) throw invalid();
  const invoice = rows[0];
  validateInvoice(source, invoice, selectedPayment, refundAmount);
  await assertUnissuedInvoiceHistory(tx, source, invoice);
  return invoice;
}

/** Runs inside the same financial/physical finalizer. source is the locked
 * pre-split order. Re-read, but never acquire a new late invoice row lock after
 * users: the prepared invoice is already locked by this transaction. An absent
 * preparation cannot authorize post-financial invoice repair. */
export async function materializeRefundInvoice(tx: DbClient, source: Order, refund: RefundMaterializationIdentity,
  prepared: RefundInvoiceSnapshot | null | undefined, selectedOrderId: number, remainingOrderId: number | null): Promise<string> {
  if (Object.hasOwn(tx, '$client')) throw Error('Refund invoice requires a caller-owned transaction');
  const rows = await tx.select().from(storeOrderInvoice).where(and(
    inArray(storeOrderInvoice.orderId, invoiceOrders(source)), eq(storeOrderInvoice.isDel, 0),
  )).orderBy(asc(storeOrderInvoice.id)).limit(3);
  if (!rows.length && !prepared) { await assertUnissuedInvoiceHistory(tx, source); return 'null'; }
  if (!prepared || rows.length !== 1 || bounded(rows[0]) !== bounded(prepared)) throw invalid();
  const targets = await tx.select().from(storeOrder).where(inArray(storeOrder.id,
    remainingOrderId === null ? [selectedOrderId] : [selectedOrderId, remainingOrderId])).limit(2);
  const selected = targets.find(row => row.id === selectedOrderId), remaining = targets.find(row => row.id === remainingOrderId);
  if (!selected || (remainingOrderId !== null && !remaining) || targets.some(row => row.uid !== source.uid
    || row.supplierId !== source.supplierId || row.storeId !== source.storeId || row.paid !== 1 || row.payType !== source.payType
    || row.isDel || row.isSystemDel || (row.id !== source.id && row.pid !== (source.pid || source.id)))
    || cents(selected.payPrice) !== cents(refund.refundPrice)
    || cents(selected.payPrice) + (remaining ? cents(remaining.payPrice) : 0) !== cents(prepared.invoiceAmount)) throw invalid();
  validateInvoice(source, prepared, selected.payPrice, refund.refundPrice);
  await assertUnissuedInvoiceHistory(tx, source, prepared);
  let selectedInvoiceId = prepared.id, remainingInvoiceId: number | null = null;
  let sourceChange: Partial<typeof storeOrderInvoice.$inferInsert>;
  if (remaining) {
    const { id: _id, ...base } = prepared;
    const [created] = await tx.insert(storeOrderInvoice).values({ ...base, orderId: selected.id,
      invoiceAmount: selected.payPrice, isRefund: 1 }).returning({ id: storeOrderInvoice.id });
    if (!created) throw invalid(); selectedInvoiceId = created.id;
    if (source.pid === 0) {
      const [retained] = await tx.insert(storeOrderInvoice).values({ ...base, orderId: remaining.id,
        invoiceAmount: remaining.payPrice, isRefund: 0 }).returning({ id: storeOrderInvoice.id });
      if (!retained) throw invalid(); remainingInvoiceId = retained.id;
      // Archive rather than delete the original application. Its immutable
      // pre-split fields are also retained by the append-only allocation receipt.
      sourceChange = { isDel: 1, isRefund: 1 };
    } else {
      if (remaining.id !== source.id) throw invalid();
      remainingInvoiceId = prepared.id;
      sourceChange = { invoiceAmount: remaining.payPrice };
    }
  } else {
    if (selected.id !== source.id) throw invalid();
    sourceChange = { isRefund: 1 };
  }
  const [updated] = await tx.update(storeOrderInvoice).set(sourceChange)
    .where(and(eq(storeOrderInvoice.id, prepared.id), eq(storeOrderInvoice.isDel, 0))).returning({ id: storeOrderInvoice.id });
  if (!updated) throw invalid();
  return bounded({ version: 'refund-invoice-allocation-v1', sourceOrderId: source.id, paymentOrderId: source.pid || source.id,
    original: prepared, selected: { invoiceId: selectedInvoiceId, orderId: selected.id, amount: selected.payPrice },
    remaining: remaining ? { invoiceId: remainingInvoiceId, orderId: remaining.id, amount: remaining.payPrice } : null });
}
