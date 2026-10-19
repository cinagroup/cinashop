import type { OrderRow } from '@/types';

export interface SupplierOrderInvoiceRecord {
  id: number; order_id: number; type: 1 | 2; header_type: 1 | 2;
  name: string; duty_number: string; email: string; bank: string; address: string; drawer_phone: string;
  recorded_amount: string; issuance_state: -1 | 0 | 1; archived: boolean;
}
export interface SupplierOrderInvoiceReview {
  state: 'recorded' | 'none' | 'unavailable'; reason: string; record: SupplierOrderInvoiceRecord | null;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: string[]) => Object.keys(v).sort().join('|') === names.sort().join('|');
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v);
const id = (v: unknown) => Number.isInteger(v) && Number(v) > 0 && Number(v) <= 2147483647;

/** Only this authorized physical order's closed invoice record can be shown. */
export function checkSupplierOrderInvoiceReview(value: unknown, header: OrderRow): asserts value is SupplierOrderInvoiceReview {
  function fail(): never { throw new Error('发票申请信息不完整或与当前订单不匹配，请重新读取'); }
  if (!object(value) || !keys(value, ['state','reason','record']) || typeof value.state !== 'string'
    || !['recorded','none','unavailable'].includes(value.state) || !text(value.reason, 255)) fail();
  if (value.state !== 'recorded') {
    if (value.record !== null || (value.state === 'none' ? value.reason !== '' : value.reason.trim() === '')) fail();
    return;
  }
  const row = value.record;
  if (value.reason !== '' || !object(row)
    || !keys(row, ['id','order_id','type','header_type','name','duty_number','email','bank','address','drawer_phone','recorded_amount','issuance_state','archived'])
    || !id(row.id) || row.order_id !== header.id || ![1,2].includes(Number(row.type)) || typeof row.type !== 'number'
    || ![1,2].includes(Number(row.header_type)) || typeof row.header_type !== 'number'
    || ![-1,0,1].includes(Number(row.issuance_state)) || typeof row.issuance_state !== 'number'
    || typeof row.archived !== 'boolean'
    || !text(row.name, 200) || !text(row.duty_number, 100) || !text(row.email, 200)
    || !text(row.bank, 100) || !text(row.address, 510) || !text(row.drawer_phone, 60)
    || typeof row.recorded_amount !== 'string' || !/^\d{1,10}\.\d{2}$/.test(row.recorded_amount)) fail();
}
