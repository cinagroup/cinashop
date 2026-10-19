import type { OrderRow } from '@/types';

interface DeliveryProduct { product_id: number; sku_unique: string; product_name: string; sku: string; quantity: number }
export type SupplierVirtualDeliveryEntry =
  | (DeliveryProduct & { kind: 'card'; quantity: 1; card_no: string; card_pwd: string })
  | (DeliveryProduct & { kind: 'content'; content: string });
export interface SupplierOrderVirtualReview {
  order_id: number; state: 'not_applicable' | 'not_delivered' | 'recorded' | 'unavailable';
  basis: 'modern' | 'php_legacy' | null; reason: string; entries: SupplierVirtualDeliveryEntry[];
}
interface Product { product_id: number; product_name: string; sku: string; quantity: number; refund_quantity: number }
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const id = (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0 && Number(v) <= 2147483647;
const labelKey = (v: { product_id: number; product_name: string; sku: string }) => JSON.stringify([v.product_id, v.product_name, v.sku]);

/** The sensitive projection belongs only to this authorized physical detail. */
export function checkSupplierOrderVirtualReview(value: unknown, header: OrderRow, products: readonly Product[]): asserts value is SupplierOrderVirtualReview {
  function fail(): never { throw new Error('卡密交付信息不完整或与当前订单不匹配，请重新读取'); }
  if (!object(value) || !keys(value, ['order_id','state','basis','reason','entries']) || value.order_id !== header.id
    || typeof value.state !== 'string' || !['not_applicable','not_delivered','recorded','unavailable'].includes(value.state)
    || !text(value.reason, 255) || !Array.isArray(value.entries) || value.entries.length > 2000) fail();
  if (header.product_type !== 1 && value.state !== 'not_applicable') fail();
  if (header.product_type === 1 && (value.state === 'not_applicable' || (header.pid === -1 && value.state !== 'unavailable'))) fail();
  if (value.state !== 'recorded') {
    if (value.basis !== null || value.entries.length !== 0
      || (value.state === 'not_applicable' ? value.reason !== '' : value.reason.trim() === '')) fail();
    return;
  }
  if (header.product_type !== 1 || header.paid !== 1 || header.delivery_type !== 'fictitious'
    || ![1,2,3].includes(header.status) || header.pid === -1 || value.reason !== ''
    || !['modern','php_legacy'].includes(value.basis) || value.entries.length === 0) fail();
  const quantities = new Map<string, { original: number; remaining: number; delivered: number }>();
  for (const product of products) {
    const key = labelKey(product), group = quantities.get(key) ?? { original: 0, remaining: 0, delivered: 0 };
    group.original += product.quantity; group.remaining += product.quantity - product.refund_quantity; quantities.set(key, group);
  }
  const encoder = new TextEncoder(); let secretBytes = 0;
  for (const entry of value.entries) {
    if (!object(entry) || !id(entry.product_id) || !text(entry.sku_unique, 40) || !entry.sku_unique || [...entry.sku_unique].length > 20
      || !text(entry.product_name, 1024) || !text(entry.sku, 1024) || !id(entry.quantity)) fail();
    if (entry.kind === 'card') {
      if (!keys(entry, ['kind','product_id','sku_unique','product_name','sku','quantity','card_no','card_pwd'])
        || entry.quantity !== 1 || !text(entry.card_no, 510) || [...entry.card_no].length > 255
        || !text(entry.card_pwd, 510) || [...entry.card_pwd].length > 255 || !entry.card_pwd.trim()) fail();
      secretBytes += encoder.encode(entry.card_no).byteLength + encoder.encode(entry.card_pwd).byteLength;
    } else if (entry.kind === 'content') {
      if (!keys(entry, ['kind','product_id','sku_unique','product_name','sku','quantity','content'])
        || !text(entry.content, 1048576) || !entry.content.trim()) fail();
      secretBytes += encoder.encode(entry.content).byteLength;
    } else fail();
    if (secretBytes > 1048576) fail();
    const group = quantities.get(labelKey({ product_id: entry.product_id, product_name: entry.product_name, sku: entry.sku })); if (!group) fail(); group.delivered += entry.quantity;
  }
  for (const group of quantities.values()) if (group.delivered < group.remaining || group.delivered > group.original) fail();
}
