import { createHmac, timingSafeEqual } from 'node:crypto';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { manualRefundCanonicalJson } from '@/services/order/CustomerManualRefund';
import { HttpApiException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { supplierOrderEditId, supplierOrderEditMoney, supplierOrderEditOperationId } from './SupplierUnpaidOrderEditInput';
import type { SupplierVideoActor } from './SupplierVideoAuthority';

export const SUPPLIER_PROACTIVE_REFUND_VERSION = 'supplier-proactive-refund-intent-v1' as const;
export const supplierProactiveRefundId = supplierOrderEditId;
export const supplierProactiveRefundUuid = supplierOrderEditOperationId;
export const supplierProactiveRefundMoney = supplierOrderEditMoney;
export const supplierProactiveRefundJson = manualRefundCanonicalJson;
export const supplierProactiveRefundConflict = (message = '订单或原主动退款操作已变化，请核对原结果') =>
  new HttpApiException(message, 409, 409);

export interface SupplierProactiveRefundIntent {
  readonly version: typeof SUPPLIER_PROACTIVE_REFUND_VERSION;
  readonly operation_id: string;
  readonly actor_id: number;
  readonly supplier_id: number;
  readonly order_id: number;
  readonly revision: string;
  readonly refund_price: string;
  readonly type: 1 | 2;
  readonly cash_returned?: true;
}

export function supplierProactiveRefundMac(key: string, source: unknown, actor: SupplierVideoActor): string {
  if (!key) throw new ServiceUnavailableException('供应商主动退款签名尚未就绪');
  return createHmac('sha256', key).update('cinashop.supplier-proactive-refund.revision.v1\0')
    .update(supplierProactiveRefundJson({ source, actor_id: actor.id, supplier_id: actor.supplierId, auth_version: actor.authVersion }))
    .digest('hex');
}

export function assertSupplierProactiveRefundRevision(received: string, expected: string): void {
  if (typeof received !== 'string' || typeof expected !== 'string'
    || !/^[a-f0-9]{64}$/.test(received) || !/^[a-f0-9]{64}$/.test(expected)
    || !timingSafeEqual(new TextEncoder().encode(received), new TextEncoder().encode(expected))) {
    throw supplierProactiveRefundConflict('主动退款依据已变化，请重新读取');
  }
}

function refundRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new ValidateException('主动退款正文须为JSON对象');
  }
  const row = value as Record<string, unknown>;
  const allowed = ['operation_id', 'revision', 'refund_price', 'type', 'cash_returned'];
  if (Reflect.ownKeys(row).some(key => typeof key !== 'string' || !allowed.includes(key)
    || !Object.hasOwn(Object.getOwnPropertyDescriptor(row, key)!, 'value'))
    || !['operation_id', 'revision', 'refund_price'].every(key => Object.hasOwn(row, key))) {
    throw new ValidateException('主动退款仅接受原操作ID、版本、金额、处理类型和实际现金返还确认');
  }
  return row;
}

export async function parseSupplierProactiveRefundIntent(orderId: number, value: unknown, actor: SupplierVideoActor):
Promise<{ intent: SupplierProactiveRefundIntent; hash: string }> {
  const identity = { actor_id: supplierProactiveRefundId(actor.id), supplier_id: supplierProactiveRefundId(actor.supplierId) };
  const row = refundRecord(value), amount = supplierProactiveRefundMoney(row.refund_price);
  if (typeof row.revision !== 'string' || !/^[a-f0-9]{64}$/.test(row.revision)) {
    throw new ValidateException('主动退款版本无效');
  }
  const type = !Object.hasOwn(row, 'type') || row.type === 1 || row.type === '1' ? 1
    : row.type === 2 || row.type === '2' ? 2 : null;
  if (type === null) throw new ValidateException('主动退款处理类型须为1或2');
  const hasCash = Object.hasOwn(row, 'cash_returned');
  if (hasCash && (row.cash_returned !== true || type === 2 || amount === '0.00')) {
    throw new ValidateException('只有正额现金退款可确认现金已返还，拒绝或零元处理须省略该字段');
  }
  // All fields are scalars. Freeze this detached snapshot BEFORE the async hash
  // so a caller cannot replace the actor, tenant or request while it is pending.
  const intent: SupplierProactiveRefundIntent = Object.freeze({
    version: SUPPLIER_PROACTIVE_REFUND_VERSION, ...identity, order_id: supplierProactiveRefundId(orderId),
    operation_id: supplierProactiveRefundUuid(row.operation_id), revision: row.revision, refund_price: amount, type,
    ...(hasCash ? { cash_returned: true as const } : {}),
  });
  return { intent, hash: await outRequestHash(intent) };
}

/** The service determines the actual settlement from its locked payment source;
 * an HTTP flag never chooses a channel or grants an execution capability. */
export function assertSupplierProactiveRefundCash(intent: SupplierProactiveRefundIntent,
  settlement: 'cash' | 'balance' | 'provider' | 'zero'): void {
  if (!['cash', 'balance', 'provider', 'zero'].includes(settlement)) throw new ValidateException('主动退款结算来源无效');
  const amount = supplierProactiveRefundMoney(intent.refund_price), hasCash = Object.hasOwn(intent, 'cash_returned');
  if (amount !== intent.refund_price || ![1, 2].includes(intent.type)) throw new ValidateException('主动退款意图无效');
  if (intent.type === 1 && amount !== '0.00' && settlement === 'zero') throw new ValidateException('正额退款不能按零元结算');
  if (intent.type === 1 && amount !== '0.00' && settlement === 'cash') {
    if (!hasCash || intent.cash_returned !== true) throw new ValidateException('正额现金退款须确认现金已实际返还');
  } else if (hasCash) {
    throw new ValidateException('非正额现金退款须省略现金返还确认');
  }
}
