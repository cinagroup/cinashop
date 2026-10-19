import { and, asc, eq, notInArray, or } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrder, storeOrderInvoice } from '@/models/schema';

type Order = Pick<typeof storeOrder.$inferSelect, 'id' | 'pid' | 'uid' | 'supplierId' | 'storeId'>;
export type SupplierOrderInvoiceRecord = {
  id: number; order_id: number; archived: boolean; type: 1 | 2; header_type: 1 | 2;
  name: string; duty_number: string; email: string; bank: string; address: string; drawer_phone: string;
  recorded_amount: string; issuance_state: -1 | 0 | 1;
};
export type SupplierOrderInvoiceReview = {
  state: 'recorded' | 'none' | 'unavailable'; reason: string; record: SupplierOrderInvoiceRecord | null;
};
const unavailable = (reason: string): SupplierOrderInvoiceReview => ({ state: 'unavailable', reason, record: null });
const fields = {
  id: storeOrderInvoice.id, orderId: storeOrderInvoice.orderId, uid: storeOrderInvoice.uid,
  category: storeOrderInvoice.category, type: storeOrderInvoice.type, headerType: storeOrderInvoice.headerType,
  name: storeOrderInvoice.name, dutyNumber: storeOrderInvoice.dutyNumber, email: storeOrderInvoice.email,
  bank: storeOrderInvoice.bank, address: storeOrderInvoice.address, drawerPhone: storeOrderInvoice.drawerPhone,
  invoiceAmount: storeOrderInvoice.invoiceAmount, isInvoice: storeOrderInvoice.isInvoice,
};
function validText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum * 2 && [...value].length <= maximum
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ud800-\udfff]/u.test(value);
}
function amount(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{1,10}(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return `${BigInt(whole)}.${fraction.padEnd(2, '0')}`;
}

/** Detail only, inside the caller's bounded RR/READ ONLY snapshot. This is a
 * frozen application record, not tax-provider verification or current invoice
 * eligibility. Never read user_invoice or substitute a parent's application. */
export async function readSupplierOrderInvoiceReview(db: DbClient, order: Order): Promise<SupplierOrderInvoiceReview> {
  if (order.pid < -1) return unavailable('订单关联无法核对');
  if (order.pid > 0) {
    const roots = await db.select({ id: storeOrder.id }).from(storeOrder).where(and(
      eq(storeOrder.id, order.pid), eq(storeOrder.pid, -1), eq(storeOrder.uid, order.uid), eq(storeOrder.isSystemDel, 0),
      or(and(eq(storeOrder.supplierId, order.supplierId), eq(storeOrder.storeId, order.storeId)),
        and(eq(storeOrder.supplierId, 0), eq(storeOrder.storeId, 0), eq(storeOrder.supplierAllocationStatus, 2))),
    )).limit(1);
    if (!roots.length) return unavailable('履约子单与付款汇总的关联无法核对');
  }
  // Two rows are sufficient to reject ambiguity. UID/category are deliberately
  // checked after this exact owned-order join, so bad associations cannot turn
  // into a misleading "none" result or disclose another customer's fields.
  const read = (deleted: 0 | 1) => db.select(fields).from(storeOrderInvoice).innerJoin(storeOrder,
    eq(storeOrder.id, storeOrderInvoice.orderId)).where(and(
    eq(storeOrder.id, order.id), eq(storeOrder.uid, order.uid), eq(storeOrder.supplierId, order.supplierId),
    eq(storeOrder.isSystemDel, 0), eq(storeOrderInvoice.isDel, deleted),
  )).orderBy(asc(storeOrderInvoice.id)).limit(2);
  let rows = await read(0), archived = false;
  if (!rows.length) { rows = await read(1); archived = true; }
  if (!rows.length) {
    const malformed = await db.select({ id: storeOrderInvoice.id }).from(storeOrderInvoice)
      .where(and(eq(storeOrderInvoice.orderId, order.id), notInArray(storeOrderInvoice.isDel, [0, 1]))).limit(1);
    if (malformed.length) return unavailable('发票申请的历史状态无法核对');
    if (order.pid > 0) {
      // Existence only: an unresolved root application must not be presented as
      // the child's fiscal identity or silently mistaken for no application.
      const pending = await db.select({ id: storeOrderInvoice.id }).from(storeOrderInvoice)
        .where(and(eq(storeOrderInvoice.orderId, order.pid), eq(storeOrderInvoice.isDel, 0))).limit(1);
      if (pending.length) return unavailable('付款汇总仍有发票申请，请先完成履约子单的发票归属处理');
    }
    return { state: 'none', reason: '', record: null };
  }
  if (rows.length !== 1) return unavailable('该履约订单存在多条发票申请，请先核对记录');
  const row = rows[0], recordedAmount = amount(row.invoiceAmount);
  if (row.uid !== order.uid || row.category !== 'order' || row.orderId !== order.id
    || !Number.isSafeInteger(row.id) || row.id <= 0 || row.id > 2147483647
    || ![1, 2].includes(row.type) || ![1, 2].includes(row.headerType) || ![-1, 0, 1].includes(row.isInvoice)
    || recordedAmount === null || !validText(row.name, 100) || !validText(row.dutyNumber, 50)
    || !validText(row.email, 100) || !validText(row.bank, 50) || !validText(row.address, 255) || !validText(row.drawerPhone, 30)) {
    return unavailable('发票申请的关联或记录内容无法核对');
  }
  return { state: 'recorded', reason: '', record: { id: row.id, order_id: row.orderId, archived,
    type: row.type as 1 | 2, header_type: row.headerType as 1 | 2,
    name: row.name, duty_number: row.dutyNumber, email: row.email, bank: row.bank,
    address: row.address, drawer_phone: row.drawerPhone, recorded_amount: recordedAmount,
    issuance_state: row.isInvoice as -1 | 0 | 1 } };
}
