import type { OrderRow } from '@/types';

export interface SupplierOrderPromotionItem {
  promotion_id: number; promotion_type: 1 | 2 | 3 | 4 | null;
  frozen_name: string | null; current_title: string | null; amount: string;
}
export interface SupplierOrderPromotionsReview {
  order_id: number; state: 'recorded' | 'none' | 'unavailable'; reason: string;
  basis: 'modern' | 'legacy' | null; total: string | null; items: SupplierOrderPromotionItem[];
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v);
const money = (v: unknown): v is string => typeof v === 'string' && /^(?:0|[1-9]\d{0,9})\.\d{2}$/.test(v);
const cents = (v: string) => BigInt(v.replace('.', ''));
export function checkSupplierOrderPromotionsReview(value: unknown, header: OrderRow, expectedTotal: string): asserts value is SupplierOrderPromotionsReview {
  function fail(): never { throw new Error('促销分摊信息不完整或与当前订单不匹配，请重新读取'); }
  if (!object(value) || !keys(value, ['order_id','state','reason','basis','total','items']) || value.order_id !== header.id
    || typeof value.state !== 'string' || !['recorded','none','unavailable'].includes(value.state)
    || !text(value.reason, 255) || !Array.isArray(value.items) || !money(expectedTotal)) fail();
  if (value.state !== 'recorded') {
    if (value.basis !== null || value.total !== null || value.items.length !== 0
      || (value.state === 'none' ? value.reason !== '' || cents(expectedTotal) !== 0n : value.reason.trim() === '')) fail();
    return;
  }
  if (value.reason !== '' || (value.basis !== 'modern' && value.basis !== 'legacy') || !money(value.total)
    || value.items.length === 0 || value.items.length > 600) fail();
  const ids = new Set<number>(); let sum = 0n;
  for (const item of value.items) {
    if (!object(item) || !keys(item, ['promotion_id','promotion_type','frozen_name','current_title','amount'])
      || typeof item.promotion_id !== 'number' || !Number.isInteger(item.promotion_id) || item.promotion_id <= 0 || item.promotion_id > 2147483647 || ids.has(item.promotion_id)
      || !money(item.amount) || !(item.current_title === null || text(item.current_title, 510))) fail();
    if (value.basis === 'modern' ? !text(item.frozen_name, 255) || typeof item.promotion_type !== 'number' || ![1,2,3].includes(item.promotion_type)
      : item.frozen_name !== null || !(item.promotion_type === null || typeof item.promotion_type === 'number' && [1,2,3,4].includes(item.promotion_type))) fail();
    ids.add(item.promotion_id); sum += cents(item.amount);
  }
  if (sum !== cents(value.total) || value.total !== expectedTotal) fail();
}
