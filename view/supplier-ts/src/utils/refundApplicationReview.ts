import type { RefundRow } from '../types';

export interface SupplierRefundApplicationReview {
  version: 1;
  refund_id: number;
  source_order_id: number;
  state: 'recorded' | 'archived' | 'unavailable';
  basis: 'quantity_claim' | 'php_legacy_snapshot' | null;
  error: string;
  items: Array<{
    row_id: number | null; cart_id: string; product_id: number;
    product_name: string; sku: string; code: string; is_gift: 0 | 1 | null;
    quantity: number; settlement_unit: string | null; settlement_subtotal: string | null;
  }>;
  order_context: {
    basis: 'linked_order_record'; order_id: string; paid: 0 | 1;
    pay_type: string; pay_price: string; pay_time: number;
    recipient: { name: string; phone: string; address: string }; mark: string;
  } | null;
}

const fail = (): never => { throw Error('退款申请核对信息不完整或与当前单据不匹配，请刷新详情'); };
const bytes = (value: string) => new TextEncoder().encode(value).length;
function object(value: unknown, keys: string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) fail();
  return value as Record<string, any>;
}
const int = (value: unknown, minimum = 1): value is number => typeof value === 'number'
  && Number.isSafeInteger(value) && value >= minimum && value <= 2147483647;
const text = (value: unknown, max = 4096): value is string => typeof value === 'string' && bytes(value) <= max;
const money = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d{0,23})\.\d{2}$/.test(value);
const cents = (value: string) => BigInt(value.replace('.', ''));

/** A present contract must be closed and bound before the drawer can bind any
 * action. Missing fields on an older server are handled explicitly by the UI. */
export function parseSupplierRefundApplicationReview(value: unknown, header: RefundRow & { is_cancel: number }): SupplierRefundApplicationReview {
  const row = object(value, ['version', 'refund_id', 'source_order_id', 'state', 'basis', 'items', 'error', 'order_context']);
  if (row.version !== 1 || !int(row.refund_id) || row.refund_id !== header.id
    || !int(row.source_order_id) || row.source_order_id !== header.store_order_id
    || !['recorded', 'archived', 'unavailable'].includes(row.state)
    || !text(row.error, 255) || !Array.isArray(row.items) || row.items.length > 100) fail();
  if (row.state === 'recorded') {
    if (!['quantity_claim', 'php_legacy_snapshot'].includes(row.basis) || row.error || !row.items.length
      || (header.refund_type === 6 && row.basis === 'quantity_claim')) fail();
  } else if (row.basis !== null || row.items.length
    || (row.state === 'unavailable' ? !row.error : row.error || header.refund_type !== 6 || header.is_cancel !== 0)) fail();

  const cartIds = new Set<string>(), rowIds = new Set<number>();
  const items: SupplierRefundApplicationReview['items'] = row.items.map((value: unknown) => {
    const item = object(value, ['row_id', 'cart_id', 'product_id', 'product_name', 'sku', 'code', 'is_gift', 'quantity', 'settlement_unit', 'settlement_subtotal']);
    if (!int(item.product_id) || !text(item.cart_id, 512) || Array.from(item.cart_id).length > 128 || !item.cart_id || item.cart_id.trim() !== item.cart_id
      || /[\x00-\x1f\x7f]/.test(item.cart_id) || cartIds.has(item.cart_id)
      || !['product_name', 'sku', 'code'].every(key => text(item[key])) || !item.product_name.trim()
      || ![0, 1, null].includes(item.is_gift) || !int(item.quantity)) fail();
    cartIds.add(item.cart_id);
    if (row.basis === 'quantity_claim') {
      if (!int(item.row_id) || rowIds.has(item.row_id)) fail();
      rowIds.add(item.row_id);
    } else if (item.row_id !== null) fail();
    if (item.settlement_unit === null) {
      if (item.settlement_subtotal !== null) fail();
    } else if (!money(item.settlement_unit) || !money(item.settlement_subtotal)
      || cents(item.settlement_unit) * BigInt(item.quantity) !== cents(item.settlement_subtotal)) fail();
    return { ...item } as SupplierRefundApplicationReview['items'][number];
  });
  if (row.state === 'recorded' && (!int(header.refund_num)
    || items.reduce((total, item) => total + item.quantity, 0) !== header.refund_num)) fail();
  if (bytes(JSON.stringify(items)) > 524288) fail();

  let order_context: SupplierRefundApplicationReview['order_context'] = null;
  if (row.order_context !== null) {
    const context = object(row.order_context, ['basis', 'order_id', 'paid', 'pay_type', 'pay_price', 'pay_time', 'recipient', 'mark']);
    const recipient = object(context.recipient, ['name', 'phone', 'address']);
    if (context.basis !== 'linked_order_record' || context.order_id !== header.order_id || !text(context.order_id, 64)
      || ![0, 1].includes(context.paid) || !text(context.pay_type, 32) || context.pay_type !== header.pay_type
      || !money(context.pay_price) || context.pay_price !== header.pay_price || !int(context.pay_time, 0)
      || !['name', 'phone', 'address'].every(key => text(recipient[key]))
      || recipient.name !== header.real_name || recipient.phone !== header.user_phone || !text(context.mark)) fail();
    order_context = { ...context, recipient: { ...recipient } } as SupplierRefundApplicationReview['order_context'];
  }
  return { version: 1, refund_id: row.refund_id, source_order_id: row.source_order_id,
    state: row.state, basis: row.basis, items, error: row.error, order_context };
}
