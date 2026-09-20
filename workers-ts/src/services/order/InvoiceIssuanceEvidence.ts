import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrder, storeOrderInvoice } from '@/models/schema';
import { storeOrderInvoiceEvidence as evidence } from '@/models/schema/invoice_evidence';
import { ValidateException } from '@/utils/errors';

/** Caller holds root/source and active invoice rows. No new row locks here:
 * this is also checked after financial locks during finalization. */
export async function assertUnissuedInvoiceHistory(tx: DbClient, source: typeof storeOrder.$inferSelect,
  invoice?: typeof storeOrderInvoice.$inferSelect): Promise<void> {
  if (Object.hasOwn(tx, '$client')) throw Error('Invoice evidence requires a caller-owned transaction');
  const orderIds = source.pid > 0 ? [source.pid, source.id] : [source.id];
  const reported = tx.select({ id: evidence.invoiceId }).from(evidence).where(and(
    inArray(evidence.orderId, orderIds),
    inArray(evidence.kind, ['issued', 'unverified']),
  )).limit(1);
  const unrecorded = tx.select({ id: storeOrderInvoice.id }).from(storeOrderInvoice).leftJoin(evidence,
    and(eq(evidence.invoiceId, storeOrderInvoice.id), eq(evidence.kind, 'created'), eq(evidence.documentNumber, '')))
    .where(and(inArray(storeOrderInvoice.orderId, orderIds), isNull(evidence.invoiceId))).limit(1);
  // One statement snapshot: deleting an uncaptured archived row records an
  // unverified event atomically. See the old row OR its event, never a gap
  // between separate READ COMMITTED statements. Do not filter is_del here.
  const [history] = await tx.select({ blocked: sql<boolean>`EXISTS (${reported}) OR EXISTS (${unrecorded})` })
    .from(sql`(values (1)) as invoice_history_probe(n)`);
  if (history.blocked) throw new ValidateException('订单有开票历史或未核验票据，退款需先完成原票与红冲处理');
  if (!invoice) return;
  const [created] = await tx.select().from(evidence).where(and(eq(evidence.invoiceId, invoice.id),
    eq(evidence.kind, 'created'), eq(evidence.documentNumber, ''))).limit(1);
  const invalid = () => new ValidateException('发票创建历史缺失或关联不一致，不能认定为未开票');
  if (!created || created.orderId !== source.id || created.uid !== source.uid) throw invalid();
  let value: unknown;
  try { value = JSON.parse(created.snapshot); } catch { throw invalid(); }
  if (!value || typeof value !== 'object' || !('v' in value) || value.v !== 1 || !('invoice' in value)) throw invalid();
  const row = value.invoice;
  if (!row || typeof row !== 'object' || !('id' in row) || row.id !== invoice.id
    || !('uid' in row) || row.uid !== source.uid || !('order_id' in row) || row.order_id !== source.id
    || !('category' in row) || row.category !== 'order' || !('is_invoice' in row) || (row.is_invoice !== 0 && row.is_invoice !== -1)
    || !('invoice_number' in row) || row.invoice_number !== '') throw invalid();
}
