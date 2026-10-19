import { checkSupplierOrderVirtualReview, type SupplierOrderVirtualReview } from './orderVirtualReview';
import type { OrderRow } from '@/types';
import { checkSupplierOrderInvoiceReview, type SupplierOrderInvoiceReview } from './orderInvoiceReview';
import { checkSupplierOrderPromotionsReview, type SupplierOrderPromotionsReview } from './orderPromotionsReview';

export interface SupplierOrderReview {
  version: 1;
  order_kind: 'order' | 'payment_summary';
  original_order_id: string | null;
  recipient: { name: string; phone: string; address: string; mark: string };
  buyer: { uid: number; nickname: string; phone: string; available: boolean };
  amounts: {
    quantity: number; total_price: string; total_postage: string; pay_postage: string;
    coupon_price: string; deduction_price: string; use_integral: string; promotions_price: string;
    first_order_price: string; change_price: string; pay_price: string; refund_price: string;
  };
  items: Array<{ id: number; product_id: number; is_gift?: 0 | 1; product_name: string; sku: string; code: string; bar_code: string;
    quantity: number; refund_quantity: number; settlement_unit: string | null; settlement_subtotal: string | null }>;
  settlement: { items_total: string | null; postage: string; total: string | null; availability: 'recorded' | 'incomplete' };
  form: Array<{ id: string; title: string; value: string; images: string[] }>;
  invoice?: SupplierOrderInvoiceReview;
  promotions?: SupplierOrderPromotionsReview;
  virtual_delivery?: SupplierOrderVirtualReview;
}
export type SupplierOrderDetail = OrderRow & { cart_info: unknown[]; review?: SupplierOrderReview };

const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 20000): v is string => typeof v === 'string' && v.length <= max;
const integer = (v: unknown) => Number.isInteger(v) && Number(v) >= 0 && Number(v) <= 2147483647;
const money = (v: unknown): v is string => typeof v === 'string' && /^\d{1,24}\.\d{2}$/.test(v);
const nullableMoney = (v: unknown) => v === null || money(v);
export function reviewImageUrl(value: unknown): value is string {
  if (!text(value, 8192)) return false;
  if (/^\/api\/assets\/[1-9]\d*\?/.test(value)) {
    const url = new URL(value, 'https://supplier.invalid');
    return /^\/api\/assets\/[1-9]\d*$/.test(url.pathname)
      && /^\d+$/.test(url.searchParams.get('expires') ?? '') && /^[A-Za-z0-9_-]+$/.test(url.searchParams.get('signature') ?? '');
  }
  try { const url = new URL(value); return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password; }
  catch { return false; }
}

/** Rendered review facts must belong to this exact header; authorization remains server-side. */
export function checkSupplierOrderReview(value: unknown, header: OrderRow): asserts value is SupplierOrderReview {
  function fail(): never { throw new Error('订单核对信息不完整或与当前订单不匹配，请重新读取'); }
  if (!record(value) || value.version !== 1 || !['order', 'payment_summary'].includes(value.order_kind)
    || (value.order_kind === 'payment_summary') !== (header.pid === -1)
    || !(value.original_order_id === null || text(value.original_order_id, 64))
    || !record(value.recipient) || !['name','phone','address','mark'].every(k => text(value.recipient[k]))
    || value.recipient.name !== header.real_name || value.recipient.phone !== header.user_phone
    || !record(value.buyer) || !integer(value.buyer.uid) || typeof value.buyer.available !== 'boolean'
    || !text(value.buyer.nickname, 120) || !text(value.buyer.phone, 30)
    || !record(value.amounts) || !integer(value.amounts.quantity) || value.amounts.quantity !== header.total_num
    || !['total_price','total_postage','pay_postage','coupon_price','deduction_price','use_integral','promotions_price','first_order_price','pay_price','refund_price'].every(k => money(value.amounts[k]))
    || !text(value.amounts.change_price, 32) || !/^-?\d{1,24}\.\d{2}$/.test(value.amounts.change_price)
    || value.amounts.pay_price !== header.pay_price || !Array.isArray(value.items) || value.items.length > 200) fail();
  if (!value.items.every((item: unknown) => record(item) && integer(item.id) && item.id > 0 && integer(item.product_id)
    && (!Object.hasOwn(item, 'is_gift') || item.is_gift === 0 || item.is_gift === 1)
    && ['product_name','sku','code','bar_code'].every(k => text(item[k], 1024))
    && integer(item.quantity) && integer(item.refund_quantity) && item.refund_quantity <= item.quantity
    && nullableMoney(item.settlement_unit) && nullableMoney(item.settlement_subtotal)
    && (item.settlement_unit === null) === (item.settlement_subtotal === null))
    || new Set(value.items.map((item: { id: number }) => item.id)).size !== value.items.length
    || !record(value.settlement) || !['recorded','incomplete'].includes(value.settlement.availability)
    || !nullableMoney(value.settlement.items_total) || !money(value.settlement.postage) || !nullableMoney(value.settlement.total)
    || (value.settlement.availability === 'recorded') !== (value.settlement.items_total !== null && value.settlement.total !== null)
    || !Array.isArray(value.form) || value.form.length > 100
    || !value.form.every((field: unknown) => record(field) && text(field.id, 255) && text(field.title, 1024)
      && text(field.value) && Array.isArray(field.images) && field.images.length <= 9 && field.images.every(reviewImageUrl))) fail();
  if (Object.hasOwn(value, 'virtual_delivery')) checkSupplierOrderVirtualReview(value.virtual_delivery, header, value.items);
  if (Object.hasOwn(value, 'invoice')) checkSupplierOrderInvoiceReview(value.invoice, header);
  if (Object.hasOwn(value, 'promotions')) checkSupplierOrderPromotionsReview(value.promotions, header, value.amounts.promotions_price);
}

export function reviewMoney(value: string | null) {
  if (value === null) return '未记录';
  const negative = value.startsWith('-'), raw = negative ? value.slice(1) : value;
  const [whole, fraction] = raw.split('.');
  return `${negative ? '-' : ''}¥${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction}`;
}
