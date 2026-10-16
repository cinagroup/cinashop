import { createHmac, timingSafeEqual } from 'node:crypto';
import { parseLevelActivationJson } from '@/services/admin/AdminLevelActivationInput';
import { productSaveCanonical } from '@/services/admin/AdminLegacyProductSaveState';
import { readBoundedUtf8Text } from '@/utils/request-body';
import { HttpApiException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import type { SupplierVideoActor } from './SupplierVideoAuthority';

export const SUPPLIER_ORDER_EDIT_FIELDS = ['order_id', 'total_price', 'total_postage', 'pay_postage',
  'pay_price', 'gain_integral', 'operation_id', 'revision'] as const;
export const supplierOrderEditCanonical = productSaveCanonical;
export const supplierOrderEditConflict = (message = '订单或原编辑操作已变化，请核对原结果') => new HttpApiException(message, 409, 409);
export function supplierOrderEditId(value: unknown): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^[1-9]\d{0,9}$/.test(String(value))
    || !Number.isSafeInteger(Number(value)) || Number(value) > 2_147_483_647) throw new ValidateException('订单ID无效');
  return Number(value);
}
export function supplierOrderEditOperationId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value))
    throw new ValidateException('订单编辑操作ID须为小写UUIDv4');
  return value;
}
export function supplierOrderEditMoney(value: unknown): string {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(String(value)))
    throw new ValidateException('订单金额须为至多两位小数的非负数');
  const [whole, fraction = ''] = String(value).split('.');
  return `${BigInt(whole)}.${fraction.padEnd(2, '0')}`;
}
export function supplierOrderEditPoints(value: unknown): number {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^(?:0|[1-9]\d{0,9})$/.test(String(value))
    || !Number.isSafeInteger(Number(value)) || Number(value) > 9_999_999_999) throw new ValidateException('赠送积分须为有界非负整数');
  return Number(value);
}
export async function readSupplierOrderEditBody(request: Request): Promise<unknown> {
  return parseLevelActivationJson(await readBoundedUtf8Text(request, 4096));
}
export function supplierOrderEditMac(appKey: string, domain: 'revision' | 'request' | 'state', value: unknown): string {
  if (!appKey) throw new ServiceUnavailableException('供应商订单编辑签名尚未就绪');
  return createHmac('sha256', appKey).update(`cinashop.supplier-unpaid-order-edit.${domain}.v1\0`)
    .update(supplierOrderEditCanonical(value)).digest('hex');
}
export function assertSupplierOrderEditRevision(received: string, expected: string): void {
  if (!/^[a-f0-9]{64}$/.test(received) || !timingSafeEqual(new TextEncoder().encode(received), new TextEncoder().encode(expected)))
    throw supplierOrderEditConflict('订单已变化，请重新载入订单编辑表单');
}
export interface SupplierOrderEditIntent {
  operationId: string; orderId: number; orderNo: string; totalPrice: string; totalPostage: string;
  payPostage: string; payPrice: string; gainIntegral: number; revision: string; requestHash: string;
}
export function prepareSupplierOrderEdit(orderId: number, body: unknown, actor: SupplierVideoActor, appKey: string): SupplierOrderEditIntent {
  supplierOrderEditId(orderId);
  if (!body || typeof body !== 'object' || Array.isArray(body) || ![Object.prototype, null].includes(Object.getPrototypeOf(body)))
    throw new ValidateException('订单编辑正文须为JSON对象');
  const row = body as Record<string, unknown>;
  if (Object.keys(row).length !== SUPPLIER_ORDER_EDIT_FIELDS.length || SUPPLIER_ORDER_EDIT_FIELDS.some(key => !Object.hasOwn(row, key)))
    throw new ValidateException('订单编辑须提交原六字段及操作ID与版本');
  if (typeof row.order_id !== 'string' || !/^[A-Za-z0-9]{1,32}$/.test(row.order_id)) throw new ValidateException('订单编号无效');
  if (typeof row.revision !== 'string' || !/^[a-f0-9]{64}$/.test(row.revision)) throw new ValidateException('订单编辑版本无效');
  const input = { operationId: supplierOrderEditOperationId(row.operation_id), orderId, orderNo: row.order_id,
    totalPrice: supplierOrderEditMoney(row.total_price), totalPostage: supplierOrderEditMoney(row.total_postage),
    payPostage: supplierOrderEditMoney(row.pay_postage), payPrice: supplierOrderEditMoney(row.pay_price),
    gainIntegral: supplierOrderEditPoints(row.gain_integral), revision: row.revision };
  return { ...input, requestHash: supplierOrderEditMac(appKey, 'request', { ...input, actorId: actor.id, supplierId: actor.supplierId }) };
}
