import type { DbClient } from '@/lib/di';
import type { storeOrder, storeOrderStatus, storeOrderOutbox } from '@/models/schema';
import { loadSupplierOfflinePaymentOperation, type SupplierOfflinePaymentRow } from './SupplierOfflinePaymentOperation';
import { prepareSupplierOfflinePayment, supplierPaymentCanonical, supplierPaymentHash, supplierPaymentOperationId } from './SupplierOfflinePaymentInput';
import type { SupplierVideoActor } from './SupplierVideoAuthority';
import { ValidateException } from '@/utils/errors';

export interface SupplierOfflinePaymentOrigin {
  version: 'supplier-offline-payment-origin-v1'; kind: 'supplier_order_offline';
  primary_audit_id: number; actor_id: number; supplier_id: number; receipt: Omit<SupplierOfflinePaymentRow, 'source'>;
}
const bad = () => new ValidateException('供应商原线下收款身份、金额或不可变凭据无法核对');
function fact(value: unknown): asserts value { if (!value) throw bad(); }
export function parseSupplierOfflinePaymentOrigin(value: unknown): SupplierOfflinePaymentOrigin {
  fact(value && typeof value === 'object' && !Array.isArray(value));
  const row = value as SupplierOfflinePaymentOrigin;
  fact(Object.keys(row).sort().join(',') === 'actor_id,kind,primary_audit_id,receipt,supplier_id,version'
    && row.version === 'supplier-offline-payment-origin-v1' && row.kind === 'supplier_order_offline'
    && Number.isSafeInteger(row.actor_id) && row.actor_id > 0 && row.actor_id <= 2147483647
    && Number.isSafeInteger(row.supplier_id) && row.supplier_id > 0 && row.supplier_id <= 2147483647
    && Number.isSafeInteger(row.primary_audit_id) && row.primary_audit_id > 0 && row.receipt && typeof row.receipt === 'object' && !Array.isArray(row.receipt)
    && Object.keys(row.receipt).sort().join(',') === 'actor_id,created_at,evidence,intent,operation_id,order_id,request_hash,result,source_hash,state,supplier_id');
  const receipt = row.receipt;
  supplierPaymentOperationId(receipt.operation_id);
  fact(receipt.state === 'committed' && receipt.intent && receipt.evidence && receipt.result
    && receipt.actor_id === row.actor_id && receipt.supplier_id === row.supplier_id && receipt.evidence.primary_audit_id === row.primary_audit_id
    && Number.isSafeInteger(receipt.created_at) && receipt.created_at > 0 && /^[a-f0-9]{64}$/.test(receipt.source_hash));
  const { version, actor_id, supplier_id, order_id, ...body } = receipt.intent;
  fact(supplierPaymentCanonical(prepareSupplierOfflinePayment(receipt.order_id, body,
    { id: receipt.actor_id, supplierId: receipt.supplier_id } as SupplierVideoActor)) === supplierPaymentCanonical(receipt.intent)
    && supplierPaymentHash(receipt.intent) === receipt.request_hash);
  const result = receipt.result, evidence = receipt.evidence;
  fact(Object.keys(result).sort().join(',') === 'id,order_no,paid,pay_price,pay_time,pay_type'
    && result.id === receipt.order_id && result.order_no === receipt.intent.order_no && result.paid === 1 && result.pay_type === 'offline'
    && result.pay_price === receipt.intent.amount && result.pay_time === receipt.created_at
    && Object.keys(evidence).sort().join(',') === 'outbox_id,primary_audit_id' && Number.isSafeInteger(evidence.outbox_id) && evidence.outbox_id > 0);
  return { version: row.version, kind: row.kind, primary_audit_id: row.primary_audit_id,
    actor_id: row.actor_id, supplier_id: row.supplier_id, receipt };
}
/** Current permissions do not revoke an already committed cash receipt.
 * Every identity, hash, primary audit and completed paid event is still proved. */
export async function readSupplierOfflinePaymentOrigin(db: DbClient, root: typeof storeOrder.$inferSelect,
  primary: typeof storeOrderStatus.$inferSelect, event: typeof storeOrderOutbox.$inferSelect): Promise<SupplierOfflinePaymentOrigin> {
  fact(primary.changeType === 'supplier_order_offline' && primary.oid === root.id && primary.changeTime === root.payTime
    && root.paid === 1 && root.payType === 'offline' && root.payTime > 0 && event.status === 'COMPLETED'
    && event.aggregateType === 'order' && event.aggregateId === root.id && event.eventType === 'order.paid'
    && event.eventKey === `order.paid:${root.id}`
    && supplierPaymentCanonical(event.payload) === supplierPaymentCanonical({ orderId: root.id, orderNo: root.orderId }));
  const match = /^供应商 ([1-9][0-9]*) \/ 管理员 ([1-9][0-9]*) \/ 原请求 ([a-f0-9-]{36}) 确认实际线下收款$/.exec(primary.changeMessage);
  fact(match);
  const receipt = await loadSupplierOfflinePaymentOperation(db, supplierPaymentOperationId(match[3]));
  fact(receipt?.state === 'committed' && receipt.evidence && receipt.source && receipt.intent && receipt.result
    && receipt.actor_id === Number(match[2]) && receipt.supplier_id === Number(match[1]) && receipt.supplier_id === root.supplierId
    && receipt.order_id === root.id && receipt.created_at === root.payTime && receipt.intent.amount === root.payPrice
    && receipt.intent.order_no === root.orderId && receipt.source.order.uid === root.uid && receipt.source.order.storeId === root.storeId
    && receipt.evidence.primary_audit_id === primary.id && receipt.evidence.outbox_id === event.id);
  // The protected payment ledger retains the complete raw purchase source.
  // A refund freezes its verified hash/reference instead of duplicating all
  // cart JSON in every generation of the refund's own full source snapshot.
  const { source: _source, ...reference } = receipt;
  return parseSupplierOfflinePaymentOrigin({ version: 'supplier-offline-payment-origin-v1', kind: 'supplier_order_offline',
    primary_audit_id: primary.id, actor_id: receipt.actor_id, supplier_id: receipt.supplier_id, receipt: reference });
}
