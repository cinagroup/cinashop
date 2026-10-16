import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { supplierOrderEditCanonical, supplierOrderEditId, supplierOrderEditMoney, supplierOrderEditOperationId } from './SupplierUnpaidOrderEditInput';
import type { SupplierVideoActor } from './SupplierVideoAuthority';
import { HttpApiException, ServiceUnavailableException, ValidateException } from '@/utils/errors';

export const SUPPLIER_OFFLINE_PAYMENT_VERSION = 'supplier-offline-payment-v1' as const;
export const supplierPaymentCanonical = supplierOrderEditCanonical;
export const supplierPaymentId = supplierOrderEditId;
export const supplierPaymentOperationId = supplierOrderEditOperationId;
export const supplierPaymentConflict = (message = '订单或原收款操作已变化，请核对原结果') => new HttpApiException(message, 409, 409);
export function supplierPaymentHash(value: unknown): string {
  return createHash('sha256').update(supplierPaymentCanonical(value)).digest('hex');
}
export function supplierPaymentRevision(appKey: string, actor: SupplierVideoActor, source: unknown): string {
  if (!appKey) throw new ServiceUnavailableException('供应商收款签名尚未就绪');
  return createHmac('sha256', appKey).update('cinashop.supplier-offline-payment.revision.v1\0')
    .update(supplierPaymentCanonical({ actor_id: actor.id, supplier_id: actor.supplierId, auth_version: actor.authVersion, source })).digest('hex');
}
export function assertSupplierPaymentRevision(received: string, expected: string): void {
  if (!/^[a-f0-9]{64}$/.test(received) || !timingSafeEqual(new TextEncoder().encode(received), new TextEncoder().encode(expected)))
    throw supplierPaymentConflict('订单已变化，请重新核对收款金额');
}
export interface SupplierOfflinePaymentIntent {
  version: typeof SUPPLIER_OFFLINE_PAYMENT_VERSION; actor_id: number; supplier_id: number; order_id: number;
  operation_id: string; revision: string; order_no: string; amount: string; cash_received?: true;
}
export function prepareSupplierOfflinePayment(orderId: number, body: unknown, actor: SupplierVideoActor): SupplierOfflinePaymentIntent {
  supplierPaymentId(orderId);
  if (!body || typeof body !== 'object' || Array.isArray(body) || ![Object.prototype, null].includes(Object.getPrototypeOf(body)))
    throw new ValidateException('收款正文须为JSON对象');
  const row = body as Record<string, unknown>, amount = supplierOrderEditMoney(row.amount), positive = amount !== '0.00';
  const keys = ['operation_id', 'revision', 'order_no', 'amount', ...(positive ? ['cash_received'] : [])];
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key)) || positive && row.cash_received !== true)
    throw new ValidateException('收款须提交原操作ID、版本、订单和金额；正金额须明确确认实际收妥现金');
  if (typeof row.revision !== 'string' || !/^[a-f0-9]{64}$/.test(row.revision)
    || typeof row.order_no !== 'string' || !/^[A-Za-z0-9]{1,32}$/.test(row.order_no) || row.order_no === '0')
    throw new ValidateException('原订单编号或版本无效');
  return { version: SUPPLIER_OFFLINE_PAYMENT_VERSION, actor_id: actor.id, supplier_id: actor.supplierId, order_id: orderId,
    operation_id: supplierPaymentOperationId(row.operation_id), revision: row.revision, order_no: row.order_no, amount,
    ...(positive ? { cash_received: true } : {}) };
}
