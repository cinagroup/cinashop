import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import type { storeOrder } from '@/models/schema';
import { HttpApiException } from '@/utils/errors';
import { assertSupplierRefundSettlementReadReady } from '@/migrations/supplierRefundSettlementRead';
import { readSupplierProactiveMoneyEvidence } from '@/services/supplier/SupplierProactiveMoneyEvidence';
import { readBoundManualRefundProof } from '@/services/supplier/SupplierManualRefundProof';
import { verifyFinancialCompletedRefund } from '@/services/customer-work/CustomerWorkFinancialVerification';
import { parseSupplierRefundSettlement, SUPPLIER_REFUND_SETTLEMENT_VERSION,
  type SupplierRefundSettlement } from '../../../../view/common/supplierRefundSettlement';

type Order = typeof storeOrder.$inferSelect;
const invalid = () => new HttpApiException('累计退款的原商品、货款和实体凭据无法完整核对', 409, 409);
const decimal = (value: bigint) => `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;

/** Caller must already authorize the real order/refund and own a read-only
 * snapshot. This explicit composition leaves the mature default verifier and
 * every write path unchanged. No historical Supplier login is impersonated. */
export async function readVerifiedSupplierRefundSettlement(tx: DbClient, order: Order,
  refundId?: number): Promise<SupplierRefundSettlement> {
  if (Object.hasOwn(tx, '$client')) throw invalid();
  const [snapshot] = await tx.execute<{ readonly: boolean }>(sql`SELECT current_setting('transaction_read_only')='on' AS readonly`);
  if (snapshot?.readonly !== true) throw invalid();
  await assertSupplierRefundSettlementReadReady(tx);
  const evidence = await readSupplierProactiveMoneyEvidence(tx, order);
  if (refundId !== undefined && evidence.first.refund_id !== refundId) throw invalid();
  await verifyFinancialCompletedRefund(tx, evidence.firstRefund, readBoundManualRefundProof, evidence.baseline);
  const later = BigInt(evidence.refunded.replace('.', '')) - BigInt(evidence.first.amount.replace('.', ''));
  if (later < 0n) throw invalid();
  return parseSupplierRefundSettlement({
    version: SUPPLIER_REFUND_SETTLEMENT_VERSION, state: 'verified',
    order_id: order.id, order_no: order.orderId, uid: order.uid, supplier_id: order.supplierId, store_id: order.storeId,
    refund_id: evidence.first.refund_id, refund_no: evidence.firstRefund.orderId,
    pay_type: order.payType, paid: evidence.paid, goods_refunded: evidence.first.amount,
    money_refunded: decimal(later), refunded: evidence.refunded, available: evidence.available,
    money_payouts: evidence.completions.length,
  }, { order_id: order.id, order_no: order.orderId, uid: order.uid, supplier_id: order.supplierId,
    store_id: order.storeId, ...(refundId === undefined ? {} : { refund_id: refundId }) });
}
