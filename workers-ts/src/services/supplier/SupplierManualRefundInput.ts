import { createHmac, timingSafeEqual } from 'node:crypto';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { manualRefundCanonicalJson } from '@/services/order/CustomerManualRefund';
import { supplierOrderEditId, supplierOrderEditMoney, supplierOrderEditOperationId } from './SupplierUnpaidOrderEditInput';
import { HttpApiException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import type { SupplierVideoActor } from './SupplierVideoAuthority';
export const supplierManualRefundId = supplierOrderEditId;
export const supplierManualRefundUuid = supplierOrderEditOperationId;
export const supplierManualRefundMoney = supplierOrderEditMoney;
export const supplierManualRefundJson = manualRefundCanonicalJson;
export const supplierManualRefundConflict = (message='售后或原现金退款操作已变化，请核对原结果') => new HttpApiException(message,409,409);
export function supplierManualRefundRecord(value:unknown):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))
    throw new ValidateException('供应商现金退款须为JSON对象');
  return value as Record<string,unknown>;
}
export function supplierManualRefundMac(key:string,source:unknown,actor:SupplierVideoActor):string {
  if(!key)throw new ServiceUnavailableException('供应商现金退款签名尚未就绪');
  return createHmac('sha256',key).update('cinashop.supplier-manual-refund.revision.v1\0')
    .update(supplierManualRefundJson({source,actor_id:actor.id,supplier_id:actor.supplierId,auth_version:actor.authVersion})).digest('hex');
}
export function assertSupplierManualRefundRevision(actual:string,expected:string) {
  if(!/^[a-f0-9]{64}$/.test(actual)||!timingSafeEqual(new TextEncoder().encode(actual),new TextEncoder().encode(expected)))
    throw supplierManualRefundConflict('现金退款审查依据已变化，请重新读取');
}
export interface SupplierManualRefundIntent {
  version:'supplier-manual-refund-intent-v1'; operation_id:string; actor_id:number; supplier_id:number;
  refund_id:number; refund_price:string; revision:string; cash_returned?:true;
}
export async function parseSupplierManualRefundIntent(refundId:number,value:unknown,actor:SupplierVideoActor) {
  const row=supplierManualRefundRecord(value),allowed=['operation_id','revision','refund_price','cash_returned'];
  if(Object.keys(row).some(k=>!allowed.includes(k))||!['operation_id','revision','refund_price'].every(k=>Object.hasOwn(row,k)))
    throw new ValidateException('现金退款仅接受原操作、审查版本、金额和实际现金返还确认');
  const amount=supplierManualRefundMoney(row.refund_price);
  if(typeof row.revision!=='string'||!/^[a-f0-9]{64}$/.test(row.revision))throw new ValidateException('现金退款审查版本无效');
  if(amount==='0.00'?Object.hasOwn(row,'cash_returned'):row.cash_returned!==true)
    throw new ValidateException('正额退款须确认现金已返还，零元退款须省略现金返还确认');
  const intent:SupplierManualRefundIntent={version:'supplier-manual-refund-intent-v1',operation_id:supplierManualRefundUuid(row.operation_id),
    actor_id:actor.id,supplier_id:actor.supplierId,refund_id:supplierManualRefundId(refundId),refund_price:amount,revision:row.revision,
    ...(amount==='0.00'?{}:{cash_returned:true as const})};
  return {intent,hash:await outRequestHash(intent)};
}
