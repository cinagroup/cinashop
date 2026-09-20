import { asc, eq } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrder, storeOrderRefund } from '@/models/schema';
import { ValidateException } from '@/utils/errors';
import { currentGenerationRefunds, loadRefundOrderGeneration } from './RefundOrderGeneration';
import { amountToCents, centsToAmount } from '@/services/payment/RefundGateway';

/** Shared by customer application and Out writes, after root/source locks and
 * before template/invoice locks. Do not acquire refund row locks here: refund
 * execution owns those before the order. Replays bypass new-write admission. */
export async function currentInvoiceAmount(tx: DbClient, order: typeof storeOrder.$inferSelect): Promise<string> {
  if (Object.hasOwn(tx, '$client')) throw Error('Invoice lifecycle requires a caller-owned transaction');
  if (order.refundStatus === 2) throw new ValidateException('订单已退款');
  if (order.refundStatus === 1) throw new ValidateException('正在申请退款中');
  const generation = await loadRefundOrderGeneration(tx, order);
  const history = await tx.select().from(storeOrderRefund).where(eq(storeOrderRefund.storeOrderId, order.id))
    .orderBy(asc(storeOrderRefund.id)).limit(403);
  if (history.length > 402) throw new ValidateException('退款历史过长，请先核对订单');
  const current = await currentGenerationRefunds(history, generation);
  if (current.some(row => !row.isCancel && !row.isDel && [0, 1, 2, 4, 5].includes(row.refundType))) {
    throw new ValidateException('正在申请退款中');
  }
  const paid = amountToCents(order.payPrice), refunded = amountToCents(order.refundPrice);
  let completed = 0;
  for (const row of current.filter(row => row.refundType === 6 && !row.isCancel && !row.isDel)) {
    const cents = amountToCents(row.refundedPrice);
    if (row.uid !== order.uid || row.supplierId !== order.supplierId || row.storeId !== order.storeId
      || cents === null || cents < 0 || cents !== amountToCents(row.refundPrice)) {
      throw new ValidateException('开票退款金额证据不一致，请先核对订单');
    }
    completed += cents;
  }
  if (paid === null || refunded === null || paid < 0 || refunded < 0 || refunded !== completed
    || !Number.isSafeInteger(completed) || refunded > paid) throw new ValidateException('开票退款金额证据不一致，请先核对订单');
  if (paid === refunded) throw new ValidateException('订单剩余实际支付金额为0，不能开发票');
  return centsToAmount(paid - refunded);
}
