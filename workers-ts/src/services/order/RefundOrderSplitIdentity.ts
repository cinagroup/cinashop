import type { storeOrderRefund } from '@/models/schema';
import { ValidateException } from '@/utils/errors';
import { amountToCents } from '@/services/payment/RefundGateway';
import { readRefundQuantityReservation } from './RefundQuantityReservation';

export type RefundMaterializationIdentity = Pick<typeof storeOrderRefund.$inferSelect,
  'id' | 'storeOrderId' | 'uid' | 'supplierId' | 'storeId' | 'orderId' | 'refundPrice' | 'refundNum' | 'cartInfo'>;

/** Same immutable identity for materialization replay and history exclusion.
 * A generation number alone must never authorize ignoring a completed refund. */
export async function refundOrderSplitFingerprint(input: RefundMaterializationIdentity): Promise<string> {
  const invalid = () => new ValidateException('退款实体拆单证据不一致，请先核对订单');
  for (const [n, minimum] of [[input.id, 1], [input.storeOrderId, 1], [input.uid, 1], [input.refundNum, 1],
    [input.supplierId, 0], [input.storeId, 0]]) {
    if (!Number.isSafeInteger(n) || n < minimum || n > 2147483647) throw invalid();
  }
  const refundCents = amountToCents(input.refundPrice);
  if (refundCents === null || refundCents < 0 || !input.orderId || input.orderId.length > 50) throw invalid();
  const claim = readRefundQuantityReservation(input); if (!claim) throw invalid();
  const bytes = new TextEncoder().encode(JSON.stringify({ version: 'refund-order-materialization-v1', refundId: input.id,
    orderId: input.storeOrderId, uid: input.uid, supplierId: input.supplierId, storeId: input.storeId,
    refundNo: input.orderId, refundCents, refundNum: input.refundNum, claim }));
  if (bytes.length > 131072) throw invalid();
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
}
