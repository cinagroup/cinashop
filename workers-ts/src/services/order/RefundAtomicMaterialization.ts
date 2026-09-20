import { asc, eq } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrder, storeOrderCartInfo } from '@/models/schema';
import { storeOrderRefundSplit, storeOrderFulfillmentBranch } from '@/models/schema/order_refund_split';
import { ValidateException } from '@/utils/errors';
import { lockOrderSettlement } from './OrderBrokerageService';
import { planOrderFinancialSplit } from './OrderSplitFinance';
import { refundSplitDisposition } from './RefundSplitAllocation';
import { refundOrderSplitFingerprint, type RefundMaterializationIdentity } from './RefundOrderSplitIdentity';
import { prepareRefundInvoice, type RefundInvoiceSnapshot } from './RefundInvoiceAllocation';

type Order = typeof storeOrder.$inferSelect;
type Cart = typeof storeOrderCartInfo.$inferSelect;
const invalid = () => new ValidateException('退款原子拆单准入证据不一致，请先核对订单');

/** Refund lock precedes this helper during execution; payment root precedes
 * source/carts/users. Pink's distinct inventory/group lock graph is not admitted
 * until its member-to-physical-order adapter exists. */
export async function lockAtomicRefundOrder(tx: DbClient, orderId: number, allowAuditRootReplay = false): Promise<Order> {
  if (Object.hasOwn(tx, '$client')) throw Error('Atomic refund requires a caller-owned transaction');
  const [initial] = await tx.select({ pid: storeOrder.pid, type: storeOrder.type }).from(storeOrder).where(eq(storeOrder.id, orderId)).limit(1);
  if (initial?.type === 3) throw new ValidateException('拼团原子退款尚需团成员与实体子单归属适配');
  if (!initial || (initial.pid < 0 && !(allowAuditRootReplay && initial.pid === -1))) throw invalid();
  const paymentId = initial.pid > 0 ? initial.pid : orderId;
  await lockOrderSettlement(tx, paymentId);
  const [root] = await tx.select().from(storeOrder).where(eq(storeOrder.id, paymentId)).limit(1).for('update');
  if (paymentId !== orderId) await lockOrderSettlement(tx, orderId);
  const [source] = paymentId === orderId ? [root] : await tx.select().from(storeOrder).where(eq(storeOrder.id, orderId)).limit(1).for('update');
  if (!root || !source || source.pid !== initial.pid || source.type !== initial.type || source.paid !== 1 || root.paid !== 1
    || source.uid !== root.uid || source.payType !== root.payType || source.isDel || source.isSystemDel || source.supplierAllocationStatus === 1
    || (source.pid > 0 && root.pid !== -1)
    || (root.supplierId !== source.supplierId && !(root.supplierId === 0 && root.supplierAllocationStatus === 2))
    || (root.storeId !== source.storeId && root.supplierAllocationStatus !== 2)) throw invalid();
  return source;
}

/** Reject known unsupported states BEFORE application/provider admission, and
 * recheck before local settlement. This does not install DDL or refund money.
 * Issued-invoice/promotional adapters remain release gates, not fallbacks. */
export async function assertAtomicRefundAdmission(tx: DbClient, order: Order, selections: ReadonlyMap<string, number>,
  held: boolean, refundAmount: string, supplied?: Cart[]): Promise<RefundInvoiceSnapshot | null> {
  if (order.type === 3) throw new ValidateException('拼团原子退款尚需团成员与实体子单归属适配');
  const rows = supplied ?? await tx.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, order.id))
    .orderBy(asc(storeOrderCartInfo.id)).limit(201).for('update');
  if (![0, 1, 2, 3].includes(order.status) || order.refundPrice !== '0.00' || order.backIntegral !== '0.00'
    || rows.some(row => row.refundNum !== (held ? selections.get(row.cartId) ?? 0 : 0)
      || ![0, 1, 2].includes(row.splitStatus) || (order.status === 0
        ? row.splitStatus === 2 || row.splitSurplusNum !== row.cartNum
        : !((row.splitStatus < 2 && row.splitSurplusNum === row.cartNum) || (row.splitStatus === 2 && row.splitSurplusNum === 0))))) throw invalid();
  const plan = planOrderFinancialSplit(order, rows.map(row => ({ ...row, refundNum: 0, splitStatus: 0, splitSurplusNum: row.cartNum })), selections);
  if (!plan || typeof plan.selected.payPrice !== 'string') throw invalid();
  const disposition = refundSplitDisposition(order.status, rows, [...selections].map(([cartId, cartNum]) => ({ cartId, cartNum })));
  if (disposition === 'whole-order-gift-remainder') throw new ValidateException('仅剩赠品的原子退款尚需赠品库存与权益适配');
  if (disposition === 'split' && order.freightPrice !== '0.00') throw new ValidateException('商家运费的原子退款尚需独立账本适配');
  if ([order.giveCoupon, order.promotionsGive].some(value => value && !['[]', '{}', 'null'].includes(value))) {
    throw new ValidateException('赠券与促销权益的原子退款尚需归属适配');
  }
  const invoice = await prepareRefundInvoice(tx, order, plan.selected.payPrice, refundAmount);
  // Assert the exact candidate schema is present without scanning another
  // tenant's evidence or treating a missing table as permission to downgrade.
  await tx.select({ branch: storeOrderRefundSplit.baseBranchId, invoice: storeOrderRefundSplit.invoiceAllocation })
    .from(storeOrderRefundSplit).where(eq(storeOrderRefundSplit.refundId, 0)).limit(1);
  await tx.select({ id: storeOrderFulfillmentBranch.id }).from(storeOrderFulfillmentBranch).where(eq(storeOrderFulfillmentBranch.id, '')).limit(1);
  return invoice;
}

/** A committed v2 completion must already have its receipt. Never repair or
 * create physical orders from a terminal replay after money was committed. */
export async function assertAtomicRefundCompleted(tx: DbClient, refund: RefundMaterializationIdentity): Promise<void> {
  const [record] = await tx.select({ fingerprint: storeOrderRefundSplit.fingerprint, sourceOrderId: storeOrderRefundSplit.sourceOrderId })
    .from(storeOrderRefundSplit).where(eq(storeOrderRefundSplit.refundId, refund.id)).limit(1);
  if (!record || record.sourceOrderId !== refund.storeOrderId || record.fingerprint !== await refundOrderSplitFingerprint(refund)) throw invalid();
}
