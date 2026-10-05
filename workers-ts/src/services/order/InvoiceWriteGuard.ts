import { and, asc, eq, inArray } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrder, storeOrderInvoice } from '@/models/schema';
import { ValidateException } from '@/utils/errors';
import { currentInvoiceAmount } from './InvoiceOrderLifecycle';

type OrderRow = typeof storeOrder.$inferSelect;
type InvoiceRow = typeof storeOrderInvoice.$inferSelect;

/** Call only after locking the payment root and source order, before user locks.
 * A source child cannot silently be issued under an unallocated root invoice. */
export async function lockSingleOrderInvoice(tx: DbClient, order: OrderRow): Promise<InvoiceRow> {
  const rows = await tx.select().from(storeOrderInvoice).where(and(
    inArray(storeOrderInvoice.orderId, order.pid > 0 ? [order.pid, order.id] : [order.id]),
    eq(storeOrderInvoice.isDel, 0),
  )).orderBy(asc(storeOrderInvoice.id)).limit(3).for('update');
  if (rows.length === 0) throw new ValidateException('订单未提交开票申请');
  if (rows.length > 1) throw new ValidateException('订单存在重复开票申请，请先完成数据核对');
  const invoice = rows[0];
  if (invoice.uid !== order.uid || invoice.orderId !== order.id || invoice.category !== 'order') {
    throw new ValidateException('订单开票申请关联异常，请先完成数据核对');
  }
  return invoice;
}

export async function invoiceWriteAmount(tx: DbClient, order: OrderRow, readOnlySnapshot = false): Promise<string> {
  if (order.pid < 0) throw new ValidateException('请先完成支付主单发票与履约子单归属核对');
  if (order.supplierAllocationStatus === 1 || order.status < 0 || ![0, 1].includes(order.paid)) {
    throw new ValidateException('订单当前状态不能修改发票');
  }
  return currentInvoiceAmount(tx, order, readOnlySnapshot);
}

/** Shared by Out and Admin. The amount is from the current paid generation;
 * neither caller may turn a client-supplied amount into accounting evidence. */
export function assertInvoiceWriteEvidence(order: OrderRow, invoice: InvoiceRow, amount: string): void {
  if (invoice.isPay !== order.paid || invoice.isRefund !== 0 || invoice.invoiceAmount !== amount
    || ![-1, 0, 1].includes(invoice.isInvoice)) {
    throw new ValidateException('订单发票状态或金额证据不一致，请先核对订单');
  }
}
