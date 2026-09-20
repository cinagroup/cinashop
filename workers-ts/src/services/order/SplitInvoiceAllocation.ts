import { and, asc, eq, inArray } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrder, storeOrderInvoice } from '@/models/schema';
import { storeOrderInvoiceAllocation as allocation } from '@/models/schema/invoice_allocation';
import { amountToCents } from '@/services/payment/RefundGateway';
import { ValidateException } from '@/utils/errors';
import { assertUnissuedInvoiceHistory } from './InvoiceIssuanceEvidence';

type Order = typeof storeOrder.$inferSelect;
type Invoice = typeof storeOrderInvoice.$inferSelect;
type Reason = 'fulfillment' | 'supplier';
const invalid = () => new ValidateException('拆单发票归属或金额证据不一致，请先核对订单');
const ids = (source: Order) => source.pid > 0 ? [source.pid, source.id] : [source.id];
function bounded(value: unknown, limit = 16384): string {
  const text = JSON.stringify(value);
  if (text === undefined || new TextEncoder().encode(text).length > limit) throw invalid();
  return text;
}
function cents(value: string): number {
  const amount = amountToCents(value);
  if (amount === null || amount < 0) throw invalid();
  return amount;
}
function transaction(tx: DbClient) {
  if (Object.hasOwn(tx, '$client')) throw Error('Split invoice requires a caller-owned transaction');
}
function validate(source: Order, invoice: Invoice) {
  if (source.pid < 0 || source.paid !== 1 || source.isDel || source.isSystemDel
    || invoice.orderId !== source.id || invoice.uid !== source.uid || invoice.category !== 'order'
    || invoice.isPay !== 1 || invoice.isDel !== 0 || invoice.isRefund !== 0
    || cents(invoice.invoiceAmount) !== cents(source.payPrice)) throw invalid();
  // Out also uses invoiceTime for metadata/rejection edits; only immutable
  // history, not that mutable timestamp, establishes never-issued status.
  if (![0, -1].includes(invoice.isInvoice) || invoice.invoiceNumber !== '') {
    throw new ValidateException('已开票或票据状态不明，拆单需先完成原票核验与红冲处理');
  }
  bounded(invoice);
}
const activeInvoices = (tx: DbClient, source: Order) => tx.select().from(storeOrderInvoice).where(and(
  inArray(storeOrderInvoice.orderId, ids(source)), eq(storeOrderInvoice.isDel, 0),
)).orderBy(asc(storeOrderInvoice.id)).limit(3);

/** Root/source/cart locks precede invoice locks, which precede supplier/user
 * financial locks. Locking alone does not block whole-order/no-split actions. */
export async function lockSplitInvoices(tx: DbClient, source: Order): Promise<Invoice[]> {
  transaction(tx);
  return activeInvoices(tx, source).for('update');
}
export async function prepareSplitInvoice(tx: DbClient, source: Order, locked?: Invoice[]): Promise<Invoice | null> {
  transaction(tx);
  const rows = locked ?? await lockSplitInvoices(tx, source);
  // This is a mandatory coordinated schema dependency, including no-invoice
  // splits. Missing history must never mean no previous issued document.
  await tx.select({ id: allocation.id }).from(allocation).limit(0);
  if (rows.length > 1) throw invalid();
  const invoice = rows[0];
  if (invoice) validate(source, invoice);
  await assertUnissuedInvoiceHistory(tx, source, invoice);
  return invoice ?? null;
}

/** Physical child orders already exist in the same transaction. No late locks
 * and no outside I/O. Financial amounts come from those authoritative rows,
 * never a second invoice-specific rounding algorithm. */
export async function materializeSplitInvoice(tx: DbClient, source: Order, prepared: Invoice | null,
  targetIds: number[], reason: Reason, now: number): Promise<void> {
  transaction(tx);
  const current = await activeInvoices(tx, source);
  if (!prepared && !current.length) { await assertUnissuedInvoiceHistory(tx, source); return; }
  if (!prepared || current.length !== 1 || bounded(current[0]) !== bounded(prepared)) throw invalid();
  validate(source, prepared);
  await assertUnissuedInvoiceHistory(tx, source, prepared);
  if (targetIds.length < 2 || targetIds.length > 200 || new Set(targetIds).size !== targetIds.length
    || targetIds.some(id => !Number.isSafeInteger(id) || id <= 0)) throw invalid();
  const rows = await tx.select().from(storeOrder).where(inArray(storeOrder.id, targetIds)).limit(200);
  const targets = targetIds.map(id => rows.find(row => row.id === id));
  const rootId = source.pid > 0 ? source.pid : source.id;
  if (targets.some(row => !row || row.uid !== source.uid || row.storeId !== source.storeId
    || row.paid !== 1 || row.payType !== source.payType || row.isDel || row.isSystemDel || row.pid !== rootId
    || (reason === 'fulfillment' && row.supplierId !== source.supplierId))
    || (source.pid === 0 && targetIds.includes(source.id))
    || (source.pid > 0 && (reason !== 'fulfillment' || !targetIds.includes(source.id)))
    || rows.reduce((sum, row) => sum + cents(row.payPrice), 0) !== cents(prepared.invoiceAmount)) throw invalid();
  const existing = await tx.select({ id: storeOrderInvoice.id }).from(storeOrderInvoice).where(and(
    inArray(storeOrderInvoice.orderId, targetIds.filter(id => id !== source.id)), eq(storeOrderInvoice.isDel, 0),
  )).limit(1);
  if (existing.length) throw invalid();
  const { id: _id, ...base } = prepared;
  const receipt: Array<{ invoiceId: number; orderId: number; supplierId: number; amount: string }> = [];
  for (const target of targets) {
    if (!target) throw invalid();
    let invoice: Invoice | undefined;
    if (target.id === source.id) {
      [invoice] = await tx.update(storeOrderInvoice).set({ invoiceAmount: target.payPrice })
        .where(and(eq(storeOrderInvoice.id, prepared.id), eq(storeOrderInvoice.isDel, 0))).returning();
    } else {
      [invoice] = await tx.insert(storeOrderInvoice).values({ ...base, orderId: target.id, invoiceAmount: target.payPrice }).returning();
    }
    if (!invoice) throw invalid();
    validate(target, invoice);
    await assertUnissuedInvoiceHistory(tx, target, invoice);
    receipt.push({ invoiceId: invoice.id, orderId: target.id, supplierId: target.supplierId, amount: target.payPrice });
  }
  if (source.pid === 0) {
    const [archived] = await tx.update(storeOrderInvoice).set({ isDel: 1 })
      .where(and(eq(storeOrderInvoice.id, prepared.id), eq(storeOrderInvoice.isDel, 0))).returning();
    if (!archived || bounded(archived) !== bounded({ ...prepared, isDel: 1 })) throw invalid();
  }
  await assertUnissuedInvoiceHistory(tx, source);
  const receiptValues = { id: crypto.randomUUID().replaceAll('-', ''),
    sourceInvoiceId: prepared.id, sourceOrderId: source.id, paymentOrderId: rootId, uid: source.uid,
    reason, sourceSnapshot: bounded(prepared), targets: bounded(receipt, 65536), addTime: now };
  const [saved] = await tx.insert(allocation).values(receiptValues).returning();
  if (!saved || bounded(saved, 98304) !== bounded(receiptValues, 98304)) throw invalid();
  if (source.pid === 0) {
    const [archived] = await tx.select().from(storeOrderInvoice).where(eq(storeOrderInvoice.id, prepared.id)).limit(1);
    if (!archived || bounded(archived) !== bounded({ ...prepared, isDel: 1 })) throw invalid();
  }
  const finalActive = await tx.select({ id: storeOrderInvoice.id }).from(storeOrderInvoice).where(and(
    inArray(storeOrderInvoice.orderId, [...new Set([rootId, ...targetIds])]), eq(storeOrderInvoice.isDel, 0),
  )).limit(201);
  if (finalActive.length !== receipt.length || finalActive.some(row => !receipt.some(part => part.invoiceId === row.id))) throw invalid();
  // Catch late database-side issuance/rewrites (including a trigger clearing
  // the number again) before this transaction can commit its allocation.
  for (const target of targets) {
    if (!target) throw invalid();
    const expected = receipt.find(row => row.orderId === target.id)!;
    const [invoice] = await tx.select().from(storeOrderInvoice).where(eq(storeOrderInvoice.id, expected.invoiceId)).limit(1);
    if (!invoice || bounded(invoice) !== bounded({ ...prepared, id: expected.invoiceId,
      orderId: target.id, invoiceAmount: target.payPrice })) throw invalid();
    await assertUnissuedInvoiceHistory(tx, target, invoice);
  }
}
