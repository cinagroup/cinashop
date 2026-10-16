import type { storeOrder, storeOrderCartInfo, storeOrderInvoice } from '@/models/schema';
import type { ManualInvoiceDisposition } from '@/services/order/InvoiceManualRedNoteEvidence';
import { manualRedUuid } from '@/services/order/InvoiceManualRedNoteProtocol';
import { ValidateException } from '@/utils/errors';
import { supplierProactiveRefundMoney } from './SupplierProactiveRefundInput';

type Order = Pick<typeof storeOrder.$inferSelect, 'id' | 'pid' | 'uid' | 'paid' | 'payPrice' | 'totalNum'>;
type Cart = Pick<typeof storeOrderCartInfo.$inferSelect, 'id' | 'oid' | 'uid' | 'cartNum'>;
type Invoice = Pick<typeof storeOrderInvoice.$inferSelect,
  'id' | 'orderId' | 'uid' | 'category' | 'invoiceAmount' | 'isPay' | 'isRefund' | 'isDel' | 'isInvoice' | 'invoiceNumber'>;
const invalid = () => new ValidateException('主动整单退货发票及实际款项归属不一致，请核对原票');
function id(value: number, zero = false) {
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1) || value > 2147483647) throw invalid();
  return value;
}
function money(value: string) {
  if (typeof value !== 'string' || supplierProactiveRefundMoney(value) !== value) throw invalid();
  return BigInt(value.replace('.', ''));
}
const decimal = (value: bigint) => `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;

/** A plan, never an invoice cancellation, issuance or tax-provider success.
 * The SQL adapter must use locked original rows and call the real
 * readInvoiceManualDisposition for ALL issued/unverified historical documents.
 * A supplied coverage object is not verification authority. That adapter must
 * retain the frozen original evidence and exact manual review hashes in its
 * atomic first-goods receipt. Later monetary completions reuse this disposition
 * and cannot cancel/red-note the full invoice a second time. */
export function planSupplierProactiveWholeInvoice(source: Order, carts: readonly Cart[],
  selections: ReadonlyMap<number, number>, invoice: Invoice, firstRefund: string, manual: ManualInvoiceDisposition | null) {
  id(source.id); id(source.uid, true); id(source.totalNum); id(invoice.id);
  if (!Number.isSafeInteger(source.pid) || source.pid < 0 || source.pid > 2147483647 || source.pid === source.id
    || source.paid !== 1 || !Array.isArray(carts) || !carts.length || carts.length > 200
    || selections.size !== carts.length || invoice.orderId !== source.id || invoice.uid !== source.uid || invoice.category !== 'order'
    || invoice.isPay !== 1 || invoice.isRefund !== 0 || invoice.isDel !== 0 || ![-1, 0, 1].includes(invoice.isInvoice)
    || typeof invoice.invoiceNumber !== 'string') throw invalid();
  let quantity = 0;
  const seen = new Set<number>();
  for (const row of carts) {
    id(row.id); id(row.cartNum);
    if (seen.has(row.id) || row.oid !== source.id || row.uid !== source.uid || selections.get(row.id) !== row.cartNum) throw invalid();
    seen.add(row.id); quantity += row.cartNum;
    if (!Number.isSafeInteger(quantity) || quantity > 2147483647) throw invalid();
  }
  const paid = money(source.payPrice), refunded = money(firstRefund);
  if (quantity !== source.totalNum || money(invoice.invoiceAmount) !== paid || refunded > paid || refunded === 0n && paid > 0n) throw invalid();
  const issued = invoice.isInvoice === 1 || invoice.invoiceNumber !== '';
  if (issued && !manual) throw new ValidateException('已开具的整单原票须先完成真实全额红冲及人工复核');
  if (manual) {
    if (manual.version !== 'invoice-manual-disposition-v1' || !/^[a-f0-9]{64}$/.test(manual.coverage_hash)
      || !Number.isSafeInteger(manual.coverage_count) || manual.coverage_count < 1 || manual.coverage_count > 200
      || !Array.isArray(manual.invoice_ids) || !manual.invoice_ids.length || manual.invoice_ids.length > manual.coverage_count
      || new Set(manual.invoice_ids).size !== manual.invoice_ids.length
      || !Array.isArray(manual.review_ids) || manual.review_ids.length !== manual.coverage_count
      || new Set(manual.review_ids).size !== manual.review_ids.length || issued && !manual.invoice_ids.includes(invoice.id)) throw invalid();
    manual.invoice_ids.forEach(value => id(value));
    manual.review_ids.forEach(value => manualRedUuid(value));
  }
  const disposition = manual ? Object.freeze({ ...manual, invoice_ids: Object.freeze([...manual.invoice_ids]),
    review_ids: Object.freeze([...manual.review_ids]) }) : null;
  return Object.freeze({ version: 'supplier-proactive-whole-invoice-plan-v1' as const,
    source_order_id: source.id, payment_order_id: source.pid || source.id, invoice_id: invoice.id,
    goods_quantity: quantity, invoice_amount: invoice.invoiceAmount,
    first_refunded: firstRefund, unreturned_payment: decimal(paid - refunded),
    disposition: manual ? 'whole-manual-red' as const : 'cancel-unissued' as const, manual_disposition: disposition,
  });
}
